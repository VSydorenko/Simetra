import { describe, expect, it } from "vitest"
import {
  ApplyConnectionLost,
  ApplyDbError,
  executePlan,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  type ApplyDatabase,
  type CatalogFingerprint,
  type ExecutablePlan,
  type ExecuteOptions,
  type FingerprintSection,
  type PlanStep,
} from "simetra/schema"
import type { PromotionRecord } from "simetra/compiler"

/**
 * Раннер транзакції на фейковому порті (план П3-1, задача 8): порядок
 * операторів спроби, паузи між спробами й те, які помилки не повторюються.
 * Справжня база — у `execute-plan.db.test.ts` designer.
 */

function fingerprint(tag: string): CatalogFingerprint {
  return {
    version: FINGERPRINT_VERSION,
    sections: Object.fromEntries(
      FINGERPRINT_SECTIONS.map((s) => [s, `${tag}-${s}`])
    ) as Record<FingerprintSection, string>,
  }
}

function step(id: string, sql: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    origin: "engine",
    sql,
    verb: "alter",
    class: "catalogOnly",
    lockClass: "accessExclusive",
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: [],
    produces: [],
    consumes: [],
    destroys: [],
    destroyed: [],
    consumed: [],
    dataLoss: false,
    rewriteRisk: false,
    guards: [],
    ...over,
  }
}

const TARGET = fingerprint("target")
const DESIRED = fingerprint("desired")

const plan: ExecutablePlan = {
  fromHash: null,
  toHash: "b".repeat(64),
  scope: { schemas: ["app", "simetra"], provider: "supabase" },
  engine: { name: "pg-delta", version: "1.0.0-alpha.56" },
  steps: [
    step("s1", "ALTER TABLE app.t ADD COLUMN d int", {
      lockedTables: [{ schema: "app", name: "t" }],
    }),
    // `share` не блокується наперед: його бере сам оператор
    step("s2", "CREATE INDEX i ON app.u (id)", {
      lockClass: "share",
      lockedTables: [{ schema: "app", name: "u" }],
    }),
    step("s3", 'ALTER TABLE app."x.y" ADD COLUMN e int', {
      lockedTables: [
        { schema: "app", name: "t" },
        { schema: "app", name: "x.y" },
      ],
    }),
  ],
  requiredPermissions: [],
  drift: null,
  targetFingerprint: TARGET,
  desiredFingerprint: DESIRED,
  locks: [
    { schema: "app", name: "t", mode: "accessExclusive" },
    { schema: "app", name: "x.y", mode: "accessExclusive" },
  ],
  preamble: [{ name: "search_path", value: "pg_catalog" }],
  promotion: null,
  resultCatalog: { tables: [], enumTypes: [], units: [] },
}

const RECORD: PromotionRecord = {
  format: 1,
  base: "0".repeat(64),
  result: "1".repeat(64),
  objectId: "00000000-0000-4000-8000-000000000001",
  kind: "Catalog",
  labelDropped: false,
  tables: [],
  columns: [],
  typeChanges: [],
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

/** План із секцією промоції: пункт `access:` поза `requiredPermissions`. */
const promoted: ExecutablePlan = {
  ...plan,
  // Поле лише показ: раннер рахує пункти з секції, тож порожнє не допомагає
  requiredPermissions: [],
  promotion: {
    recordHash: "d".repeat(64),
    record: RECORD,
    permissionItems: [{ token: "access:app.party", summary: ["anon: select"] }],
    preservation: [],
    columns: [],
    canonicalNames: [],
    conversions: [],
  },
}

/** `search_path` транзакції до преамбули — його раннер і повертає. */
const SESSION_PATH = '"$user", public'

const options: ExecuteOptions = {
  mode: "apply",
  planHash: "p".repeat(64),
  allow: [],
  snapshot: { tables: [] },
  sleep: async () => {},
}

interface Script {
  locked?: boolean
  role?: string
  /** Помилка оператора з міткою `label` у спробі `attempt`. */
  fail?: (label: string, attempt: number) => Error | undefined
  /** Ledger після обриву з'єднання: є рядок цього застосування. */
  ledgerHasApply?: boolean
  /** Форма знайденого рядка ledger; типово поточна. */
  ledgerFormat?: number
  /** Секції відбитка цілі до кроків; типово `TARGET`. */
  targetSections?: CatalogFingerprint["sections"]
}

/** Мітка оператора для журналу: що саме виконав раннер. */
function labelOf(sql: string): string | undefined {
  if (sql.includes("pg_try_advisory_xact_lock")) return "try-lock"
  if (sql.includes("pg_advisory_xact_lock")) return "lookup-lock"
  if (sql.includes("set_config('statement_timeout', $1"))
    return "lookup-timeouts"
  if (sql.includes("set_config('lock_timeout'")) return "timeouts"
  if (sql.includes("current_user")) return "role"
  if (sql.includes("to_regclass") && sql.includes(" AS marker")) return "state"
  if (sql.startsWith("SAVEPOINT simetra_fingerprint")) return "fingerprint"
  if (sql.startsWith("INSERT INTO simetra.marker")) return "marker"
  if (sql.startsWith("INSERT INTO simetra.ledger")) return "ledger"
  if (sql.includes("WHERE apply_id")) return "lookup"
  if (sql.includes("current_setting('search_path')")) return "save-path"
  if (sql.includes("set_config('search_path'")) return "set-path"
  if (sql.includes("check_function_bodies")) return "function-bodies"
  // Решта операторів відбитка й стану — частини вже позначених кроків
  if (
    sql.includes("search_path") ||
    sql.includes("simetra_fingerprint") ||
    sql.includes("encode(sha256") ||
    sql.includes("to_regclass")
  )
    return undefined
  return sql
}

function fakeDb(script: Script = {}) {
  const log: string[] = []
  const params: Record<string, readonly unknown[] | undefined> = {}
  let attempt = 0
  const db: ApplyDatabase = {
    async transaction(_target, end, fn) {
      attempt++
      let stepsRan = false
      log.push("BEGIN")
      const tx = {
        query: async <R extends Record<string, unknown>>(
          sql: string,
          p?: readonly unknown[]
        ): Promise<R[]> => {
          const label = labelOf(sql)
          if (label !== undefined) {
            log.push(label)
            params[label] = p
          }
          const error =
            label === undefined ? undefined : script.fail?.(label, attempt)
          if (error !== undefined) throw error
          if (plan.steps.some((s) => s.sql === sql)) stepsRan = true
          const rows: Record<string, unknown>[] =
            label === "try-lock"
              ? [{ locked: script.locked ?? true }]
              : label === "role"
                ? [{ role: script.role ?? "postgres" }]
                : sql.includes(" AS marker")
                  ? [{ marker: false, ledger: false }]
                  : sql.includes("to_regclass")
                    ? [{ exists: true }]
                    : label === "lookup"
                      ? script.ledgerHasApply === true
                        ? [{ format: script.ledgerFormat ?? 1 }]
                        : []
                      : label === "save-path"
                        ? [{ path: SESSION_PATH }]
                        : sql.includes("encode(sha256")
                          ? [
                              stepsRan
                                ? DESIRED.sections
                                : (script.targetSections ?? TARGET.sections),
                            ]
                          : []
          return rows as R[]
        },
      }
      try {
        const value = await fn(tx)
        log.push(end === "commit" ? "COMMIT" : "ROLLBACK")
        return value
      } catch (error) {
        log.push("ROLLBACK")
        throw error
      }
    },
  }
  return { db, log, params }
}

const target = { url: "postgres://fake" }

describe("executePlan", () => {
  it("runs one attempt in the order of decision 11", async () => {
    const { db, log, params } = fakeDb()
    const outcome = await executePlan(db, target, plan, options)
    expect(outcome).toMatchObject({ status: "committed", attempts: 1 })
    expect(log).toEqual([
      "BEGIN",
      "try-lock",
      "timeouts",
      "role",
      "state",
      'LOCK TABLE ONLY app.t, ONLY app."x.y" IN ACCESS EXCLUSIVE MODE',
      "fingerprint",
      "save-path",
      "set-path",
      "ALTER TABLE app.t ADD COLUMN d int",
      "CREATE INDEX i ON app.u (id)",
      'ALTER TABLE app."x.y" ADD COLUMN e int',
      "set-path",
      "fingerprint",
      "marker",
      "ledger",
      "COMMIT",
    ])
    expect(params.timeouts).toEqual(["3000ms", "600000ms", "60000ms"])
  })

  /** Журнал операторів разом із параметрами кожного. */
  function spied(script: Script = {}) {
    const calls: { sql: string; params?: readonly unknown[] }[] = []
    const { db, log } = fakeDb(script)
    const spy: ApplyDatabase = {
      transaction: (t, end, fn) =>
        db.transaction(t, end, (tx) =>
          fn({
            query: (sql, p) => {
              calls.push({ sql, params: p })
              return tx.query(sql, p)
            },
          })
        ),
    }
    return { db: spy, log, calls }
  }

  it("takes access-exclusive locks first, then share-row-exclusive ones", async () => {
    const { db, log } = fakeDb()
    const outcome = await executePlan(
      db,
      target,
      {
        ...plan,
        locks: [
          ...plan.locks,
          { schema: "app", name: "p", mode: "shareRowExclusive" },
          { schema: "ref", name: "q", mode: "shareRowExclusive" },
        ],
      },
      options
    )
    expect(outcome).toMatchObject({ status: "committed" })
    const locks = log.filter((l) => l.startsWith("LOCK TABLE"))
    expect(locks).toEqual([
      'LOCK TABLE ONLY app.t, ONLY app."x.y" IN ACCESS EXCLUSIVE MODE',
      "LOCK TABLE ONLY app.p, ONLY ref.q IN SHARE ROW EXCLUSIVE MODE",
    ])
    expect(log.indexOf(locks[1]!)).toBeLessThan(log.indexOf("fingerprint"))
  })

  it("locks the artifact's tables, not the step tables", async () => {
    const { db, log } = fakeDb()
    await executePlan(db, target, { ...plan, locks: [] }, options)
    expect(log.some((l) => l.startsWith("LOCK TABLE"))).toBe(false)
  })

  it("reports a vanished share-row-exclusive table as a changed target", async () => {
    const { db } = fakeDb({
      fail: (label) =>
        label.includes("SHARE ROW EXCLUSIVE")
          ? new ApplyDbError("gone", "42P01")
          : undefined,
    })
    const outcome = await executePlan(
      db,
      target,
      {
        ...plan,
        locks: [{ schema: "app", name: "p", mode: "shareRowExclusive" }],
      },
      options
    )
    expect(outcome).toMatchObject({
      status: "refused",
      diagnostics: [
        { code: "apply.target-changed", params: { sections: "relations" } },
      ],
    })
  })

  it("sets the preamble search path around the engine steps only", async () => {
    const intent = step("s1", "ALTER TABLE app.t RENAME TO t2", {
      origin: "intent",
    })
    const engineSteps = plan.steps.map((s, i) => ({ ...s, id: `s${i + 2}` }))
    const { db, log, calls } = spied()
    const outcome = await executePlan(
      db,
      target,
      { ...plan, steps: [intent, ...engineSteps] },
      options
    )
    expect(outcome).toMatchObject({ status: "committed" })
    const at = (label: string) => log.indexOf(label)
    // Крок наміру — під налаштуваннями транзакції, до преамбули
    expect(at("ALTER TABLE app.t RENAME TO t2")).toBeLessThan(at("save-path"))
    expect(log.slice(at("save-path"), at("save-path") + 3)).toEqual([
      "save-path",
      "set-path",
      "ALTER TABLE app.t ADD COLUMN d int",
    ])
    expect(log.lastIndexOf("set-path")).toBe(
      log.indexOf('ALTER TABLE app."x.y" ADD COLUMN e int') + 1
    )
    const sets = calls.filter((c) => c.sql.includes("set_config('search_path'"))
    expect(sets.map((c) => c.params)).toEqual([["pg_catalog"], [SESSION_PATH]])
    expect(log).not.toContain("function-bodies")
  })

  it("runs the guards of an engine step under the preamble search path", async () => {
    const guard =
      "SELECT count(*) AS lost FROM app.t WHERE c IS NOT NULL AND c::int::text IS DISTINCT FROM c"
    const guarded = step("s1", "ALTER TABLE app.t ALTER COLUMN c TYPE int", {
      guards: [guard],
    })
    const { db, calls } = spied()
    // Результат не важить (фейк не знає цього кроку): лише порядок операторів
    await executePlan(db, target, { ...plan, steps: [guarded] }, options)
    const sqls = calls.map((c) => c.sql)
    const setAt = sqls.findIndex((sql) =>
      sql.includes("set_config('search_path'")
    )
    expect(setAt).toBeGreaterThanOrEqual(0)
    expect(sqls.indexOf(guard)).toBeGreaterThan(setAt)
  })

  it("does not touch the search path without a preamble", async () => {
    const { db, log } = fakeDb()
    await executePlan(db, target, { ...plan, preamble: [] }, options)
    expect(log).not.toContain("save-path")
    expect(log).not.toContain("set-path")
  })

  it("leaves function body validation on although the preamble turns it off", async () => {
    const { db, log } = fakeDb()
    const outcome = await executePlan(
      db,
      target,
      {
        ...plan,
        preamble: [
          { name: "search_path", value: "pg_catalog" },
          { name: "check_function_bodies", value: "off" },
        ],
      },
      options
    )
    expect(outcome).toMatchObject({ status: "committed" })
    expect(log).not.toContain("function-bodies")
  })

  it("refuses a preamble setting off the allowed list before BEGIN", async () => {
    const { db, log } = fakeDb()
    const outcome = await executePlan(
      db,
      target,
      { ...plan, preamble: [{ name: "role", value: "postgres" }] },
      options
    )
    expect(outcome).toMatchObject({
      status: "refused",
      attempts: 0,
      diagnostics: [
        {
          code: "engine.preamble-unknown",
          params: { name: "role", value: "postgres" },
        },
      ],
    })
    expect(log).toEqual([])
  })

  it("checks the promotion items of the section, not the display field", async () => {
    const { db, log } = fakeDb()
    const outcome = await executePlan(db, target, promoted, {
      ...options,
      mode: "rehearse",
    })
    expect(outcome).toMatchObject({
      status: "refused",
      attempts: 0,
      diagnostics: [
        {
          code: "apply.permission-required",
          params: { items: "access:app.party" },
        },
      ],
    })
    expect(log).toEqual([])
  })

  it("refuses to commit a promotion before BEGIN", async () => {
    const { db, log } = fakeDb()
    const outcome = await executePlan(db, target, promoted, {
      ...options,
      allow: ["access:app.party"],
    })
    expect(outcome).toMatchObject({
      status: "refused",
      attempts: 0,
      diagnostics: [{ code: "apply.promotion-checks-pending" }],
    })
    expect(log).toEqual([])
  })

  it.each(["rehearse", "proof"] as const)(
    "runs a promotion in %s mode and records it with its hash",
    async (mode) => {
      const { db, log, calls } = spied()
      const outcome = await executePlan(db, target, promoted, {
        ...options,
        mode,
        allow: ["access:app.party"],
      })
      expect(outcome.status).toBe(
        mode === "rehearse" ? "rolledBack" : "committed"
      )
      expect(log).toContain("ledger")
      const ledger = calls.find((c) =>
        c.sql.startsWith("INSERT INTO simetra.ledger")
      )!
      expect(ledger.params).toContain(
        JSON.stringify({ hash: "d".repeat(64), record: RECORD })
      )
    }
  )

  it("records no promotion for a plan without one", async () => {
    const { db, calls } = spied()
    await executePlan(db, target, plan, options)
    const ledger = calls.find((c) =>
      c.sql.startsWith("INSERT INTO simetra.ledger")
    )!
    const columns = /\(([^)]*)\)/
      .exec(ledger.sql)![1]!
      .split(",")
      .map((c) => c.trim())
    expect(ledger.params![columns.indexOf("promotion")]).toBeNull()
  })

  it("takes the advisory lock with the platform key", async () => {
    const sqls: string[] = []
    const { db } = fakeDb()
    const spy: ApplyDatabase = {
      transaction: (t, end, fn) =>
        db.transaction(t, end, (tx) =>
          fn({
            query: (sql, p) => {
              sqls.push(sql)
              return tx.query(sql, p)
            },
          })
        ),
    }
    await executePlan(spy, target, plan, options)
    expect(sqls[0]).toContain("pg_try_advisory_xact_lock(1397312837, 1)")
  })

  it("skips the chain in proof mode and ends rehearse with ROLLBACK", async () => {
    const proof = fakeDb()
    expect(
      await executePlan(proof.db, target, plan, {
        ...options,
        mode: "proof",
        planHash: "proof",
      })
    ).toMatchObject({ status: "committed" })
    expect(proof.log).not.toContain("state")

    const rehearse = fakeDb()
    expect(
      await executePlan(rehearse.db, target, plan, {
        ...options,
        mode: "rehearse",
      })
    ).toMatchObject({ status: "rolledBack", attempts: 1 })
    expect(rehearse.log.slice(-3)).toEqual(["marker", "ledger", "ROLLBACK"])
  })

  it("backs off 500, 1000, 2000, 4000 ms ±20% between attempts", async () => {
    for (let run = 0; run < 20; run++) {
      const pauses: number[] = []
      const { db, log } = fakeDb({
        fail: (label) =>
          label.startsWith("LOCK TABLE")
            ? new ApplyDbError("lock timeout", "55P03")
            : undefined,
      })
      const outcome = await executePlan(db, target, plan, {
        ...options,
        sleep: async (ms) => {
          pauses.push(ms)
        },
      })
      expect(outcome).toMatchObject({
        status: "failed",
        attempts: 5,
        diagnostics: [{ code: "apply.lock-timeout", params: { attempts: 5 } }],
      })
      expect(log.filter((l) => l === "BEGIN")).toHaveLength(5)
      expect(pauses).toHaveLength(4)
      ;[500, 1000, 2000, 4000].forEach((base, i) => {
        expect(pauses[i]).toBeGreaterThanOrEqual(base * 0.8)
        expect(pauses[i]).toBeLessThanOrEqual(base * 1.2)
      })
    }
  })

  it("never pauses longer than the maximum", async () => {
    const pauses: number[] = []
    const { db } = fakeDb({
      fail: (label) =>
        label === "ALTER TABLE app.t ADD COLUMN d int"
          ? new ApplyDbError("deadlock detected", "40P01")
          : undefined,
    })
    await executePlan(db, target, plan, {
      ...options,
      timeouts: { attempts: 9 },
      sleep: async (ms) => {
        pauses.push(ms)
      },
    })
    expect(pauses).toHaveLength(8)
    expect(Math.max(...pauses)).toBeLessThanOrEqual(8000)
    expect(pauses.slice(4).every((ms) => ms >= 8000 * 0.8)).toBe(true)
  })

  it("commits on a later attempt after a lock conflict", async () => {
    const { db, log } = fakeDb({
      fail: (label, attempt) =>
        label === "fingerprint" && attempt === 1
          ? new ApplyDbError("lock timeout", "55P03")
          : undefined,
    })
    const outcome = await executePlan(db, target, plan, options)
    expect(outcome).toMatchObject({ status: "committed", attempts: 2 })
    expect(log.filter((l) => l === "COMMIT")).toHaveLength(1)
  })

  it("does not retry a failed step", async () => {
    const { db, log } = fakeDb({
      fail: (label) =>
        label === "ALTER TABLE app.t ADD COLUMN d int"
          ? new ApplyDbError('relation "app.t" does not exist', "42P01")
          : undefined,
    })
    const outcome = await executePlan(db, target, plan, options)
    expect(outcome).toEqual({
      status: "failed",
      attempts: 1,
      diagnostics: [
        expect.objectContaining({
          code: "apply.step-failed",
          severity: "error",
          params: {
            step: "s1",
            sqlstate: "42P01",
            error: 'relation "app.t" does not exist',
          },
        }),
      ],
    })
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(1)
    expect(log.at(-1)).toBe("ROLLBACK")
  })

  it.each(["42P01", "42809"])(
    "reports a locked table that vanished or changed kind (%s) as a changed target",
    async (sqlstate) => {
      const { db, log } = fakeDb({
        fail: (label) =>
          label.startsWith("LOCK TABLE")
            ? new ApplyDbError("gone", sqlstate)
            : undefined,
      })
      const outcome = await executePlan(db, target, plan, options)
      expect(outcome).toEqual({
        status: "refused",
        attempts: 1,
        diagnostics: [
          expect.objectContaining({
            code: "apply.target-changed",
            params: { sections: "relations" },
          }),
        ],
      })
      expect(log.filter((l) => l === "BEGIN")).toHaveLength(1)
      expect(log).not.toContain("fingerprint")
    }
  )

  it("refuses at once when the advisory lock is taken", async () => {
    const pauses: number[] = []
    const { db, log } = fakeDb({ locked: false })
    const outcome = await executePlan(db, target, plan, {
      ...options,
      sleep: async (ms) => {
        pauses.push(ms)
      },
    })
    expect(outcome).toMatchObject({
      status: "refused",
      attempts: 1,
      diagnostics: [{ code: "apply.busy" }],
    })
    expect(pauses).toEqual([])
    expect(log).toEqual(["BEGIN", "try-lock", "ROLLBACK"])
  })

  it("refuses an API role", async () => {
    const { db } = fakeDb({ role: "authenticated" })
    expect(await executePlan(db, target, plan, options)).toMatchObject({
      status: "refused",
      diagnostics: [
        { code: "apply.api-role", params: { role: "authenticated" } },
      ],
    })
  })

  it("refuses a plan off the chain", async () => {
    const { db } = fakeDb()
    expect(
      await executePlan(
        db,
        target,
        { ...plan, fromHash: "a".repeat(64) },
        options
      )
    ).toMatchObject({
      status: "refused",
      diagnostics: [
        {
          code: "apply.chain",
          params: { expected: "a".repeat(64), found: "initial" },
        },
      ],
    })
  })

  it("refuses a fingerprint of another version before BEGIN", async () => {
    const { db, log } = fakeDb()
    const outcome = await executePlan(
      db,
      target,
      { ...plan, targetFingerprint: { ...TARGET, version: 99 } },
      options
    )
    expect(outcome).toMatchObject({
      status: "refused",
      attempts: 0,
      diagnostics: [
        {
          code: "apply.plan-versions",
          params: {
            field: "fingerprintVersion",
            plan: 99,
            current: FINGERPRINT_VERSION,
          },
        },
      ],
    })
    expect(log).toEqual([])
  })

  it("lints and checks permissions before BEGIN", async () => {
    const { db, log } = fakeDb()
    const outcome = await executePlan(
      db,
      target,
      {
        ...plan,
        steps: [
          step("s1", "DROP TABLE app.t CASCADE", { class: "destructive" }),
        ],
        drift: { reason: "drift", sections: ["owner"], paths: [] },
      },
      options
    )
    expect(outcome).toMatchObject({ status: "refused", attempts: 0 })
    expect(
      outcome.diagnostics.map((d) => [d.code, d.params.items ?? d.params.verb])
    ).toEqual([
      ["apply.cascade", "DROP TABLE"],
      ["apply.permission-required", "drift, s1"],
    ])
    expect(log).toEqual([])
  })

  it("does not retry a lost connection and reads the ledger", async () => {
    const applied = fakeDb({
      ledgerHasApply: true,
      fail: (label, attempt) =>
        label === "ledger" && attempt === 1
          ? new ApplyConnectionLost("Connection terminated")
          : undefined,
    })
    const outcome = await executePlan(applied.db, target, plan, options)
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
    expect(applied.log.filter((l) => l === "BEGIN")).toHaveLength(2)
    // Пошук — окремим оператором після блокуючого advisory lock: знімок
    // береться вже після того, як `COMMIT` у дорозі став видимим
    expect(applied.log.slice(-5)).toEqual([
      "BEGIN",
      "lookup-timeouts",
      "lookup-lock",
      "lookup",
      "ROLLBACK",
    ])
    // Межа очікування — `idleInTransactionMs` плюс 30 с
    expect(applied.params["lookup-timeouts"]).toEqual(["90000ms"])
    if (outcome.status !== "committed") throw new Error("committed expected")
    expect(outcome.diagnostics[0]!.params.applyId).toBe(outcome.applyId)
  })

  it("reports not applied when the ledger has no row of this apply", async () => {
    const { db } = fakeDb({
      fail: (label, attempt) =>
        label === "fingerprint" && attempt === 1
          ? new ApplyConnectionLost("Connection terminated")
          : undefined,
    })
    expect(await executePlan(db, target, plan, options)).toMatchObject({
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
  })

  it("reports an unknown outcome when the ledger cannot be read", async () => {
    const { db } = fakeDb({
      fail: (label) =>
        label === "ledger" || label === "lookup"
          ? new ApplyConnectionLost("Connection terminated")
          : undefined,
    })
    expect(await executePlan(db, target, plan, options)).toMatchObject({
      status: "failed",
      diagnostics: [
        { code: "apply.connection-lost", params: { outcome: "unknown" } },
      ],
    })
  })

  it("bounds the lookup wait by the idle-in-transaction timeout", async () => {
    const { db, params } = fakeDb({
      fail: (label, attempt) =>
        label === "ledger" && attempt === 1
          ? new ApplyConnectionLost("Connection terminated")
          : undefined,
    })
    await executePlan(db, target, plan, {
      ...options,
      timeouts: { idleInTransactionMs: 5000 },
    })
    expect(params["lookup-timeouts"]).toEqual(["35000ms"])
  })

  it("reports an unknown outcome with the apply id when the lookup times out", async () => {
    const { db } = fakeDb({
      ledgerHasApply: true,
      fail: (label) =>
        label === "ledger"
          ? new ApplyConnectionLost("Connection terminated")
          : label === "lookup-lock"
            ? new ApplyDbError(
                "canceling statement due to lock timeout",
                "55P03"
              )
            : undefined,
    })
    const outcome = await executePlan(db, target, plan, options)
    expect(outcome).toMatchObject({
      status: "failed",
      attempts: 1,
      diagnostics: [
        { code: "apply.connection-lost", params: { outcome: "unknown" } },
      ],
    })
    const [diagnostic] = outcome.diagnostics
    const applyId = String(diagnostic!.params.applyId)
    expect(applyId).toMatch(/^[0-9a-f-]{36}$/)
    expect(diagnostic!.message).toContain(applyId)
  })

  it("reports an unknown outcome for a ledger row of another format", async () => {
    const { db } = fakeDb({
      ledgerHasApply: true,
      ledgerFormat: 2,
      fail: (label, attempt) =>
        label === "ledger" && attempt === 1
          ? new ApplyConnectionLost("Connection terminated")
          : undefined,
    })
    expect(await executePlan(db, target, plan, options)).toMatchObject({
      status: "failed",
      diagnostics: [
        { code: "apply.connection-lost", params: { outcome: "unknown" } },
      ],
    })
  })

  it("compares the target without owner only in proof mode", async () => {
    const script = {
      targetSections: { ...TARGET.sections, owner: "another-owner" },
    }
    expect(
      await executePlan(fakeDb(script).db, target, plan, {
        ...options,
        mode: "proof",
        planHash: "proof",
      })
    ).toMatchObject({ status: "committed" })
    expect(
      await executePlan(fakeDb(script).db, target, plan, options)
    ).toMatchObject({
      status: "refused",
      diagnostics: [
        { code: "apply.target-changed", params: { sections: "owner" } },
      ],
    })
  })

  it("ignores timeouts given as undefined", async () => {
    const { db, params, log } = fakeDb({
      fail: (label) =>
        label.startsWith("LOCK TABLE")
          ? new ApplyDbError("lock timeout", "55P03")
          : undefined,
    })
    const outcome = await executePlan(db, target, plan, {
      ...options,
      timeouts: {
        lockTimeoutMs: undefined,
        statementTimeoutMs: undefined,
        idleInTransactionMs: undefined,
        attempts: undefined,
        backoffMs: undefined,
      },
    })
    expect(params.timeouts).toEqual(["3000ms", "600000ms", "60000ms"])
    expect(outcome).toMatchObject({ status: "failed", attempts: 5 })
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(5)
  })

  it("does not look in the ledger after a lost rehearsal", async () => {
    const { db, log } = fakeDb({
      ledgerHasApply: true,
      fail: (label) =>
        label === "ledger"
          ? new ApplyConnectionLost("Connection terminated")
          : undefined,
    })
    expect(
      await executePlan(db, target, plan, { ...options, mode: "rehearse" })
    ).toMatchObject({
      status: "failed",
      diagnostics: [
        { code: "apply.connection-lost", params: { outcome: "not-applied" } },
      ],
    })
    expect(log).not.toContain("lookup")
    expect(log).not.toContain("lookup-lock")
  })

  it("passes an unexpected database error through", async () => {
    const { db } = fakeDb({
      fail: (label) =>
        label === "marker"
          ? new ApplyDbError("permission denied for table marker", "42501")
          : undefined,
    })
    await expect(executePlan(db, target, plan, options)).rejects.toThrow(
      ApplyDbError
    )
  })
})
