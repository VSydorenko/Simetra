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
  executePlan,
  type ApplyDatabase,
  type EngineScope,
  type PlanArtifact,
  type PlanOutcome,
  type PromotionInput,
  type RehearsalProof,
  type SchemaEngine,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  acceptDebt,
  catalog,
  CONTACT_FILE,
  COUNTERPARTY_FILE,
  COUNTERPARTY_ID,
  counterpartyMapping,
  metaFiles,
  promotionProject,
  project,
  testDatabaseUrl,
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
 * на справжній базі (план П3-1, задача 9): гейт
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
  provider: "supabase",
}

/** Роль, якій за спиною платформи передають таблицю цілі. */
export const OWNER = testRoleName("build_plan_owner")
/** Роль, членом якої роль сесії не є: об'єкт такого власника план не зніме. */
export const STRANGER = testRoleName("build_plan_stranger")

/** Роль-група, членом якої є роль API: її привілеї роль API успадковує. */
export const WRITERS = testRoleName("build_plan_writers")

/** Роль адміністрування копії, інша за роль плану (R7 плану П3-2b-0). */
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
      `create role ${OWNER} nologin; grant ${OWNER} to postgres;
       create role ${STRANGER} nologin;
       create role ${WRITERS} nologin; grant ${WRITERS} to authenticated;
       create role ${COPIER} login password '${COPIER_PASSWORD}';`
    )
  )
  afterAll(() => dropRoles(OWNER, STRANGER, WRITERS, COPIER))
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

export async function compiled(
  entries: Record<string, unknown>
): Promise<CompiledModel> {
  // Дослівні одиниці фікстур — не предмет цих тестів, тож борг прийнято
  const result = await compile(
    await acceptDebt(
      metaFiles({
        "project.meta.json": project({ defaultSchema: "app" }),
        ...entries,
      })
    )
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
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
 * plpgsql-функція без тригера сліпа для `plpgsql_check` (рішення 5 плану
 * П3-2b-1). Немає — порожньо.
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
export const readerWithoutPlpgsqlCheck: ApplyDatabase = {
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

// Фікстура промоції: спільна для файлів промоції конвеєра
export type Json = Record<string, unknown>

/**
 * Тека фікстури без модуля й рахунку, з таблицею контактів як ТЧ. Коментар
 * таблиці фікстури й коментар колонки `inn` `promote` переносить в описи
 * дослівно й сам дає їм клас `metadata` (R24).
 */
export function contactsProject(): Map<string, string> {
  const files = promotionProject({
    module: false,
    contacts: true,
    invoice: false,
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
    counterpartyMapping({ module: false, fill: false })
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
