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
import { promoteInput, type PromoteInput } from "simetra/compiler"
import {
  parseRehearsal,
  type EngineScope,
  type RehearsalReport,
} from "simetra/schema"
import { afterEach, expect } from "vitest"
import { databaseResource } from "../io/database"
import type { PlanData } from "../tools/apply-tools"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { InvokeOptions, ToolResult } from "../tools/types"
import {
  acceptDebt,
  metaFiles,
  project as projectFile,
  testProvider,
  uuid,
} from "../../../simetra/test/support"
import { query } from "./support/db"

/**
 * Спільна підготовка тестів повного циклу промоції (`promotion-commit.db.test.ts`
 * та його профільного напарника): проєкт, виклики інструментів, фікстури
 * довідника й тригерів.
 */

export const SIMETRA = resolve(__dirname, "../../../simetra")
export const ENV = "SIMETRA_DATABASE_URL"
export const scope: EngineScope = { schemas: ["app"], provider: testProvider() }

const disposers: (() => Promise<void>)[] = []

/** Прибирання тек проєктів після тесту; кличеться на верхньому рівні файлу. */
export function usePromotionCleanup(): void {
  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((d) => d()))
  })
}

/** Порожня ціль: лише базовий стан провайдера. */
export const EMPTY = "select 1;"

/**
 * Пункт `CREATE DATABASE` копії цілі з даними для спільного `withCopy`.
 * `TEMPLATE` вимагає, щоб до цілі не було з'єднань: інструменти закривають
 * свої пули по виклику, а `query` — клієнт по запиту.
 */
export const templateOf = (url: string): string =>
  `template "${new URL(url).pathname.slice(1)}"`

export const MEMBER_ID = uuid(9501)
export const MEMBER_FILE = "custom-tables/Member/Member.meta.json"
export const ROWS = 500

/**
 * Прийнята таблиця `app.members` без грантів ролям API: статичний гейт
 * доступу 2a промоцію пропускає без пункту `access:`.
 */
export function member() {
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
export const mapping = (): PromoteInput =>
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
export const SEED = `
  insert into app.members (id, name, inactive)
  select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
         'member ' || i,
         case when i % 3 = 0 then true when i % 5 = 0 then null else false end
  from generate_series(1, ${ROWS}) as i;`

export async function projectWith(
  o: { member?: unknown; files?: Record<string, string> } = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-promotion-commit-"))
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  disposers.push(() => rm(root, { recursive: true }))
  const dir = join(root, "metadata")
  const files = await acceptDebt(
    metaFiles({
      "project.meta.json": projectFile({
        defaultSchema: "app",
        database: { provider: testProvider() },
      }),
      [MEMBER_FILE]: o.member ?? member(),
      ...o.files,
    })
  )
  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

export const options = (dir: string, url: string): InvokeOptions => ({
  dir,
  readOnly: false,
  allowDatabaseWrite: true,
  dryRun: false,
  confirmed: true,
  channel: "cli",
  database: databaseResource({ [ENV]: url }, { url: ENV }),
})

export const call = (
  name: "plan" | "apply" | "promote",
  input: unknown,
  o: InvokeOptions
): Promise<ToolResult> => invoke(toolByName(name)!, input, o)

export const codes = (r: ToolResult) => r.diagnostics.map((d) => d.code)
export const errors = (r: ToolResult) =>
  r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)

export async function planned(dir: string, url: string): Promise<PlanData> {
  const r = await call("plan", {}, options(dir, url))
  expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
  expect(r.written).toBe(true)
  return r.data as PlanData
}

export const apply = (
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
export async function promoted(
  url: string,
  o: {
    member?: unknown
    files?: Record<string, string>
    seed?: string
    mapping?: PromoteInput
  } = {}
): Promise<{ dir: string; data: PlanData }> {
  const dir = await projectWith(o)
  const before = await planned(dir, url)
  expect(before.promotion).toBeNull()
  const committed = await apply(dir, url, before)
  expect(committed.diagnostics, JSON.stringify(committed.diagnostics)).toEqual(
    []
  )
  await query(url, o.seed ?? SEED)
  const r = await call("promote", o.mapping ?? mapping(), options(dir, url))
  expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
  expect(r.written).toBe(true)
  return { dir, data: await planned(dir, url) }
}

/** Таблиці схеми `app`, рядки `members` і ledger — те, що не має змінитися. */
export async function state(url: string) {
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

export const ledger = (url: string) =>
  query<{ promotion: unknown; rehearsal_hash: string | null }>(
    url,
    "select promotion, rehearsal_hash from simetra.ledger order by id"
  )

/** Звіт репетиції з `plans/`, розібраний строго. */
export async function reportAt(
  dir: string,
  file: string
): Promise<RehearsalReport> {
  const parsed = parseRehearsal(
    await readFile(join(dirname(dir), file), "utf8")
  )
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.report
}

/** Кожен третій із 500 — `true`. */
export const INACTIVE = Math.floor(ROWS / 3)

/** Прийнятий тригер `UPDATE OF` на `app.member`. */
export const AUDIT = "members_audit"

/** Обробник у закритій оболонці: його кличе і прийнятий тригер, і підписка. */
export const AUDIT_HANDLER = `CREATE FUNCTION app.audit_member() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
BEGIN
  RETURN NEW;
END $$;
`

/**
 * `app.member` з тригером `INSERT OR UPDATE OF rank`: промоція в довідник з
 * кодом, чию нумерацію платформа ще не генерує, а тригер — клас `platform`,
 * його замінює підписка з `whenChanged` (спека промоції §8, §9.2). `type` —
 * тип колонки `rank`: умову над `varchar` тінь друкує з `::text`.
 */
export const audited = (type: Record<string, unknown>) => ({
  // Таблиця вже в імені довідника: нумерацію про неї план каже лише тому, що
  // її переводить промоція, а не тому, що таблиці в цілі немає
  member: {
    ...member(),
    physicalName: "member",
    columns: [
      ...member().columns,
      { id: uuid(9506), name: "rank", physicalName: "rank", ...type },
    ],
  },
  files: {
    "sql/app/handlers.sql": AUDIT_HANDLER,
    "custom-tables/Member/Member.sql": `CREATE TRIGGER ${AUDIT} BEFORE INSERT OR UPDATE OF rank ON app.member FOR EACH ROW EXECUTE FUNCTION app.audit_member();\n`,
  },
  mapping: () => {
    const m = mapping()
    return promoteInput.parse({
      ...m,
      into: { kind: "Catalog", name: "Member", data: { codeLength: 9 } },
      // Реквізит з іншим ім'ям: колонка `UPDATE OF` перейменовується
      columns: {
        ...m.columns,
        rank: { to: "attribute", element: { name: "priority" } },
      },
      conversions: {
        ...m.conversions,
        [`trigger:app.member.${AUDIT}`]: "platform",
      },
    })
  },
  /** Підписка, що замінює прийнятий тригер; пишеться після `promote`. */
  subscription: {
    id: uuid(9511),
    kind: "EventSubscription",
    name: "AuditMember",
    physicalName: "member_audit",
    sources: [{ kind: "Catalog", name: "Member" }],
    event: "beforeWrite",
    whenChanged: ["priority"],
    handler: { schema: "app", name: "audit_member" },
  },
})

/** Тригери таблиці без внутрішніх (FK) і їхній стан увімкнення. */
export const triggersOf = (url: string, table: string) =>
  query<{ name: string; enabled: string }>(
    url,
    `select tgname as name, tgenabled as enabled from pg_trigger where tgrelid = '${table}'::regclass and not tgisinternal order by tgname`
  )
