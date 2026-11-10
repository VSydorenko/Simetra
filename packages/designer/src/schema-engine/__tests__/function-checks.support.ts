import { afterAll, beforeAll, expect } from "vitest"
import { compile } from "simetra/compiler"
import { PROVIDER_OWNER_ROLES } from "simetra/model"
import {
  desiredForApply,
  executePlan,
  footprintTables,
  planFootprint,
  planLocks,
  planPlatformFunctions,
  readFingerprint,
  readLedgerHead,
  readProviderLocks,
  readServerFacts,
  readSessionSearchPath,
  PROVIDER_LOCKS,
  tableKey,
  type ApplyDesired,
  type CatalogFingerprint,
  type ExecutablePlan,
  type ExecuteOptions,
  type PlanStep,
  type TableLock,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  catalog,
  fingerprintAfterSteps,
  metaFiles,
  project,
  testRoleName,
  testSuperuserUrl,
  testProvider,
} from "../../../../simetra/test/support"
import {
  asSuperuser,
  dropRoles,
  inTarget as loadTarget,
  query,
} from "../../__tests__/support/db"

/**
 * Ревалідація тіл функцій раннером на справжній базі (спека промоції
 * §7.2): валідатори мов `sql` і `plpgsql` до кроків і після, під шляхом
 * ревалідації й власними налаштуваннями функції, проти базової лінії в тій
 * самій транзакції. Ціль кожного тесту — окрема база від `withDesiredShadow`,
 * як у `execute-plan.db.test.ts`.
 */

/**
 * Спільна підготовка тестів ревалідації тіл функцій: ціль із бажаним станом
 * моделі, план над живою ціллю й прогін кроків раннером. Ціль кожного тесту —
 * окрема база від `withDesiredShadow`, як у `execute-plan.db.test.ts`.
 */

export const engine = createPgDeltaEngine()
export const apply = createApplyDatabase({ readOnly: false })
export const reader = createApplyDatabase({ readOnly: true })

/** Роль застосування профілю: нею ж виконується план. */
export const OWNER = PROVIDER_OWNER_ROLES[testProvider()]

/** Роль-власник, членом якої роль застосування не є. */
export const STRANGER = testRoleName("fncheck_owner")

export const PREAMBLE: ExecutablePlan["preamble"] = [
  { name: "search_path", value: "pg_catalog" },
  { name: "check_function_bodies", value: "off" },
]

export const options: ExecuteOptions = {
  mode: "apply",
  planHash: "c".repeat(64),
  allow: [],
  snapshot: { tables: [] },
  sleep: async () => {},
}

let desired: ApplyDesired
/** Функції платформи моделі: їх `plpgsql_check` і перелік сліпих не беруть. */
let platformFunctions: string[]

/** Функції платформи моделі, готової хуком `useFunctionChecks`. */
export const platformFunctionNames = (): readonly string[] => platformFunctions

/**
 * Бажаний стан моделі й роль-власник готуються до тестів файлу: кожен файл
 * перевірки функцій кличе це на верхньому рівні, бо хуки в модулі підтримки
 * без виклику не реєструвалися б у файлі.
 */
export function useFunctionChecks(): void {
  beforeAll(async () => {
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project({
          defaultSchema: "app",
          database: { provider: testProvider() },
        }),
        "catalogs/Party/Party.meta.json": catalog("Party"),
      })
    )
    expect(compiled.diagnostics).toEqual([])
    desired = await desiredForApply(compiled.model!)
    platformFunctions = planPlatformFunctions(compiled.model!)
    await query(testSuperuserUrl(), `create role ${STRANGER} nologin`)
  })
  afterAll(() => dropRoles(STRANGER))
}

/**
 * Ціль: бажаний стан моделі, далі `setup` роллю застосування й `superuser`
 * сесією суперкористувача; базу прибирає порт. На відміну від спільного
 * `inTarget`, бажаний стан — модель, а `setup` і `superuser` ідуть окремими
 * запитами по вже завантаженій цілі.
 */
export const inTarget = <T>(
  setup: string,
  fn: (url: string) => Promise<T>,
  superuser?: string
): Promise<T> =>
  loadTarget(desired.sql, desired.scope, async (url) => {
    await query(url, setup)
    if (superuser !== undefined) await query(asSuperuser(url), superuser)
    return fn(url)
  })

export const read = (url: string): Promise<CatalogFingerprint> =>
  reader.transaction({ url }, "rollback", (tx) =>
    readFingerprint(tx, desired.scope)
  )

/**
 * Відбиток бажаного стану: кроки в тій самій цілі, у транзакції з відкатом;
 * `bodiesOff` — кроки під вимкненою валідацією тіл, як під преамбулою.
 */
export const desiredFingerprint = (
  url: string,
  steps: readonly PlanStep[],
  o: { bodiesOff?: boolean } = {}
): Promise<CatalogFingerprint> =>
  fingerprintAfterSteps(url, desired.scope, steps, o)

export function step(
  id: string,
  sql: string,
  over: Partial<PlanStep> = {}
): PlanStep {
  return {
    id,
    origin: "engine",
    sql,
    verb: "create",
    class: "catalogOnly",
    lockClass: "none",
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: [],
    produces: [],
    consumes: [],
    destroys: [],
    produced: [],
    destroyed: [],
    consumed: [],
    dataLoss: false,
    rewriteRisk: false,
    guards: [],
    ...over,
  }
}

export const EMPTY_MODEL = { tables: [], enumTypes: [], units: [] }

/** Блокування за слідом кроків без моделей (кроки тут без FK). */
export function locksOf(steps: readonly PlanStep[]): TableLock[] {
  const footprint = planFootprint(steps, {
    source: EMPTY_MODEL,
    desired: EMPTY_MODEL,
    typeChanges: [],
    newToOld: new Map(),
    columnsNewToOld: new Map(),
    live: [],
    providerStatements: new Map(),
    providerLocks: [],
  })
  const rights = new Map(
    footprintTables(footprint).map((t) => [tableKey(t.schema, t.name), true])
  )
  return planLocks({ footprint, rights }).locks
}

export const sessionPath = (url: string): Promise<string> =>
  reader.transaction({ url }, "rollback", readSessionSearchPath)

/** План над живою ціллю; бажаний відбиток — кроки в цій самій цілі. */
export async function planFor(
  url: string,
  steps: PlanStep[],
  over: Partial<ExecutablePlan> = {}
): Promise<ExecutablePlan> {
  return {
    fromHash: null,
    toHash: "1".repeat(64),
    scope: desired.scope,
    engine: engine.identity,
    steps,
    requiredPermissions: [],
    drift: null,
    role: OWNER,
    locks: locksOf(steps),
    implicitLocks: [],
    providerLocks: await reader.transaction({ url }, "rollback", (tx) =>
      readProviderLocks(tx, OWNER, PROVIDER_LOCKS[testProvider()])
    ),
    foreignKeys: { subjects: [], live: [] },
    preamble: [],
    revalidationSearchPath: await sessionPath(url),
    // Режим, який план дає на стеку: supautils ставить розширення
    plpgsqlCheck: "transient",
    platformFunctions,
    desiredInvalid: [],
    promotion: null,
    environment: { defaultPrivileges: [] },
    resultCatalog: EMPTY_MODEL,
    targetFingerprint: await read(url),
    ...(await reader.transaction({ url }, "rollback", async (tx) => ({
      server: await readServerFacts(tx),
      ledgerHead: await readLedgerHead(tx),
    }))),
    ...over,
    desiredFingerprint:
      over.desiredFingerprint ?? (await desiredFingerprint(url, steps)),
  }
}

export const TABLE_T = "create table app.t (id int, a text)"
export const NEUTRAL = step("s1", "CREATE TABLE app.n (id int)")
export const RENAME_A = step("s1", "ALTER TABLE app.t RENAME COLUMN a TO b", {
  verb: "alter",
  lockClass: "accessExclusive",
  lockedTables: [{ schema: "app", name: "t" }],
})

export const columnsOf = async (
  url: string,
  table: string
): Promise<string[]> =>
  (
    await query<{ name: string }>(
      url,
      `select attname as name from pg_attribute where attrelid = '${table}'::regclass and attnum > 0 and not attisdropped order by attnum`
    )
  ).map((r) => r.name)

export const FP = `${TABLE_T};
  create function app.fp() returns text language plpgsql as $$ declare r text; begin select a into r from app.t limit 1; return r; end $$`

/** Прогін `steps` на цілі після `setup`; `fn` бачить результат і базу. */
export async function run(
  setup: string,
  steps: PlanStep[],
  over: Partial<ExecutablePlan> = {},
  fn: (
    outcome: Awaited<ReturnType<typeof executePlan>>,
    url: string
  ) => Promise<void> = async () => {},
  superuser?: string
) {
  await inTarget(
    setup,
    async (url) =>
      fn(
        await executePlan(
          apply,
          { url },
          await planFor(url, steps, over),
          options
        ),
        url
      ),
    superuser
  )
}

export const checkFailed = (
  outcome: Awaited<ReturnType<typeof executePlan>>
): string => {
  expect(outcome).toMatchObject({
    status: "failed",
    diagnostics: [{ code: "apply.function-check-failed" }],
  })
  return String(outcome.diagnostics[0]!.params.functions)
}
