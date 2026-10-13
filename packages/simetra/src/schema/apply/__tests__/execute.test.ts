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
  type GlobalDefaultPrivilege,
  type PlanStep,
  type PreservedTable,
  type ProviderLockSet,
  SUPABASE_LOCKS,
} from "simetra/schema"
import { promotionRecordHash, type PromotionRecord } from "simetra/compiler"

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
    produced: [],
    destroyed: [],
    consumed: [],
    dataLoss: false,
    rewriteRisk: false,
    guards: [],
    ...over,
  }
}

/** Перелік провайдера, який план прочитав з цілі: таблиць немає. */
const NO_PROVIDER_TABLES: ProviderLockSet[] = SUPABASE_LOCKS.sources.map(
  (source) => ({
    setting: source.setting,
    statements: [...source.statements],
    tables: [],
  })
)

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
  role: "postgres",
  implicitLocks: [],
  providerLocks: NO_PROVIDER_TABLES,
  locks: [
    { schema: "app", name: "t", mode: "accessExclusive" },
    { schema: "app", name: "x.y", mode: "accessExclusive" },
  ],
  preamble: [{ name: "search_path", value: "pg_catalog" }],
  promotion: null,
  environment: { defaultPrivileges: [] },
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

const RECORD_HASH = await promotionRecordHash(RECORD)

/** План із секцією промоції: пункт `access:` поза `requiredPermissions`. */
const promoted: ExecutablePlan = {
  ...plan,
  // Поле лише показ: раннер рахує пункти з секції, тож порожнє не допомагає
  requiredPermissions: [],
  promotion: {
    recordHash: RECORD_HASH,
    record: RECORD,
    permissionItems: [{ token: "access:app.party", summary: ["anon: select"] }],
    preservation: [],
    columns: [],
    canonicalNames: [],
    conversions: [],
  },
}

/**
 * Запис з однією таблицею `app.t → app.u` і його хеш: секція зі
 * збереженням мусить мати рівно один замір на кожну таблицю запису.
 */
const TABLED: PromotionRecord = {
  ...RECORD,
  tables: [{ id: RECORD.objectId, schema: "app", from: "t", to: "u" }],
}
const tabled = {
  record: TABLED,
  recordHash: await promotionRecordHash(TABLED),
}

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
  /** Таблиці до кроків і замки сесії для звірки сліду. */
  existing?: {
    oid: string
    schema: string
    name: string
    ancestors: string[]
  }[]
  held?: { oid: string; mode: string }[]
  /** Таблиці замків, що є в базі (копії доказу). */
  present?: { schema: string; name: string }[]
  /** Значення налаштувань провайдера за іменем; типово немає. */
  providerSettings?: Record<string, string>
  /** Таблиці переліку провайдера, що є в базі. */
  providerTables?: { schema: string; name: string }[]
  /** Рядки глобальних типових привілеїв ролі на цілі; типово немає. */
  environment?: GlobalDefaultPrivilege[]
}

/** Мітка оператора для журналу: що саме виконав раннер. */
function labelOf(sql: string): string | undefined {
  if (sql.includes("pg_try_advisory_xact_lock")) return "try-lock"
  if (sql.includes("pg_advisory_xact_lock")) return "lookup-lock"
  if (sql.includes("set_config('statement_timeout', $1"))
    return "lookup-timeouts"
  if (sql.includes("set_config('lock_timeout'")) return "timeouts"
  if (sql.includes("current_user")) return "role"
  if (sql.includes("FROM pg_catalog.pg_locks")) return "held-locks"
  if (sql.includes("c.oid::text AS oid")) return "existing"
  if (sql.includes("current_setting($1, true)")) return "provider-setting"
  if (sql.includes("current_schemas(true)")) return "provider-tables"
  if (sql.includes("x(schema text, name text)")) return "present"
  if (sql.includes("FROM pg_catalog.pg_default_acl")) return "environment"
  if (sql.includes("to_regclass") && sql.includes(" AS marker")) return "state"
  if (sql.startsWith("SAVEPOINT simetra_fingerprint")) return "fingerprint"
  if (sql.startsWith("INSERT INTO simetra.marker")) return "marker"
  if (sql.startsWith("INSERT INTO simetra.ledger")) return "ledger"
  if (sql.includes("WHERE apply_id")) return "lookup"
  if (sql.includes("current_setting('search_path')")) return "save-path"
  if (sql.includes("set_config('search_path'")) return "set-path"
  if (sql.includes("check_function_bodies")) return "function-bodies"
  if (sql.includes("hashtextextended"))
    return `measure ${sql.slice(sql.lastIndexOf(" FROM ") + 6)}`
  if (sql.includes(" AS probe"))
    return `probe ${sql.slice("SELECT pg_catalog.count(".length, sql.indexOf(") AS probe"))}`
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
            label?.startsWith("measure") === true
              ? [{ rows: "1", c0: "5" }]
              : label === "provider-setting"
                ? [
                    {
                      value: script.providerSettings?.[String(p?.[0])] ?? null,
                    },
                  ]
                : label === "provider-tables"
                  ? (script.providerTables ?? [])
                  : label === "present"
                    ? (script.present ?? [])
                    : label === "environment"
                      ? (script.environment ?? []).map((r) => ({ ...r }))
                      : label === "existing"
                        ? (script.existing ?? [])
                        : label === "held-locks"
                          ? (script.held ?? [])
                          : label === "try-lock"
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
                                    : sql.includes("encode(sha256")
                                      ? [
                                          stepsRan
                                            ? DESIRED.sections
                                            : (script.targetSections ??
                                              TARGET.sections),
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
      "role",
      "timeouts",
      "state",
      "provider-setting",
      "provider-setting",
      "environment",
      'LOCK TABLE app.t, app."x.y" IN ACCESS EXCLUSIVE MODE',
      "fingerprint",
      "ALTER TABLE app.t ADD COLUMN d int",
      "CREATE INDEX i ON app.u (id)",
      'ALTER TABLE app."x.y" ADD COLUMN e int',
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

  it("takes the locks from the strongest mode down, before the fingerprint", async () => {
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
          { schema: "app", name: "s", mode: "share" },
          { schema: "app", name: "v", mode: "shareUpdateExclusive" },
        ],
      },
      options
    )
    expect(outcome).toMatchObject({ status: "committed" })
    const locks = log.filter((l) => l.startsWith("LOCK TABLE"))
    expect(locks).toEqual([
      'LOCK TABLE app.t, app."x.y" IN ACCESS EXCLUSIVE MODE',
      "LOCK TABLE app.p, ref.q IN SHARE ROW EXCLUSIVE MODE",
      "LOCK TABLE app.s IN SHARE MODE",
      "LOCK TABLE app.v IN SHARE UPDATE EXCLUSIVE MODE",
    ])
    expect(log.indexOf(locks.at(-1)!)).toBeLessThan(log.indexOf("fingerprint"))
  })

  it("refuses a lock privilege denial without a retry", async () => {
    const { db, log } = fakeDb({
      fail: (label) =>
        label.startsWith("LOCK TABLE")
          ? new ApplyDbError("permission denied for table t", "42501")
          : undefined,
    })
    const outcome = await executePlan(db, target, plan, options)
    expect(outcome).toMatchObject({
      status: "refused",
      attempts: 1,
      diagnostics: [
        {
          code: "apply.lock-privilege",
          params: {
            mode: "ACCESS EXCLUSIVE",
            tables: 'app.t, app."x.y"',
            error: "permission denied for table t",
          },
        },
      ],
    })
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(1)
  })

  it("refuses a role other than the plan's right after the advisory lock", async () => {
    const { db, log } = fakeDb({ role: "someone_else" })
    const outcome = await executePlan(db, target, plan, {
      ...options,
      mode: "rehearse",
    })
    expect(outcome).toMatchObject({
      status: "refused",
      diagnostics: [
        {
          code: "apply.role-mismatch",
          params: { plan: "postgres", current: "someone_else" },
        },
      ],
    })
    expect(log).toEqual(["BEGIN", "try-lock", "role", "ROLLBACK"])
    // Копія доказу — інша база, можливо з іншою роллю адміністрування
    const proof = fakeDb({ role: "someone_else" })
    expect(
      await executePlan(proof.db, target, plan, { ...options, mode: "proof" })
    ).toMatchObject({ status: "committed" })
  })

  it("refuses before the locks when the global default privileges changed after the plan", async () => {
    // Рішення 5(д) плану П3-2b-0: план доведено без глобальних ADP ролі, а на
    // цілі вони вже є
    const anon: GlobalDefaultPrivilege = {
      objtype: "S",
      grantee: "anon",
      privilege: "SELECT",
      grantable: false,
    }
    const { db, log, params } = fakeDb({ environment: [anon] })
    expect(await executePlan(db, target, plan, options)).toMatchObject({
      status: "refused",
      attempts: 1,
      diagnostics: [
        {
          code: "apply.target-changed",
          params: { sections: "environment" },
        },
      ],
    })
    expect(params.environment).toEqual(["postgres"])
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(1)
    expect(log.some((l) => l.startsWith("LOCK TABLE"))).toBe(false)
    // Той самий перелік, що й у плані, — застосування йде далі
    const same = fakeDb({ environment: [anon] })
    expect(
      await executePlan(
        same.db,
        target,
        { ...plan, environment: { defaultPrivileges: [anon] } },
        options
      )
    ).toMatchObject({ status: "committed" })
    // Копію доказу засіяно й звірено окремо: раннер її середовища не читає
    const proof = fakeDb({ environment: [anon] })
    expect(
      await executePlan(proof.db, target, plan, { ...options, mode: "proof" })
    ).toMatchObject({ status: "committed" })
    expect(proof.log).not.toContain("environment")
  })

  it("refuses before the locks when the provider list changed after the plan", async () => {
    // План побудовано з порожнім переліком, а на цілі він уже називає таблицю
    const script: Script = {
      providerSettings: {
        "supautils.policy_grants": JSON.stringify({ postgres: ["auth.users"] }),
      },
      providerTables: [{ schema: "auth", name: "users" }],
    }
    const { db, log } = fakeDb(script)
    const outcome = await executePlan(db, target, plan, {
      ...options,
      mode: "rehearse",
    })
    expect(outcome).toMatchObject({
      status: "refused",
      diagnostics: [
        {
          code: "apply.target-changed",
          params: { sections: "providerLocks" },
        },
      ],
    })
    // Без повтору й без жодного замка
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(1)
    expect(log.some((l) => l.startsWith("LOCK TABLE"))).toBe(false)
    // Той самий перелік, що й у плані, — застосування йде далі
    const same = fakeDb(script)
    expect(
      await executePlan(
        same.db,
        target,
        {
          ...plan,
          providerLocks: NO_PROVIDER_TABLES.map((set) =>
            set.setting === "supautils.policy_grants"
              ? { ...set, tables: [{ schema: "auth", name: "users" }] }
              : set
          ),
        },
        options
      )
    ).toMatchObject({ status: "committed" })
    // Копія доказу перелік не перечитує
    const proof = fakeDb(script)
    expect(
      await executePlan(proof.db, target, plan, { ...options, mode: "proof" })
    ).toMatchObject({ status: "committed" })
    expect(proof.log).not.toContain("provider-setting")
  })

  it("warns about a lock beyond the plan's footprint on existing tables only", async () => {
    const { db } = fakeDb({
      existing: [
        { oid: "1", schema: "app", name: "t", ancestors: [] },
        { oid: "2", schema: "app", name: "p", ancestors: [] },
        { oid: "3", schema: "app", name: "w", ancestors: [] },
        { oid: "4", schema: "app", name: "x", ancestors: [] },
      ],
      held: [
        { oid: "1", mode: "AccessExclusiveLock" },
        { oid: "2", mode: "ShareRowExclusiveLock" },
        // Кілька режимів однієї таблиці — одне попередження з сильнішим
        { oid: "2", mode: "ShareLock" },
        // Не сильніше за ROW EXCLUSIVE
        { oid: "3", mode: "RowExclusiveLock" },
        { oid: "4", mode: "ShareUpdateExclusiveLock" },
        // Таблиця, створена планом: її до кроків не було
        { oid: "9", mode: "AccessExclusiveLock" },
      ],
    })
    const outcome = await executePlan(
      db,
      target,
      {
        ...plan,
        implicitLocks: [
          { schema: "app", name: "p", mode: "share", step: "s2" },
        ],
      },
      { ...options, mode: "rehearse" }
    )
    expect(outcome).toMatchObject({
      status: "rolledBack",
      diagnostics: [
        {
          code: "apply.lock-footprint-exceeded",
          severity: "warning",
          params: {
            table: "app.p",
            mode: "SHARE ROW EXCLUSIVE",
            planned: "SHARE",
          },
        },
        {
          code: "apply.lock-footprint-exceeded",
          severity: "warning",
          params: {
            table: "app.x",
            mode: "SHARE UPDATE EXCLUSIVE",
            planned: "none",
          },
        },
      ],
    })
  })

  it("plans a child in the mode of its ancestors, locked without ONLY", async () => {
    const { db } = fakeDb({
      existing: [
        { oid: "1", schema: "app", name: "t", ancestors: [] },
        // Партиція партиції app.t: замок предка займає і її
        { oid: "5", schema: "app", name: "t_2026", ancestors: ["6", "1"] },
        { oid: "6", schema: "app", name: "t_y", ancestors: ["1"] },
        { oid: "7", schema: "app", name: "p", ancestors: [] },
        { oid: "8", schema: "app", name: "p_1", ancestors: ["7"] },
      ],
      held: [
        { oid: "1", mode: "AccessExclusiveLock" },
        { oid: "5", mode: "AccessExclusiveLock" },
        { oid: "6", mode: "AccessExclusiveLock" },
        // Нащадок неявного замка SHARE узяв сильніший режим — прогалина
        { oid: "8", mode: "ExclusiveLock" },
      ],
    })
    const outcome = await executePlan(
      db,
      target,
      {
        ...plan,
        implicitLocks: [
          { schema: "app", name: "p", mode: "share", step: "s2" },
        ],
      },
      { ...options, mode: "rehearse" }
    )
    expect(outcome).toMatchObject({
      status: "rolledBack",
      diagnostics: [
        {
          code: "apply.lock-footprint-exceeded",
          params: { table: "app.p_1", mode: "EXCLUSIVE", planned: "SHARE" },
        },
      ],
    })
  })

  it("locks on the proof copy only the tables it has", async () => {
    const { db, log } = fakeDb({ present: [{ schema: "app", name: "t" }] })
    const outcome = await executePlan(db, target, plan, {
      ...options,
      mode: "proof",
    })
    expect(outcome).toMatchObject({ status: "committed" })
    expect(log.filter((l) => l.startsWith("LOCK TABLE"))).toEqual([
      "LOCK TABLE app.t IN ACCESS EXCLUSIVE MODE",
    ])
    // Ціль: таблиця, якої немає, — відмова «ціль змінилась», а не пропуск
    const live = fakeDb()
    await executePlan(live.db, target, plan, options)
    expect(live.log).not.toContain("present")
  })

  it("checks the lock footprint on rehearsal and proof, not on apply", async () => {
    for (const mode of ["rehearse", "proof"] as const) {
      const { db, log } = fakeDb()
      await executePlan(db, target, plan, { ...options, mode })
      expect(log.indexOf("existing")).toBeLessThan(
        log.indexOf("ALTER TABLE app.t ADD COLUMN d int")
      )
      expect(log.indexOf("held-locks")).toBe(log.indexOf("ledger") + 1)
    }
    const { db, log } = fakeDb()
    await executePlan(db, target, plan, options)
    expect(log).not.toContain("existing")
    expect(log).not.toContain("held-locks")
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

  // R22 плану П3-2a: пара преамбули неподільна, тож у 2a план її лише несе
  it("runs every step and guard under the transaction settings although the plan records a preamble", async () => {
    const intent = step("s1", "ALTER TABLE app.t RENAME TO t2", {
      origin: "intent",
    })
    const guard =
      "SELECT count(*) AS lost FROM app.t WHERE c IS NOT NULL AND c::int::text IS DISTINCT FROM c"
    const engineSteps = plan.steps.map((s, i) => ({
      ...s,
      id: `s${i + 2}`,
      guards: i === 0 ? [guard] : [],
    }))
    const { db, log, calls } = spied()
    const outcome = await executePlan(
      db,
      target,
      {
        ...plan,
        steps: [intent, ...engineSteps],
        preamble: [
          { name: "search_path", value: "pg_catalog" },
          { name: "check_function_bodies", value: "off" },
        ],
      },
      options
    )
    expect(outcome).toMatchObject({ status: "committed" })
    expect(log).not.toContain("save-path")
    expect(log).not.toContain("set-path")
    expect(log).not.toContain("function-bodies")
    expect(calls.some((c) => c.params?.includes("pg_catalog") === true)).toBe(
      false
    )
    // Сторож повністю кваліфікований і йде перед своїм кроком без преамбули
    expect(log.indexOf(guard)).toBe(
      log.indexOf("ALTER TABLE app.t ADD COLUMN d int") - 1
    )
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
        JSON.stringify({ hash: RECORD_HASH, record: RECORD })
      )
    }
  )

  it("refuses before BEGIN a promotion whose hash is not its record's", async () => {
    const { db, log } = fakeDb()
    const run = executePlan(
      db,
      target,
      {
        ...promoted,
        promotion: { ...promoted.promotion!, recordHash: "d".repeat(64) },
      },
      { ...options, mode: "rehearse", allow: ["access:app.party"] }
    )
    // Ledger виводить із хешу «запис застосовано»: розбіжність із записом —
    // зламаний конвеєр плану, а не стан цілі, тож це виняток, а не відмова
    await expect(run).rejects.toThrow(/recordHash/)
    expect(log).toEqual([])
  })

  const brokenPreservation: [
    string,
    PreservedTable[],
    PromotionRecord["columns"]?,
  ][] = [
    ["no measurement", []],
    [
      "a measurement of another table",
      [
        {
          before: { schema: "app", table: "t" },
          after: { schema: "app", table: "v" },
          key: { before: "id", after: "id" },
          columns: [],
        },
      ],
    ],
    [
      "a measurement under another old name",
      [
        {
          before: { schema: "app", table: "x" },
          after: { schema: "app", table: "u" },
          key: { before: "id", after: "id" },
          columns: [],
        },
      ],
    ],
    [
      "a measurement without a mapped column",
      [
        {
          before: { schema: "app", table: "t" },
          after: { schema: "app", table: "u" },
          key: { before: "id", after: "id" },
          columns: [],
        },
      ],
      [
        {
          id: "00000000-0000-4000-8000-000000000011",
          sourceId: "00000000-0000-4000-8000-000000000012",
          schema: "app",
          table: "u",
          from: "c",
          to: "d",
        },
      ],
    ],
  ]
  it.each(brokenPreservation)(
    "refuses before BEGIN a promotion with %s for its table",
    async (_, preservation, columns = []) => {
      const record = { ...TABLED, columns }
      const { db, log } = fakeDb()
      const run = executePlan(
        db,
        target,
        {
          ...promoted,
          promotion: {
            ...promoted.promotion!,
            record,
            recordHash: await promotionRecordHash(record),
            permissionItems: [],
            preservation,
          },
        },
        { ...options, mode: "rehearse" }
      )
      // Без заміру доказ збереження тихо пропустився б: це зламаний
      // конвеєр плану, а не стан цілі
      await expect(run).rejects.toThrow(/preserve exactly the tables/)
      expect(log).toEqual([])
    }
  )

  it("measures preservation before the steps and after them", async () => {
    const { db, log } = fakeDb()
    const outcome = await executePlan(
      db,
      target,
      {
        ...promoted,
        promotion: {
          ...promoted.promotion!,
          ...tabled,
          permissionItems: [],
          preservation: [
            {
              before: { schema: "app", table: "t" },
              after: { schema: "app", table: "u" },
              key: { before: "id", after: "id" },
              columns: [{ before: "c", after: "d" }],
            },
          ],
        },
      },
      { ...options, mode: "rehearse" }
    )
    expect(outcome).toMatchObject({ status: "rolledBack", diagnostics: [] })
    expect(
      log.slice(
        log.indexOf('LOCK TABLE app.t, app."x.y" IN ACCESS EXCLUSIVE MODE') + 1
      )
    ).toEqual([
      "fingerprint",
      "measure app.t",
      "existing",
      "ALTER TABLE app.t ADD COLUMN d int",
      "CREATE INDEX i ON app.u (id)",
      'ALTER TABLE app."x.y" ADD COLUMN e int',
      "measure app.u",
      "fingerprint",
      "marker",
      "ledger",
      "held-locks",
      "ROLLBACK",
    ])
  })

  it("blames a failing key cast on the key, not on another cast column", async () => {
    // Ключ `id` і колонка `x` обидві міняють тип; падає лише приведення
    // ключа. Проба з ключем у виразі впала б і для `x`
    const overflow = new ApplyDbError("integer out of range", "22003")
    const { db, log } = fakeDb({
      fail: (label) =>
        label === "measure app.t" || label === "probe (id::integer)"
          ? overflow
          : undefined,
    })
    const outcome = await executePlan(
      db,
      target,
      {
        ...promoted,
        promotion: {
          ...promoted.promotion!,
          ...tabled,
          permissionItems: [],
          preservation: [
            {
              before: { schema: "app", table: "t" },
              after: { schema: "app", table: "u" },
              key: { before: "(id::integer)", after: "id" },
              columns: [
                { before: "(x::integer)", after: "x", typeChangeStep: "s7" },
                { before: "(id::integer)", after: "id", typeChangeStep: "s9" },
              ],
            },
          ],
        },
      },
      { ...options, mode: "rehearse" }
    )
    expect(outcome).toMatchObject({
      status: "failed",
      diagnostics: [
        {
          code: "apply.type-narrowing",
          params: { step: "s9", table: "app.u", column: "id" },
        },
      ],
    })
    expect(log).toContain("probe (x::integer)")
    expect(log).not.toContain("ALTER TABLE app.t ADD COLUMN d int")
  })

  it("rethrows a before measurement failure that no single cast explains", async () => {
    const overflow = new ApplyDbError("integer out of range", "22003")
    const { db } = fakeDb({
      fail: (label) => (label === "measure app.t" ? overflow : undefined),
    })
    await expect(
      executePlan(
        db,
        target,
        {
          ...promoted,
          promotion: {
            ...promoted.promotion!,
            ...tabled,
            permissionItems: [],
            preservation: [
              {
                before: { schema: "app", table: "t" },
                after: { schema: "app", table: "u" },
                key: { before: "id", after: "id" },
                columns: [
                  { before: "(x::integer)", after: "x", typeChangeStep: "s7" },
                ],
              },
            ],
          },
        },
        { ...options, mode: "rehearse" }
      )
    ).rejects.toBe(overflow)
  })

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
    expect(rehearse.log.slice(-3)).toEqual(["ledger", "held-locks", "ROLLBACK"])
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
    // План, побудований тією самою роллю API: збіг ролі не рятує
    const { db } = fakeDb({ role: "authenticated" })
    expect(
      await executePlan(db, target, { ...plan, role: "authenticated" }, options)
    ).toMatchObject({
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
