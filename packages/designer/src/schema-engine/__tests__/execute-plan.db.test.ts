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
import { compile } from "simetra/compiler"
import {
  ApplyConnectionLost,
  desiredForApply,
  executePlan,
  readFingerprint,
  type ApplyDatabase,
  type ApplyDesired,
  type CatalogFingerprint,
  type DriftReport,
  type ExecutablePlan,
  type ExecuteOptions,
  type ExecuteOutcome,
  type PlanStep,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  catalog,
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
    `drop role if exists ${API_LOGIN}; drop role if exists ${OWNER};`
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
     alter role ${API_LOGIN} set role = 'service_role';`
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

/** Відбиток бажаного стану: окрема база, де `setup` і кроки вже виконано. */
const desiredFingerprint = (
  setup: string,
  steps: readonly PlanStep[]
): Promise<CatalogFingerprint> =>
  inTarget(`${setup};\n${steps.map((s) => `${s.sql};`).join("\n")}`, read)

function step(id: string, sql: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
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
    dataLoss: false,
    rewriteRisk: false,
    ...over,
  }
}

const CREATE_N = step("s1", "CREATE TABLE app.n (id int)")
const ALTER_T = step("s1", "ALTER TABLE app.t ADD COLUMN d int", {
  verb: "alter",
  lockClass: "accessExclusive",
  lockedTables: [{ schema: "app", name: "t" }],
})

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
    resultCatalog: { tables: [], enumTypes: [], units: [] },
    ...over,
    targetFingerprint: over.targetFingerprint ?? (await read(url)),
    desiredFingerprint:
      over.desiredFingerprint ?? (await desiredFingerprint(BASE, steps)),
  }
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
      })
      expect(outcome).toMatchObject({ status: "rolledBack", attempts: 1 })
      expect(await exists(url, "app.n")).toBe(false)
      expect(await marker(url)).toBeUndefined()
      expect(await ledger(url)).toEqual([])
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

  it("refuses an API role", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
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
            query: async <R extends Record<string, unknown>>(
              sql: string,
              params?: readonly unknown[]
            ) => (await client.query(sql, params as unknown[])).rows as R[],
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
        targetFingerprint: await read(url),
        desiredFingerprint: fingerprintA,
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
      const outcome = await executePlan(
        lostBeforeCommit,
        { url },
        forward,
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
        desiredFingerprint: await read(url),
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
        desiredFingerprint: await read(url),
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
})
