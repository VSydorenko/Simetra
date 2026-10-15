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
import { promoteInput, type PromoteInput } from "simetra/compiler"
import {
  parseRehearsal,
  rehearsalHash,
  type EngineScope,
  type RehearsalReport,
} from "simetra/schema"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { databaseResource } from "../io/database"
import { createPgDeltaEngine } from "../schema-engine"
import type { ApplyData, PlanData } from "../tools/apply-tools"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { InvokeOptions, ToolResult } from "../tools/types"
import {
  acceptDebt,
  metaFiles,
  project as projectFile,
  SHADOW_PREFIX,
  shadowDatabaseCount,
  testDatabaseUrl,
  testSuperuserUrl,
  uuid,
} from "../../../simetra/test/support"

/**
 * Повний цикл промоції з кроком даних інструментами (план П3-2b-3, задача
 * 5): `promote` → `plan` → репетиція на копії цілі з даними → `apply` з
 * `COMMIT` → повторний `plan` нічого не планує. Копія — окрема база
 * `CREATE DATABASE … TEMPLATE <ціль>`: ті самі факти сервера, голова ledger і
 * власники, тож раннер приймає її за копію цієї цілі. Проєкт синтетичний.
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
  // Копія має префікс тіней — лічильник ловить і її
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

/** Ціль — окрема база від `withDesiredShadow`; її прибирає порт. */
async function inTarget(fn: (url: string) => Promise<void>): Promise<void> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    "select 1;",
    scope,
    (target) => fn(target.url)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
}

/**
 * Копія цілі з даними. Ім'я — за конвенцією тіней (`pgdelta_shadow_<мс у
 * base36>_…`): сирота вбитого прогону потрапить у звіт сторожа стеку з
 * віком. `TEMPLATE` вимагає, щоб до цілі не було з'єднань: інструменти
 * закривають свої пули по виклику, а `query` — клієнт по запиту. Прибирання
 * — у `finally`, зокрема на шляху падіння.
 */
async function withCopy(
  target: string,
  fn: (url: string) => Promise<void>
): Promise<void> {
  const name = `${SHADOW_PREFIX}${Date.now().toString(36)}_copy_${Math.random().toString(36).slice(2, 8)}`
  const source = new URL(target).pathname.slice(1)
  await query(
    testSuperuserUrl(),
    `create database ${name} owner postgres template ${source}`
  )
  try {
    const at = new URL(testDatabaseUrl())
    at.pathname = `/${name}`
    await fn(at.toString())
  } finally {
    await query(
      testSuperuserUrl(),
      `drop database if exists ${name} with (force)`
    )
  }
}

const MEMBER_ID = uuid(9501)
const MEMBER_FILE = "custom-tables/Member/Member.meta.json"
const ROWS = 500

/**
 * Прийнята таблиця `app.members` без грантів ролям API: статичний гейт
 * доступу 2a промоцію пропускає без пункту `access:`.
 */
function member() {
  const column = (n: number, name: string, rest: Record<string, unknown>) => ({
    id: uuid(n),
    name,
    physicalName: name,
    ...rest,
  })
  return {
    id: MEMBER_ID,
    kind: "CustomTable",
    name: "Member",
    physicalName: "members",
    kindLabel: "member",
    schema: "app",
    columns: [
      column(9502, "id", { type: "UUID", notNull: true }),
      column(9503, "name", { type: "Text", notNull: true }),
      column(9504, "inactive", { type: "Boolean" }),
    ],
    primaryKey: { name: "members_pkey", columns: ["id"] },
    rowLevelSecurity: "enabled",
  }
}

/**
 * Довідник без коду; `inactive` знімається, а позначку видалення заповнює
 * крок даних зі старої колонки — до перейменувань, у старих іменах.
 */
const mapping = (): PromoteInput =>
  promoteInput.parse({
    target: { name: "Member" },
    into: { kind: "Catalog", name: "Member", data: { codeLength: 0 } },
    columns: {
      id: { to: "standard", name: "ref" },
      name: { to: "standard", name: "description" },
      inactive: { to: "retire" },
    },
    fill: [
      {
        target: { to: "standard", name: "deletionMark" },
        expression: "coalesce(inactive, false)",
      },
    ],
  })

/**
 * 500 рядків: кожен третій `inactive = true`, з решти кожен п'ятий — `NULL`
 * (його крок даних має перетворити на `false`), інші — `false`. Ключі
 * детерміновані.
 */
const SEED = `
  insert into app.members (id, name, inactive)
  select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
         'member ' || i,
         case when i % 3 = 0 then true when i % 5 = 0 then null else false end
  from generate_series(1, ${ROWS}) as i;`

async function projectWith(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-promotion-commit-"))
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  disposers.push(() => rm(root, { recursive: true }))
  const dir = join(root, "metadata")
  const files = await acceptDebt(
    metaFiles({
      "project.meta.json": projectFile({ defaultSchema: "app" }),
      [MEMBER_FILE]: member(),
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

const apply = (
  dir: string,
  url: string,
  data: PlanData,
  o: { rehearse?: boolean } = {}
): Promise<ToolResult> =>
  call(
    "apply",
    {
      plan: data.file,
      planHash: data.planHash,
      allow: data.requiredPermissions,
      ...(o.rehearse === true ? { rehearse: true } : {}),
    },
    options(dir, url)
  )

/**
 * Стан до промоції застосовано з `COMMIT`, засіяно, потім `promote`: тека
 * метаданих уже після промоції, запис — у `plans/`, план промоції побудовано.
 */
async function promoted(url: string): Promise<{ dir: string; data: PlanData }> {
  const dir = await projectWith()
  const before = await planned(dir, url)
  expect(before.promotion).toBeNull()
  const committed = await apply(dir, url, before)
  expect(committed.diagnostics, JSON.stringify(committed.diagnostics)).toEqual(
    []
  )
  await query(url, SEED)
  const r = await call("promote", mapping(), options(dir, url))
  expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
  expect(r.written).toBe(true)
  return { dir, data: await planned(dir, url) }
}

/** Таблиці схеми `app`, рядки `members` і ledger — те, що не має змінитися. */
async function state(url: string) {
  return {
    tables: await query(
      url,
      "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where nspname = 'app' and relkind = 'r' order by relname"
    ),
    members: await query(
      url,
      "select count(*)::int as rows, count(*) filter (where inactive)::int as inactive from app.members"
    ),
    ledger: await ledger(url),
  }
}

const ledger = (url: string) =>
  query<{ promotion: unknown; rehearsal_hash: string | null }>(
    url,
    "select promotion, rehearsal_hash from simetra.ledger order by id"
  )

/** Звіт репетиції з `plans/`, розібраний строго. */
async function reportAt(dir: string, file: string): Promise<RehearsalReport> {
  const parsed = parseRehearsal(
    await readFile(join(dirname(dir), file), "utf8")
  )
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.report
}

/** Кожен третій із 500 — `true`. */
const INACTIVE = Math.floor(ROWS / 3)

describe("promotion commit", () => {
  it("promotes, rehearses on a copy with data, commits and plans nothing", async () => {
    await inTarget(async (url) => {
      const { dir, data } = await promoted(url)
      expect(
        await query(
          url,
          "select count(*) filter (where inactive)::int as t, count(*) filter (where inactive is null)::int as n from app.members"
        )
      ).toEqual([{ t: INACTIVE, n: 67 }])

      // План промоції з одним кроком даних; попередження про відкладений
      // COMMIT більше немає
      const promotion = data.promotion!
      expect(promotion.tables).toEqual([
        { schema: "app", from: "members", to: "member" },
      ])
      expect(promotion.data).toHaveLength(1)
      expect(promotion.data[0]).toMatchObject({
        before: { schema: "app", table: "members" },
        after: { schema: "app", table: "member" },
        columns: [
          {
            column: "deletion_mark",
            expression: "coalesce(inactive, false)",
          },
        ],
      })
      const plan = await call("plan", {}, options(dir, url))
      expect(codes(plan)).not.toContain("plan.promotion-commit-pending")

      // Репетиція на копії з даними: відкат, звіт записано, рядки — усі 500
      let file = ""
      await withCopy(url, async (copy) => {
        const r = await apply(dir, copy, data, { rehearse: true })
        expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
        expect((r.data as ApplyData).status).toBe("rolledBack")
        file = (r.data as ApplyData).report!
        expect(file).toMatch(/\.rehearsal\.json$/)
      })
      const report = await reportAt(dir, file)
      expect(report.planHash).toBe(data.planHash)
      expect(report.rows).toEqual([
        { schema: "app", table: "members", rows: ROWS },
      ])

      // Застосування з COMMIT: позначка — рівно там, де `inactive = true`
      const r = await apply(dir, url, data)
      expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
      expect(codes(r)).not.toContain("apply.rehearsal-fewer-rows")
      expect((r.data as ApplyData).status).toBe("committed")
      expect(
        await query(
          url,
          "select count(*)::int as rows, count(*) filter (where deletion_mark)::int as marked, count(*) filter (where deletion_mark is null)::int as nulls from app.member"
        )
      ).toEqual([{ rows: ROWS, marked: INACTIVE, nulls: 0 }])
      const last = (await ledger(url)).at(-1)!
      expect(last.promotion).not.toBeNull()
      expect(last.rehearsal_hash).toBe(await rehearsalHash(report))

      // Повторний план: нічого застосовувати
      const again = await call("plan", {}, options(dir, url))
      expect(again.ok, JSON.stringify(again.diagnostics)).toBe(true)
      expect(errors(again)).toEqual([])
      expect(again.data).toBeUndefined()
      expect(again.artifacts).toEqual([])
    })
  })

  it("refuses to commit without a rehearsal report", async () => {
    await inTarget(async (url) => {
      const { dir, data } = await promoted(url)
      const before = await state(url)
      const r = await apply(dir, url, data)
      expect(errors(r)).toEqual(["apply.rehearsal-required"])
      expect(r.data).toBeUndefined()
      expect(await state(url)).toEqual(before)
    })
  })

  it("refuses to commit after a rehearsal on an emptied copy", async () => {
    // Копія без рядків: репетиція проходить і пише звіт з `rows: 0`, але про
    // дані цілі вона нічого не довела — фаза 6c відмовляє в транзакції
    await inTarget(async (url) => {
      const { dir, data } = await promoted(url)
      let file = ""
      await withCopy(url, async (copy) => {
        await query(copy, "delete from app.members")
        const r = await apply(dir, copy, data, { rehearse: true })
        expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
        expect((r.data as ApplyData).status).toBe("rolledBack")
        file = (r.data as ApplyData).report!
      })
      expect((await reportAt(dir, file)).rows).toEqual([
        { schema: "app", table: "members", rows: 0 },
      ])

      const before = await state(url)
      expect(before.members).toEqual([{ rows: ROWS, inactive: INACTIVE }])
      const r = await apply(dir, url, data)
      expect(r.diagnostics.map((d) => [d.code, d.params])).toEqual([
        ["apply.rehearsal-copy-empty", { table: "app.members" }],
      ])
      expect(await state(url)).toEqual(before)
    })
  })
})
