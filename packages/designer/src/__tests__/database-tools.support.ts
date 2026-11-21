import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { databaseResource } from "../io/database"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { InvokeOptions, ToolResult } from "../tools/types"
import type { DiffData } from "../tools/database-tools"
import {
  compile,
  loadSqlParser,
  type CompiledModel,
  platformInstall,
  renderModelIndependentLayer,
  renderSharedTriggerFunctions,
} from "simetra/compiler"
import {
  applyStateOwnership,
  desiredForApply,
  renderApplyState,
  renderDesiredState,
  type EngineScope,
} from "simetra/schema"
import { readMetadataDir } from "../io/metadata-dir"
import {
  acceptDebt,
  catalog,
  metaFiles,
  movementQuery,
  project as projectFile,
  runTag,
  superuserClient,
  testProvider,
  testRoleName,
} from "../../../simetra/test/support"
import { dropRoles, inTarget as loadTarget, query } from "./support/db"
import { installMismatch, installObjects } from "./support/platform-install"
import { leftoverShadows, provisionedShadows } from "./support/shadows"
import { snapshotOf } from "./helpers/catalog"

/**
 * Спільна підготовка тестів `introspect` і `diff` над живою базою
 * (`database-tools.db.test.ts` та його профільні напарники): тека проєкту,
 * ціль із SQL фікстури, виклик інструмента з ресурсом запуску.
 */

export const SIMETRA = resolve(__dirname, "../../../simetra")
export const ENV = "SIMETRA_DATABASE_URL"

const disposers: (() => Promise<void>)[] = []

/** Прибирання після тесту; кличеться на верхньому рівні файлу тестів. */
export function useDatabaseToolsCleanup(): void {
  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((d) => d()))
  })
}

/** Прибирання, що виконається після поточного тесту. */
export const onCleanup = (dispose: () => Promise<void>): void => {
  disposers.push(dispose)
}

/** Корінь проєкту з `node_modules/simetra`; тека метаданих ще не існує. */
export async function freshProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-db-tools-"))
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  onCleanup(() => rm(root, { recursive: true }))
  return join(root, "metadata")
}

export const scopeOf = (schemas: string[]): EngineScope => ({
  schemas,
  provider: testProvider(),
})

/**
 * Розгортає `sql` у тимчасову базу поруч зі стеком; її прибирає порт.
 * Спільний `inTarget`, де межу задає перелік схем.
 */
export const inTarget = (
  sql: string,
  schemas: string[],
  fn: (url: string) => Promise<void>
): Promise<void> => loadTarget(sql, scopeOf(schemas), fn)

export const options = (
  dir: string,
  env: NodeJS.ProcessEnv,
  shadow?: string
): InvokeOptions => ({
  dir,
  readOnly: false,
  allowDatabaseWrite: false,
  dryRun: false,
  confirmed: false,
  channel: "cli",
  database: databaseResource(env, {
    url: ENV,
    ...(shadow === undefined ? {} : { shadow }),
  }),
})

export const call = (
  name: "introspect" | "diff",
  input: unknown,
  o: InvokeOptions
): Promise<ToolResult> => invoke(toolByName(name)!, input, o)

export const errors = (r: ToolResult) =>
  r.diagnostics.filter((d) => d.severity === "error")

/**
 * Diff of a database without the apply state against the metadata `dir`
 * holds: no errors, and the plan and the differences are exactly the
 * platform install (fork (b) of the outbox: the first apply installs it,
 * `diff` lists that install) — derived by `installObjects` from the compiled
 * empty project, without what the apply state owns. A new platform table or
 * unit changes the expected set by itself; an action or difference outside it
 * is red.
 */
export async function expectOnlyPlatformInstall(
  data: DiffData,
  dir: string
): Promise<void> {
  const compiled = await compile(await readMetadataDir(dir))
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  const expected = installObjects(
    await platformInstall(testProvider()),
    applyStateOwnership(compiled.model!).owns
  )
  expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  expect(data.applyState).toBe("absent")
  expect(expected.objects.length).toBeGreaterThan(0)
  expect(installMismatch(data, expected, await loadSqlParser())).toEqual({
    foreignActions: [],
    foreignDifferences: [],
    foreignGrants: [],
    unplanned: [],
    undifferenced: [],
  })
}

export const SHOP = `
  CREATE SCHEMA app;
  CREATE TYPE app.order_status AS ENUM ('new', 'paid');
  CREATE TABLE app.customer (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE app.orders (
    id uuid PRIMARY KEY,
    customer_id uuid NOT NULL REFERENCES app.customer (id),
    status app.order_status NOT NULL,
    total numeric(12, 2)
  );
  CREATE INDEX orders_customer_idx ON app.orders (customer_id);
`

export const introspectInput = {
  schemas: ["app"],
  project: {
    name: "Shop",
    attributeCase: "snake_case",
    database: { provider: testProvider() },
  },
}

/** Ціль SHOP і тека, вже прочитана з неї. */
export async function introspected(
  fn: (dir: string, env: NodeJS.ProcessEnv, url: string) => Promise<void>
): Promise<void> {
  await inTarget(SHOP, ["app"], async (url) => {
    const dir = await freshProject()
    const env = { [ENV]: url }
    const r = await call("introspect", introspectInput, options(dir, env))
    expect(errors(r)).toEqual([])
    expect(r.written).toBe(true)
    await fn(dir, env, url)
  })
}

/**
 * Таблиця застосунку з колонками механіки, спільні функції шару в `simetra` і
 * тригер механіки на таблиці в тексті генератора; `edit` змінює лише текст
 * тригера. Шар рендерить той самий генератор, що й застосування, тож без
 * зміни тригер — платформний вміст.
 */
async function layerTarget(edit: (trigger: string) => string): Promise<{
  sql: string
  trigger: string
}> {
  const parse = await loadSqlParser()
  const table = { schema: "app", name: "note" }
  const trigger = renderModelIndependentLayer(
    table,
    testProvider(),
    parse
  ).find(
    (u) =>
      u.class === "trigger" &&
      u.identity === "trigger:app.note.note_simetra_touch"
  )
  expect(trigger).toBeDefined()
  const functions = renderSharedTriggerFunctions(testProvider(), parse)
  return {
    sql: [
      "CREATE SCHEMA simetra;",
      ...functions.map((u) => u.sql),
      "CREATE SCHEMA app;",
      "CREATE TABLE app.note (id uuid PRIMARY KEY, updated_at timestamptz NOT NULL, version bigint NOT NULL);",
      edit(trigger!.sql),
    ].join("\n"),
    trigger: trigger!.identity,
  }
}

const noteInput = {
  schemas: ["app"],
  project: {
    name: "Notes",
    attributeCase: "snake_case",
    database: { provider: testProvider() },
  },
}

/**
 * И4 на шляху інструмента (план #286): тригер механіки на таблиці
 * застосунку платформний лише за вмістом. Схему `simetra` `introspect` не
 * читає, тож тут — лише тригер у схемі застосунку. Реєструється з файлу
 * кожного профілю (`database-tools.db.test.ts`,
 * `database-tools.supabase.db.test.ts`).
 */
export function describeToolPathInvariants(): void {
  describe("introspect judges a mechanics trigger by its content", () => {
    it("the trigger in the generator's form is the platform's and is not written", async () => {
      const target = await layerTarget((sql) => sql)
      await inTarget(target.sql, ["app"], async (url) => {
        const dir = await freshProject()
        const r = await call(
          "introspect",
          noteInput,
          options(dir, { [ENV]: url })
        )
        expect(errors(r)).toEqual([])
        expect(r.written).toBe(true)
        const compiled = await compile(await readMetadataDir(dir))
        expect(
          compiled
            .model!.sqlUnits.filter((u) => u.file !== undefined)
            .map((u) => u.identity)
        ).toEqual([])
      })
    })

    it("the same name with another event goes to the folder and is refused (И4)", async () => {
      const target = await layerTarget((sql) => {
        expect(sql).toContain(" BEFORE ")
        return sql.replace(" BEFORE ", " AFTER ")
      })
      await inTarget(target.sql, ["app"], async (url) => {
        const dir = await freshProject()
        const r = await call(
          "introspect",
          noteInput,
          options(dir, { [ENV]: url })
        )
        expect(r.written).toBe(false)
        // Точна одиниця: сам тригер у файлі таблиці, а не інша одиниця шару
        expect(
          errors(r).map((d) => ({
            code: d.code,
            file: d.file,
            unit: d.params?.unit,
            function: d.params?.function,
          }))
        ).toEqual([
          {
            code: "sql.platform-function-call",
            file: "custom-tables/Note/Note.sql",
            unit: target.trigger,
            function: "simetra.touch",
          },
        ])
      })
    })
  })

  describe("introspect over an applied folder judges its generated units by the catalog form of one shadow", () => {
    /** Тека з довідником: його тригери й гранти рендерить тека, не шар. */
    const kept = () =>
      metaFiles({
        "project.meta.json": projectFile({
          name: "Shop",
          defaultSchema: "app",
          naming: { attributeCase: "snake_case" },
          database: { provider: testProvider() },
        }),
        "catalogs/Currency/Currency.meta.json": catalog("Currency", {
          schema: "app",
        }),
      })

    async function written(
      dir: string,
      files: ReadonlyMap<string, string>
    ): Promise<void> {
      for (const [path, text] of files) {
        await mkdir(dirname(join(dir, path)), { recursive: true })
        await writeFile(join(dir, path), text)
      }
    }

    it("the folder's units are the platform's, through one run-tagged shadow that is gone after the call", async () => {
      const files = kept()
      const compiled = await compile(files)
      expect(
        compiled.diagnostics.filter((d) => d.severity === "error")
      ).toEqual([])
      await inTarget(
        renderDesiredState(compiled.model!).sql,
        ["app"],
        async (url) => {
          const dir = await freshProject()
          await written(dir, files)
          const mark = provisionedShadows().length
          const r = await call("introspect", {}, options(dir, { [ENV]: url }))
          expect(errors(r)).toEqual([])
          expect(r.written).toBe(true)
          // Тригери довідника не стали дослівним SQL теки
          const after = await compile(await readMetadataDir(dir))
          expect(
            after
              .model!.sqlUnits.filter((u) => u.file !== undefined)
              .map((u) => u.identity)
          ).toEqual([])
          // Одна тінь на виклик, з тегом прогону, і її вже немає
          const shadows = provisionedShadows().slice(mark)
          expect(shadows).toHaveLength(1)
          expect(shadows[0]).toContain(runTag())
          expect(await leftoverShadows(mark)).toEqual([])
        }
      )
    })

    it("a folder whose shadow fails is refused loudly, and the shadow is gone", async () => {
      // Тінь теки падає на поданні над таблицею, якої немає: еталона теки
      // немає, і introspect це називає, а не пише теку без нього
      const files = kept()
      const compiled = await compile(files)
      expect(
        compiled.diagnostics.filter((d) => d.severity === "error")
      ).toEqual([])
      const broken = await acceptDebt(
        new Map([
          ...files,
          [
            "sql/app/broken.sql",
            "CREATE VIEW app.broken AS SELECT id FROM app.nowhere;\n",
          ],
        ])
      )
      await inTarget(
        renderDesiredState(compiled.model!).sql,
        ["app"],
        async (url) => {
          const dir = await freshProject()
          await written(dir, broken)
          const mark = provisionedShadows().length
          const r = await call("introspect", {}, options(dir, { [ENV]: url }))
          expect(r.written).toBe(false)
          expect(errors(r).map((d) => d.code)).toContain(
            "engine.shadow-load-failed"
          )
          expect(provisionedShadows().slice(mark)).toHaveLength(1)
          expect(await leftoverShadows(mark)).toEqual([])
        }
      )
    })
  })

  describe("over an applied folder what the folder describes is judged by diff and the reference", () => {
    /**
     * Тека `files`, застосована повністю: бажаний SQL моделі й стан
     * застосування, тож `diff` до будь-якої зміни порожній.
     */
    async function applied(
      files: ReadonlyMap<string, string>,
      fn: (dir: string, url: string, model: CompiledModel) => Promise<void>
    ): Promise<void> {
      const compiled = await compile(files)
      expect(
        compiled.diagnostics.filter((d) => d.severity === "error")
      ).toEqual([])
      const model = compiled.model!
      const { scope } = await desiredForApply(model)
      await inTarget(
        `${renderDesiredState(model).sql}\n\n${renderApplyState(model)}`,
        [...scope.schemas],
        async (url) => {
          const dir = await freshProject()
          for (const [path, text] of files) {
            await mkdir(dirname(join(dir, path)), { recursive: true })
            await writeFile(join(dir, path), text)
          }
          await fn(dir, url, model)
        }
      )
    }

    /**
     * Файл SQL об'єкта (довідника), а не розкладка прийому
     * (`sql/<схема>/<файл>.sql` — розкладка самого `introspect`, її одиниці
     * судить еталон): його одиниці описує тека (Р4).
     */
    const OWN_FILE = "catalogs/Item/Item.sql"
    const FILE_FUNCTION = "function:app.item_count()"
    const OWN_SQL =
      "CREATE FUNCTION app.item_count() RETURNS bigint LANGUAGE sql STABLE\n" +
      "  SET search_path = ''\n" +
      "  AS $$ SELECT count(*) FROM app.item $$;\n"
    /** Обгортка запиту рухів документа «Продаж» за регістром «Залишки». */
    const MOVEMENT_WRAPPER = "function:app.sale_stock_movements(uuid)"

    /** Той самий текст одиниці, що замінює наявну функцію. */
    const replacing = (sql: string): string => {
      expect(sql).toMatch(/^CREATE (OR REPLACE )?FUNCTION /)
      return sql.replace(
        /^CREATE (OR REPLACE )?FUNCTION /,
        "CREATE OR REPLACE FUNCTION "
      )
    }

    it("a folder file function and the movement query wrapper with another body in the database are each a diff row (Р4)", async () => {
      // Одиниці файлу теки й обгортку запиту рухів прийом поверх теки не
      // судить за вмістом (їх описує тека, Р4): розбіжність тіла мусить
      // показати `diff`, рядок на кожну, а не тиша
      const files = await acceptDebt(
        new Map([...movementQuery(testProvider()), [OWN_FILE, OWN_SQL]])
      )
      await applied(files, async (dir, url, model) => {
        const env = { [ENV]: url }
        const diff = async () =>
          (await call("diff", {}, options(dir, env))).data as DiffData
        expect(await diff()).toMatchObject({
          plan: [],
          differences: [],
          empty: true,
        })
        // Перший прийом розкладає SQL фікстури за своїми правилами (файл
        // `sql/public/…` — у файли одиниць); зміни тіл нижче судить уже другий
        expect(errors(await call("introspect", {}, options(dir, env)))).toEqual(
          []
        )
        const before = await snapshotOf(dir)
        const file = model.sqlUnits.find(
          (u) => u.file === OWN_FILE && u.identity === FILE_FUNCTION
        )
        const wrapper = model.sqlUnits.find(
          (u) => u.class === "movementQuery" && u.identity === MOVEMENT_WRAPPER
        )
        expect(file).toBeDefined()
        expect(wrapper).toBeDefined()
        expect(file!.sql).toContain("SELECT count(*) FROM app.item")
        expect(wrapper!.sql).toContain("ORDER BY g.line_number")
        await query(
          url,
          replacing(file!.sql).replace(
            "SELECT count(*) FROM app.item",
            "SELECT count(*) + 1 FROM app.item"
          )
        )
        await query(
          url,
          replacing(wrapper!.sql).replace(
            "ORDER BY g.line_number",
            "ORDER BY g.qty"
          )
        )
        // Прийом поверх теки ці одиниці не переписує з бази: їх описує тека
        const adopted = await call("introspect", {}, options(dir, env))
        expect(errors(adopted)).toEqual([])
        expect(adopted.changes).toEqual([])
        expect(await snapshotOf(dir)).toEqual(before)
        const data = await diff()
        expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual(
          []
        )
        expect(
          data.differences.map((d) => ({ path: d.path, kind: d.kind }))
        ).toEqual([
          { path: `units.${FILE_FUNCTION}`, kind: "changed" },
          { path: `units.${MOVEMENT_WRAPPER}`, kind: "changed" },
        ])
        // Двигун замінює тіло на місці: дія `alter` над самою функцією
        expect(
          data.plan.map((a) => ({ verb: a.verb, consumes: a.consumes }))
        ).toEqual([
          { verb: "alter", consumes: [FILE_FUNCTION, "schema:app"] },
          { verb: "alter", consumes: [MOVEMENT_WRAPPER, "schema:app"] },
        ])
        expect(data.empty).toBe(false)
      })
    })

    it("a second introspect over the first's folder changes nothing", async () => {
      // Другий прохід іде шляхом наявної теки з тінню: файли теки, обгортку
      // запиту рухів і згенеровані одиниці еталон теки впізнає, тож прохід
      // нічого не пише й не додає діагностик до діагностик самої теки
      await applied(movementQuery(testProvider()), async (dir, url) => {
        const env = { [ENV]: url }
        const first = await call("introspect", {}, options(dir, env))
        expect(errors(first)).toEqual([])
        const before = await snapshotOf(dir)
        const again = await call("introspect", {}, options(dir, env))
        // Єдина діагностика — попередження самої теки фікстури (скоуп «org»
        // ніхто не читає), а не прийому
        expect(
          again.diagnostics.map((d) => ({ code: d.code, severity: d.severity }))
        ).toEqual([{ code: "rights.scope-kind-unread", severity: "warning" }])
        expect(again.changes).toEqual([])
        expect(again.written).toBe(false)
        expect(await snapshotOf(dir)).toEqual(before)
      })
    })

    it("a foreign grant on a kind table is refused over the folder, not dropped (И7)", async () => {
      // Таблицю виду тека грантує сама (контракт доступу): грант іншій ролі
      // з еталоном не збігається, тож іде в теку, і компілятор його називає
      const role = testRoleName("db_tools_grantee")
      const client = await superuserClient()
      try {
        await client.query(`CREATE ROLE ${role} NOLOGIN`)
      } finally {
        await client.end()
      }
      try {
        await applied(
          movementQuery(testProvider()),
          async (dir, url, model) => {
            expect(
              model.sqlUnits.some(
                (u) =>
                  u.class === "grant" &&
                  u.identity.startsWith("grant:grant:table:app.item:")
              )
            ).toBe(true)
            await query(url, `GRANT SELECT ON TABLE app.item TO ${role}`)
            const before = await snapshotOf(dir)
            const r = await call("introspect", {}, options(dir, { [ENV]: url }))
            expect(r.written).toBe(false)
            expect(
              errors(r).map((d) => ({ code: d.code, file: d.file }))
            ).toEqual([
              {
                code: "sql.generated-grant",
                file: `sql/app/grant__table__app_item__${role}__select.sql`,
              },
            ])
            expect(await snapshotOf(dir)).toEqual(before)
          }
        )
      } finally {
        await dropRoles(role)
      }
    })
  })
}
