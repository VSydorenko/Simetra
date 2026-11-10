import pg from "pg"
import { afterAll, beforeAll, expect } from "vitest"
import { compile } from "simetra/compiler"
import {
  desiredForApply,
  executePlan,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  readFingerprint,
  readLedgerHead,
  readServerFacts,
  type ApplyDatabase,
  type ApplyDesired,
  type CatalogFingerprint,
  type FingerprintSection,
  type DriftReport,
  type EngineCatalog,
  type ExecutablePlan,
  type ExecuteOptions,
  type ExecuteOutcome,
  footprintTables,
  planFootprint,
  planLocks,
  readProviderLocks,
  readSessionSearchPath,
  PROVIDER_LOCKS,
  tableKey,
  type PlanStep,
  type ProviderLockSet,
  type RehearsalProof,
  type TableLock,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  catalog,
  fingerprintAfterSteps,
  metaFiles,
  project,
  testDatabaseUrl,
  testRoleName,
  testSuperuserUrl,
  loginUrl,
} from "../../../../simetra/test/support"
import {
  dropRoles,
  inTarget as loadTarget,
  query,
} from "../../__tests__/support/db"

/**
 * Спільна підготовка тестів раннера транзакції `executePlan`: ціль із
 * бажаним станом застосування маленької моделі, ролі, план, складений
 * вручну, і помічники синхронізації зі станом бази.
 */

export const engine = createPgDeltaEngine()
export const stack = { url: testDatabaseUrl() }
export const apply = createApplyDatabase({ readOnly: false })

/** Роль-власник для підміни власника на цілі. */
export const OWNER = testRoleName("execute_owner")
/** Роль входу без права на явний `LOCK`: лише те, що їй дасть тест. */
export const LOCKER = testRoleName("execute_locker")
export const LOCKER_PASSWORD = "simetra-execute-locker"

/** Базовий стан цілі поверх бажаного стану моделі. */
export const BASE = `
  create table app.t (id int primary key, c text);
  insert into app.t values (1, null);
  grant create on schema app to ${OWNER};
`

export const H1 = "1".repeat(64)
export const H2 = "2".repeat(64)
export const PLAN_HASH = "c".repeat(64)
export const DRIFT: DriftReport = {
  reason: "drift",
  sections: ["owner"],
  paths: [],
}

export let desired: ApplyDesired

/** З'єднання, що тримає блокування, доки тест його не відпустить. */
export async function holder(url: string, sql: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url })
  // Обрив чужого backend не має валити процес тесту
  client.on("error", () => {})
  await client.connect()
  await client.query(sql)
  return client
}

/** Опитування стану бази з межею: синхронізація без фіксованих пауз. */
export async function until(
  what: string,
  check: () => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Бажаний стан і ролі файлу готуються до його тестів і прибираються після:
 * кожен файл раннера кличе це на верхньому рівні, бо хуки в модулі підтримки
 * без виклику не реєструвалися б у файлі.
 */
export function useExecutePlanSetup(): void {
  beforeAll(async () => {
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project({ defaultSchema: "app" }),
        "catalogs/Party/Party.meta.json": catalog("Party"),
      })
    )
    expect(compiled.diagnostics).toEqual([])
    desired = await desiredForApply(compiled.model!)
    await query(
      testSuperuserUrl(),
      `create role ${OWNER} nologin; grant ${OWNER} to postgres;
       create role ${LOCKER} login bypassrls password '${LOCKER_PASSWORD}';`
    )
  })
  afterAll(() => dropRoles(OWNER, LOCKER))
}

/**
 * Ціль: бажаний стан застосування моделі плюс `setup`; базу прибирає порт.
 * На відміну від спільного `inTarget`, бажаний стан — модель, а `setup` іде
 * окремим запитом по вже завантаженій цілі.
 */
export const inTarget = <T>(
  setup: string,
  fn: (url: string) => Promise<T>
): Promise<T> =>
  loadTarget(desired.sql, desired.scope, async (url) => {
    await query(url, setup)
    return fn(url)
  })

export const read = (url: string): Promise<CatalogFingerprint> =>
  createApplyDatabase({ readOnly: true }).transaction(
    { url },
    "rollback",
    (tx) => readFingerprint(tx, desired.scope)
  )

/**
 * Відбиток бажаного стану: кроки в тій самій цілі, у транзакції з відкатом.
 * Окрема база була б іншою ціллю, і відбиток залежав би від того, як вона
 * відтворила `setup`, а не від самої цілі.
 */
export const desiredFingerprint = (
  url: string,
  steps: readonly PlanStep[]
): Promise<CatalogFingerprint> =>
  fingerprintAfterSteps(url, desired.scope, steps)

/**
 * Бажаний відбиток для тестів, де відмова настає до звірки з ним: порівняння
 * не відбувається, тож зміст не важить, а справжній відбиток створював би
 * враження, що тест його перевіряє.
 */
export const NOT_COMPARED: CatalogFingerprint = {
  version: FINGERPRINT_VERSION,
  sections: Object.fromEntries(
    FINGERPRINT_SECTIONS.map((section) => [section, "not-compared"])
  ) as Record<FingerprintSection, string>,
}

/**
 * Каталог двигуна бажаного стану: окрема база, де `setup` і кроки вже
 * виконано, — те, що `applyTool` бере з бажаної тіні.
 */
export const desiredCatalog = (
  setup: string,
  steps: readonly PlanStep[]
): Promise<EngineCatalog> =>
  inTarget(
    `${setup};\n${steps.map((s) => `${s.sql};`).join("\n")}`,
    async (url) => (await engine.extract({ url }, desired.scope)).catalog
  )

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

export const CREATE_N = step("s1", "CREATE TABLE app.n (id int)")
export const ALTER_T = step("s1", "ALTER TABLE app.t ADD COLUMN d int", {
  verb: "alter",
  lockClass: "accessExclusive",
  lockedTables: [{ schema: "app", name: "t" }],
})

export const EMPTY_MODEL = { tables: [], enumTypes: [], units: [] }

/**
 * Блокування плану за слідом кроків без моделей (кроки тут без FK): власні
 * таблиці, вихідні імена через `newToOld`, детермінований порядок. Право на
 * явний `LOCK` — на кожній таблиці: роль тестів ними володіє.
 */
export function locksOf(
  steps: readonly PlanStep[],
  newToOld: ReadonlyMap<string, string> = new Map()
): TableLock[] {
  const footprint = planFootprint(steps, {
    source: EMPTY_MODEL,
    desired: EMPTY_MODEL,
    typeChanges: [],
    newToOld,
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

/**
 * Перелік провайдера цілі для ролі плану — як його записав би план: ключ
 * переліку — роль плану.
 */
export const providerList = (
  url: string,
  role = "postgres"
): Promise<ProviderLockSet[]> =>
  createApplyDatabase({ readOnly: true }).transaction(
    { url },
    "rollback",
    (tx) => readProviderLocks(tx, role, PROVIDER_LOCKS.supabase)
  )

/** Шлях пошуку сесії цілі — як його записав би план для ревалідації. */
export const sessionPath = (url: string): Promise<string> =>
  createApplyDatabase({ readOnly: true }).transaction(
    { url },
    "rollback",
    readSessionSearchPath
  )

/**
 * Факти сервера й голова ledger цілі — як їх записав би план тією самою
 * транзакцією READ ONLY, що й стан.
 */
export const identityOf = (
  url: string
): Promise<Pick<ExecutablePlan, "server" | "ledgerHead">> =>
  createApplyDatabase({ readOnly: true }).transaction(
    { url },
    "rollback",
    async (tx) => ({
      server: await readServerFacts(tx),
      ledgerHead: await readLedgerHead(tx),
    })
  )

/** План від `fromHash` до `toHash` над живою ціллю. */
export async function planFor(
  url: string,
  steps: PlanStep[],
  over: Partial<ExecutablePlan> = {}
): Promise<ExecutablePlan> {
  return {
    fromHash: null,
    toHash: H1,
    scope: desired.scope,
    engine: engine.identity,
    steps,
    requiredPermissions: [],
    drift: null,
    role: "postgres",
    locks: locksOf(steps),
    implicitLocks: [],
    foreignKeys: { subjects: [], live: [] },
    preamble: [],
    // Перевірку `plpgsql_check` тримає `function-checks.db.test.ts`
    plpgsqlCheck: "unavailable",
    platformFunctions: [],
    desiredInvalid: [],
    promotion: null,
    // Цілі тестів глобальних ADP ролі не мають
    environment: { defaultPrivileges: [] },
    resultCatalog: { tables: [], enumTypes: [], units: [] },
    ...(await identityOf(url)),
    ...over,
    providerLocks:
      over.providerLocks ?? (await providerList(url, over.role ?? "postgres")),
    revalidationSearchPath:
      over.revalidationSearchPath ?? (await sessionPath(url)),
    targetFingerprint: over.targetFingerprint ?? (await read(url)),
    desiredFingerprint:
      over.desiredFingerprint ?? (await desiredFingerprint(url, steps)),
  }
}

/**
 * Заглушка доказу репетиції: тести, що не перевіряють сам доказ двигуна,
 * підставляють двигун, який не бачить розбіжності.
 */
export const stubRehearsal: RehearsalProof = {
  engine: {
    plan: () => ({ actions: [], empty: true, preamble: [], diagnostics: [] }),
  },
  desired: {} as EngineCatalog,
}

// `satisfies`, а не анотація: імпорт за межі модуля втратив би звуження до
// режиму `apply`, і розгортання з полями іншого режиму не пройшло б перевірку
export const options = {
  mode: "apply",
  planHash: PLAN_HASH,
  allow: [],
  snapshot: { tables: [] },
  sleep: async () => {},
} satisfies ExecuteOptions

/** Перше застосування без кроків: marker отримує `hash`. */
export async function establish(url: string, hash: string): Promise<void> {
  const fingerprint = await read(url)
  const outcome = await executePlan(
    apply,
    { url },
    {
      fromHash: null,
      toHash: hash,
      scope: desired.scope,
      engine: engine.identity,
      steps: [],
      requiredPermissions: [],
      drift: null,
      role: "postgres",
      ...(await identityOf(url)),
      locks: [],
      implicitLocks: [],
      providerLocks: await providerList(url),
      foreignKeys: { subjects: [], live: [] },
      preamble: [],
      revalidationSearchPath: await sessionPath(url),
      plpgsqlCheck: "unavailable",
      platformFunctions: [],
      desiredInvalid: [],
      promotion: null,
      environment: { defaultPrivileges: [] },
      targetFingerprint: fingerprint,
      desiredFingerprint: fingerprint,
      resultCatalog: { tables: [], enumTypes: [], units: [] },
    },
    { ...options, planHash: "e".repeat(64) }
  )
  expect(outcome).toMatchObject({ status: "committed" })
}

export interface MarkerRow extends Record<string, unknown> {
  snapshot_hash: string
  plan_hash: string
  fingerprint: Record<string, string>
}

export const marker = async (url: string): Promise<MarkerRow | undefined> =>
  (
    await query<MarkerRow>(
      url,
      "select snapshot_hash, plan_hash, fingerprint from simetra.marker"
    )
  )[0]

export interface LedgerRow extends Record<string, unknown> {
  plan_hash: string
  from_hash: string | null
  to_hash: string
  allowed: string[]
  drift: DriftReport | null
  no_drift: boolean
  apply_id: string
}

export const ledger = (url: string): Promise<LedgerRow[]> =>
  query<LedgerRow>(
    url,
    "select plan_hash, from_hash, to_hash, allowed, drift, drift is null as no_drift, apply_id from simetra.ledger order by id"
  )

export const exists = async (url: string, table: string): Promise<boolean> =>
  (
    await query<{ found: boolean }>(
      url,
      `select to_regclass('${table}') is not null as found`
    )
  )[0]!.found

/** Порт, що лічить відкриті транзакції: «до `BEGIN` на цілі» — нуль. */
export function counted(db: ApplyDatabase): {
  db: ApplyDatabase
  count: () => number
} {
  let n = 0
  return {
    db: {
      statement: (target, sql) => db.statement(target, sql),
      transaction: (target, end, fn) => {
        n++
        return db.transaction(target, end, fn)
      },
    },
    count: () => n,
  }
}

export const codes = (outcome: ExecuteOutcome) =>
  outcome.diagnostics.map((d) => d.code)

/**
 * Порт, що після `fn` і до `COMMIT`/`ROLLBACK` виконує `sql` на тій самій
 * транзакції й зберігає рядки: після `ROLLBACK` репетиції дані й режим
 * тригерів повертаються самі, тож перевірка після прогону нічого не доводить.
 */
export function observing(
  db: ApplyDatabase,
  sql: string
): { db: ApplyDatabase; rows(): Record<string, unknown>[] } {
  let seen: Record<string, unknown>[] = []
  return {
    db: {
      statement: (target, sql) => db.statement(target, sql),
      transaction: (target, end, fn) =>
        db.transaction(target, end, async (tx) => {
          const value = await fn(tx)
          seen = await tx.query(sql)
          return value
        }),
    },
    rows: () => seen,
  }
}

/**
 * Порт, що читає `sql` на тому самому з'єднанні вже після кінця транзакції
 * раннера: його `COMMIT`/`ROLLBACK` виконується тут, а кінцю порту лишається
 * порожня транзакція.
 */
export function afterEnd(
  db: ApplyDatabase,
  sql: string
): { db: ApplyDatabase; rows(): Record<string, unknown>[] } {
  let seen: Record<string, unknown>[] = []
  return {
    db: {
      statement: (target, sql) => db.statement(target, sql),
      transaction: (target, end, fn) =>
        db.transaction(target, end, async (tx) => {
          const value = await fn(tx)
          await tx.query(end === "commit" ? "COMMIT" : "ROLLBACK")
          seen = await tx.query(sql)
          await tx.query("BEGIN")
          return value
        }),
    },
    rows: () => seen,
  }
}

/**
 * Порт, що до транзакції раннера лишає на з'єднанні сесійний стан `sql`, —
 * як попередній клієнт того самого backend за пулером: `BEGIN` порту закомічено порожнім, `sql` іде поза транзакцією.
 */
export function sessionLeftover(db: ApplyDatabase, sql: string): ApplyDatabase {
  return {
    statement: (target, sql) => db.statement(target, sql),
    transaction: (target, end, fn) =>
      db.transaction(target, end, async (tx) => {
        await tx.query("COMMIT")
        await tx.query(sql)
        await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED")
        return fn(tx)
      }),
  }
}

/** Та сама база цілі, але сесією іншої ролі входу. */
export const loginAs = (url: string, user: string, password: string): string =>
  loginUrl(url, user, password)
