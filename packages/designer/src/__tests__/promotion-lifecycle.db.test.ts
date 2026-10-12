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
import pg from "pg"
import {
  promoteInput,
  promotionRecordHash,
  promotionRecordSchema,
  type PromoteInput,
} from "simetra/compiler"
import type { EngineScope } from "simetra/schema"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { databaseResource } from "../io/database"
import { renderPlan } from "../io/report"
import { createPgDeltaEngine } from "../schema-engine"
import type { ApplyData, PlanData } from "../tools/apply-tools"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { InvokeOptions, ToolResult } from "../tools/types"
import {
  acceptDebt,
  catalog,
  metaFiles,
  project as projectFile,
  shadowDatabaseCount,
  testDatabaseUrl,
  uuid,
} from "../../../simetra/test/support"

/**
 * Наскрізний цикл промоції інструментами (план П3-2a, задача 13): стан до
 * промоції застосовано з даними, `promote` пише запис у `plans/`, `plan`
 * читає його й будує план промоції, а `apply` репетирує його на цілі й
 * відкочує. Застосування з `COMMIT` до П3-2b — відмова. Фікстура синтетична.
 * Ціль кожного тесту — окрема база від `withDesiredShadow`; база стеку лише
 * читається.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const SIMETRA = resolve(__dirname, "../../../simetra")
const ENV = "SIMETRA_DATABASE_URL"
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

let shadowsBefore = 0
const disposers: (() => Promise<void>)[] = []
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((d) => d()))
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

async function query<R extends Record<string, unknown>>(
  url: string,
  sql: string
): Promise<R[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<R>(sql)).rows
  } finally {
    await client.end()
  }
}

/** Ціль із `setup`; базу прибирає порт. */
async function inTarget(
  setup: string,
  fn: (url: string) => Promise<void>
): Promise<void> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    setup,
    scope,
    (target) => fn(target.url)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
}

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
          columns: ["ref"],
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
 * читання — дослівний модуль таблиці, який вид замінює своїм доступом.
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

/** Мапінг у довідник без коду й ієрархії, без кроку `fill`. */
function mapping(o: { read?: boolean; swap?: boolean } = {}): PromoteInput {
  return promoteInput.parse({
    target: { name: "Item" },
    into: { kind: "Catalog", name: "Item", data: { codeLength: 0 } },
    columns: {
      id: { to: "standard", name: "ref" },
      title: { to: "standard", name: "description" },
      isDeleted: { to: "standard", name: "deletionMark" },
      // Обмін: колонка `code` стає реквізитом `legacy` і навпаки
      code: { to: "attribute", element: { name: o.swap ? "legacy" : "code" } },
      groupId: { to: "attribute", element: { name: "group" } },
      legacy: o.swap
        ? { to: "attribute", element: { name: "code" } }
        : { to: "retire" },
    },
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
      "Item#indexes/items_title_idx": "property",
      ...(o.read === true
        ? { [READ_UNITS.policy]: "platform", [READ_UNITS.grant]: "platform" }
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
  o: { read?: boolean; swap?: boolean; title?: string; onDelete?: string } = {}
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

describe("promotion lifecycle", () => {
  it("promote → plan → rehearse on the target → rolled back", async () => {
    await inTarget(EMPTY, async (url) => {
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
        implicitLocks: [],
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
      expect(promotion.permissionItems).toEqual([
        {
          token: "delete:app.item.item_group_id_fkey",
          summary: ["own (group_id) → groups: on delete restrict → noAction"],
        },
      ])
      expect(data.requiredPermissions[0]).toBe(
        "delete:app.item.item_group_id_fkey"
      )

      // Клас конверсії — біля кроку видалення, який він покриває
      const conversion = (pattern: RegExp) =>
        stepMatching(data, pattern).map((s) => s.conversion)
      expect(conversion(/^COMMENT ON TABLE/)).toEqual(["metadata"])
      expect(conversion(/DROP INDEX "app"."items_title_idx"/)).toEqual([
        "property",
      ])
      expect(conversion(/DROP CONSTRAINT "items_code_key"/)).toEqual([
        "property",
      ])
      expect(conversion(/DROP COLUMN "legacy"/)).toEqual([undefined])
      expect(stepMatching(data, /TYPE character varying\(150\)/)).toHaveLength(
        1
      )

      // Текст: блок промоції — між дрейфом і кроками
      const text = renderPlan(data, "", { ok: true, written: true, dry: false })
      const block = text.indexOf(`promotion: Catalog Item (${ITEM_ID})`)
      expect(block).toBeGreaterThan(text.indexOf(`planHash: ${data.planHash}`))
      expect(text.indexOf("steps (")).toBeGreaterThan(block)
      expect(text).toContain("  table app.items -> app.item\n")
      expect(text).toContain("  constraint app.item: items_pkey -> item_pkey\n")
      expect(text).toContain(
        "  delete:app.item.item_group_id_fkey (needs allow: delete:app.item.item_group_id_fkey)\n    own (group_id) → groups: on delete restrict → noAction\n"
      )

      // Репетиція на цілі з усіма пунктами: відкат, імена й дані ті самі
      const before = await state(url)
      const r = await apply(dir, url, data, { rehearse: true })
      expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
      expect((r.data as ApplyData).status).toBe("rolledBack")
      expect(await state(url)).toEqual(before)
      expect(before.items).toEqual([
        expect.objectContaining({ id: ITEM_ROW, title: "first", code: "c-1" }),
      ])
    })
  })

  it("renames the foreign key to Group when its delete action is the kind's", async () => {
    await inTarget(EMPTY, async (url) => {
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
      expect(data.promotion!.permissionItems).toEqual([])
    })
  })

  it("refuses to commit the promotion in this plan", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await promoted(url)
      const data = await planned(dir, url)
      const before = await state(url)
      const r = await apply(dir, url, data)
      expect(errors(r)).toEqual(["apply.promotion-checks-pending"])
      expect(r.data).toBeUndefined()
      expect(await state(url)).toEqual(before)
    })
  })

  it("needs access: for a table read through the API", async () => {
    await inTarget(EMPTY, async (url) => {
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
    await inTarget(EMPTY, async (url) => {
      const dir = await promoted(url, { title: long })
      const data = await planned(dir, url)
      const [retype] = stepMatching(data, /TYPE character varying\(150\)/)
      const before = await state(url)
      const r = await apply(dir, url, data, { rehearse: true })
      expect(errors(r)).toEqual(["apply.type-narrowing"])
      expect(r.diagnostics[0]!.params).toMatchObject({ step: retype!.id })
      expect(await state(url)).toEqual(before)
      expect(before.items).toEqual([expect.objectContaining({ title: long })])
    })
  })

  it("swaps two attribute columns by identity", async () => {
    // Review Focus 2: `code` → `legacy`, `legacy` → `code`; доказ збереження
    // в транзакції репетиції порівнює значення за ідентичністю колонок
    await inTarget(EMPTY, async (url) => {
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
    await inTarget(EMPTY, async (url) => {
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
