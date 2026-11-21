import { afterAll, beforeAll, expect } from "vitest"
import {
  applyChanges,
  canonicalSnapshot,
  compile,
  promoteObject,
  type CompiledModel,
  type PromoteInput,
  type PromotionRecord,
} from "simetra/compiler"
import {
  buildPlan,
  desiredForApply,
  engineScope,
  executePlan,
  type ApplyDatabase,
  type EngineScope,
  type PlanArtifact,
  type PlanOutcome,
  type PromotionInput,
  type RehearsalProof,
  type SchemaEngine,
} from "simetra/schema"
import { PROVIDER_OWNER_ROLES } from "simetra/model"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  acceptDebt,
  catalog,
  CONTACT_FILE,
  COUNTERPARTY_FILE,
  COUNTERPARTY_ID,
  counterpartyMapping,
  customTable,
  metaFiles,
  promotionProject,
  project,
  testDatabaseUrl,
  testProvider,
  testRoleFor,
  testRoleName,
  testSuperuserUrl,
  uuid,
} from "../../../../simetra/test/support"
import {
  asSuperuser,
  dropRoles,
  inTarget as loadTarget,
  query,
} from "../../__tests__/support/db"

/**
 * Спільна підготовка файлів `build-plan*.db.test.ts`. Конвеєр плану `buildPlan`
 * на справжній базі: гейт
 * дрейфу, план від живої цілі, класи й лінт, доказ на копії тим самим
 * раннером і детермінований артефакт. Ціль кожного тесту — окрема база від
 * `withDesiredShadow`; база стеку лише читається.
 */

export const engine = createPgDeltaEngine()
export const stack = { url: testDatabaseUrl() }
export const dbs = {
  reader: createApplyDatabase({ readOnly: true }),
  scratch: createApplyDatabase({ readOnly: false }),
}
export const writer = createApplyDatabase({ readOnly: false })
export const targetScope: EngineScope = {
  schemas: ["app"],
  provider: testProvider(),
}

function requiredRole(purpose: "user" | "anonymous"): string {
  const role = testRoleFor(purpose)
  if (role === null)
    throw new Error(`no ${purpose} role in the ${testProvider()} profile`)
  return role
}

/** Роль плану: власник профілю, від якого сесія застосування. */
export const SESSION_OWNER = PROVIDER_OWNER_ROLES[testProvider()]
/** Ролі API профілю — гранти й політики тестів ідуть їм. */
export const USER = requiredRole("user")
export const ANON = requiredRole("anonymous")

/** Роль, якій за спиною платформи передають таблицю цілі. */
export const OWNER = testRoleName("build_plan_owner")
/** Роль, членом якої роль сесії не є: об'єкт такого власника план не зніме. */
export const STRANGER = testRoleName("build_plan_stranger")
/**
 * Роль, членом якої роль сесії є без успадкування (`INHERIT FALSE`): `ALTER`
 * і `DROP` її об'єктів вимагають привілеїв ролі, а не лише членства.
 */
export const NOINHERIT_OWNER = testRoleName("build_plan_noinherit")

/** Роль-група, членом якої є роль API: її привілеї роль API успадковує. */
export const WRITERS = testRoleName("build_plan_writers")

/** Роль адміністрування копії, інша за роль плану. */
export const COPIER = testRoleName("build_plan_copier")
export const COPIER_PASSWORD = "simetra_build_plan_copier"

/** Службова роль провайдера, членом якої роль сесії застосування не є. */
export const SERVICE_ROLE = "supabase_auth_admin"

/**
 * Ролі файлу створюються до його тестів і прибираються після: кожен файл
 * конвеєра кличе це на верхньому рівні, бо хуки в модулі підтримки без
 * виклику не реєструвалися б у файлі.
 */
export function useBuildPlanRoles(): void {
  beforeAll(() =>
    query(
      testSuperuserUrl(),
      `create role ${OWNER} nologin; grant ${OWNER} to ${SESSION_OWNER} with inherit true;
       create role ${STRANGER} nologin;
       create role ${NOINHERIT_OWNER} nologin; grant ${NOINHERIT_OWNER} to ${SESSION_OWNER} with inherit false;
       create role ${WRITERS} nologin; grant ${WRITERS} to ${USER};
       create role ${COPIER} login password '${COPIER_PASSWORD}';`
    )
  )
  afterAll(() => dropRoles(OWNER, STRANGER, NOINHERIT_OWNER, WRITERS, COPIER))
}

/**
 * Ціль із `setup`; базу прибирає порт. Спільний `inTarget` із межею цілі
 * конвеєра.
 */
export const inTarget = <T>(
  setup: string,
  fn: (url: string) => Promise<T>
): Promise<T> => loadTarget(setup, targetScope, fn)

/** Порожня ціль: лише базовий стан провайдера. */
export const EMPTY = "select 1;"

async function compileEntries(entries: Record<string, unknown>) {
  // Дослівні одиниці фікстур — не предмет цих тестів, тож борг прийнято
  return compile(
    await acceptDebt(
      metaFiles({
        "project.meta.json": project({
          defaultSchema: "app",
          database: { provider: testProvider() },
        }),
        ...entries,
      })
    )
  )
}

export async function compiled(
  entries: Record<string, unknown>
): Promise<CompiledModel> {
  const result = await compileEntries(entries)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/** Коди помилок компілятора для форми, яку він відмовляє (моделі немає). */
export async function compileErrors(
  entries: Record<string, unknown>
): Promise<string[]> {
  const result = await compileEntries(entries)
  expect(result.model).toBeUndefined()
  return result.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => d.code)
}

export const PARTY = "catalogs/Party/Party.meta.json"
export const party = (attributes: unknown[] = []) =>
  catalog("Party", { id: uuid(9001), attributes })

export const plan = (
  url: string,
  model: CompiledModel,
  over: SchemaEngine = engine
): Promise<PlanOutcome> => buildPlan(over, dbs, model, { target: { url } }, [])

/**
 * Доказ репетиції: бажаний каталог із бажаної тіні моделі, як його будує
 * `applyTool`.
 */
export async function rehearsalOf(
  model: CompiledModel,
  artifact: PlanArtifact
): Promise<RehearsalProof> {
  const desired = await desiredForApply(model)
  const shadow = await engine.withDesiredShadow(
    { target: stack },
    desired.sql,
    artifact.scope,
    (db) => engine.extract(db, artifact.scope)
  )
  if (shadow.status !== "loaded")
    throw new Error(
      `desired shadow did not load: ${shadow.diagnostics.map((d) => d.message).join("; ")}`
    )
  return { engine, desired: shadow.value.catalog }
}

export function planned(outcome: PlanOutcome): PlanArtifact {
  if (outcome.status !== "planned")
    throw new Error(
      `expected planned, got ${outcome.status}: ${outcome.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ")}`
    )
  return outcome.artifact
}

export const codes = (outcome: PlanOutcome): string[] =>
  outcome.diagnostics.map((d) => d.code)

export const errors = (outcome: PlanOutcome): string[] =>
  outcome.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)

/**
 * Попередження про сліпі функції, яке дає застосування чи репетиція: тригерна
 * plpgsql-функція без тригера сліпа для `plpgsql_check` (спека промоції
 * §7.2). Немає — порожньо.
 */
export const blindDiagnostics = (functions: readonly string[]) =>
  functions.length === 0
    ? []
    : [
        expect.objectContaining({
          code: "apply.function-check-blind",
          severity: "warning",
          params: { count: functions.length, functions: functions.join(", ") },
        }),
      ]

/** Застосовує артефакт так само, як інструмент `apply`. */
export async function applyArtifact(
  url: string,
  artifact: PlanArtifact,
  model: CompiledModel,
  blind: readonly string[] = []
): Promise<void> {
  const outcome = await executePlan(writer, { url }, artifact, {
    mode: "apply",
    planHash: artifact.planHash,
    allow: artifact.requiredPermissions,
    snapshot: canonicalSnapshot(model),
  })
  expect(outcome.diagnostics).toEqual(blindDiagnostics(blind))
  expect(outcome.status).toBe("committed")
}

/**
 * План і застосування моделі на цілі; `blind` — сліпі функції, про які
 * застосування попереджає.
 */
export async function establish(
  url: string,
  model: CompiledModel,
  blind: readonly string[] = []
): Promise<void> {
  await applyArtifact(url, planned(await plan(url, model)), model, blind)
}

export const stepMatching = (artifact: PlanArtifact, pattern: RegExp) =>
  artifact.steps.filter((s) => pattern.test(s.sql))

/**
 * Читач цілі, на якій `plpgsql_check` немає й поставити його не можна: на
 * запиті фактів розширення справжній читач підмінено, решта — як є.
 */
/**
 * Грант, що відрізняється від бажаного лише опцією гранту (#277): ціль з
 * опцією поверх простого бажаного — дрейф обох свідків (модель каталогу
 * бачить одиницю з опцією, `*` в атомі привілею) і план, що її знімає;
 * бажана опція поверх простого гранту — крок `WITH GRANT OPTION`. Спільний
 * для профілів: роль API — свого профілю.
 */
export async function expectGrantOptionDrift(): Promise<void> {
  // Гранти згенерованих таблиць дає компілятор, а таблиць `.sql` не пише,
  // тож об'єкт — представлення модуля
  const grant = (option: string) => ({
    "sql/app/note.sql": [
      "CREATE VIEW app.note AS SELECT 1 AS id;",
      `GRANT SELECT ON app.note TO ${ANON}${option};`,
    ].join("\n"),
  })
  const plain = await compiled(grant(""))
  const optioned = await compiled(grant(" WITH GRANT OPTION"))
  await inTarget(EMPTY, async (url) => {
    await establish(url, plain)
    await query(url, `grant select on app.note to ${ANON} with grant option`)
    const drifted = planned(await plan(url, plain))
    expect(drifted.drift?.reason).toBe("drift")
    expect(drifted.drift?.sections).toContain("acl")
    expect(drifted.drift?.paths).toContain(
      `units.grant:grant:table:app.note:${ANON}:select*`
    )
    await applyArtifact(url, drifted, plain)
    expect((await plan(url, plain)).status).toBe("unchanged")
    const widened = planned(await plan(url, optioned))
    expect(widened.drift).toBeNull()
    expect(stepMatching(widened, /WITH GRANT OPTION/)).toHaveLength(1)
    await applyArtifact(url, widened, optioned)
    expect((await plan(url, optioned)).status).toBe("unchanged")
  })
  expect(
    optioned.sqlUnits
      .filter((u) => u.class === "grant" && u.name === "app.note")
      .map((u) => u.identity)
  ).toEqual([`grant:grant:table:app.note:${ANON}:select*`])
}

export const readerWithoutPlpgsqlCheck: ApplyDatabase = {
  statement: (target, sql) => dbs.reader.statement(target, sql),
  transaction: (target, end, fn) =>
    dbs.reader.transaction(target, end, (tx) =>
      fn({
        ...tx,
        query: async <R extends Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[]
        ): Promise<R[]> =>
          sql.includes("pg_available_extension_versions")
            ? ([
                {
                  installed: false,
                  schema: null,
                  schemaUsage: false,
                  functionExecute: false,
                  available: false,
                  trusted: false,
                  superuser: false,
                  createOnDatabase: true,
                  checkSchemaTaken: false,
                },
              ] as unknown as R[])
            : tx.query<R>(sql, params),
      })
    ),
}

/**
 * Сліпі функції поза межею (сесією суперкористувача): застосунку
 * (`other.fh()`), провайдера з переліку пресету (`pgbouncer.get_auth(text)`:
 * її вже має засів тіні, але з власником `postgres`) і провайдера поза ним.
 * Власник — роль, членом якої сесія не є, без `EXECUTE` для всіх, як у
 * `pgbouncer.get_auth` справжнього стеку.
 */
export const BLIND_SETUP = `create schema other;
  create function other.fh() returns int language sql as $$ select 1 $$;
  create function pgbouncer.other_auth(p_usename text) returns text language plpgsql as $$ begin return p_usename; end $$;
  alter function other.fh() owner to ${STRANGER};
  revoke execute on function other.fh() from public;
  alter function pgbouncer.get_auth(text) owner to ${STRANGER};
  revoke execute on function pgbouncer.get_auth(text) from public;
  alter function pgbouncer.other_auth(text) owner to ${STRANGER};
  revoke execute on function pgbouncer.other_auth(text) from public;`

/**
 * Прийнята таблиця `app.notes` з рядковою колонкою `note`. Дослівні тригер і
 * політика — лише на `CustomTable`, як прийнятий борг (спека прав §6.1): на таблиці
 * виду це помилка `sql.kind-table-verbatim`. Тести, чий предмет — дослівний
 * тригер чи політика, ставлять їх сюди.
 */
export const NOTES = "custom-tables/Notes/Notes.meta.json"
export const notes = (
  type: Record<string, unknown> = { type: "String", length: 20 }
) =>
  customTable("Notes", {
    id: uuid(9201),
    physicalName: "notes",
    columns: [
      {
        id: uuid(9202),
        name: "id",
        physicalName: "id",
        type: "UUID",
        notNull: true,
      },
      { id: uuid(9203), name: "note", physicalName: "note", ...type },
    ],
    primaryKey: { name: "notes_pkey", columns: ["id"] },
  })

// Фікстура промоції: спільна для файлів промоції конвеєра
export type Json = Record<string, unknown>

/**
 * Тека фікстури без модуля й рахунку, з таблицею контактів як ТЧ. Коментар
 * таблиці фікстури й коментар колонки `inn` `promote` переносить в описи
 * дослівно й сам дає їм клас `metadata` (спека промоції §8).
 */
export function contactsProject(): Map<string, string> {
  const files = promotionProject({
    module: false,
    contacts: true,
    invoice: false,
    provider: testProvider(),
  })
  const party = JSON.parse(files.get(COUNTERPARTY_FILE)!) as Json
  ;(party.columns as Json[])[2]!.comment = "Taxpayer number"
  files.set(COUNTERPARTY_FILE, JSON.stringify(party))
  const raw = JSON.parse(files.get(CONTACT_FILE)!) as Json
  ;(raw.columns as Json[]).push({
    id: uuid(7105),
    name: "lineNumber",
    physicalName: "line_number",
    type: "Integer",
    notNull: true,
  })
  files.set(CONTACT_FILE, JSON.stringify(raw))
  return files
}

/** Мапінг без кроку `fill` і з ТЧ `contacts`. */
export function contactsMapping(): PromoteInput {
  const mapping = structuredClone(
    counterpartyMapping({
      module: false,
      fill: false,
      provider: testProvider(),
    })
  )
  mapping.tabularSections = [
    {
      table: "CounterpartyContact",
      name: "contacts",
      columns: {
        id: { to: "standard", name: "ref" },
        counterpartyId: { to: "standard", name: "parent" },
        lineNumber: { to: "standard", name: "lineNumber" },
        phone: {
          to: "attribute",
          collection: "attributes",
          element: { name: "phone" },
        },
      },
    },
  ]
  return mapping
}

export interface Promoted {
  before: CompiledModel
  after: CompiledModel
  afterFiles: Map<string, string>
  record: PromotionRecord
  input: PromotionInput
}

export async function promoted(
  files: Map<string, string> = contactsProject(),
  mapping: PromoteInput = contactsMapping()
): Promise<Promoted> {
  const compiledFiles = async (f: ReadonlyMap<string, string>) => {
    const result = await compile(f)
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    return result.model!
  }
  const before = await compiledFiles(files)
  let n = 900_000
  const result = await promoteObject(files, mapping, {
    schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
    newId: () => uuid(++n),
  })
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  const record = result.record!
  const after = applyChanges(files, result.changes)
  return {
    before,
    after: await compiledFiles(after),
    afterFiles: after,
    record,
    input: { record, file: `plans/${COUNTERPARTY_ID}.promotion.json` },
  }
}

/** Ціль у стані до промоції, `drift` поверх неї, і план стану після. */
export async function planPromotion(
  p: Promoted,
  o: {
    drift?: string
    superuser?: boolean
    records?: PromotionInput[]
    /** Двигун лише для плану промоції; стан «до» ставить справжній. */
    engine?: SchemaEngine
    /** Читач цілі лише для плану промоції. */
    reader?: ApplyDatabase
  } = {}
): Promise<PlanOutcome> {
  return inTarget(EMPTY, async (url) => {
    await establish(url, p.before)
    if (o.drift !== undefined)
      await query(o.superuser === true ? asSuperuser(url) : url, o.drift)
    return buildPlan(
      o.engine ?? engine,
      { ...dbs, reader: o.reader ?? dbs.reader },
      p.after,
      { target: { url } },
      o.records ?? [p.input]
    )
  })
}

/** Стара таблиця фікстури, як її бачить ціль до промоції. */
export const OLD = "app.counterparties"

export const params = (outcome: PlanOutcome, code: string) =>
  outcome.diagnostics.filter((d) => d.code === code).map((d) => d.params)

export const ref = (kind: string, name: string) => ({ kind, name })

export async function compiledFiles(
  files: Map<string, string>
): Promise<CompiledModel> {
  const result = await compile(files)
  expect(result.diagnostics).toEqual([])
  return result.model!
}

/** Ціль у межах схем моделі: `policyDomain()` живе в `public`. */
export async function inModelTarget<T>(
  model: CompiledModel,
  fn: (url: string) => Promise<T>
): Promise<T> {
  return loadTarget(EMPTY, (await engineScope(model)).scope, fn)
}

export const carrierTables = (artifact: PlanArtifact) =>
  artifact.steps
    .filter((s) => s.origin === "carriers")
    .map((s) => s.lockedTables[0]!.name)

export const one = async <R extends Record<string, unknown>>(
  url: string,
  sql: string,
  params: unknown[]
): Promise<R> => (await query<R>(url, sql, params))[0]!
