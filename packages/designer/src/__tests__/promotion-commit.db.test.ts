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
  rehearsalHash,
  type EngineScope,
  type RehearsalReport,
} from "simetra/schema"
import { afterEach, describe, expect, it } from "vitest"
import { databaseResource } from "../io/database"
import type { ApplyData, PlanData } from "../tools/apply-tools"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { InvokeOptions, ToolResult } from "../tools/types"
import {
  acceptDebt,
  metaFiles,
  project as projectFile,
  uuid,
} from "../../../simetra/test/support"
import { inTarget, query, withCopy } from "./support/db"

/**
 * Повний цикл промоції з кроком даних інструментами (план П3-2b-3, задача
 * 5): `promote` → `plan` → репетиція на копії цілі з даними → `apply` з
 * `COMMIT` → повторний `plan` нічого не планує. Копія — окрема база
 * `CREATE DATABASE … TEMPLATE <ціль>`: ті самі факти сервера, голова ledger і
 * власники, тож раннер приймає її за копію цієї цілі. Проєкт синтетичний.
 */

const SIMETRA = resolve(__dirname, "../../../simetra")
const ENV = "SIMETRA_DATABASE_URL"
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((d) => d()))
})

/** Порожня ціль: лише базовий стан провайдера. */
const EMPTY = "select 1;"

/**
 * Пункт `CREATE DATABASE` копії цілі з даними для спільного `withCopy`.
 * `TEMPLATE` вимагає, щоб до цілі не було з'єднань: інструменти закривають
 * свої пули по виклику, а `query` — клієнт по запиту.
 */
const templateOf = (url: string): string =>
  `template "${new URL(url).pathname.slice(1)}"`

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

async function projectWith(
  o: { member?: unknown; files?: Record<string, string> } = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-promotion-commit-"))
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  disposers.push(() => rm(root, { recursive: true }))
  const dir = join(root, "metadata")
  const files = await acceptDebt(
    metaFiles({
      "project.meta.json": projectFile({ defaultSchema: "app" }),
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
async function promoted(
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

/** Розширення `moddatetime`: у цілі — до плану, у проєкті — та сама одиниця. */
const MODDATETIME =
  "CREATE EXTENSION IF NOT EXISTS moddatetime WITH SCHEMA extensions;\n"

/** Прийнятий тригер службової дати на `app.members`. */
const STAMP = "members_stamp"

/** `app.members` з колонкою службової дати й тригером `moddatetime`. */
const stamped = {
  member: {
    ...member(),
    columns: [
      ...member().columns,
      {
        id: uuid(9505),
        name: "updatedAt",
        physicalName: "updated_at",
        type: "DateTime",
        notNull: true,
      },
    ],
  },
  files: {
    "sql/app/extensions.sql": MODDATETIME,
    "custom-tables/Member/Member.sql": `CREATE TRIGGER ${STAMP} BEFORE UPDATE ON app.members FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);\n`,
  },
  seed: `
  insert into app.members (id, name, inactive, updated_at)
  select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
         'member ' || i,
         case when i % 3 = 0 then true when i % 5 = 0 then null else false end,
         '2000-01-01T00:00:00Z'
  from generate_series(1, ${ROWS}) as i;`,
  // Службова дата стає стандартною `updatedAt`, тригер — класом `platform`:
  // його замінює механіка рядка (спека промоції §8)
  mapping: () => {
    const m = mapping()
    return promoteInput.parse({
      ...m,
      columns: {
        ...m.columns,
        updatedAt: { to: "standard", name: "updatedAt" },
      },
      conversions: {
        ...m.conversions,
        [`trigger:app.members.${STAMP}`]: "platform",
      },
    })
  },
}

/** Прийнятий тригер `UPDATE OF` на `app.member`. */
const AUDIT = "members_audit"

/** Обробник у закритій оболонці: його кличе і прийнятий тригер, і підписка. */
const AUDIT_HANDLER = `CREATE FUNCTION app.audit_member() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
BEGIN
  RETURN NEW;
END $$;
`

/**
 * `app.member` з тригером `INSERT OR UPDATE OF rank`: промоція в довідник з
 * кодом, чию нумерацію платформа ще не генерує, а тригер — клас `platform`,
 * його замінює підписка з `whenChanged` (рішення 6–7 плану П3-3a2). `type` —
 * тип колонки `rank`: умову над `varchar` тінь друкує з `::text`.
 */
const audited = (type: Record<string, unknown>) => ({
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
const triggersOf = (url: string, table: string) =>
  query<{ name: string; enabled: string }>(
    url,
    `select tgname as name, tgenabled as enabled from pg_trigger where tgrelid = '${table}'::regclass and not tgisinternal order by tgname`
  )

describe("promotion commit", () => {
  it("promotes, rehearses on a copy with data, commits and plans nothing", async () => {
    await inTarget(EMPTY, scope, async (url) => {
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
      await withCopy(templateOf(url), async (copy) => {
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
    await inTarget(EMPTY, scope, async (url) => {
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
    await inTarget(EMPTY, scope, async (url) => {
      const { dir, data } = await promoted(url)
      let file = ""
      await withCopy(templateOf(url), async (copy) => {
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

  it.each([
    ["an integer", { type: "Integer" }],
    ["a varchar", { type: "String", length: 20 }],
  ])(
    "warns of the UPDATE OF narrowing on %s column and the numbering in a promotion plan",
    async (_, type) => {
      const fixture = audited(type)
      await inTarget(EMPTY, scope, async (url) => {
        const dir = await projectWith(fixture)
        const committed = await apply(dir, url, await planned(dir, url))
        expect(
          errors(committed),
          JSON.stringify(committed.diagnostics)
        ).toEqual([])
        const promote = await call(
          "promote",
          fixture.mapping(),
          options(dir, url)
        )
        expect(errors(promote), JSON.stringify(promote.diagnostics)).toEqual([])
        // Підписку на довідник можна описати лише після промоції: до неї
        // довідника `Member` немає, а без неї прийнятому тригеру нема заміни
        const file = join(
          dir,
          "event-subscriptions/AuditMember/AuditMember.meta.json"
        )
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify(fixture.subscription))
        const r = await call("plan", {}, options(dir, url))
        expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
        expect((r.data as PlanData).promotion).not.toBeNull()
        // Колонка — у старому імені, як тригер і таблиця запису
        expect(
          r.diagnostics
            .filter((d) => d.severity === "warning")
            .filter((d) =>
              [
                "plan.update-of-narrowed",
                "plan.numbering-not-generated",
              ].includes(d.code)
            )
            .map((d) => [d.code, d.params])
        ).toEqual([
          [
            "plan.numbering-not-generated",
            { object: "Member", table: "app.member" },
          ],
          [
            "plan.update-of-narrowed",
            { trigger: AUDIT, table: "app.member", columns: "rank" },
          ],
        ])
      })
    }
  )

  it("replaces an adopted moddatetime trigger by the row mechanics", async () => {
    await inTarget(MODDATETIME, scope, async (url) => {
      const { dir, data } = await promoted(url, {
        ...stamped,
        mapping: stamped.mapping(),
      })
      expect(await triggersOf(url, "app.members")).toEqual([
        { name: STAMP, enabled: "O" },
      ])
      expect(data.promotion!.data).toHaveLength(1)
      let file = ""
      await withCopy(templateOf(url), async (copy) => {
        const r = await apply(dir, copy, data, { rehearse: true })
        expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
        file = (r.data as ApplyData).report!
      })
      expect((await reportAt(dir, file)).rows).toEqual([
        { schema: "app", table: "members", rows: ROWS },
      ])

      const r = await apply(dir, url, data)
      expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
      expect((r.data as ApplyData).status).toBe("committed")
      // Прийнятого тригера немає, механіка є, і обидва — увімкнені, як до
      // плану: крок даних повертає стан тригерів
      expect(await triggersOf(url, "app.member")).toEqual([
        { name: "member_simetra_touch", enabled: "O" },
      ])
      // Колонку версії й механіку створює фаза двигуна після запису значень,
      // тож переписані кроком рядки — з першою версією
      expect(
        await query(
          url,
          "select count(*)::int as rows, count(*) filter (where version = 1)::int as first from app.member"
        )
      ).toEqual([{ rows: ROWS, first: ROWS }])
      await query(
        url,
        "update app.member set description = 'renamed' where id = '00000000-0000-4000-8000-000000000001'"
      )
      expect(
        await query(
          url,
          "select version::int as version, updated_at > '2000-01-01T00:00:00Z' as touched from app.member where id = '00000000-0000-4000-8000-000000000001'"
        )
      ).toEqual([{ version: 2, touched: true }])
    })
  })
})
