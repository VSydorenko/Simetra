import pg from "pg"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import {
  compile,
  loadSqlParser,
  localize,
  promotionRecordHash,
  type PromotionRecord,
} from "simetra/compiler"
import type { CatalogModel, PhysicalTable } from "simetra/model"
import {
  ApplyConnectionLost,
  ApplyDbError,
  dataGuardSql,
  desiredForApply,
  executePlan,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  readFingerprint,
  readLedgerHead,
  readServerFacts,
  rehearsalHash,
  rehearsalReport,
  type ApplyDatabase,
  type ApplyDesired,
  type CatalogFingerprint,
  type DataStepKind,
  type DataTable,
  type FingerprintSection,
  type DriftReport,
  type EngineCatalog,
  type ExecutablePlan,
  type ExecuteOptions,
  type ExecuteOutcome,
  footprintTables,
  intentStep,
  planFootprint,
  planLocks,
  preservationPlan,
  readLiveForeignKeys,
  readLockRights,
  readProviderLocks,
  readSessionSearchPath,
  SUPABASE_LOCKS,
  tableKey,
  type PlanStep,
  type ProviderLockSet,
  type RehearsalProof,
  type RehearsalReport,
  type TableLock,
  typeGuards,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  catalog,
  fingerprintAfterSteps,
  metaFiles,
  project,
  shadowDatabaseCount,
  testDatabaseUrl,
  testSuperuserUrl,
} from "../../../../simetra/test/support"

/**
 * Раннер транзакції `executePlan` на справжній базі (план П3-1, задача 8).
 * Ціль кожного тесту — окрема база від `withDesiredShadow` із бажаним станом
 * застосування маленької моделі; база стеку лише читається. Відбитки цілі й
 * бажаного стану читаються з реальних баз, план складається вручну. Тести з
 * блокуваннями й обривом синхронізуються зі станом бази (`pg_locks`,
 * `pg_stat_activity`), а не з паузами.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const apply = createApplyDatabase({ readOnly: false })

/** Роль-власник для підміни власника на цілі. */
const OWNER = "simetra_execute_owner"
/** Роль входу, чия сесія стає роллю API провайдера. */
const API_LOGIN = "simetra_execute_api"
const API_PASSWORD = "simetra-execute-api"
/** Роль входу без права на явний `LOCK`: лише те, що їй дасть тест. */
const LOCKER = "simetra_execute_locker"
const LOCKER_PASSWORD = "simetra-execute-locker"

/** Базовий стан цілі поверх бажаного стану моделі. */
const BASE = `
  create table app.t (id int primary key, c text);
  insert into app.t values (1, null);
  grant create on schema app to ${OWNER};
`

const H1 = "1".repeat(64)
const H2 = "2".repeat(64)
const PLAN_HASH = "c".repeat(64)
const DRIFT: DriftReport = { reason: "drift", sections: ["owner"], paths: [] }

let desired: ApplyDesired

/** Один запит (чи кілька операторів) з окремого з'єднання. */
async function other<R extends Record<string, unknown>>(
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

/** З'єднання, що тримає блокування, доки тест його не відпустить. */
async function holder(url: string, sql: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url })
  // Обрив чужого backend не має валити процес тесту
  client.on("error", () => {})
  await client.connect()
  await client.query(sql)
  return client
}

/** Опитування стану бази з межею: синхронізація без фіксованих пауз. */
async function until(
  what: string,
  check: () => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function dropRoles(): Promise<void> {
  await other(
    testSuperuserUrl(),
    `drop role if exists ${API_LOGIN}; drop role if exists ${OWNER};
     drop role if exists ${LOCKER};`
  )
}

beforeAll(async () => {
  const compiled = await compile(
    metaFiles({
      "project.meta.json": project({ defaultSchema: "app" }),
      "catalogs/Party/Party.meta.json": catalog("Party"),
    })
  )
  expect(compiled.diagnostics).toEqual([])
  desired = await desiredForApply(compiled.model!)
  // Ролі могли лишитися від убитого прогону
  await dropRoles()
  await other(
    testSuperuserUrl(),
    `create role ${OWNER} nologin; grant ${OWNER} to postgres;
     create role ${API_LOGIN} login password '${API_PASSWORD}';
     grant service_role to ${API_LOGIN};
     alter role ${API_LOGIN} set role = 'service_role';
     create role ${LOCKER} login password '${LOCKER_PASSWORD}';`
  )
})
afterAll(dropRoles)

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

/** Ціль: бажаний стан застосування моделі плюс `setup`; базу прибирає порт. */
async function inTarget<T>(
  setup: string,
  fn: (url: string) => Promise<T>
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    desired.sql,
    desired.scope,
    async (target) => {
      await other(target.url, setup)
      return fn(target.url)
    }
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

const read = (url: string): Promise<CatalogFingerprint> =>
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
const desiredFingerprint = (
  url: string,
  steps: readonly PlanStep[]
): Promise<CatalogFingerprint> =>
  fingerprintAfterSteps(url, desired.scope, steps)

/**
 * Бажаний відбиток для тестів, де відмова настає до звірки з ним: порівняння
 * не відбувається, тож зміст не важить, а справжній відбиток створював би
 * враження, що тест його перевіряє.
 */
const NOT_COMPARED: CatalogFingerprint = {
  version: FINGERPRINT_VERSION,
  sections: Object.fromEntries(
    FINGERPRINT_SECTIONS.map((section) => [section, "not-compared"])
  ) as Record<FingerprintSection, string>,
}

/**
 * Каталог двигуна бажаного стану: окрема база, де `setup` і кроки вже
 * виконано, — те, що `applyTool` бере з бажаної тіні.
 */
const desiredCatalog = (
  setup: string,
  steps: readonly PlanStep[]
): Promise<EngineCatalog> =>
  inTarget(
    `${setup};\n${steps.map((s) => `${s.sql};`).join("\n")}`,
    async (url) => (await engine.extract({ url }, desired.scope)).catalog
  )

function step(id: string, sql: string, over: Partial<PlanStep> = {}): PlanStep {
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

const CREATE_N = step("s1", "CREATE TABLE app.n (id int)")
const ALTER_T = step("s1", "ALTER TABLE app.t ADD COLUMN d int", {
  verb: "alter",
  lockClass: "accessExclusive",
  lockedTables: [{ schema: "app", name: "t" }],
})

const EMPTY_MODEL = { tables: [], enumTypes: [], units: [] }

/**
 * Блокування плану за слідом кроків без моделей (кроки тут без FK): власні
 * таблиці, вихідні імена через `newToOld`, детермінований порядок. Право на
 * явний `LOCK` — на кожній таблиці: роль тестів ними володіє.
 */
function locksOf(
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

/** Та сама база цілі, але сесією суперкористувача стеку. */
function asSuperuser(url: string): string {
  const su = new URL(testSuperuserUrl())
  su.pathname = new URL(url).pathname
  return su.toString()
}

/**
 * Перелік провайдера цілі для ролі плану — як його записав би план: ключ
 * переліку — роль плану.
 */
const providerList = (
  url: string,
  role = "postgres"
): Promise<ProviderLockSet[]> =>
  createApplyDatabase({ readOnly: true }).transaction(
    { url },
    "rollback",
    (tx) => readProviderLocks(tx, role, SUPABASE_LOCKS)
  )

/** Шлях пошуку сесії цілі — як його записав би план для ревалідації. */
const sessionPath = (url: string): Promise<string> =>
  createApplyDatabase({ readOnly: true }).transaction(
    { url },
    "rollback",
    readSessionSearchPath
  )

/**
 * Факти сервера й голова ledger цілі — як їх записав би план тією самою
 * транзакцією READ ONLY, що й стан.
 */
const identityOf = (
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
async function planFor(
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
const stubRehearsal: RehearsalProof = {
  engine: {
    plan: () => ({ actions: [], empty: true, preamble: [], diagnostics: [] }),
  },
  desired: {} as EngineCatalog,
}

const options: ExecuteOptions = {
  mode: "apply",
  planHash: PLAN_HASH,
  allow: [],
  snapshot: { tables: [] },
  sleep: async () => {},
}

/** Перше застосування без кроків: marker отримує `hash`. */
async function establish(url: string, hash: string): Promise<void> {
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

interface MarkerRow extends Record<string, unknown> {
  snapshot_hash: string
  plan_hash: string
  fingerprint: Record<string, string>
}

const marker = async (url: string): Promise<MarkerRow | undefined> =>
  (
    await other<MarkerRow>(
      url,
      "select snapshot_hash, plan_hash, fingerprint from simetra.marker"
    )
  )[0]

interface LedgerRow extends Record<string, unknown> {
  plan_hash: string
  from_hash: string | null
  to_hash: string
  allowed: string[]
  drift: DriftReport | null
  no_drift: boolean
  apply_id: string
}

const ledger = (url: string): Promise<LedgerRow[]> =>
  other<LedgerRow>(
    url,
    "select plan_hash, from_hash, to_hash, allowed, drift, drift is null as no_drift, apply_id from simetra.ledger order by id"
  )

const exists = async (url: string, table: string): Promise<boolean> =>
  (
    await other<{ found: boolean }>(
      url,
      `select to_regclass('${table}') is not null as found`
    )
  )[0]!.found

/** Порт, що лічить відкриті транзакції: «до `BEGIN` на цілі» — нуль. */
function counted(db: ApplyDatabase): {
  db: ApplyDatabase
  count: () => number
} {
  let n = 0
  return {
    db: {
      transaction: (target, end, fn) => {
        n++
        return db.transaction(target, end, fn)
      },
    },
    count: () => n,
  }
}

const codes = (outcome: ExecuteOutcome) =>
  outcome.diagnostics.map((d) => d.code)

/**
 * Порт, що після `fn` і до `COMMIT`/`ROLLBACK` виконує `sql` на тій самій
 * транзакції й зберігає рядки: після `ROLLBACK` репетиції дані й режим
 * тригерів повертаються самі, тож перевірка після прогону нічого не доводить.
 */
function observing(
  db: ApplyDatabase,
  sql: string
): { db: ApplyDatabase; rows(): Record<string, unknown>[] } {
  let seen: Record<string, unknown>[] = []
  return {
    db: {
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
function afterEnd(
  db: ApplyDatabase,
  sql: string
): { db: ApplyDatabase; rows(): Record<string, unknown>[] } {
  let seen: Record<string, unknown>[] = []
  return {
    db: {
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
 * як попередній клієнт того самого backend за пулером (Review Focus 4 плану
 * П3-2b-2): `BEGIN` порту закомічено порожнім, `sql` іде поза транзакцією.
 */
function sessionLeftover(db: ApplyDatabase, sql: string): ApplyDatabase {
  return {
    transaction: (target, end, fn) =>
      db.transaction(target, end, async (tx) => {
        await tx.query("COMMIT")
        await tx.query(sql)
        await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED")
        return fn(tx)
      }),
  }
}

describe("executePlan", () => {
  it("applies and records state", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      const outcome = await executePlan(apply, { url }, plan, options)
      expect(outcome).toMatchObject({
        status: "committed",
        attempts: 1,
        diagnostics: [],
      })
      expect(await exists(url, "app.n")).toBe(true)
      expect(await marker(url)).toMatchObject({
        plan_hash: PLAN_HASH,
        snapshot_hash: H1,
      })
      const rows = await ledger(url)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        plan_hash: PLAN_HASH,
        from_hash: null,
        to_hash: H1,
        allowed: [],
        no_drift: true,
      })
      if (outcome.status !== "committed") throw new Error("committed expected")
      expect(rows[0]!.apply_id).toBe(outcome.applyId)
    })
  })

  it("records accepted drift", async () => {
    await inTarget(BASE, async (url) => {
      await establish(url, H1)
      const before = await marker(url)
      await other(url, `alter table app.t owner to ${OWNER}`)
      const fingerprint = await read(url)
      const plan = await planFor(url, [], {
        fromHash: H1,
        toHash: H1,
        drift: DRIFT,
        requiredPermissions: ["drift"],
        desiredFingerprint: fingerprint,
      })

      const refusal = counted(apply)
      const refused = await executePlan(refusal.db, { url }, plan, options)
      expect(refused).toMatchObject({
        status: "refused",
        diagnostics: [
          { code: "apply.permission-required", params: { items: "drift" } },
        ],
      })
      expect(refusal.count()).toBe(0)

      const outcome = await executePlan(apply, { url }, plan, {
        ...options,
        allow: ["drift"],
      })
      expect(outcome).toMatchObject({ status: "committed" })
      const last = (await ledger(url)).at(-1)!
      expect(last).toMatchObject({
        from_hash: H1,
        to_hash: H1,
        allowed: ["drift"],
        drift: DRIFT,
      })
      const after = await marker(url)
      expect(after!.fingerprint).toEqual(fingerprint.sections)
      expect(after!.fingerprint.owner).not.toBe(before!.fingerprint.owner)
    })
  })

  it("keeps every check for a drift-only plan", async () => {
    await inTarget(BASE, async (url) => {
      await establish(url, H1)
      await other(url, `alter table app.t owner to ${OWNER}`)
      const fingerprint = await read(url)
      const plan = await planFor(url, [], {
        fromHash: H1,
        toHash: H1,
        drift: DRIFT,
        requiredPermissions: ["drift"],
        desiredFingerprint: fingerprint,
      })
      const allowed = { ...options, allow: ["drift"] }
      const before = await ledger(url)

      const offChain = await executePlan(
        apply,
        { url },
        { ...plan, fromHash: H2, toHash: H2 },
        allowed
      )
      expect(offChain).toMatchObject({ status: "refused" })
      expect(codes(offChain)).toEqual(["apply.chain"])

      const diverging = await executePlan(
        apply,
        { url },
        {
          ...plan,
          desiredFingerprint: {
            ...fingerprint,
            sections: { ...fingerprint.sections, relations: "0" },
          },
        },
        allowed
      )
      expect(diverging).toMatchObject({
        status: "failed",
        diagnostics: [
          { code: "apply.verify-failed", params: { sections: "relations" } },
        ],
      })

      await other(url, "alter table app.t add column z int")
      const changed = await executePlan(apply, { url }, plan, allowed)
      expect(changed).toMatchObject({ status: "refused" })
      expect(codes(changed)).toEqual(["apply.target-changed"])

      expect(await ledger(url)).toEqual(before)
    })
  })

  it("rehearse leaves no trace", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      const outcome = await executePlan(apply, { url }, plan, {
        ...options,
        mode: "rehearse",
        rehearsal: stubRehearsal,
      })
      expect(outcome).toMatchObject({ status: "rolledBack", attempts: 1 })
      expect(await exists(url, "app.n")).toBe(false)
      expect(await marker(url)).toBeUndefined()
      expect(await ledger(url)).toEqual([])
    })
  })

  it("proves the rehearsal on the same connection", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      const outcome = await executePlan(apply, { url }, plan, {
        ...options,
        mode: "rehearse",
        rehearsal: { engine, desired: await desiredCatalog(BASE, [CREATE_N]) },
      })
      expect(outcome).toMatchObject({ status: "rolledBack", diagnostics: [] })
      expect(await exists(url, "app.n")).toBe(false)
    })
  })

  it("refuses a rehearsal whose result differs from the desired state", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      // Бажаний каталог бази без кроку: після кроку двигун ще має план
      // його прибрати
      const outcome = await executePlan(apply, { url }, plan, {
        ...options,
        mode: "rehearse",
        rehearsal: { engine, desired: await desiredCatalog(BASE, []) },
      })
      expect(outcome).toMatchObject({
        status: "failed",
        diagnostics: [{ code: "apply.rehearsal-proof-failed" }],
      })
      const params = outcome.diagnostics[0]!.params
      expect(Number(params.count)).toBeGreaterThanOrEqual(1)
      expect(String(params.first)).toMatch(/app.*\bn\b/i)
      expect(await exists(url, "app.n")).toBe(false)
      expect(await marker(url)).toBeUndefined()
    })
  })

  describe("the proof that a rehearsal copy is a copy of this target", () => {
    /**
     * Роль-власник об'єктів копії, відновленої під іншими власниками. Ім'я
     * унікальне для прогону, як і ім'я копії: стек спільний, і чужу роль з
     * тим самим ім'ям тест не має права ні зайняти, ні видалити.
     */
    const COPY_OWNER = `simetra_copy_owner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

    /** Ім'я бази з адреси. */
    const nameOf = (url: string): string => new URL(url).pathname.slice(1)

    /** Адреса бази `name` з тими самими роллю й сервером, що й `url`. */
    const onDatabase = (url: string, name: string): string => {
      const at = new URL(url)
      at.pathname = `/${name}`
      return at.toString()
    }

    /**
     * Копія цілі — окрема база стеку `CREATE DATABASE … <how>` з власником
     * `postgres`, як тінь двигуна; прибирається у `finally`, зокрема на шляху
     * падіння: інакше її зловить сторож стеку.
     */
    async function withCopy<T>(
      how: string,
      fn: (url: string) => Promise<T>
    ): Promise<T> {
      const name = `simetra_copy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      await other(
        testSuperuserUrl(),
        `create database ${name} owner postgres ${how}`
      )
      try {
        return await fn(onDatabase(testDatabaseUrl(), name))
      } finally {
        await other(
          testSuperuserUrl(),
          `drop database if exists ${name} with (force)`
        )
      }
    }

    const rehearse = (
      url: string,
      plan: ExecutablePlan,
      proof = stubRehearsal
    ) =>
      executePlan(apply, { url }, plan, {
        ...options,
        mode: "rehearse",
        rehearsal: proof,
      })

    it("refuses a copy with the same chain and another head", async () => {
      // Review Focus 1 плану П3-2b-3: staging того самого проєкту отримав ті
      // самі плани окремими застосуваннями — ланцюжок, роль, відбиток і
      // сервер збігаються, голова ledger — ні
      await inTarget(BASE, (url) =>
        withCopy(`template ${nameOf(url)}`, async (copy) => {
          const first = await planFor(url, [CREATE_N])
          for (const db of [url, copy])
            expect(
              await executePlan(apply, { url: db }, first, options)
            ).toMatchObject({ status: "committed" })
          const next = await planFor(
            url,
            [step("s1", "CREATE TABLE app.m (id int)")],
            { fromHash: H1, toHash: H2 }
          )
          const outcome = await rehearse(copy, next)
          expect(outcome).toMatchObject({
            status: "refused",
            diagnostics: [
              { code: "apply.target-changed", params: { sections: "ledger" } },
            ],
          })
          expect(await exists(copy, "app.m")).toBe(false)
          // Та сама репетиція на самій цілі проходить
          expect(await rehearse(url, next)).toMatchObject({
            status: "rolledBack",
          })
        })
      )
    })

    it("rehearses a copy restored under other owners", async () => {
      // Review Focus 2 плану П3-2b-3 і вимір задачі 0: таблиця без явних
      // грантів (relacl IS NULL) у копії належить ролі, членом якої є роль
      // застосування. Фаза 6 репетиції порівнює без власника й пропускає;
      // повний доказ двигуна бачить дії ACL, і відмова називає причину
      // Створення — до `try`: якщо воно впаде, `finally` не видалить роль,
      // якої цей прогін не створив
      await other(
        testSuperuserUrl(),
        `create role ${COPY_OWNER} nologin; grant ${COPY_OWNER} to postgres;`
      )
      try {
        await inTarget(BASE, (url) =>
          withCopy(`template ${nameOf(url)}`, async (copy) => {
            await other(
              asSuperuser(copy),
              `alter table app.t owner to ${COPY_OWNER}`
            )
            expect(
              await other<{ acl: string | null }>(
                copy,
                "select relacl::text as acl from pg_class where oid = 'app.t'::regclass"
              )
            ).toEqual([{ acl: null }])
            const plan = await planFor(url, [CREATE_N])
            const rehearsed = await rehearse(copy, plan, {
              engine,
              desired: await desiredCatalog(BASE, [CREATE_N]),
            })
            expect(rehearsed).toMatchObject({
              status: "failed",
              diagnostics: [
                {
                  code: "apply.rehearsal-proof-failed",
                  params: { cause: "owners" },
                },
              ],
            })
            const [refusal] = rehearsed.diagnostics
            expect(refusal!.message).toContain(
              "the owners of the copy differ from the target"
            )
            expect(localize(refusal!, "en").hint).toContain(
              "pg_restore --no-owner"
            )
            expect(localize(refusal!, "uk").hint).toContain(
              "pg_restore --no-owner"
            )
            // Та сама різниця на застосуванні — ціль змінилась
            const applied = await executePlan(
              apply,
              { url: copy },
              plan,
              options
            )
            expect(applied).toMatchObject({
              status: "refused",
              diagnostics: [
                { code: "apply.target-changed", params: { sections: "owner" } },
              ],
            })
            expect(await exists(copy, "app.n")).toBe(false)
            expect(await marker(copy)).toBeUndefined()
          })
        )
      } finally {
        // Роль — після баз: бази з її об'єктами вже прибрано
        await other(testSuperuserUrl(), `drop role if exists ${COPY_OWNER}`)
      }
    })

    it("refuses a copy on another server", async () => {
      // Аудит Codex: копія з тією самою схемою й станом, але іншим
      // упорядкуванням — інший факт сервера, відмова до першого кроку. Ціль і
      // копію будує той самий рецепт, різниться лише `LC_COLLATE`/`LC_CTYPE`
      const recipe = `${desired.sql};\n${BASE}`
      await withCopy("template template0", (url) =>
        withCopy(
          "template template0 lc_collate 'C' lc_ctype 'C'",
          async (copy) => {
            await other(url, recipe)
            await other(copy, recipe)
            const plan = await planFor(url, [CREATE_N])
            expect(
              await other<{ collate: string }>(
                copy,
                "select datcollate as collate from pg_database where datname = current_database()"
              )
            ).toEqual([{ collate: "C" }])
            expect(plan.server.collate).not.toBe("C")
            const outcome = await rehearse(copy, plan)
            expect(outcome).toMatchObject({
              status: "refused",
              diagnostics: [
                {
                  code: "apply.target-changed",
                  params: { sections: "server" },
                },
              ],
            })
            expect(await exists(copy, "app.n")).toBe(false)
            // Та сама репетиція на самій цілі проходить
            expect(await rehearse(url, plan)).toMatchObject({
              status: "rolledBack",
            })
          }
        )
      )
    })
  })

  it("refuses when busy", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      // Advisory lock діє в межах бази: тримач — у тій самій базі цілі
      const busy = await holder(url, "select pg_advisory_lock(1397312837, 1)")
      try {
        const outcome = await executePlan(apply, { url }, plan, options)
        expect(outcome).toMatchObject({
          status: "refused",
          attempts: 1,
          diagnostics: [{ code: "apply.busy" }],
        })
      } finally {
        await busy.end()
      }
      expect(await exists(url, "app.n")).toBe(false)
    })
  })

  /** Чи чекає хтось блокування на `app.t`. */
  const waitsOnT = async (url: string): Promise<boolean> =>
    (
      await other<{ waiting: boolean }>(
        url,
        "select exists (select from pg_locks where relation = 'app.t'::regclass and not granted) as waiting"
      )
    )[0]!.waiting

  it("retries on lock timeout", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [ALTER_T])
      const reader = await holder(
        url,
        "begin; lock table app.t in access share mode"
      )
      try {
        const running = executePlan(apply, { url }, plan, {
          ...options,
          timeouts: { lockTimeoutMs: 300 },
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        })
        // Перша спроба чекає блокування, а поки його тримають — здається:
        // зникнення очікувача й доводить вичерпаний `lock_timeout`
        await until("the first attempt to wait", () => waitsOnT(url))
        await until(
          "the first attempt to give up",
          async () => !(await waitsOnT(url))
        )
        await reader.query("rollback")
        const outcome = await running
        expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
        expect(outcome.attempts).toBeGreaterThanOrEqual(2)
      } finally {
        await reader.end()
      }
      expect(
        await other(
          url,
          "select 1 from information_schema.columns where table_schema = 'app' and table_name = 't' and column_name = 'd'"
        )
      ).toHaveLength(1)
    })
  })

  it("gives up after attempts", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [ALTER_T])
      const reader = await holder(
        url,
        "begin; lock table app.t in access share mode"
      )
      try {
        const outcome = await executePlan(apply, { url }, plan, {
          ...options,
          timeouts: { lockTimeoutMs: 100, attempts: 2 },
        })
        expect(outcome).toMatchObject({
          status: "failed",
          attempts: 2,
          diagnostics: [
            { code: "apply.lock-timeout", params: { attempts: 2 } },
          ],
        })
      } finally {
        await reader.end()
      }
      expect(await marker(url)).toBeUndefined()
    })
  })

  /** Та сама база цілі, але сесією іншої ролі входу. */
  const loginAs = (url: string, user: string, password: string): string => {
    const as = new URL(url)
    as.username = user
    as.password = password
    return as.toString()
  }

  it("refuses an API role", async () => {
    await inTarget(BASE, async (url) => {
      // План тієї самої ролі API: збіг ролі плану від відмови не рятує
      const plan = await planFor(url, [CREATE_N], { role: "service_role" })
      const asApi = new URL(url)
      asApi.username = API_LOGIN
      asApi.password = API_PASSWORD
      const outcome = await executePlan(
        apply,
        { url: asApi.toString() },
        plan,
        options
      )
      expect(outcome).toMatchObject({
        status: "refused",
        attempts: 1,
        diagnostics: [
          { code: "apply.api-role", params: { role: "service_role" } },
        ],
      })
      expect(await exists(url, "app.n")).toBe(false)
    })
  })

  it("refuses a plan built for another role", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      const outcome = await executePlan(
        apply,
        { url: loginAs(url, API_LOGIN, API_PASSWORD) },
        plan,
        { ...options, mode: "rehearse", rehearsal: stubRehearsal }
      )
      expect(outcome).toMatchObject({
        status: "refused",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.role-mismatch",
            params: { plan: "postgres", current: "service_role" },
          },
        ],
      })
      expect(await exists(url, "app.n")).toBe(false)
    })
  })

  it("refuses a LOCK the role has no right to, without a retry", async () => {
    // Лише REFERENCES: неявний замок кроку FK він дає, явний LOCK — ні
    const setup = `${BASE};
      grant usage on schema app, simetra to ${LOCKER};
      grant select on all tables in schema simetra to ${LOCKER};
      grant references on app.t to ${LOCKER};`
    await inTarget(setup, async (url) => {
      const plan = await planFor(url, [ALTER_T], { role: LOCKER })
      const outcome = await executePlan(
        apply,
        { url: loginAs(url, LOCKER, LOCKER_PASSWORD) },
        plan,
        { ...options, mode: "rehearse", rehearsal: stubRehearsal }
      )
      expect(outcome).toMatchObject({
        status: "refused",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.lock-privilege",
            params: { mode: "ACCESS EXCLUSIVE", tables: "app.t" },
          },
        ],
      })
    })
  })

  it("reads the right to an explicit LOCK and keeps a table without it implicit", async () => {
    const setup = `${BASE};
      grant usage on schema app, simetra to ${LOCKER};
      grant select on all tables in schema simetra to ${LOCKER};
      grant references on app.t to ${LOCKER};`
    await inTarget(setup, async (url) => {
      const asLocker = { url: loginAs(url, LOCKER, LOCKER_PASSWORD) }
      const reader = createApplyDatabase({ readOnly: true })
      const rights = () =>
        reader.transaction(asLocker, "rollback", (tx) =>
          readLockRights(tx, [
            { schema: "app", name: "t" },
            // Таблиці, якої на цілі немає, у правах немає
            { schema: "app", name: "absent" },
          ])
        )
      const t = tableKey("app", "t")
      expect(await rights()).toEqual(new Map([[t, false]]))
      // Без права таблиця сліду — неявний замок свого кроку
      const footprint = [
        {
          step: "s1",
          tables: [
            { schema: "app", name: "t", mode: "accessExclusive" as const },
          ],
        },
      ]
      expect(planLocks({ footprint, rights: await rights() })).toEqual({
        locks: [],
        implicitLocks: [
          { schema: "app", name: "t", mode: "accessExclusive", step: "s1" },
        ],
      })
      // MAINTAIN (Postgres 17) теж дає явний LOCK
      await other(url, `grant maintain on app.t to ${LOCKER}`)
      expect(await rights()).toEqual(new Map([[t, true]]))
    })
  })

  it("reads the provider lock list of the plan role, only tables that exist", async () => {
    const reader = createApplyDatabase({ readOnly: true })
    const read = (url: string, role: string) =>
      reader.transaction({ url }, "rollback", (tx) =>
        readProviderLocks(tx, role, SUPABASE_LOCKS)
      )
    // База стеку несе всі таблиці провайдера, і перелік — з налаштування
    // supautils цілі, а не з пресету
    const [policy, trigger] = await read(stack.url, "postgres")
    const listed = (setting: string) =>
      other<{ names: string[] }>(
        stack.url,
        `select array(select pg_catalog.json_array_elements_text(
           pg_catalog.current_setting('${setting}')::json -> 'postgres')) as names`
      ).then((rows) => rows[0]!.names)
    for (const [set, setting] of [
      [policy!, "supautils.policy_grants"],
      [trigger!, "supautils.drop_trigger_grants"],
    ] as const) {
      expect(set.setting).toBe(setting)
      const names = await listed(setting)
      expect(set.tables).toContainEqual({ schema: "auth", name: "users" })
      for (const t of set.tables)
        expect(names).toContain(`${t.schema}.${t.name}`)
    }
    expect(policy!.statements).toEqual([
      "createPolicy",
      "alterPolicy",
      "dropPolicy",
      "commentPolicy",
    ])
    expect(trigger!.statements).toEqual(["dropTrigger"])
    // Таблиця з переліку, якої на цілі немає, відсіюється, а не валить план
    await inTarget(BASE, async (url) => {
      await other(asSuperuser(url), "drop table auth.audit_log_entries cascade")
      const [onTarget] = await read(url, "postgres")
      expect(onTarget!.tables).toEqual(
        policy!.tables.filter((t) => t.name !== "audit_log_entries")
      )
    })
    // Роль поза переліком — таблиць немає, без відмови
    expect(
      (await read(stack.url, "authenticated")).map((s) => s.tables)
    ).toEqual([[], []])
  })

  it("leaves out a listed table in a schema the plan role cannot use, without aborting the read", async () => {
    // Роль тестів має `pg_read_all_data`, тобто USAGE на кожній схемі, тож
    // роль плану без USAGE — окремий вхід; ключ переліку — той самий
    const setup = `${BASE};
      grant usage on schema app to ${LOCKER};
      grant update on app.t to ${LOCKER};`
    await inTarget(setup, async (url) => {
      await other(
        asSuperuser(url),
        `revoke all on schema realtime from public;
         grant usage on schema auth to ${LOCKER}`
      )
      const asLocker = loginAs(url, LOCKER, LOCKER_PASSWORD)
      const [usage] = await other<{ usable: boolean }>(
        asLocker,
        "select pg_catalog.has_schema_privilege('realtime', 'USAGE') as usable"
      )
      expect(usage!.usable).toBe(false)
      // `to_regclass` тут кидає 42501 — саме це зірвало б транзакцію плану
      await expect(
        other(asLocker, "select to_regclass('realtime.messages')")
      ).rejects.toMatchObject({ code: "42501" })
      const reader = createApplyDatabase({ readOnly: true })
      const { sets, rights } = await reader.transaction(
        { url: asLocker },
        "rollback",
        async (tx) => {
          const sets = await readProviderLocks(tx, "postgres", SUPABASE_LOCKS)
          // Транзакція жива: наступне читання плану проходить
          const rights = await readLockRights(tx, [
            { schema: "app", name: "t" },
          ])
          return { sets, rights }
        }
      )
      const tables = sets.flatMap((set) => set.tables)
      expect(tables).toContainEqual({ schema: "auth", name: "users" })
      expect(tables.filter((t) => t.schema === "realtime")).toEqual([])
      expect(rights).toEqual(new Map([[tableKey("app", "t"), true]]))
    })
  })

  it("refuses before the locks when the provider list changed after the plan", async () => {
    await inTarget(BASE, async (url) => {
      // План побудовано з переліком, де таблиця ще є; на цілі її вже немає
      const plan = await planFor(url, [ALTER_T])
      expect(
        plan.providerLocks.some((set) =>
          set.tables.some((t) => t.name === "audit_log_entries")
        )
      ).toBe(true)
      await other(asSuperuser(url), "drop table auth.audit_log_entries cascade")
      // Читач `app.t` конфліктує з ACCESS EXCLUSIVE: спроба замка чекала б
      const reader = await holder(
        url,
        "begin; lock table app.t in access share mode"
      )
      try {
        const outcome = await executePlan(apply, { url }, plan, {
          ...options,
          timeouts: { lockTimeoutMs: 15_000 },
        })
        expect(outcome).toMatchObject({
          status: "refused",
          attempts: 1,
          diagnostics: [
            {
              code: "apply.target-changed",
              params: { sections: "providerLocks" },
            },
          ],
        })
      } finally {
        await reader.query("rollback")
        await reader.end()
      }
      expect(await ledger(url)).toEqual([])
    })
  })

  describe("foreign keys of the footprint", () => {
    // Рішення 9 плану П3-2b-1: схема `other` поза межею, крок змінює тип
    // колонки, на яку FK з неї посилався б
    const setup = `${BASE};
      create schema other;`
    const RETYPE = step("s1", "ALTER TABLE app.t ALTER COLUMN id TYPE bigint", {
      verb: "alter",
      lockClass: "accessExclusive",
      lockedTables: [{ schema: "app", name: "t" }],
    })
    const subjects = [{ schema: "app", name: "t" }]

    /** План, що прочитав FK `app.t` так, як це робить `lockPlan`. */
    async function watched(url: string): Promise<ExecutablePlan> {
      const live = await createApplyDatabase({ readOnly: true }).transaction(
        { url },
        "rollback",
        (tx) => readLiveForeignKeys(tx, subjects)
      )
      expect(live).toEqual([])
      return planFor(url, [RETYPE], {
        foreignKeys: { subjects, live },
        desiredFingerprint: await desiredFingerprint(url, [RETYPE]),
      })
    }

    const idType = async (url: string): Promise<string> =>
      (
        await other<{ type: string }>(
          url,
          `select format_type(atttypid, atttypmod) as type from pg_attribute
            where attrelid = 'app.t'::regclass and attname = 'id'`
        )
      )[0]!.type

    it("refuses when a foreign key outside the scope appeared after the plan", async () => {
      await inTarget(setup, async (url) => {
        const plan = await watched(url)
        await other(url, "create table other.r (t int references app.t)")
        const outcome = await executePlan(apply, { url }, plan, options)
        expect(outcome).toMatchObject({
          status: "refused",
          attempts: 1,
          diagnostics: [
            {
              code: "apply.target-changed",
              params: { sections: "foreignKeys" },
            },
          ],
        })
        // Кроків не виконано
        expect(await idType(url)).toBe("integer")
        expect(await ledger(url)).toEqual([])
      })
    })

    it("applies when the foreign keys are as planned", async () => {
      await inTarget(setup, async (url) => {
        const plan = await watched(url)
        expect(await executePlan(apply, { url }, plan, options)).toMatchObject({
          status: "committed",
        })
        expect(await idType(url)).toBe("bigint")
      })
    })
  })

  it("needs the right on the table itself only, its children are locked with it", async () => {
    // Рішення 10 плану П3-2b-1: права нащадка LOCK без ONLY не перевіряє
    const setup = `${BASE};
      create table app.it (id int);
      create table app.it_child () inherits (app.it);
      grant usage on schema app to ${LOCKER};
      grant update on app.it to ${LOCKER};`
    await inTarget(setup, async (url) => {
      const asLocker = { url: loginAs(url, LOCKER, LOCKER_PASSWORD) }
      const rights = await createApplyDatabase({ readOnly: true }).transaction(
        asLocker,
        "rollback",
        (tx) => readLockRights(tx, [{ schema: "app", name: "it" }])
      )
      expect(rights).toEqual(new Map([[tableKey("app", "it"), true]]))
      const held = await apply.transaction(asLocker, "rollback", async (tx) => {
        await tx.query("LOCK TABLE app.it IN ACCESS EXCLUSIVE MODE")
        return tx.query<{ child: boolean; mode: string }>(
          `select l.relation = 'app.it_child'::regclass as child, l.mode
             from pg_locks l
            where l.pid = pg_backend_pid() and l.granted
              and l.relation in ('app.it'::regclass, 'app.it_child'::regclass)
            order by child`
        )
      })
      expect(held).toEqual([
        { child: false, mode: "AccessExclusiveLock" },
        { child: true, mode: "AccessExclusiveLock" },
      ])
    })
  })

  it("locks the children of a table up front and plans them in its mode", async () => {
    const setup = `${BASE};
      create table app.pt (id int, k int) partition by list (k);
      create table app.pt_1 partition of app.pt for values in (1);
      create table app.it (id int);
      create table app.it_child () inherits (app.it);`
    await inTarget(setup, async (url) => {
      const steps = [
        step("s1", "ALTER TABLE app.pt ADD COLUMN x int", {
          verb: "alter",
          lockClass: "accessExclusive",
          lockedTables: [{ schema: "app", name: "pt" }],
        }),
        step("s2", "ALTER TABLE app.it ADD COLUMN x int", {
          verb: "alter",
          lockClass: "accessExclusive",
          lockedTables: [{ schema: "app", name: "it" }],
        }),
      ]
      const plan = await planFor(url, steps, {
        desiredFingerprint: await desiredFingerprint(url, steps),
      })
      expect(plan.locks).toEqual([
        { schema: "app", name: "it", mode: "accessExclusive" },
        { schema: "app", name: "pt", mode: "accessExclusive" },
      ])
      // Читач партиції: замок без ONLY чекає на неї ще до кроків
      const reader = await holder(
        url,
        "begin; lock table app.pt_1 in access share mode"
      )
      try {
        const running = executePlan(apply, { url }, plan, {
          ...options,
          mode: "rehearse",
          rehearsal: stubRehearsal,
          timeouts: { lockTimeoutMs: 15_000 },
        })
        let waiting: { query: string; mode: string } | undefined
        await until("the apply to wait on the partition", async () => {
          ;[waiting] = await other<{ query: string; mode: string }>(
            url,
            `select a.query, l.mode from pg_locks l
               join pg_stat_activity a on a.pid = l.pid
              where l.relation = 'app.pt_1'::regclass and not l.granted
                -- Знімок pg_stat_activity окремий від pg_locks: без цієї
                -- умови він міг показати попередній оператор того backend
                and a.wait_event_type = 'Lock'`
          )
          return waiting !== undefined
        })
        expect(waiting!.mode).toBe("AccessExclusiveLock")
        expect(waiting!.query).toMatch(
          /^LOCK TABLE app\.it, app\.pt IN ACCESS EXCLUSIVE MODE$/
        )
        await reader.query("rollback")
        // Нащадки заплановано в режимі батька: звірка сліду мовчить
        expect(await running).toMatchObject({
          status: "rolledBack",
          diagnostics: [],
        })
      } finally {
        await reader.end()
      }
    })
  })

  it("warns on rehearsal about a lock beyond the plan's footprint", async () => {
    await inTarget(BASE, async (url) => {
      // Слід без власної таблиці кроку: замок береться посеред кроків
      const plan = await planFor(url, [ALTER_T], { locks: [] })
      const outcome = await executePlan(apply, { url }, plan, {
        ...options,
        mode: "rehearse",
        rehearsal: stubRehearsal,
      })
      expect(outcome).toMatchObject({
        status: "rolledBack",
        diagnostics: [
          {
            code: "apply.lock-footprint-exceeded",
            severity: "warning",
            params: {
              table: "app.t",
              mode: "ACCESS EXCLUSIVE",
              planned: "none",
            },
          },
        ],
      })
      // З повним слідом — тиша
      const full = await planFor(url, [ALTER_T])
      expect(
        await executePlan(apply, { url }, full, {
          ...options,
          mode: "rehearse",
          rehearsal: stubRehearsal,
        })
      ).toMatchObject({ status: "rolledBack", diagnostics: [] })
    })
  })

  it("refuses an off-chain plan", async () => {
    await inTarget(BASE, async (url) => {
      await establish(url, H1)
      const plan = await planFor(url, [CREATE_N], {
        fromHash: H2,
        toHash: "3".repeat(64),
      })
      const outcome = await executePlan(apply, { url }, plan, options)
      expect(outcome).toMatchObject({
        status: "refused",
        diagnostics: [
          { code: "apply.chain", params: { expected: H2, found: H1 } },
        ],
      })
      expect(await exists(url, "app.n")).toBe(false)
    })
  })

  it("refuses a changed target", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      await other(url, "alter table app.t add column z int")
      const outcome = await executePlan(apply, { url }, plan, options)
      expect(outcome).toMatchObject({ status: "refused" })
      expect(codes(outcome)).toEqual(["apply.target-changed"])
      expect(outcome.diagnostics[0]!.params.sections).toContain("columns")
      expect(await exists(url, "app.n")).toBe(false)
      expect(await marker(url)).toBeUndefined()
    })
  })

  it("refuses a vanished locked table", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [ALTER_T])
      // Таблицю прибрано за спиною платформи вже після плану
      await other(url, "drop table app.t")
      const outcome = await executePlan(apply, { url }, plan, options)
      expect(outcome).toMatchObject({
        status: "refused",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.target-changed",
            params: { sections: "relations" },
          },
        ],
      })
      expect(await marker(url)).toBeUndefined()
      expect(await ledger(url)).toEqual([])
    })
  })

  /**
   * Перейменування наміром і крок двигуна, що називає таблицю вже новим
   * іменем (рішення 9 плану П3-2a). Артефакт зібрано вручну: конвеєр плану
   * з промоцією з'являється пізніше (R12).
   */
  const renamePlan = (url: string) => {
    const steps: PlanStep[] = [
      {
        ...intentStep("ALTER TABLE app.t RENAME TO u", [
          { schema: "app", name: "t" },
        ]),
        id: "s1",
      },
      step("s2", "ALTER TABLE app.u ADD COLUMN d int", {
        verb: "alter",
        lockClass: "accessExclusive",
        lockedTables: [{ schema: "app", name: "u" }],
      }),
    ]
    const newToOld = new Map([[tableKey("app", "u"), tableKey("app", "t")]])
    return planFor(url, steps, { locks: locksOf(steps, newToOld) })
  }

  it("locks a renamed table by its old name", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await renamePlan(url)
      expect(plan.locks).toEqual([
        { schema: "app", name: "t", mode: "accessExclusive" },
      ])
      const outcome = await executePlan(apply, { url }, plan, options)
      expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
      expect(await exists(url, "app.u")).toBe(true)
      expect(await exists(url, "app.t")).toBe(false)
    })
  })

  // Review Focus 3 плану П3-2a
  it("refuses with target-changed when a renamed table vanished before apply", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await renamePlan(url)
      // Таблицю зі старим ім'ям прибрано за спиною платформи після плану
      await other(url, "drop table app.t")
      const outcome = await executePlan(apply, { url }, plan, options)
      expect(outcome).toMatchObject({
        status: "refused",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.target-changed",
            params: { sections: "relations" },
          },
        ],
      })
      expect(await marker(url)).toBeUndefined()
      expect(await ledger(url)).toEqual([])
    })
  })

  it("takes SHARE ROW EXCLUSIVE on FK targets up front", async () => {
    const setup = `${BASE};
      create table app.p (id int primary key);
      create table app.c (id int primary key, p int);`
    await inTarget(setup, async (url) => {
      const steps = [
        step(
          "s1",
          "ALTER TABLE app.c ADD CONSTRAINT c_p_fk FOREIGN KEY (p) REFERENCES app.p (id)",
          {
            verb: "alter",
            lockClass: "accessExclusive",
            lockedTables: [{ schema: "app", name: "c" }],
          }
        ),
      ]
      // Слід кроку FK: власна таблиця й ціль FK (виведення сліду — у
      // модульних тестах і тестах плану)
      const plan = await planFor(url, steps, {
        locks: [
          { schema: "app", name: "c", mode: "accessExclusive" },
          { schema: "app", name: "p", mode: "shareRowExclusive" },
        ],
        desiredFingerprint: await desiredFingerprint(url, steps),
      })
      // Запис у ціль FK тримає ROW EXCLUSIVE, що конфліктує з SHARE ROW
      // EXCLUSIVE перевірки FK
      const writer = await holder(
        url,
        "begin; lock table app.p in row exclusive mode"
      )
      try {
        const running = executePlan(apply, { url }, plan, {
          ...options,
          timeouts: { lockTimeoutMs: 15_000 },
        })
        let waiting: { query: string; mode: string } | undefined
        await until("the apply to wait on the FK target", async () => {
          ;[waiting] = await other<{ query: string; mode: string }>(
            url,
            `select a.query, l.mode from pg_locks l
               join pg_stat_activity a on a.pid = l.pid
              where l.relation = 'app.p'::regclass and not l.granted
                -- Знімок pg_stat_activity окремий від pg_locks: без цієї
                -- умови він міг показати попередній оператор того backend
                and a.wait_event_type = 'Lock'`
          )
          return waiting !== undefined
        })
        // Очікування — на блокуванні наперед, а не посеред кроку
        expect(waiting!.mode).toBe("ShareRowExclusiveLock")
        expect(waiting!.query).toMatch(
          /^LOCK TABLE app\.p IN SHARE ROW EXCLUSIVE MODE$/
        )
        await writer.query("rollback")
        expect(await running).toMatchObject({ status: "committed" })
      } finally {
        await writer.end()
      }
    })
  })

  describe("engine preamble", () => {
    /** Що бачить кожна фаза: намір, крок двигуна, запис стану. */
    const SEEN = `${BASE};
      create table app.seen (at text, path text, bodies text);
      create function app.seen_state() returns trigger language plpgsql as $$
      begin
        insert into app.seen values ('state', current_setting('search_path'), current_setting('check_function_bodies'));
        return null;
      end $$;
      create trigger seen_state after insert on simetra.ledger
        for each row execute function app.seen_state();`
    const record = (at: string) =>
      `INSERT INTO app.seen VALUES ('${at}', current_setting('search_path'), current_setting('check_function_bodies'))`

    const seen = async (preamble: ExecutablePlan["preamble"]) =>
      inTarget(SEEN, async (target) => {
        const steps: PlanStep[] = [
          { ...intentStep(record("intent"), []), id: "s1" },
          step("s2", record("engine"), { verb: "alter" }),
          step("s3", record("environment"), { origin: "environment" }),
        ]
        const plan = await planFor(target, steps, {
          preamble,
          desiredFingerprint: await desiredFingerprint(target, steps),
        })
        const outcome = await executePlan(apply, { url: target }, plan, options)
        expect(outcome).toMatchObject({ status: "committed" })
        const rows = await other<{ at: string; path: string; bodies: string }>(
          target,
          "select at, path, bodies from app.seen"
        )
        return Object.fromEntries(rows.map((r) => [r.at, r]))
      })

    // R22 плану П3-2a, рішення 1 плану П3-2b-1: преамбула — лише навколо
    // блоку кроків двигуна, бо тіла функцій після кроків перевіряє ревалідація
    it("runs engine steps under the preamble and the other steps under the transaction settings", async () => {
      const rows = await seen([
        { name: "search_path", value: "pg_catalog" },
        { name: "check_function_bodies", value: "off" },
      ])
      expect(rows.engine).toMatchObject({ path: "pg_catalog", bodies: "off" })
      expect(rows.intent!.path).not.toBe("pg_catalog")
      expect(rows.intent!.bodies).toBe("on")
      // Після кроків двигуна налаштування знову ті, що до них
      expect(rows.environment).toEqual({ ...rows.intent, at: "environment" })
      expect(rows.state).toEqual({ ...rows.intent, at: "state" })
    })

    it("runs a preamble of the search path alone as it is", async () => {
      const rows = await seen([{ name: "search_path", value: "pg_catalog" }])
      expect(rows.engine).toMatchObject({ path: "pg_catalog", bodies: "on" })
      expect(rows.state).toEqual({ ...rows.intent, at: "state" })
    })

    it("proves a SQL function whose body names a table of public without schema", async () => {
      // Під `search_path = pg_catalog` при ввімкненій валідації тіл
      // `CREATE FUNCTION` упав би: `zz_rows` не знайшлася б (рев'ю I1)
      const setup = `${BASE};
        create table public.zz_rows (id int);
        insert into public.zz_rows values (1), (2);`
      const steps = [
        step(
          "s1",
          "CREATE FUNCTION app.count_rows() RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*) FROM zz_rows $$"
        ),
      ]
      const outcome = await inTarget(setup, async (url) =>
        executePlan(
          apply,
          { url },
          await planFor(url, steps, {
            preamble: [
              { name: "search_path", value: "pg_catalog" },
              { name: "check_function_bodies", value: "off" },
            ],
            desiredFingerprint: await desiredFingerprint(url, steps),
          }),
          { ...options, mode: "proof" }
        )
      )
      expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
    })
  })

  describe("preservation proof", () => {
    /**
     * Промоція `app.pt` → `app.pu` з перейменуванням `c` → `d` і зміною типу
     * `x` (рішення 6 плану П3-2a). Артефакт зібрано вручну, як у
     * `renamePlan`: конвеєр плану з промоцією з'являється пізніше.
     */
    const OBJECT_ID = "00000000-0000-4000-8000-000000000001"
    const SETUP = `${BASE};
      create table app.pt (id int primary key, c text, x bigint);
      insert into app.pt values (1, 'a', 10), (2, null, 20), (3, 'n', 30);`

    const RECORD: PromotionRecord = {
      format: 1,
      base: "0".repeat(64),
      result: "1".repeat(64),
      objectId: OBJECT_ID,
      kind: "Catalog",
      labelDropped: false,
      tables: [{ id: OBJECT_ID, schema: "app", from: "pt", to: "pu" }],
      columns: [
        ["id", "id"],
        ["c", "d"],
        ["x", "x"],
      ].map(([from, to], n) => ({
        id: `00000000-0000-4000-8000-00000000010${n}`,
        sourceId: `00000000-0000-4000-8000-00000000020${n}`,
        schema: "app",
        table: "pu",
        from: from!,
        to: to!,
      })),
      typeChanges: [
        {
          schema: "app",
          table: "pu",
          column: "x",
          from: "bigint",
          to: "integer",
        },
      ],
      dataSteps: [],
      retired: [],
      relaxed: [],
      tightened: [],
      rowLevelSecurity: [],
      deleteSemantics: [],
      conversions: [],
      movedUnits: [],
      rewrittenUnits: [],
      contractChanges: [],
    }

    /** Таблиця вихідного стану: заміри беруть із неї первинний ключ. */
    const source: PhysicalTable = {
      schema: "app",
      name: "pt",
      origin: { objectId: OBJECT_ID },
      rowLevelSecurity: "off",
      columns: [],
      primaryKey: { name: "pt_pkey", columns: ["id"] },
      uniques: [],
      checks: [],
      foreignKeys: [],
      indexes: [],
    }

    const TYPE_STEP = "s3"

    /** Намір, крок зміни типу `x` і, за потреби, штучний крок після них. */
    async function promotionPlan(
      url: string,
      over: { extra?: string; stops?: boolean } = {}
    ): Promise<ExecutablePlan> {
      const newToOld = new Map([[tableKey("app", "pu"), tableKey("app", "pt")]])
      const old = [{ schema: "app", name: "pt" }]
      const steps: PlanStep[] = [
        { ...intentStep("ALTER TABLE app.pt RENAME TO pu", old), id: "s1" },
        {
          ...intentStep("ALTER TABLE app.pu RENAME COLUMN c TO d", old),
          id: "s2",
        },
        step(TYPE_STEP, "ALTER TABLE app.pu ALTER COLUMN x TYPE integer", {
          verb: "alter",
          lockClass: "accessExclusive",
          lockedTables: [{ schema: "app", name: "pu" }],
        }),
        ...(over.extra === undefined
          ? []
          : [step("s4", over.extra, { verb: "alter" })]),
      ]
      const preservation = preservationPlan(
        RECORD,
        {
          steps: [],
          tablesNewToOld: newToOld,
          tempNames: new Map(),
          columns: [],
        },
        { tables: [source] },
        new Map([[JSON.stringify(["app", "pu", "x"]), TYPE_STEP]]),
        []
      )
      return planFor(url, steps, {
        locks: locksOf(steps, newToOld),
        promotion: {
          recordHash: await promotionRecordHash(RECORD),
          record: RECORD,
          permissionItems: [],
          preservation,
          columns: [
            { table: { schema: "app", name: "pu" }, from: "c", to: "d" },
          ],
          canonicalNames: [],
          conversions: [],
          data: [],
        },
        // Розбіжність зупиняє спробу до звірки з бажаним відбитком
        desiredFingerprint:
          over.extra === undefined && over.stops !== true
            ? await desiredFingerprint(url, steps)
            : NOT_COMPARED,
      })
    }

    const rehearse = {
      ...options,
      mode: "rehearse",
      rehearsal: stubRehearsal,
    } as const

    /** Ціль не змінилася: таблиця під старим іменем зі старими даними. */
    const untouched = async (url: string) =>
      expect(
        await other(url, "select id, c, x::text from app.pt order by id")
      ).toEqual([
        { id: 1, c: "a", x: "10" },
        { id: 2, c: null, x: "20" },
        { id: 3, c: "n", x: "30" },
      ])

    it("proves rows and mapped values survive the renames", async () => {
      await inTarget(SETUP, async (url) => {
        const plan = await promotionPlan(url)
        const outcome = await executePlan(apply, { url }, plan, rehearse)
        expect(outcome).toMatchObject({ status: "rolledBack", diagnostics: [] })
        await untouched(url)
      })
    })

    it("tells NULL from a text that looks like the null marker", async () => {
      await inTarget(SETUP, async (url) => {
        const plan = await promotionPlan(url, {
          extra: "UPDATE app.pu SET d = NULL WHERE d = 'n'",
        })
        const outcome = await executePlan(apply, { url }, plan, rehearse)
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.preservation-failed",
              params: { table: "app.pu", column: "d" },
            },
          ],
        })
        await untouched(url)
      })
    })

    it("catches a step that changes a mapped value", async () => {
      await inTarget(SETUP, async (url) => {
        const plan = await promotionPlan(url, {
          extra: "UPDATE app.pu SET x = 21 WHERE id = 2",
        })
        const outcome = await executePlan(apply, { url }, plan, rehearse)
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.preservation-failed",
              params: { table: "app.pu", column: "x" },
            },
          ],
        })
        expect(outcome.diagnostics[0]!.params).not.toHaveProperty("rows")
        await untouched(url)
      })
    })

    it("catches a lost row", async () => {
      await inTarget(SETUP, async (url) => {
        const plan = await promotionPlan(url, {
          extra: "DELETE FROM app.pu WHERE id = 3",
        })
        const outcome = await executePlan(apply, { url }, plan, rehearse)
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.preservation-failed",
              params: { table: "app.pu", rows: "3 → 2" },
            },
          ],
        })
        expect(outcome.diagnostics[0]!.params).not.toHaveProperty("column")
        await untouched(url)
      })
    })

    it("takes the longest statement of a large table from its measure", async () => {
      // Рішення 3–4 плану П3-2b-3: без повільного кроку двигуна найдовший
      // оператор репетиції — замір великої таблиці, і саме він, а не сума
      // фази, входить у формулу тайм-ауту застосування
      const record: PromotionRecord = { ...RECORD, typeChanges: [] }
      const setup = `${BASE};
        create table app.pt (id int primary key, c text, x bigint);
        alter table app.pt set (autovacuum_enabled = false);
        insert into app.pt
          select g, md5(g::text), g from generate_series(1, 500000) g;`
      await inTarget(setup, async (url) => {
        const newToOld = new Map([
          [tableKey("app", "pu"), tableKey("app", "pt")],
        ])
        const old = [{ schema: "app", name: "pt" }]
        const steps: PlanStep[] = [
          { ...intentStep("ALTER TABLE app.pt RENAME TO pu", old), id: "s1" },
          {
            ...intentStep("ALTER TABLE app.pu RENAME COLUMN c TO d", old),
            id: "s2",
          },
        ]
        const preservation = preservationPlan(
          record,
          {
            steps: [],
            tablesNewToOld: newToOld,
            tempNames: new Map(),
            columns: [],
          },
          { tables: [source] },
          new Map(),
          []
        )
        const plan = await planFor(url, steps, {
          locks: locksOf(steps, newToOld),
          promotion: {
            recordHash: await promotionRecordHash(record),
            record,
            permissionItems: [],
            preservation,
            columns: [
              { table: { schema: "app", name: "pu" }, from: "c", to: "d" },
            ],
            canonicalNames: [],
            conversions: [],
            data: [],
          },
        })
        const outcome = await executePlan(apply, { url }, plan, rehearse)
        if (outcome.status !== "rolledBack")
          throw new Error(
            `not rolled back: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
          )
        const { evidence } = outcome
        expect(evidence.rows).toEqual([
          { schema: "app", table: "pt", rows: 500000 },
        ])
        expect(evidence.preservation).toEqual(evidence.rows)
        // Найдовший — за сирим виміром: округлення звіту могло б зрівняти
        // два заміри; звіт бере його округленим угору
        const timed = evidence.durations.steps
        const max = Math.max(...timed.map((s) => s.ms))
        const longest = timed.filter((s) => s.ms === max)
        expect(longest.map((s) => s.id)).toEqual([
          expect.stringMatching(/^measure(Before|After)-\d+$/),
        ])
        expect(
          rehearsalReport("e".repeat(64), evidence).durations.longestStatementMs
        ).toBe(Math.ceil(max))
      })
    })

    it("sets the statement timeout from the report", async () => {
      // Review Focus 5 на базі: тригер на ledger бачить тайм-аут, з яким
      // йде транзакція після фази 6c, — стан пишеться після всіх кроків
      const record: PromotionRecord = { ...RECORD, typeChanges: [] }
      const setup = `${SETUP};
        create table app.seen (timeout text);
        create function app.seen_timeout() returns trigger language plpgsql as $$
        begin
          insert into app.seen
            select setting from pg_catalog.pg_settings where name = 'statement_timeout';
          return null;
        end $$;
        create trigger seen_timeout after insert on simetra.ledger
          for each row execute function app.seen_timeout();`
      await inTarget(setup, async (url) => {
        const newToOld = new Map([
          [tableKey("app", "pu"), tableKey("app", "pt")],
        ])
        const old = [{ schema: "app", name: "pt" }]
        const steps: PlanStep[] = [
          { ...intentStep("ALTER TABLE app.pt RENAME TO pu", old), id: "s1" },
          {
            ...intentStep("ALTER TABLE app.pu RENAME COLUMN c TO d", old),
            id: "s2",
          },
        ]
        const preservation = preservationPlan(
          record,
          {
            steps: [],
            tablesNewToOld: newToOld,
            tempNames: new Map(),
            columns: [],
          },
          { tables: [source] },
          new Map(),
          []
        )
        // Бажаний відбиток — з тригером: він частина цілі
        const plan = await planFor(url, steps, {
          locks: locksOf(steps, newToOld),
          plpgsqlCheck: "transient",
          promotion: {
            recordHash: await promotionRecordHash(record),
            record,
            permissionItems: [],
            preservation,
            columns: [
              { table: { schema: "app", name: "pu" }, from: "c", to: "d" },
            ],
            canonicalNames: [],
            conversions: [],
            data: [],
          },
        })
        // Копія з одним рядком, ціль — з трьома: ⌈3 × 30 000 × 3 / 1⌉
        const report: RehearsalReport = {
          format: 1,
          planHash: PLAN_HASH,
          server: plan.server,
          ledgerHead: plan.ledgerHead,
          rows: [{ schema: "app", table: "pt", rows: 1 }],
          durations: { phases: [], steps: [], longestStatementMs: 30_000 },
          data: [],
          preservation: [{ schema: "app", table: "pt", rows: 1 }],
          plpgsqlCheck: "skipped",
          triggers: [],
          lockFootprint: [],
        }
        const outcome = await executePlan(apply, { url }, plan, {
          ...options,
          report,
        })
        expect(outcome).toMatchObject({
          status: "committed",
          diagnostics: [
            {
              code: "apply.rehearsal-fewer-rows",
              params: { table: "app.pt", copy: 1, target: 3 },
            },
          ],
        })
        expect(await other(url, "select timeout from app.seen")).toEqual([
          { timeout: "270000" },
        ])
        expect(
          await other(url, "select rehearsal_hash from simetra.ledger")
        ).toEqual([{ rehearsal_hash: await rehearsalHash(report) }])
      })
    })

    it("reports a failing cast in the before measurement as narrowing", async () => {
      const setup = `${SETUP}; insert into app.pt values (4, 'b', 1099511627776);`
      await inTarget(setup, async (url) => {
        const plan = await promotionPlan(url, { stops: true })
        const outcome = await executePlan(apply, { url }, plan, rehearse)
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.type-narrowing",
              params: {
                step: TYPE_STEP,
                table: "app.pu",
                column: "x",
                sqlstate: "22003",
              },
            },
          ],
        })
        expect(await exists(url, "app.pt")).toBe(true)
      })
    })

    it("names the table whose preservation measure fails", async () => {
      // Вираз заміру падає не на приведенні (колонки немає, 42703), тож це не
      // звуження, а збій заміру: без нього доказу збереження немає
      await inTarget(SETUP, async (url) => {
        const plan = await promotionPlan(url)
        const [table] = plan.promotion!.preservation
        const broken: ExecutablePlan = {
          ...plan,
          promotion: {
            ...plan.promotion!,
            preservation: [
              {
                ...table!,
                columns: table!.columns.map((c, n) =>
                  n === 1 ? { ...c, before: "no_such_column" } : c
                ),
              },
            ],
          },
        }
        const outcome = await executePlan(apply, { url }, broken, rehearse)
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.preservation-measure-failed",
              params: { table: "app.pt", side: "before", sqlstate: "42703" },
            },
          ],
        })
        await untouched(url)
      })
    })
  })

  describe.each(["proof", "rehearse"] as const)("data steps (%s)", (mode) => {
    /**
     * Промоція `app.dt` → `app.du` з кроками даних (план П3-2b-2, задача 5).
     * Артефакт зібрано вручну, як у `preservation proof`: секцію `data`
     * будує план, а тут раннер має отримати саме її. Змаплені колонки
     * зберігають імена; незмаплена ціль з'являється кроком наміру.
     */
    const OBJECT_ID = "00000000-0000-4000-8000-000000000001"

    interface Fill {
      column: string
      expression: string
      kind: DataStepKind
      /** Тип запису: для змапленої цілі зі зміною типу — старий. */
      type: string
      /** Ціль — наявна колонка таблиці, а не нова. */
      mapped?: boolean
    }

    interface DataCase {
      /** Колонки старої таблиці, крім ключа `id`. */
      columns: string[]
      fills: Fill[]
      triggers?: DataTable["triggers"]
      /** Зміна типу змапленої колонки кроком двигуна `s3` зі сторожем. */
      typeChange?: { column: string; from: string; to: string }
      /** Спроба зупиняється до звірки з бажаним відбитком. */
      stops?: boolean
      /** Кроки двигуна після запису (і після зміни типу, коли вона є). */
      engine?: PlanStep[]
      /** Друга таблиця одиниці — табличну частину `app.ds` → `app.dv`. */
      second?: Pick<DataCase, "columns" | "fills" | "triggers">
    }

    const TYPE_STEP = "s3"
    const SECTION_ID = "00000000-0000-4000-8000-000000000002"

    async function dataStepPlan(
      url: string,
      c: DataCase
    ): Promise<ExecutablePlan> {
      const parse = await loadSqlParser()
      // Таблиці одиниці в порядку запису; ідентифікатори колонок — свої в
      // кожної, а номери кроків наскрізні, як їх дає план
      const sides = [
        {
          id: OBJECT_ID,
          from: "dt",
          to: "du",
          ids: ["1", "2"],
          columns: c.columns,
          fills: c.fills,
          triggers: c.triggers,
        },
        ...(c.second === undefined
          ? []
          : [
              {
                id: SECTION_ID,
                from: "ds",
                to: "dv",
                ids: ["3", "4"],
                ...c.second,
              },
            ]),
      ]
      const record: PromotionRecord = {
        format: 1,
        base: "0".repeat(64),
        result: "1".repeat(64),
        objectId: OBJECT_ID,
        kind: "Catalog",
        labelDropped: false,
        tables: sides.map((s) => ({
          id: s.id,
          schema: "app",
          from: s.from,
          to: s.to,
        })),
        columns: sides.flatMap((s) =>
          ["id", ...s.columns].map((name, n) => ({
            id: `00000000-0000-4000-8000-000000000${s.ids[0]}0${n}`,
            sourceId: `00000000-0000-4000-8000-000000000${s.ids[1]}0${n}`,
            schema: "app",
            table: s.to,
            from: name,
            to: name,
          }))
        ),
        typeChanges:
          c.typeChange === undefined
            ? []
            : [{ schema: "app", table: "du", ...c.typeChange }],
        dataSteps: sides.flatMap((s) =>
          s.fills.map((f) => ({
            names: "beforeRenames" as const,
            schema: "app",
            table: s.from,
            key: "id",
            column: f.column,
            expression: f.expression,
            kind: f.kind,
          }))
        ),
        retired: [],
        relaxed: [],
        tightened: [],
        rowLevelSecurity: [],
        deleteSemantics: [],
        conversions: [],
        movedUnits: [],
        rewrittenUnits: [],
        contractChanges: [],
      }
      let next = 0
      const data: DataTable[] = sides.map((s, t) => ({
        temp: `simetra_fill_${t + 1}`,
        before: { schema: "app", table: s.from, key: "id" },
        after: { schema: "app", table: s.to, key: "id" },
        columns: s.fills.map((f) => ({
          step: `d${++next}`,
          column: f.column,
          type: f.type,
          expression: f.expression,
          kind: f.kind,
          guard: dataGuardSql({ schema: "app", table: s.from }, f, "compare"),
        })),
        triggers: s.triggers ?? [],
      }))
      const old = (s: (typeof sides)[number]) => [
        { schema: "app", name: s.from },
      ]
      const steps: PlanStep[] = [
        ...sides.map((s, t) => ({
          ...intentStep(`ALTER TABLE app.${s.from} RENAME TO ${s.to}`, old(s)),
          id: t === 0 ? "s1" : "s1b",
        })),
        ...sides
          .flatMap((s) =>
            s.fills.filter((f) => f.mapped !== true).map((f) => ({ s, f }))
          )
          .map(({ s, f }, i) => ({
            ...intentStep(
              `ALTER TABLE app.${s.to} ADD COLUMN ${f.column} ${f.type}`,
              old(s)
            ),
            id: `s2${String.fromCharCode(97 + i)}`,
          })),
      ]
      if (c.typeChange !== undefined) {
        const { column, from, to } = c.typeChange
        const sql = `ALTER TABLE "app"."du" ALTER COLUMN "${column}" TYPE ${to} USING "${column}"::${to}`
        const source: CatalogModel = {
          tables: [
            {
              schema: "app",
              name: "du",
              rowLevelSecurity: "off",
              columns: [
                { name: "id", type: "integer", notNull: true },
                { name: column, type: from, notNull: false },
              ],
              uniques: [],
              checks: [],
              foreignKeys: [],
              indexes: [],
            },
          ],
          enumTypes: [],
          units: [],
        }
        const result = typeGuards({ id: TYPE_STEP, sql }, source, parse)
        if (!("guards" in result)) throw new Error(result.refusal.message)
        steps.push(
          step(TYPE_STEP, sql, {
            verb: "alter",
            class: "destructive",
            lockClass: "accessExclusive",
            lockedTables: [{ schema: "app", name: "du" }],
            guards: result.guards,
          })
        )
      }
      steps.push(...(c.engine ?? []))
      const newToOld = new Map(
        sides.map((s) => [tableKey("app", s.to), tableKey("app", s.from)])
      )
      const sources: PhysicalTable[] = sides.map((s) => ({
        schema: "app",
        name: s.from,
        origin:
          s.id === OBJECT_ID
            ? { objectId: OBJECT_ID }
            : { objectId: OBJECT_ID, tabularSectionId: s.id },
        rowLevelSecurity: "off",
        columns: [],
        primaryKey: { name: `${s.from}_pkey`, columns: ["id"] },
        uniques: [],
        checks: [],
        foreignKeys: [],
        indexes: [],
      }))
      const preservation = preservationPlan(
        record,
        {
          steps: [],
          tablesNewToOld: newToOld,
          tempNames: new Map(),
          columns: [],
        },
        { tables: sources },
        new Map(
          c.typeChange === undefined
            ? []
            : [[JSON.stringify(["app", "du", c.typeChange.column]), TYPE_STEP]]
        ),
        data
      )
      return planFor(url, steps, {
        locks: locksOf(steps, newToOld),
        promotion: {
          recordHash: await promotionRecordHash(record),
          record,
          permissionItems: [],
          preservation,
          columns: [],
          canonicalNames: [],
          conversions: [],
          data,
        },
        ...(c.stops === true ? { desiredFingerprint: NOT_COMPARED } : {}),
      })
    }

    const run = (
      db: ApplyDatabase,
      url: string,
      plan: ExecutablePlan
    ): Promise<ExecuteOutcome> => {
      // Дозвіл — лише руйнівному кроку зміни типу, коли він є
      const allow = plan.steps.some((s) => s.id === TYPE_STEP)
        ? [TYPE_STEP]
        : []
      return executePlan(
        db,
        { url },
        plan,
        mode === "rehearse"
          ? { ...options, mode, rehearsal: stubRehearsal, allow }
          : { ...options, mode, allow }
      )
    }
    const done = mode === "rehearse" ? "rolledBack" : "committed"

    /** Тригер, що дописує `!` до `label` при кожному оновленні рядка. */
    const BANG = `
      create table app.dt (id int primary key, c text);
      insert into app.dt values (1, 'a'), (2, null), (3, 'c');
      create function app.bang() returns trigger language plpgsql as $$
        begin new.label := coalesce(new.label, '') || '!'; return new; end $$;
      create trigger dt_bang before update on app.dt
        for each row execute function app.bang();`
    const CONVERSION: Fill = {
      column: "label",
      expression: "upper(c)",
      kind: "conversion",
      type: "text",
    }
    /** Записані значення й режим тригера — до кінця транзакції. */
    const WRITTEN = `select
      (select json_agg(json_build_object('id', id, 'label', label) order by id)
         from app.du) as rows,
      (select tgenabled::text from pg_trigger where tgname = 'dt_bang') as mode`
    const UPPER = [
      { id: 1, label: "A" },
      { id: 2, label: null },
      { id: 3, label: "C" },
    ]

    it("writes a conversion with user triggers off", async () => {
      await inTarget(`${BASE}; ${BANG}`, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["c"],
          fills: [CONVERSION],
          triggers: [{ name: "dt_bang", enabled: "O" }],
        })
        const seen = observing(apply, WRITTEN)
        const outcome = await run(seen.db, url, plan)
        expect(outcome).toMatchObject({ status: done, diagnostics: [] })
        expect(seen.rows()).toEqual([{ rows: UPPER, mode: "O" }])
      })
    })

    // Review Focus 3: двигун такої таблиці не планує (`engine.unrepresentable`),
    // тож артефакт зібрано вручну з відбитком цілі, де тригер уже `A`, і
    // раннер проходить усі перевірки
    it("restores an ENABLE ALWAYS trigger as always", async () => {
      const setup = `${BASE}; ${BANG}
        alter table app.dt enable always trigger dt_bang;`
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["c"],
          fills: [CONVERSION],
          triggers: [{ name: "dt_bang", enabled: "A" }],
        })
        const seen = observing(apply, WRITTEN)
        const outcome = await run(seen.db, url, plan)
        expect(outcome).toMatchObject({ status: done, diagnostics: [] })
        expect(seen.rows()).toEqual([{ rows: UPPER, mode: "A" }])
      })
    })

    it("truncates nothing in a backfill of a mapped column", async () => {
      const setup = `${BASE};
        create table app.dt (id int primary key, code text);
        insert into app.dt values (1, repeat('x', 25)), (2, null), (3, 'short');`
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["code"],
          fills: [
            {
              column: "code",
              expression: "coalesce(code, 'x')",
              kind: "backfill",
              type: "text",
              mapped: true,
            },
          ],
          typeChange: {
            column: "code",
            from: "text",
            to: "character varying(20)",
          },
          stops: true,
        })
        const outcome = await run(apply, url, plan)
        // Значення записано в старий тип, а звуження ловить сторож кроку
        // двигуна вже на записаному — без мовчазного обрізання
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.type-narrowing",
              params: {
                step: TYPE_STEP,
                table: "app.du",
                column: "code",
                lost: 1,
              },
            },
          ],
        })
        expect(
          await other(url, "select length(code) as n from app.dt where id = 1")
        ).toEqual([{ n: 25 }])
      })
    })

    // Review Focus 2: порушення відкладеного FK — одразу після запису, а не
    // `55006 pending trigger events` на наступному кроці
    it("stops a deferred foreign key broken by the write", async () => {
      const setup = `${BASE};
        create table app.dp (id int primary key);
        insert into app.dp values (1);
        create table app.dt (id int primary key,
          p int references app.dp deferrable initially deferred);
        insert into app.dt values (1, 1);`
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["p"],
          fills: [
            {
              column: "p",
              expression: "p + 100",
              kind: "repair",
              type: "integer",
              mapped: true,
            },
          ],
          // DDL тієї самої таблиці після запису: без `SET CONSTRAINTS` фази
          // 10 вона впала б `55006 pending trigger events`
          engine: [
            step("s4", "ALTER TABLE app.du ADD COLUMN extra int", {
              verb: "alter",
              lockClass: "accessExclusive",
              lockedTables: [{ schema: "app", name: "du" }],
            }),
          ],
          stops: true,
        })
        const outcome = await run(apply, url, plan)
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.deferred-constraint-failed",
              params: { after: "data", sqlstate: "23503" },
            },
          ],
        })
        expect(await other(url, "select p from app.dt")).toEqual([{ p: 1 }])
      })
    })

    /** Тригер користувача, що лише пропускає рядок: важить його режим. */
    const KEEP = `
      create function app.keep() returns trigger language plpgsql as $$
        begin return new; end $$;`
    /** Режими тригерів за іменем — до кінця транзакції. */
    const MODES = `select json_object_agg(tgname, tgenabled::text order by tgname)
      as modes from pg_trigger where tgname like '%_keep'`

    // Рішення В17: увімкнення тригера — `ALTER TABLE`, а він неможливий, поки
    // на таблиці є відкладені події (`55006`). Вихідний відкладений FK ставить
    // подію на саму записувану таблицю
    it("restores the triggers of a table with a deferred outbound foreign key", async () => {
      const setup = `${BASE}; ${KEEP}
        create table app.dp (id int primary key);
        insert into app.dp values (1), (2);
        create table app.dt (id int primary key, c text,
          p int references app.dp deferrable initially deferred);
        insert into app.dt values (1, 'a', 1), (2, null, 1);
        create trigger dt_keep before update on app.dt
          for each row execute function app.keep();`
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["c", "p"],
          fills: [
            {
              column: "p",
              expression: "p + 1",
              kind: "repair",
              type: "integer",
              mapped: true,
            },
            CONVERSION,
          ],
          triggers: [{ name: "dt_keep", enabled: "O" }],
        })
        const seen = observing(
          apply,
          `select (select json_agg(json_build_object('p', p, 'label', label)
             order by id) from app.du) as rows, (${MODES}) as modes`
        )
        const outcome = await run(seen.db, url, plan)
        expect(outcome).toMatchObject({ status: done, diagnostics: [] })
        expect(seen.rows()).toEqual([
          {
            rows: [
              { p: 2, label: "A" },
              { p: 2, label: null },
            ],
            modes: { dt_keep: "O" },
          },
        ])
      })
    })

    it.runIf(mode === "rehearse")(
      "reports the rows and the data counters of a rehearsal",
      async () => {
        await inTarget(`${BASE}; ${BANG}`, async (url) => {
          const plan = await dataStepPlan(url, {
            columns: ["c"],
            fills: [CONVERSION],
            triggers: [{ name: "dt_bang", enabled: "O" }],
          })
          const outcome = await run(apply, url, plan)
          if (outcome.status !== "rolledBack")
            throw new Error(`not rolled back: ${outcome.status}`)
          const { evidence } = outcome
          // Лічильники — числа, хоч порт віддає `count(*)` рядком
          expect(evidence).toMatchObject({
            rows: [{ schema: "app", table: "dt", rows: 3 }],
            data: [{ schema: "app", table: "dt", computed: 3, written: 3 }],
            preservation: [{ schema: "app", table: "dt", rows: 3 }],
            triggers: [
              { schema: "app", table: "dt", name: "dt_bang", enabled: "O" },
            ],
            plpgsqlCheck: "skipped",
            lockFootprint: [],
          })
          const counts = [
            ...evidence.rows.map((r) => r.rows),
            ...evidence.data.flatMap((d) => [d.computed, d.written]),
          ]
          for (const n of counts) expect(typeof n).toBe("number")
          const ids = evidence.durations.steps.map((s) => s.id)
          for (const id of ["s1", "s2a", "compute-table-1", "write-table-1"])
            expect(ids, id).toContain(id)
        })
      }
    )

    it.runIf(mode === "rehearse")(
      "times the deferred check of the data write apart from the end of the steps",
      async () => {
        // Рішення В17: відкладений FK перевіряється одразу після запису
        // даних; цей оператор — окремий запис доказів, не фаза 13
        const setup = `${BASE}; ${KEEP}
          create table app.dp (id int primary key);
          insert into app.dp values (1), (2);
          create table app.dt (id int primary key, c text,
            p int references app.dp deferrable initially deferred);
          insert into app.dt values (1, 'a', 1), (2, null, 1);
          create trigger dt_keep before update on app.dt
            for each row execute function app.keep();`
        await inTarget(setup, async (url) => {
          const plan = await dataStepPlan(url, {
            columns: ["c", "p"],
            fills: [
              {
                column: "p",
                expression: "p + 1",
                kind: "repair",
                type: "integer",
                mapped: true,
              },
              CONVERSION,
            ],
            triggers: [{ name: "dt_keep", enabled: "O" }],
          })
          const outcome = await run(apply, url, plan)
          if (outcome.status !== "rolledBack")
            throw new Error(`not rolled back: ${outcome.status}`)
          const ids = outcome.evidence.durations.steps.map((s) => s.id)
          expect(ids.filter((id) => id.startsWith("constraints-"))).toEqual([
            "constraints-data",
            "constraints-deferred",
          ])
        })
      }
    )

    // Вхідний відкладений FK `NO ACTION` ставить подію на таблицю, на яку
    // посилаються, — тобто знову на записувану
    it("restores the triggers of a table with a deferred inbound foreign key", async () => {
      const setup = `${BASE}; ${KEEP}
        create table app.dt (id int primary key, code text unique);
        insert into app.dt values (1, 'A'), (2, 'b');
        create table app.dr (id int primary key,
          code text references app.dt (code) deferrable initially deferred);
        insert into app.dr values (1, 'A');
        create trigger dt_keep before update on app.dt
          for each row execute function app.keep();`
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["code"],
          fills: [
            {
              column: "code",
              expression: "upper(code)",
              kind: "repair",
              type: "text",
              mapped: true,
            },
          ],
          triggers: [{ name: "dt_keep", enabled: "O" }],
        })
        const seen = observing(
          apply,
          `select (select json_agg(code order by id) from app.du) as codes,
             (${MODES}) as modes`
        )
        const outcome = await run(seen.db, url, plan)
        expect(outcome).toMatchObject({ status: done, diagnostics: [] })
        expect(seen.rows()).toEqual([
          { codes: ["A", "B"], modes: { dt_keep: "O" } },
        ])
      })
    })

    // Вердикт архітектора до В17: проміжний стан між записами двох таблиць
    // одиниці порушує відкладений FK A → B, і перевірка не сміє настати
    // раніше за запис обох; вимкнення тригерів B після запису A не падає
    it("writes two tables of a unit before the deferred check and restores both", async () => {
      const setup = `${BASE}; ${KEEP}
        create table app.ds (id int primary key, code text unique);
        insert into app.ds values (1, 'a'), (2, 'b');
        create table app.dt (id int primary key,
          code text references app.ds (code) deferrable initially deferred);
        insert into app.dt values (1, 'a'), (2, 'b');
        create trigger dt_keep before update on app.dt
          for each row execute function app.keep();
        create trigger ds_keep before update on app.ds
          for each row execute function app.keep();
        alter table app.ds enable always trigger ds_keep;`
      const UPPER_CODE: Fill = {
        column: "code",
        expression: "upper(code)",
        kind: "repair",
        type: "text",
        mapped: true,
      }
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["code"],
          fills: [UPPER_CODE],
          triggers: [{ name: "dt_keep", enabled: "O" }],
          second: {
            columns: ["code"],
            fills: [UPPER_CODE],
            triggers: [{ name: "ds_keep", enabled: "A" }],
          },
        })
        const seen = observing(
          apply,
          `select (select json_agg(code order by id) from app.du) as du,
             (select json_agg(code order by id) from app.dv) as dv,
             (${MODES}) as modes`
        )
        const outcome = await run(seen.db, url, plan)
        expect(outcome).toMatchObject({ status: done, diagnostics: [] })
        expect(seen.rows()).toEqual([
          {
            du: ["A", "B"],
            dv: ["A", "B"],
            modes: { ds_keep: "A", dt_keep: "O" },
          },
        ])
      })
    })

    // Вердикт архітектора до задачі 5: відкладений тригер користувача фази 10
    // спрацьовує під налаштуваннями транзакції. Подію ставить каскад FK на
    // іншу таблицю (тригери записуваної таблиці вимкнено), а тіло називає
    // таблицю `public` без схеми — під закріпленим `search_path` її немає
    it("fires a deferred user trigger of the write under the transaction settings", async () => {
      const setup = `${BASE};
        create table public.dt_seen (id int);
        create table app.dt (id int primary key, code text unique);
        insert into app.dt values (1, 'a'), (2, 'b');
        create table app.dr (id int primary key,
          code text references app.dt (code) on update cascade);
        insert into app.dr values (1, 'a');
        create function app.dr_seen() returns trigger language plpgsql as $$
          begin insert into dt_seen values (new.id); return null; end $$;
        create constraint trigger dr_seen after update on app.dr
          deferrable initially deferred
          for each row execute function app.dr_seen();`
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["code"],
          fills: [
            {
              column: "code",
              expression: "upper(code)",
              kind: "repair",
              type: "text",
              mapped: true,
            },
          ],
        })
        const seen = observing(
          apply,
          "select (select json_agg(id) from public.dt_seen) as seen, (select json_agg(code order by id) from app.dr) as codes"
        )
        const outcome = await run(seen.db, url, plan)
        expect(outcome).toMatchObject({ status: done, diagnostics: [] })
        expect(seen.rows()).toEqual([{ seen: [1], codes: ["A"] }])
      })
    })

    // Review Focus 4: сесійна тимчасова таблиця попереднього клієнта на
    // тому самому backend
    it("refuses a session temp table left on the backend", async () => {
      await inTarget(`${BASE}; ${BANG}`, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["c"],
          fills: [CONVERSION],
          triggers: [{ name: "dt_bang", enabled: "O" }],
          stops: true,
        })
        const outcome = await run(
          sessionLeftover(apply, "CREATE TEMP TABLE simetra_fill_1 (k int)"),
          url,
          plan
        )
        expect(outcome).toMatchObject({
          status: "refused",
          diagnostics: [
            {
              code: "apply.temp-name-taken",
              params: { name: "pg_temp.simetra_fill_1" },
            },
          ],
        })
        expect(await exists(url, "app.dt")).toBe(true)
      })
    })

    it("keeps temp tables out of the checks", async () => {
      const setup = `${BASE};
        create table app.dt (id int primary key, c text);
        insert into app.dt values (1, 'a'), (2, null);`
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["c"],
          fills: [CONVERSION],
        })
        const seen = afterEnd(
          apply,
          "select to_regclass('pg_temp.simetra_fill_1') is null as gone"
        )
        const outcome = await run(seen.db, url, plan)
        // Без `apply.lock-footprint-exceeded` і `apply.function-check-blind`,
        // відбиток результату — бажаний
        expect(outcome).toMatchObject({ status: done, diagnostics: [] })
        expect(seen.rows()).toEqual([{ gone: true }])
      })
    })

    // Review Focus 1: віконна функція в агрегаті заборонена
    it("measures a windowed expression", async () => {
      const setup = `${BASE};
        create table app.dt (id int primary key, c text);
        insert into app.dt values (3, 'a'), (1, null), (2, 'b');`
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["c"],
          fills: [
            {
              column: "seq",
              expression: "(row_number() over (order by id))::text",
              kind: "conversion",
              type: "text",
            },
          ],
        })
        const seen = observing(
          apply,
          "select json_agg(seq order by id) as seq from app.du"
        )
        const outcome = await run(seen.db, url, plan)
        expect(outcome).toMatchObject({ status: done, diagnostics: [] })
        expect(seen.rows()).toEqual([{ seq: ["1", "2", "3"] }])
      })
    })

    it("names the data step whose expression fails", async () => {
      const setup = `${BASE};
        create table app.dt (id int primary key, code text);
        insert into app.dt values (1, '7'), (2, 'x');`
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["code"],
          fills: [
            {
              column: "n",
              expression: "(code)::int",
              kind: "conversion",
              type: "integer",
            },
          ],
          stops: true,
        })
        const outcome = await run(apply, url, plan)
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.data-step-failed",
              params: {
                phase: "measure-before",
                step: "d1",
                table: "app.du",
                column: "n",
                sqlstate: "22P02",
              },
            },
          ],
        })
      })
    })

    // Вердикт архітектора: переповнення приведення — крок, а не сира
    // помилка. Замір «до» приводить вираз до типу запису раніше за сторож,
    // тож переповнення ловить він
    it("names the step whose cast overflows", async () => {
      const setup = `${BASE};
        create table app.dt (id int primary key, amount int);
        insert into app.dt values (1, 12), (2, 123456);`
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["amount"],
          fills: [
            {
              column: "price",
              expression: "(amount)::numeric(4,2)",
              kind: "conversion",
              type: "numeric(4,2)",
            },
          ],
          stops: true,
        })
        const outcome = await run(apply, url, plan)
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.data-step-failed",
              params: {
                phase: "measure-before",
                step: "d1",
                table: "app.du",
                column: "price",
                sqlstate: "22003",
              },
            },
          ],
        })
      })
    })

    it("names the table whose write fails", async () => {
      const setup = `${BASE};
        create table app.dt (id int primary key, n int check (n < 100));
        insert into app.dt values (1, 1), (2, 50);`
      await inTarget(setup, async (url) => {
        const plan = await dataStepPlan(url, {
          columns: ["n"],
          fills: [
            {
              column: "n",
              expression: "n + 60",
              kind: "repair",
              type: "integer",
              mapped: true,
            },
          ],
          stops: true,
        })
        const outcome = await run(apply, url, plan)
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.data-step-failed",
              params: {
                phase: "write",
                statement: "update",
                table: "app.du",
                steps: "d1",
                sqlstate: "23514",
              },
            },
          ],
        })
        expect(await other(url, "select n from app.dt order by id")).toEqual([
          { n: 1 },
          { n: 50 },
        ])
      })
    })
  })

  it("catches an owner swap on the target", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      await other(url, `alter table app.t owner to ${OWNER}`)
      const outcome = await executePlan(apply, { url }, plan, options)
      expect(outcome).toMatchObject({ status: "refused" })
      expect(codes(outcome)).toEqual(["apply.target-changed"])
      expect(outcome.diagnostics[0]!.params.sections).toContain("owner")
      expect(await exists(url, "app.n")).toBe(false)
    })
  })

  it("rolls back on a pre-commit mismatch", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      const outcome = await executePlan(
        apply,
        { url },
        {
          ...plan,
          steps: [...plan.steps, step("s2", "CREATE TABLE app.extra ()")],
        },
        options
      )
      expect(outcome).toMatchObject({ status: "failed" })
      expect(codes(outcome)).toEqual(["apply.verify-failed"])
      expect(outcome.diagnostics[0]!.params.sections).toContain("relations")
      expect(await exists(url, "app.n")).toBe(false)
      expect(await exists(url, "app.extra")).toBe(false)
      expect(await marker(url)).toBeUndefined()
    })
  })

  it("names the differing catalog paths before it rolls back", async () => {
    await inTarget(BASE, async (url) => {
      // Хибний бажаний відбиток (ціль до кроку) і модель результату без
      // колонки, яку створює крок: розбіжність називає саме її шлях
      const before = await read(url)
      const resultCatalog = (await engine.extract({ url }, desired.scope)).model
      const plan = await planFor(url, [ALTER_T], {
        desiredFingerprint: before,
        resultCatalog,
      })
      const outcome = await executePlan(apply, { url }, plan, options)
      expect(outcome).toMatchObject({ status: "failed" })
      expect(codes(outcome)).toEqual(["apply.verify-failed"])
      expect(outcome.diagnostics[0]!.params).toEqual({
        sections: "columns",
        paths: "tables.app.t.columns.d",
      })
      expect(await read(url)).toEqual(before)
      expect(await marker(url)).toBeUndefined()
    })
  })

  it("reports applied after a connection loss at COMMIT", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      let first = true
      const lostAfterCommit: ApplyDatabase = {
        async transaction(target, end, fn) {
          const value = await apply.transaction(target, end, fn)
          if (first) {
            first = false
            throw new ApplyConnectionLost("Connection terminated unexpectedly")
          }
          return value
        },
      }
      const outcome = await executePlan(lostAfterCommit, { url }, plan, options)
      expect(outcome).toMatchObject({
        status: "committed",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.connection-lost",
            severity: "warning",
            params: { outcome: "applied" },
          },
        ],
      })
      expect(await marker(url)).toMatchObject({ plan_hash: PLAN_HASH })
      expect(await ledger(url)).toHaveLength(1)
    })
  })

  /** Чи чекає хтось advisory lock застосування в цій базі. */
  const waitsOnApplyLock = async (url: string): Promise<boolean> =>
    (
      await other<{ waiting: boolean }>(
        url,
        "select exists (select from pg_locks where locktype = 'advisory' and classid = 1397312837 and objid = 1 and database = (select oid from pg_database where datname = current_database()) and not granted) as waiting"
      )
    )[0]!.waiting

  /**
   * Порт, чия перша транзакція йде на окремому клієнті й «обривається»
   * після `fn`: раннер отримує `ApplyConnectionLost`, а backend живе далі
   * з усіма блокуваннями спроби. Що з ним стане — вирішує `then` (його
   * результат — `pending`). Решта транзакцій — справжній порт.
   */
  function lostWithLiveBackend(
    then: (client: pg.Client, pid: number) => Promise<void>
  ): {
    db: ApplyDatabase
    pending: () => Promise<void>
    close: () => Promise<void>
  } {
    let pending: Promise<void> = Promise.resolve()
    let first = true
    let live: pg.Client | undefined
    return {
      pending: () => pending,
      // Провалений тест не має лишити backend, що тримає базу цілі: інакше
      // порт не прибере тінь
      close: async () => {
        await live?.end().catch(() => {})
      },
      db: {
        async transaction(target, end, fn) {
          if (!first) return apply.transaction(target, end, fn)
          first = false
          const client = new pg.Client({ connectionString: target.url })
          live = client
          // Сервер може вбити цей backend: подія не має валити процес тесту
          client.on("error", () => {})
          await client.connect()
          const [row] = (
            await client.query<{ pid: number }>(
              "select pg_backend_pid() as pid"
            )
          ).rows
          await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
          await fn({
            // Помилка оператора з SQLSTATE — `ApplyDbError`, як у справжнього
            // порту: раннер на цьому стоїть (зокрема транспорт ревалідації)
            query: async <R extends Record<string, unknown>>(
              sql: string,
              params?: readonly unknown[]
            ) => {
              try {
                return (await client.query(sql, params as unknown[]))
                  .rows as R[]
              } catch (error) {
                const { code, message } = error as {
                  code?: string
                  message: string
                }
                throw code === undefined
                  ? error
                  : new ApplyDbError(message, code)
              }
            },
            // Спроба цього порту доходить до кінця без розбіжності відбитка
            extract: () =>
              Promise.reject(new Error("this port does not extract")),
          })
          pending = then(client, row!.pid)
          throw new ApplyConnectionLost("Connection terminated unexpectedly")
        },
      },
    }
  }

  it("waits for a COMMIT in flight before reading the ledger", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      // `COMMIT` доходить до сервера лише тоді, коли пошук уже чекає на
      // блокування: без очікування пошук сказав би «не застосовано»
      const port = lostWithLiveBackend(async (client) => {
        await until("the lookup to wait", () => waitsOnApplyLock(url))
        await client.query("COMMIT")
      })
      const outcome = await executePlan(
        port.db,
        { url },
        plan,
        options
      ).finally(async () => {
        await port.pending().finally(port.close)
      })
      expect(outcome).toMatchObject({
        status: "committed",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.connection-lost",
            severity: "warning",
            params: { outcome: "applied" },
          },
        ],
      })
      expect(await marker(url)).toMatchObject({ plan_hash: PLAN_HASH })
      expect(await exists(url, "app.n")).toBe(true)
    })
  })

  it("waits for an orphaned transaction to be ended by the server", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      // `COMMIT` не надіслано, а backend лишився «idle in transaction» з
      // блокуваннями: його знімає `idle_in_transaction_session_timeout`,
      // який раннер ставить у спробі. Зменшений тайм-аут — заради часу
      // тесту; закрити сокет тут не можна: backend помітив би EOF і
      // відкотився одразу, а не осиротів
      let orphan = 0
      const port = lostWithLiveBackend(async (_client, pid) => {
        orphan = pid
        await until("the lookup to wait", () => waitsOnApplyLock(url))
      })
      const outcome = await executePlan(port.db, { url }, plan, {
        ...options,
        timeouts: { idleInTransactionMs: 3000 },
      }).finally(async () => {
        await port.pending().finally(port.close)
      })
      expect(outcome).toMatchObject({
        status: "failed",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.connection-lost",
            severity: "error",
            params: { outcome: "not-applied" },
          },
        ],
      })
      expect(
        await other(
          testSuperuserUrl(),
          `select 1 from pg_stat_activity where pid = ${orphan}`
        )
      ).toEqual([])
      expect(await exists(url, "app.n")).toBe(false)
      expect(await marker(url)).toBeUndefined()
    })
  })

  it("does not mistake an earlier apply for this one", async () => {
    await inTarget(BASE, async (url) => {
      const A = H1
      const B = H2
      await establish(url, A)
      const fingerprintA = await read(url)
      const forward = await planFor(url, [CREATE_N], {
        fromHash: A,
        toHash: B,
      })
      expect(await executePlan(apply, { url }, forward, options)).toMatchObject(
        { status: "committed" }
      )
      const back: ExecutablePlan = {
        ...forward,
        fromHash: B,
        toHash: A,
        steps: [
          step("s1", "DROP TABLE app.n", {
            verb: "drop",
            class: "destructive",
            lockClass: "accessExclusive",
            lockedTables: [{ schema: "app", name: "n" }],
          }),
        ],
        requiredPermissions: ["s1"],
        locks: [{ schema: "app", name: "n", mode: "accessExclusive" }],
        targetFingerprint: await read(url),
        desiredFingerprint: fingerprintA,
        // Голова ledger — після першого застосування, як прочитав би план
        ...(await identityOf(url)),
      }
      expect(
        await executePlan(apply, { url }, back, {
          ...options,
          planHash: "d".repeat(64),
          allow: ["s1"],
        })
      ).toMatchObject({ status: "committed" })
      // Той самий перехід A→B — той самий `planHash`, і ledger його вже має
      expect(
        (await ledger(url)).filter((r) => r.plan_hash === PLAN_HASH)
      ).toHaveLength(1)

      // Обривається лише транзакція застосування, а не пошук у ledger
      let first = true
      const lostBeforeCommit: ApplyDatabase = {
        transaction: (target, end, fn) => {
          if (!first) return apply.transaction(target, end, fn)
          first = false
          return apply.transaction(target, end, async (tx) => {
            await fn(tx)
            throw new ApplyConnectionLost("Connection terminated unexpectedly")
          })
        },
      }
      // Повтор переходу A→B з тим самим `planHash`; голова ledger — поточна,
      // інакше відмова фази 4e настала б раніше за обрив
      const outcome = await executePlan(
        lostBeforeCommit,
        { url },
        { ...forward, ...(await identityOf(url)) },
        options
      )
      expect(outcome).toMatchObject({
        status: "failed",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.connection-lost",
            severity: "error",
            params: { outcome: "not-applied" },
          },
        ],
      })
      expect(await exists(url, "app.n")).toBe(false)
      expect(await marker(url)).toMatchObject({ snapshot_hash: A })
    })
  })

  it("reports not applied after a connection loss mid-transaction", async () => {
    await inTarget(BASE, async (url) => {
      await establish(url, H1)
      const before = await marker(url)
      const sleepStep = step("s1", "SELECT pg_sleep(5)", { verb: "alter" })
      const plan = await planFor(url, [sleepStep], {
        fromHash: H1,
        toHash: H2,
      })
      const running = executePlan(apply, { url }, plan, options)
      const database = new URL(url).pathname.slice(1)
      const backend = async () =>
        (
          await other<{ pid: number }>(
            testSuperuserUrl(),
            `select pid from pg_stat_activity where datname = '${database}' and query = '${sleepStep.sql}' and state = 'active'`
          )
        )[0]?.pid
      await until(
        "the step to run",
        async () => (await backend()) !== undefined
      )
      await other(
        testSuperuserUrl(),
        `select pg_terminate_backend(${await backend()})`
      )
      const outcome = await running
      expect(outcome).toMatchObject({
        status: "failed",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.connection-lost",
            params: { outcome: "not-applied" },
          },
        ],
      })
      expect(await marker(url)).toEqual(before)
    })
  })

  it("refuses a missing permission at execution", async () => {
    await inTarget(BASE, async (url) => {
      const drop = step("s1", "DROP TABLE app.t", {
        verb: "drop",
        class: "destructive",
        lockClass: "accessExclusive",
        lockedTables: [{ schema: "app", name: "t" }],
      })
      // Відмова настає до транзакції, тож бажаний стан тут не важить
      const plan = await planFor(url, [drop], {
        requiredPermissions: ["s1"],
        desiredFingerprint: NOT_COMPARED,
      })
      const port = counted(apply)
      const outcome = await executePlan(port.db, { url }, plan, options)
      expect(outcome).toMatchObject({
        status: "refused",
        attempts: 0,
        diagnostics: [
          { code: "apply.permission-required", params: { items: "s1" } },
        ],
      })
      expect(port.count()).toBe(0)
      expect(await exists(url, "app.t")).toBe(true)
    })
  })

  it("refuses CASCADE at execution", async () => {
    await inTarget(BASE, async (url) => {
      const drop = step("s1", "DROP TABLE app.t CASCADE", {
        verb: "drop",
        class: "destructive",
        lockClass: "accessExclusive",
        lockedTables: [{ schema: "app", name: "t" }],
      })
      // Відмова настає до транзакції, тож бажаний стан тут не важить
      const plan = await planFor(url, [drop], {
        requiredPermissions: ["s1"],
        desiredFingerprint: NOT_COMPARED,
      })
      const port = counted(apply)
      const outcome = await executePlan(port.db, { url }, plan, {
        ...options,
        allow: ["s1"],
      })
      expect(outcome).toMatchObject({ status: "refused", attempts: 0 })
      expect(codes(outcome)).toEqual(["apply.cascade"])
      expect(port.count()).toBe(0)
      expect(await exists(url, "app.t")).toBe(true)
    })
  })

  it("reports the failing step", async () => {
    await inTarget(BASE, async (url) => {
      await establish(url, H1)
      const before = await marker(url)
      const setNotNull = step("s1", "ALTER TABLE app.t ALTER c SET NOT NULL", {
        verb: "alter",
        class: "validationScan",
        lockClass: "accessExclusive",
        lockedTables: [{ schema: "app", name: "t" }],
      })
      const plan = await planFor(url, [setNotNull], {
        fromHash: H1,
        toHash: H2,
        // Бажаний стан з `NOT NULL` недосяжний на рядку з `NULL`
        desiredFingerprint: await read(url),
      })
      const outcome = await executePlan(apply, { url }, plan, options)
      expect(outcome).toMatchObject({
        status: "failed",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.step-failed",
            params: { step: "s1", sqlstate: "23502" },
          },
        ],
      })
      expect(await marker(url)).toEqual(before)
    })
  })

  describe("type-narrowing guard", () => {
    /**
     * Крок зміни типу зі сторожами, як їх ставить `classifySteps`: старий тип
     * — з моделі вихідного стану, тут зібраної вручну у формі `format_type()`.
     */
    async function typeStep(
      sql: string,
      table: string,
      columns: Record<string, string>
    ): Promise<PlanStep> {
      const source: CatalogModel = {
        tables: [
          {
            schema: "app",
            name: table,
            rowLevelSecurity: "off",
            columns: Object.entries(columns).map(([name, type]) => ({
              name,
              type,
              notNull: false,
            })),
            uniques: [],
            checks: [],
            foreignKeys: [],
            indexes: [],
          },
        ],
        enumTypes: [],
        units: [],
      }
      const result = typeGuards(
        { id: "s1", sql },
        source,
        await loadSqlParser()
      )
      if (!("guards" in result)) throw new Error(result.refusal.message)
      expect(result.guards).toHaveLength(1)
      return step("s1", sql, {
        verb: "alter",
        class: "destructive",
        lockClass: "accessExclusive",
        lockedTables: [{ schema: "app", name: table }],
        guards: result.guards,
      })
    }

    /** План, що мусить зупинитися до кроку: бажаний відбиток не важить. */
    const stopping = async (url: string, s: PlanStep) =>
      planFor(url, [s], {
        requiredPermissions: ["s1"],
        desiredFingerprint: NOT_COMPARED,
      })

    const allowS1 = { ...options, allow: ["s1"] }

    it("stops a truncating varchar change on the data", async () => {
      const setup = `${BASE};
        create table app.v (id int primary key, c text);
        insert into app.v values (1, 'abcdefgh'), (2, 'abc'), (3, null);`
      await inTarget(setup, async (url) => {
        const s = await typeStep(
          `ALTER TABLE "app"."v" ALTER COLUMN "c" TYPE character varying(5) USING "c"::character varying(5)`,
          "v",
          { id: "integer", c: "text" }
        )
        const outcome = await executePlan(
          apply,
          { url },
          await stopping(url, s),
          { ...allowS1, mode: "rehearse", rehearsal: stubRehearsal }
        )
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.type-narrowing",
              params: { step: "s1", table: "app.v", column: "c", lost: 1 },
            },
          ],
        })
        expect(
          await other(
            url,
            "select c, pg_typeof(c)::text as type from app.v where id = 1"
          )
        ).toEqual([{ c: "abcdefgh", type: "text" }])
      })
    })

    it("stops truncation inside a partition", async () => {
      const setup = `${BASE};
        create table app.p (id int, c text) partition by list (id);
        create table app.p1 partition of app.p for values in (1);
        insert into app.p values (1, 'abcdefgh');`
      await inTarget(setup, async (url) => {
        const s = await typeStep(
          "ALTER TABLE app.p ALTER COLUMN c TYPE character varying(5) USING c::character varying(5)",
          "p",
          { id: "integer", c: "text" }
        )
        const outcome = await executePlan(
          apply,
          { url },
          await stopping(url, s),
          allowS1
        )
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.type-narrowing",
              params: { step: "s1", table: "app.p", column: "c", lost: 1 },
            },
          ],
        })
        expect(await other(url, "select c from app.p1")).toEqual([
          { c: "abcdefgh" },
        ])
      })
    })

    it("stops a rounding numeric change", async () => {
      const setup = `${BASE};
        create table app.v (id int primary key, n numeric(10,4));
        insert into app.v values (1, 1.2345), (2, 1.2);`
      await inTarget(setup, async (url) => {
        const s = await typeStep(
          "ALTER TABLE app.v ALTER COLUMN n TYPE numeric(10,2) USING n::numeric(10,2)",
          "v",
          { id: "integer", n: "numeric(10,4)" }
        )
        const outcome = await executePlan(
          apply,
          { url },
          await stopping(url, s),
          allowS1
        )
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.type-narrowing",
              params: { step: "s1", table: "app.v", column: "n", lost: 1 },
            },
          ],
        })
        expect(
          await other(url, "select n::text from app.v where id = 1")
        ).toEqual([{ n: "1.2345" }])
      })
    })

    it("lets an enum to text change through", async () => {
      const setup = `${BASE};
        create type app.mood as enum ('calm', 'busy');
        create table app.v (id int primary key, m app.mood);
        insert into app.v values (1, 'calm'), (2, null);`
      await inTarget(setup, async (url) => {
        const s = await typeStep(
          "ALTER TABLE app.v ALTER COLUMN m TYPE text USING m::text",
          "v",
          { id: "integer", m: "app.mood" }
        )
        const plan = await planFor(url, [s], {
          requiredPermissions: ["s1"],
          desiredFingerprint: await desiredFingerprint(url, [s]),
        })
        const outcome = await executePlan(apply, { url }, plan, {
          ...allowS1,
          mode: "rehearse",
          rehearsal: stubRehearsal,
        })
        expect(outcome).toMatchObject({ status: "rolledBack", diagnostics: [] })
      })
    })

    it("reports a failing cast as narrowing", async () => {
      const setup = `${BASE};
        create table app.v (id int primary key, x bigint);
        insert into app.v values (1, 1099511627776);`
      await inTarget(setup, async (url) => {
        const s = await typeStep(
          "ALTER TABLE app.v ALTER COLUMN x TYPE integer USING x::integer",
          "v",
          { id: "integer", x: "bigint" }
        )
        const outcome = await executePlan(
          apply,
          { url },
          await stopping(url, s),
          allowS1
        )
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.type-narrowing",
              params: {
                step: "s1",
                table: "app.v",
                column: "x",
                sqlstate: "22003",
              },
            },
          ],
        })
        expect(outcome.diagnostics[0]!.params).not.toHaveProperty("lost")
      })
    })

    it("reports a guard error outside class 22 by its own code", async () => {
      // У `json` немає рівності: сторож падає з 42883, а не на даних
      const setup = `${BASE};
        create table app.v (id int primary key, j json);
        insert into app.v values (1, '{"a": 1}');`
      await inTarget(setup, async (url) => {
        const s = await typeStep(
          "ALTER TABLE app.v ALTER COLUMN j TYPE jsonb USING j::jsonb",
          "v",
          { id: "integer", j: "json" }
        )
        const outcome = await executePlan(
          apply,
          { url },
          await stopping(url, s),
          allowS1
        )
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.type-guard-failed",
              params: { step: "s1", column: "j", sqlstate: "42883" },
            },
          ],
        })
        expect(
          await other(url, "select pg_typeof(j)::text as type from app.v")
        ).toEqual([{ type: "json" }])
      })
    })
  })

  describe("end of transaction", () => {
    const NOT_VALID = step(
      "s1",
      "ALTER TABLE app.t ADD CONSTRAINT t_a CHECK (c <> '') NOT VALID",
      {
        verb: "alter",
        lockClass: "accessExclusive",
        lockedTables: [{ schema: "app", name: "t" }],
      }
    )
    const VALID = step("s1", NOT_VALID.sql.replace(" NOT VALID", ""), {
      ...NOT_VALID,
    })

    // Review Focus 5 плану П3-2b-1: `ROLLBACK` не запускає відкладених
    // перевірок, тож без `SET CONSTRAINTS ALL IMMEDIATE` репетиція мовчала б
    it("surfaces a deferred foreign key violation before a rehearsal rolls back", async () => {
      const setup = `${BASE};
        create table app.p (id int primary key);
        create table app.c (id int, p int references app.p deferrable initially deferred);
        insert into app.p values (1);
        insert into app.c values (1, 1);`
      await inTarget(setup, async (url) => {
        const steps = [
          step("s1", "DELETE FROM app.p", {
            verb: "alter",
            class: "destructive",
          }),
        ]
        const plan = await planFor(url, steps, {
          // Каталог кроком не змінюється
          desiredFingerprint: await read(url),
        })
        const outcome = await executePlan(apply, { url }, plan, {
          ...options,
          mode: "rehearse",
          rehearsal: stubRehearsal,
          allow: ["s1"],
        })
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.deferred-constraint-failed",
              params: { sqlstate: "23503" },
            },
          ],
        })
        expect(await other(url, "select id from app.p")).toEqual([{ id: 1 }])
      })
    })

    it("refuses a NOT VALID constraint the desired state does not have", async () => {
      await inTarget(BASE, async (url) => {
        const plan = await planFor(url, [NOT_VALID], {
          desiredInvalid: [],
          desiredFingerprint: await desiredFingerprint(url, [VALID]),
        })
        const outcome = await executePlan(apply, { url }, plan, options)
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [{ code: "apply.constraint-invalid" }],
        })
        expect(String(outcome.diagnostics[0]!.params?.objects)).toContain("t_a")
        expect(
          await other(
            url,
            "select conname from pg_constraint where conname = 't_a'"
          )
        ).toEqual([])
      })
    })

    it("accepts an invalid object the desired state also has", async () => {
      await inTarget(BASE, async (url) => {
        const plan = await planFor(url, [NOT_VALID], {
          desiredInvalid: ["constraint app.t t_a"],
          desiredFingerprint: await desiredFingerprint(url, [NOT_VALID]),
        })
        const outcome = await executePlan(apply, { url }, plan, options)
        expect(outcome).toMatchObject({ status: "committed" })
      })
    })
  })
})
