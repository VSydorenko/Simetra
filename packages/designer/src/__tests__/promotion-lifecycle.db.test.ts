import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  promoteInput,
  promotionRecordHash,
  promotionRecordSchema,
  type PromoteInput,
} from "simetra/compiler"
import {
  parseRehearsal,
  rehearsalHash,
  type EngineScope,
  type RehearsalReport,
} from "simetra/schema"
import { afterAll, describe, expect, it } from "vitest"
import { databaseResource } from "../io/database"
import { renderPlan } from "../io/report"
import type { ApplyData, PlanData } from "../tools/apply-tools"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { InvokeOptions, ToolResult } from "../tools/types"
import {
  acceptDebt,
  catalog,
  metaFiles,
  project as projectFile,
  uuid,
} from "../../../simetra/test/support"
import { inTarget, query } from "./support/db"

/**
 * Наскрізний цикл промоції інструментами (план П3-2a, задача 13): стан до
 * промоції застосовано з даними, `promote` пише запис у `plans/`, `plan`
 * читає його й будує план промоції, а `apply` репетирує його на цілі й
 * відкочує. Застосування з `COMMIT` — лише з чинним звітом репетиції (план
 * П3-2b-3): тут копією служить сама ціль. Фікстура синтетична.
 * Ціль кожного тесту — окрема база від `withDesiredShadow`; база стеку лише
 * читається.
 */

const SIMETRA = resolve(__dirname, "../../../simetra")
const ENV = "SIMETRA_DATABASE_URL"
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

// Теки проєктів прибираються після файлу, а не після тесту: тести йдуть
// конкурентно, і `afterEach` одного стер би теку сусіда посеред його роботи
const disposers: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(disposers.splice(0).map((d) => d()))
})

/** Порожня ціль: лише базовий стан провайдера. */
const EMPTY = "select 1;"

const GROUP_ID = uuid(9301)
const ITEM_ID = uuid(9311)
const LINE_ID = uuid(9321)
const GROUP_FILE = "catalogs/Group/Group.meta.json"
const ITEM_FILE = "custom-tables/Item/Item.meta.json"
const ITEM_SQL = "custom-tables/Item/Item.sql"
const LINE_FILE = "custom-tables/ItemLine/ItemLine.meta.json"
const RECORD_FILE = `plans/${ITEM_ID}.promotion.json`

const column = (
  n: number,
  name: string,
  physicalName: string,
  rest: Record<string, unknown>
) => ({ id: uuid(n), name, physicalName, ...rest })

/**
 * Прийнята таблиця `Item` з ТЧ `ItemLine` і посиланням на довідник `Group`.
 * Коментар таблиці `promote` переносить в опис дослівно (R24).
 */
function item(onDelete = "restrict") {
  return {
    id: ITEM_ID,
    kind: "CustomTable",
    name: "Item",
    physicalName: "items",
    kindLabel: "item",
    schema: "app",
    comment: "Items of the catalog",
    columns: [
      column(9312, "id", "id", { type: "UUID", notNull: true }),
      column(9313, "title", "title", { type: "Text", notNull: true }),
      column(9314, "code", "code", { type: "Text" }),
      column(9315, "groupId", "group_id", { type: "UUID" }),
      column(9316, "isDeleted", "is_deleted", {
        type: "Boolean",
        notNull: true,
        default: "false",
      }),
      column(9317, "legacy", "legacy", { type: "Text" }),
    ],
    primaryKey: { name: "items_pkey", columns: ["id"] },
    uniques: [{ name: "items_code_key", columns: ["code"] }],
    foreignKeys: [
      {
        name: "items_group_id_fkey",
        columns: ["groupId"],
        references: {
          object: { kind: "Catalog", name: "Group" },
          key: "ref",
        },
        onDelete,
      },
    ],
    indexes: [{ name: "items_title_idx", keys: [{ column: "title" }] }],
    rowLevelSecurity: "enabled",
  }
}

function itemLine() {
  return {
    id: LINE_ID,
    kind: "CustomTable",
    name: "ItemLine",
    physicalName: "item_lines",
    kindLabel: "item_line",
    schema: "app",
    columns: [
      column(9322, "id", "id", { type: "UUID", notNull: true }),
      column(9323, "itemId", "item_id", { type: "UUID", notNull: true }),
      column(9324, "qty", "qty", { type: "Integer" }),
      // Стандартний `lineNumber` ТЧ — NOT NULL без типового значення: без
      // власної колонки його заповнив би лише крок `fill`, а його тут немає
      column(9325, "lineNumber", "line_number", {
        type: "Integer",
        notNull: true,
      }),
    ],
    primaryKey: { name: "item_lines_pkey", columns: ["id"] },
    foreignKeys: [
      {
        name: "item_lines_item_id_fkey",
        columns: ["itemId"],
        references: {
          object: { kind: "CustomTable", name: "Item" },
          columns: ["id"],
        },
        onDelete: "cascade",
      },
    ],
    rowLevelSecurity: "enabled",
  }
}

/**
 * Читання через API до промоції: грант ролі `authenticated` і політика
 * читання — дослівний модуль таблиці, який промоція знімає (клас `removed`).
 */
const READ_MODULE = `CREATE POLICY items_read ON app.items FOR SELECT TO authenticated USING (true);

GRANT SELECT ON app.items TO authenticated;
`
const READ_UNITS = {
  policy: "policy:app.items.items_read",
  grant: "grant:grant:table:app.items:authenticated:select",
}

/**
 * Метадані до промоції; `read` додає читання через API, `onDelete` — дія FK
 * на `Group` (типово `restrict`, як у прийнятій таблиці).
 */
function beforeEntries(
  o: { read?: boolean; onDelete?: string } = {}
): Record<string, unknown> {
  return {
    [GROUP_FILE]: catalog("Group", {
      id: GROUP_ID,
      physicalName: "groups",
      codeLength: 0,
    }),
    [ITEM_FILE]: item(o.onDelete),
    ...(o.read === true ? { [ITEM_SQL]: READ_MODULE } : {}),
    [LINE_FILE]: itemLine(),
  }
}

/**
 * `columns` підміняє долю колонки прийнятої таблиці, `fill` додає кроки даних
 * (типово їх немає).
 */
interface MappingOptions {
  read?: boolean
  swap?: boolean
  columns?: Record<string, unknown>
  fill?: PromoteInput["fill"]
}

/** Мапінг у довідник без коду й ієрархії, без кроку `fill`. */
function mapping(o: MappingOptions = {}): PromoteInput {
  return promoteInput.parse({
    target: { name: "Item" },
    into: { kind: "Catalog", name: "Item", data: { codeLength: 0 } },
    columns: {
      id: { to: "standard", name: "ref" },
      title: { to: "standard", name: "description" },
      isDeleted: { to: "standard", name: "deletionMark" },
      // Обмін: колонка `code` стає реквізитом `legacy` і навпаки
      code: {
        to: "attribute",
        element: { name: o.swap ? "legacy" : "code", unique: true },
      },
      groupId: { to: "attribute", element: { name: "group" } },
      legacy: o.swap
        ? { to: "attribute", element: { name: "code" } }
        : { to: "retire" },
      ...o.columns,
    },
    ...(o.fill === undefined ? {} : { fill: o.fill }),
    tabularSections: [
      {
        table: "ItemLine",
        name: "lines",
        columns: {
          id: { to: "standard", name: "ref" },
          itemId: { to: "standard", name: "parent" },
          qty: { to: "attribute", element: { name: "qty" } },
          lineNumber: { to: "standard", name: "lineNumber" },
        },
      },
    ],
    conversions: {
      "Item#uniques/items_code_key": "property",
      // Вид не відтворює індекс опису, тож він лише знімається
      "Item#indexes/items_title_idx": "removed",
      // Генерованих політик і грантів ролям API вид ще не дає, тож клас
      // `platform` для них відмовив би (рішення 7 плану П3-2b-0): читання
      // знімається класом `removed`
      ...(o.read === true
        ? { [READ_UNITS.policy]: "removed", [READ_UNITS.grant]: "removed" }
        : {}),
    },
  })
}

/** Корінь проєкту з `node_modules/simetra` і текою метаданих. */
async function projectWith(entries: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-promotion-"))
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  disposers.push(() => rm(root, { recursive: true }))
  const dir = join(root, "metadata")
  // Дослівні одиниці фікстури — прийнятий борг
  const files = await acceptDebt(
    metaFiles({
      "project.meta.json": projectFile({ defaultSchema: "app" }),
      ...entries,
    })
  )
  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

const options = (dir: string, url: string): InvokeOptions => ({
  dir,
  readOnly: false,
  allowDatabaseWrite: true,
  dryRun: false,
  confirmed: true,
  channel: "cli",
  database: databaseResource({ [ENV]: url }, { url: ENV }),
})

const call = (
  name: "plan" | "apply" | "promote",
  input: unknown,
  o: InvokeOptions
): Promise<ToolResult> => invoke(toolByName(name)!, input, o)

const codes = (r: ToolResult) => r.diagnostics.map((d) => d.code)
const errors = (r: ToolResult) =>
  r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)

async function planned(dir: string, url: string): Promise<PlanData> {
  const r = await call("plan", {}, options(dir, url))
  expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
  expect(r.written).toBe(true)
  return r.data as PlanData
}

async function apply(
  dir: string,
  url: string,
  data: PlanData,
  o: { allow?: string[]; rehearse?: boolean } = {}
): Promise<ToolResult> {
  return call(
    "apply",
    {
      plan: data.file,
      planHash: data.planHash,
      allow: o.allow ?? data.requiredPermissions,
      ...(o.rehearse === true ? { rehearse: true } : {}),
    },
    options(dir, url)
  )
}

const GROUP_ROW = uuid(9401)
const ITEM_ROW = uuid(9402)
const LINE_ROW = uuid(9403)

/** Рядки стану до промоції; `title` — назва рядка `Item`. */
const rows = (title = "first") => `
  insert into app.groups (id) values ('${GROUP_ROW}');
  insert into app.items (id, title, code, group_id, legacy)
    values ('${ITEM_ROW}', '${title}', 'c-1', '${GROUP_ROW}', 'old');
  insert into app.item_lines (id, item_id, qty, line_number)
    values ('${LINE_ROW}', '${ITEM_ROW}', 3, 1);`

/**
 * Стан до промоції, застосований із `COMMIT` і з даними, потім `promote`:
 * тека метаданих уже після промоції, запис — у `plans/`.
 */
async function promoted(
  url: string,
  o: MappingOptions & { title?: string; onDelete?: string } = {}
): Promise<string> {
  const dir = await projectWith(beforeEntries(o))
  const before = await planned(dir, url)
  expect(before.promotion).toBeNull()
  const committed = await apply(dir, url, before)
  expect(committed.diagnostics, JSON.stringify(committed.diagnostics)).toEqual(
    []
  )
  await query(url, rows(o.title))

  const r = await call("promote", mapping(o), options(dir, url))
  expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
  expect(r.written).toBe(true)
  expect(r.artifacts).toEqual([RECORD_FILE])
  return dir
}

/** Імена таблиць схеми `app` і дані прийнятих таблиць. */
async function state(url: string) {
  return {
    tables: await query(
      url,
      "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where nspname = 'app' and relkind = 'r' order by relname"
    ),
    items: await query(url, "select * from app.items order by id"),
    lines: await query(url, "select * from app.item_lines order by id"),
  }
}

const intentSteps = (d: PlanData) =>
  d.steps.filter((s) => s.origin === "intent")
const engineSteps = (d: PlanData) =>
  d.steps.filter((s) => s.origin === "engine")
const stepMatching = (d: PlanData, pattern: RegExp) =>
  d.steps.filter((s) => pattern.test(s.sql))

// Конкурентно: кожен тест — у власній цілі й теці проєкту, кластера не
// змінює, а спільного змінного стану файл не має
describe.concurrent("promotion lifecycle", () => {
  it("promote → plan → rehearse on the target → rolled back", async () => {
    await inTarget(EMPTY, scope, async (url) => {
      const dir = await promoted(url)
      const record = promotionRecordSchema.parse(
        JSON.parse(await readFile(join(dirname(dir), RECORD_FILE), "utf8"))
      )
      const data = await planned(dir, url)

      // Блок промоції: що стає чим і що людина дозволяє
      const promotion = data.promotion!
      expect(promotion).toMatchObject({
        objectId: ITEM_ID,
        kind: "Catalog",
        name: "Item",
        recordHash: await promotionRecordHash(record),
        tables: [
          { schema: "app", from: "items", to: "item" },
          { schema: "app", from: "item_lines", to: "item_lines" },
        ],
      })
      const itemTable = { schema: "app", name: "item" }
      const lines = { schema: "app", name: "item_lines" }
      expect(promotion.columns).toEqual([
        { table: itemTable, from: "title", to: "description" },
        { table: itemTable, from: "is_deleted", to: "deletion_mark" },
        { table: lines, from: "item_id", to: "parent_id" },
      ])
      expect(promotion.canonicalNames).toEqual([
        {
          kind: "constraint",
          table: itemTable,
          from: "items_code_key",
          to: "item_code_key",
        },
        {
          kind: "constraint",
          table: itemTable,
          from: "items_pkey",
          to: "item_pkey",
        },
        {
          kind: "constraint",
          table: lines,
          from: "item_lines_item_id_fkey",
          to: "item_lines_parent_id_fkey",
        },
      ])

      // Кроки наміру — першими; PK і FK ТЧ лише перейменовано
      const intent = intentSteps(data)
      expect(data.steps.slice(0, intent.length)).toEqual(intent)
      expect(intent.map((s) => s.sql)).toEqual([
        "ALTER TABLE app.items RENAME TO item",
        "ALTER TABLE app.item RENAME COLUMN title TO description",
        "ALTER TABLE app.item RENAME COLUMN is_deleted TO deletion_mark",
        "ALTER TABLE app.item_lines RENAME COLUMN item_id TO parent_id",
        "ALTER TABLE app.item RENAME CONSTRAINT items_code_key TO item_code_key",
        "ALTER TABLE app.item RENAME CONSTRAINT items_pkey TO item_pkey",
        "ALTER TABLE app.item_lines RENAME CONSTRAINT item_lines_item_id_fkey TO item_lines_parent_id_fkey",
      ])
      expect(
        engineSteps(data).filter((s) =>
          /pkey|parent_id_fkey|DROP TABLE|CREATE TABLE/.test(s.sql)
        )
      ).toEqual([])
      // FK на `Group` з `restrict` не еквівалентний FK виду (`noAction`):
      // інша дія видалення — інший ключ (рішення 4), тож DROP/ADD двигуна, а
      // зміну семантики дозволяє пункт `delete:` (рішення 8)
      expect(
        stepMatching(data, /group_id_fkey/).map((s) => [s.origin, s.sql])
      ).toEqual([
        [
          "engine",
          'ALTER TABLE "app"."item" DROP CONSTRAINT "items_group_id_fkey"',
        ],
        [
          "engine",
          'ALTER TABLE "app"."item" ADD CONSTRAINT "item_group_id_fkey" FOREIGN KEY (group_id) REFERENCES app.groups(id)',
        ],
      ])
      // Таблиці виду читає роль користувача (згенерований `GRANT SELECT`),
      // а пише роль команд поколонково (спека П4 §6.2); прийнята таблиця
      // таких грантів не мала — новий доступ під `access:`
      const command = (table: string, privileges: string) =>
        `extra grant:grant:table:app.${table}:simetra_command:${privileges}`
      expect(promotion.permissionItems).toEqual([
        {
          token: "access:app.item",
          summary: [
            "extra grant:grant:table:app.item:authenticated:select",
            command("item", "insert(code),update(code)"),
            command("item", "insert(description),update(description)"),
            command("item", "insert(group_id),update(group_id)"),
            command("item", "insert(id)"),
            command("item", "select"),
            command("item", "update(deletion_mark)"),
          ],
        },
        {
          token: "access:app.item_lines",
          summary: [
            "extra grant:grant:table:app.item_lines:authenticated:select",
            command("item_lines", "delete,select"),
            command("item_lines", "insert(id)"),
            command("item_lines", "insert(line_number),update(line_number)"),
            command("item_lines", "insert(parent_id)"),
            command("item_lines", "insert(qty),update(qty)"),
          ],
        },
        {
          token: "delete:app.item.item_group_id_fkey",
          summary: ["own (group_id) → groups: on delete restrict → noAction"],
        },
        {
          token: "remove:app.item",
          summary: ["tables.app.items.indexes.items_title_idx"],
        },
      ])
      // Пункти промоції йдуть першими в порядку токенів: `access:` таблиць
      // виду — перед `delete:`
      expect(data.requiredPermissions.slice(0, 3)).toEqual([
        "access:app.item",
        "access:app.item_lines",
        "delete:app.item.item_group_id_fkey",
      ])
      // Зняття FK бере ACCESS EXCLUSIVE на `groups` — наперед, у старому
      // імені, а не посеред кроків (R26)
      expect(data.locks).toContainEqual({
        schema: "app",
        name: "groups",
        mode: "accessExclusive",
      })
      expect(data.implicitLocks).toEqual([])

      // Клас конверсії — біля кроку видалення, який він покриває
      const conversion = (pattern: RegExp) =>
        stepMatching(data, pattern).map((s) => s.conversion)
      expect(conversion(/^COMMENT ON TABLE/)).toEqual(["metadata"])
      expect(conversion(/DROP INDEX "app"."items_title_idx"/)).toEqual([
        "removed",
      ])
      // Еквівалентно відтворений `property` не знімається: лише перейменовано
      expect(conversion(/DROP CONSTRAINT "items_code_key"/)).toEqual([])
      expect(conversion(/DROP COLUMN "legacy"/)).toEqual([undefined])
      expect(stepMatching(data, /TYPE character varying\(150\)/)).toHaveLength(
        1
      )

      // Текст: блок промоції — між дрейфом і кроками
      const text = renderPlan(data, "", { ok: true, written: true })
      const block = text.indexOf(`promotion: Catalog Item (${ITEM_ID})`)
      expect(block).toBeGreaterThan(text.indexOf(`planHash: ${data.planHash}`))
      expect(text.indexOf("steps (")).toBeGreaterThan(block)
      expect(text).toContain("  table app.items -> app.item\n")
      // Таблиця, що лишає ім'я, рядка перейменування не дає
      expect(text).not.toContain("app.item_lines -> app.item_lines")
      expect(text).toContain("  constraint app.item: items_pkey -> item_pkey\n")
      expect(text).toContain(
        "  delete:app.item.item_group_id_fkey (needs allow: delete:app.item.item_group_id_fkey)\n    own (group_id) → groups: on delete restrict → noAction\n"
      )

      // Репетиція на цілі з усіма пунктами: відкат, імена й дані ті самі
      const before = await state(url)
      const r = await apply(dir, url, data, { rehearse: true })
      expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
      expect((r.data as ApplyData).status).toBe("rolledBack")
      // Звірка сліду: замки сесії не вийшли за слід плану
      expect(codes(r)).not.toContain("apply.lock-footprint-exceeded")
      expect(await state(url)).toEqual(before)
      expect(before.items).toEqual([
        expect.objectContaining({ id: ITEM_ROW, title: "first", code: "c-1" }),
      ])
    })
  })

  it("renames the foreign key to Group when its delete action is the kind's", async () => {
    await inTarget(EMPTY, scope, async (url) => {
      const dir = await promoted(url, { onDelete: "noAction" })
      const data = await planned(dir, url)
      // Та сама дія видалення — той самий ключ: FK на таблицю поза одиницею
      // отримує канонічне ім'я, без DROP/ADD і без пункту `delete:`
      expect(data.promotion!.canonicalNames).toContainEqual({
        kind: "constraint",
        table: { schema: "app", name: "item" },
        from: "items_group_id_fkey",
        to: "item_group_id_fkey",
      })
      expect(
        stepMatching(data, /group_id_fkey/).map((s) => [s.origin, s.sql])
      ).toEqual([
        [
          "intent",
          "ALTER TABLE app.item RENAME CONSTRAINT items_group_id_fkey TO item_group_id_fkey",
        ],
      ])
      // Лишився тільки дозвіл на зняття індексу опису (клас `removed`) і
      // новий доступ читання таблиць виду (згенерований `GRANT SELECT`)
      expect(data.promotion!.permissionItems.map((i) => i.token)).toEqual([
        "access:app.item",
        "access:app.item_lines",
        "remove:app.item",
      ])
    })
  })

  /** Звіт репетиції з `plans/`, розібраний строго. */
  async function reportAt(dir: string, file: string): Promise<RehearsalReport> {
    const parsed = parseRehearsal(
      await readFile(join(dirname(dir), file), "utf8")
    )
    if (!parsed.ok) throw new Error(parsed.message)
    return parsed.report
  }

  /** Рядки ledger цілі за порядком застосувань. */
  const ledger = (url: string) =>
    query<{ promotion: unknown; rehearsal_hash: string | null }>(
      url,
      "select promotion, rehearsal_hash from simetra.ledger order by id"
    )

  it("refuses to commit the promotion without a valid rehearsal report", async () => {
    // Гейти звіту на рівні конвеєра: відмова до будь-якої транзакції, ціль і
    // ledger ті самі; далі копія з меншою кількістю рядків — попередження
    await inTarget(EMPTY, scope, async (url) => {
      const dir = await promoted(url)
      const data = await planned(dir, url)
      const before = await state(url)
      const applied = await ledger(url)
      const unchanged = async () => {
        expect(await state(url)).toEqual(before)
        expect(await ledger(url)).toEqual(applied)
      }

      const none = await apply(dir, url, data)
      expect(errors(none)).toEqual(["apply.rehearsal-required"])
      expect(none.data).toBeUndefined()
      await unchanged()

      const rehearsed = await apply(dir, url, data, { rehearse: true })
      expect(errors(rehearsed), JSON.stringify(rehearsed.diagnostics)).toEqual(
        []
      )
      const file = (rehearsed.data as ApplyData).report!
      const path = join(dirname(dir), file)
      const valid = await readFile(path, "utf8")
      const report = await reportAt(dir, file)
      expect(report.rows).toEqual([
        { schema: "app", table: "items", rows: 1 },
        { schema: "app", table: "item_lines", rows: 1 },
      ])

      const stale = async (content: string, reason: string): Promise<void> => {
        await writeFile(path, content)
        const r = await apply(dir, url, data)
        expect(r.diagnostics.map((d) => [d.code, d.params?.reason])).toEqual([
          ["apply.rehearsal-stale", reason],
        ])
        await unchanged()
      }
      await stale(
        JSON.stringify({ ...report, planHash: "f".repeat(64) }),
        "plan"
      )
      await stale(JSON.stringify({ ...report, format: 2 }), "format")
      // Файл переписано, `planHash` той самий (аудит Codex, блокер)
      await stale(JSON.stringify({ ...report, rows: [] }), "tables")
      await writeFile(path, "{")
      const broken = await apply(dir, url, data)
      expect(broken.refusal?.reason).toBe("refused")
      await unchanged()

      // На цілі після репетиції з'явився ще рядок: копія менша
      await writeFile(path, valid)
      await query(
        url,
        `insert into app.items (id, title, code, group_id, legacy)
           values ('${uuid(9404)}', 'second', 'c-2', '${GROUP_ROW}', 'old')`
      )
      const r = await apply(dir, url, data)
      expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
      expect(r.diagnostics.map((d) => [d.code, d.params])).toContainEqual([
        "apply.rehearsal-fewer-rows",
        { table: "app.items", copy: 1, target: 2 },
      ])
      expect((r.data as ApplyData).status).toBe("committed")
    })
  })

  it("needs access: for a table read through the API", async () => {
    await inTarget(EMPTY, scope, async (url) => {
      const dir = await promoted(url, { read: true })
      const data = await planned(dir, url)
      const token = "access:app.item"
      expect(data.requiredPermissions).toContain(token)
      expect(data.promotion!.permissionItems.map((i) => i.token)).toContain(
        token
      )

      const without = await apply(dir, url, data, {
        rehearse: true,
        allow: data.requiredPermissions.filter((p) => p !== token),
      })
      expect(errors(without)).toEqual(["apply.permission-required"])

      const r = await apply(dir, url, data, { rehearse: true })
      expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
      expect((r.data as ApplyData).status).toBe("rolledBack")
    })
  })

  it("stops a too-long title on rehearsal", async () => {
    // Review Focus 4: значення, довше за `varchar(150)` опису виду
    const long = "x".repeat(151)
    await inTarget(EMPTY, scope, async (url) => {
      const dir = await promoted(url, { title: long })
      const data = await planned(dir, url)
      const [retype] = stepMatching(data, /TYPE character varying\(150\)/)
      const before = await state(url)
      const r = await apply(dir, url, data, { rehearse: true })
      expect(errors(r)).toEqual(["apply.type-narrowing"])
      expect(r.diagnostics[0]!.params).toMatchObject({
        step: retype!.id,
        table: "app.item",
        column: "description",
      })
      expect(await state(url)).toEqual(before)
      expect(before.items).toEqual([expect.objectContaining({ title: long })])
    })
  })

  describe("deliberate type conversion", () => {
    // Реквізит `legacy` (text) стає jsonb, `code` (text) — varchar(20): обидві
    // зміни переписують значення, тож без кроку даних їх зупиняє сторож
    // звуження, а ремонт у кроці даних записує приведене до кроку двигуна
    const JSON_TEXT = '{"a":1}'
    const LONG_CODE = "c".repeat(25)
    const asJson = {
      legacy: { to: "attribute", element: { name: "legacy", type: "Json" } },
    } as const
    const asVarchar = {
      code: {
        to: "attribute",
        element: { name: "code", unique: true, type: "String", length: 20 },
      },
    } as const
    const repairJson: PromoteInput["fill"] = [
      {
        target: { to: "attribute", name: "legacy" },
        expression: "legacy::jsonb",
      },
    ]
    const repairCode: PromoteInput["fill"] = [
      {
        target: { to: "attribute", name: "code" },
        expression: "left(code, 20)",
      },
    ]

    /** Ціль із даними до промоції, у яких `legacy` і `code` треба переписати. */
    async function converted(
      url: string,
      o: MappingOptions
    ): Promise<{ dir: string; data: PlanData }> {
      const dir = await promoted(url, o)
      await query(
        url,
        `update app.items set legacy = '${JSON_TEXT}', code = '${LONG_CODE}'`
      )
      return { dir, data: await planned(dir, url) }
    }

    it("refuses a normalizing type change without a data step", async () => {
      await inTarget(EMPTY, scope, async (url) => {
        const { dir, data } = await converted(url, { columns: asJson })
        const before = await state(url)
        const r = await apply(dir, url, data, { rehearse: true })
        expect(errors(r)).toEqual(["apply.type-narrowing"])
        expect(r.diagnostics[0]!.params).toMatchObject({
          table: "app.item",
          column: "legacy",
        })
        expect(await state(url)).toEqual(before)
      })
    })

    it("rehearses a normalizing type change through a repair", async () => {
      // Review Focus 5: ремонт пише нормалізований текст до кроку двигуна
      await inTarget(EMPTY, scope, async (url) => {
        const { dir, data } = await converted(url, {
          columns: asJson,
          fill: repairJson,
        })
        expect(data.requiredPermissions).toContain("repair:app.item")
        // `planPromotion` не експортується: кроки даних перевіряємо крізь
        // артефакт плану на диску — блок для людини має нести ті самі кроки
        expect(data.promotion!.data).not.toEqual([])
        const artifact = JSON.parse(
          await readFile(join(dirname(dir), data.file), "utf8")
        ) as { promotion: { data: unknown } }
        expect(data.promotion!.data).toEqual(artifact.promotion.data)
        const before = await state(url)
        const r = await apply(dir, url, data, { rehearse: true })
        expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
        expect((r.data as ApplyData).status).toBe("rolledBack")
        expect(await state(url)).toEqual(before)
      })
    })

    it("commits the promotion with a valid rehearsal report", async () => {
      // Репетиція пише звіт файлом, `apply` читає його й комітить; доказ
      // промоції (дані, збереження, plpgsql_check) проходить справжній файл
      await inTarget(EMPTY, scope, async (url) => {
        const { dir, data } = await converted(url, {
          columns: asJson,
          fill: repairJson,
        })
        const rehearsed = await apply(dir, url, data, { rehearse: true })
        expect(
          errors(rehearsed),
          JSON.stringify(rehearsed.diagnostics)
        ).toEqual([])
        const file = (rehearsed.data as ApplyData).report!
        const report = await reportAt(dir, file)
        expect(report.planHash).toBe(data.planHash)
        expect(report.data).toEqual([
          { schema: "app", table: "items", computed: 1, written: 1 },
        ])
        expect(report.preservation).toEqual([
          { schema: "app", table: "items", rows: 1 },
          { schema: "app", table: "item_lines", rows: 1 },
        ])
        // Перевірка тіл не пропущена; помилки функцій провайдера — ті самі
        // до кроків і після
        if (report.plpgsqlCheck === "skipped")
          throw new Error("a promotion rehearsal must check plpgsql bodies")
        expect(report.plpgsqlCheck.after).toEqual(report.plpgsqlCheck.baseline)
        expect(report.durations.longestStatementMs).toBeGreaterThan(0)

        const r = await apply(dir, url, data)
        expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
        expect((r.data as ApplyData).status).toBe("committed")
        expect(
          await query(url, "select id, legacy from app.item order by id")
        ).toEqual([{ id: ITEM_ROW, legacy: { a: 1 } }])
        // Хеш звіту — в рядку ledger цього застосування
        const last = (await ledger(url)).at(-1)!
        expect(last.promotion).not.toBeNull()
        expect(last.rehearsal_hash).toBe(await rehearsalHash(report))
      })
    })

    it("rehearses a truncating repair", async () => {
      await inTarget(EMPTY, scope, async (url) => {
        const without = await converted(url, { columns: asVarchar })
        const refused = await apply(without.dir, url, without.data, {
          rehearse: true,
        })
        expect(errors(refused)).toEqual(["apply.type-narrowing"])
      })
      await inTarget(EMPTY, scope, async (url) => {
        const { dir, data } = await converted(url, {
          columns: asVarchar,
          fill: repairCode,
        })
        const r = await apply(dir, url, data, { rehearse: true })
        expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
        expect((r.data as ApplyData).status).toBe("rolledBack")
      })
    })

    it("refuses a repair without its permission", async () => {
      await inTarget(EMPTY, scope, async (url) => {
        const { dir, data } = await converted(url, {
          columns: asJson,
          fill: repairJson,
        })
        const token = "repair:app.item"
        const r = await apply(dir, url, data, {
          rehearse: true,
          allow: data.requiredPermissions.filter((p) => p !== token),
        })
        expect(errors(r)).toEqual(["apply.permission-required"])
        expect(JSON.stringify(r.diagnostics[0]!.params)).toContain(token)
      })
    })
  })

  it("swaps two attribute columns by identity", async () => {
    // Review Focus 2: `code` → `legacy`, `legacy` → `code`; доказ збереження
    // в транзакції репетиції порівнює значення за ідентичністю колонок
    await inTarget(EMPTY, scope, async (url) => {
      const dir = await promoted(url, { swap: true })
      const data = await planned(dir, url)
      const itemTable = { schema: "app", name: "item" }
      const swapped = data.promotion!.columns.filter(
        (c) => !["title", "is_deleted", "item_id"].includes(c.from)
      )
      // Через тимчасове ім'я: жодне перейменування не займає ще зайнятого
      expect(swapped).toHaveLength(3)
      const [away, first, second] = swapped
      expect(away).toMatchObject({ table: itemTable, from: "code" })
      expect(away!.to).toMatch(/^simetra_tmp_\d+$/)
      expect(first).toEqual({ table: itemTable, from: "legacy", to: "code" })
      expect(second).toEqual({ table: itemTable, from: away!.to, to: "legacy" })
      expect(stepMatching(data, /DROP COLUMN/)).toEqual([])

      const before = await state(url)
      const r = await apply(dir, url, data, { rehearse: true })
      expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
      expect((r.data as ApplyData).status).toBe("rolledBack")
      expect(await state(url)).toEqual(before)
    })
  })

  it("does not block a fresh environment with a record file", async () => {
    // Review Focus 5: нова ціль без marker і таблиць, а запис лежить у репо
    await inTarget(EMPTY, scope, async (url) => {
      const dir = await projectWith(beforeEntries())
      const promote = await call("promote", mapping(), options(dir, url))
      expect(errors(promote)).toEqual([])
      expect(promote.artifacts).toEqual([RECORD_FILE])

      const r = await call("plan", {}, options(dir, url))
      expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
      expect(codes(r)).toContain("plan.promotion-not-applicable")
      const data = r.data as PlanData
      expect(data.promotion).toBeNull()
      expect(intentSteps(data)).toEqual([])
    })
  })
})
