import { describe, expect, it } from "vitest"
import {
  ApplyConnectionLost,
  ApplyDbError,
  DATA_SETTINGS,
  executePlan,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  type ApplyDatabase,
  type CatalogFingerprint,
  type EngineCatalog,
  type ExecutablePlan,
  type ExecuteOptions,
  type Extracted,
  type FingerprintSection,
  type GlobalDefaultPrivilege,
  type LiveForeignKey,
  type PlanStep,
  type PreservedTable,
  type RehearsalProof,
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
  foreignKeys: { subjects: [], live: [] },
  preamble: [{ name: "search_path", value: "pg_catalog" }],
  revalidationSearchPath: '"$user", public, extensions',
  plpgsqlCheck: "unavailable",
  desiredInvalid: [],
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

/**
 * Заглушка доказу репетиції (фаза 18): двигун не бачить розбіжності. Тести,
 * що не перевіряють сам доказ, підставляють її в `rehearse`.
 */
const stubRehearsal: RehearsalProof = {
  engine: {
    plan: () => ({ actions: [], empty: true, preamble: [], diagnostics: [] }),
  },
  desired: {} as EngineCatalog,
}

const options: ExecuteOptions = {
  mode: "apply",
  planHash: "p".repeat(64),
  allow: [],
  snapshot: { tables: [] },
  sleep: async () => {},
}

const withMode = (mode: "apply" | "rehearse" | "proof"): ExecuteOptions =>
  mode === "rehearse"
    ? { ...options, mode, rehearsal: stubRehearsal }
    : { ...options, mode }

interface Script {
  /** Недійсні обмеження й індекси цілі після кроків (фаза 16). */
  invalid?: string[]
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
  /** Секції відбитка після кроків; типово `DESIRED`. */
  resultSections?: CatalogFingerprint["sections"]
  /** Діагностичний витяг у транзакції; типово фейк витягу не має. */
  extract?: () => Promise<Extracted>
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
  /** FK цілі, що торкаються таблиць сліду; типово немає. */
  foreignKeys?: LiveForeignKey[]
  /**
   * Результат DO-блоку валідаторів за номером виклику в спробі: 0 — базова
   * лінія, 1 — після кроків; `"none"` — блок завершився без результату.
   * Типово помилок немає.
   */
  validators?: (call: number) => ValidatorResult | "none"
  /** Сліпі функції цілі; типово немає. */
  blind?: string[]
  /** Сліпі функції цілі з переліку пресету провайдера; типово немає. */
  expectedBlind?: string[]
  /** Факти `plpgsql_check` бази поверх «немає, але можна поставити». */
  plpgsql?: Record<string, unknown>
  /** Групи помилок `plpgsql_check` за номером виклику: 0 — до, 1 — після. */
  plpgsqlGroups?: (call: number) => Record<string, unknown>[]
}

/** Факти бази: розширення немає, роль може його поставити. */
const PLPGSQL_FACTS = {
  installed: false,
  schema: null,
  schemaUsage: false,
  functionExecute: false,
  available: true,
  trusted: false,
  superuser: false,
  createOnDatabase: true,
  checkSchemaTaken: false,
}

/** Те, що DO-блок валідаторів віддає винятком `SIMFE`. */
interface ValidatorResult {
  total: number
  errors: {
    oid: string
    signature: string
    sqlstate: string
    message: string
  }[]
}

/** Налаштування транзакції фейкової бази до будь-якого `set_config`. */
const SESSION = { search_path: '"$user", public', check_function_bodies: "on" }

/** Мітка оператора для журналу: що саме виконав раннер. */
function labelOf(sql: string): string | undefined {
  if (sql.includes("current_setting(s.name)")) return "get-settings"
  if (sql.includes("set_config(s.name, s.value, true)")) return "set-settings"
  if (sql.startsWith("DO $simetra$")) return "validators"
  if (sql.includes("simetra_revalidate")) return undefined
  if (sql.includes("pg_available_extension_versions")) return "plpgsql-facts"
  if (sql.includes("plpgsql_check_function_tb(p.oid")) return "plpgsql-check"
  if (sql.includes("regprocedure::text AS signature")) return "blind"
  if (sql === "SET CONSTRAINTS ALL IMMEDIATE") return "set-constraints"
  if (sql.includes("c.convalidated")) return "invalid"
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
  if (sql.includes("k.contype = 'f'")) return "foreign-keys"
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
  // Заміри й проби рахують вирази в підзапиті: мітка — таблиця підзапиту
  // і вираз проби між переводами рядка
  if (sql.includes("hashtextextended"))
    return `measure ${/ FROM (\S+)\) AS s$/.exec(sql)![1]!}`
  if (sql.includes(" AS probe"))
    return `probe ${/\(SELECT \(\n([\s\S]*)\n\) AS x FROM /.exec(sql)![1]!}`
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
  /** Налаштування транзакції під кожним виконанням оператора з міткою. */
  const seen: Record<string, Record<string, string>[]> = {}
  let attempt = 0
  const db: ApplyDatabase = {
    async transaction(_target, end, fn) {
      attempt++
      let stepsRan = false
      let validatorCalls = 0
      let plpgsqlCalls = 0
      const settings: Record<string, string> = { ...SESSION }
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
          if (label !== undefined)
            seen[label] = [...(seen[label] ?? []), { ...settings }]
          const error =
            label === undefined ? undefined : script.fail?.(label, attempt)
          if (error !== undefined) throw error
          if (plan.steps.some((s) => s.sql === sql)) stepsRan = true
          if (label === "set-settings") {
            const [names, values] = p as [string[], string[]]
            names.forEach((n, i) => (settings[n] = values[i]!))
          }
          if (label === "validators") {
            const result = script.validators?.(validatorCalls++) ?? {
              total: 0,
              errors: [],
            }
            if (result !== "none")
              throw new ApplyDbError(JSON.stringify(result), "SIMFE")
          }
          if (label === "foreign-keys")
            return (script.foreignKeys ?? []).map((fk) => ({
              schema: fk.schema,
              table: fk.table,
              columns: fk.columns,
              ref_schema: fk.references.schema,
              ref_table: fk.references.table,
              ref_columns: fk.references.columns,
            })) as unknown as R[]
          const rows: Record<string, unknown>[] =
            label?.startsWith("measure") === true
              ? [{ rows: "1", c0: "5" }]
              : label === "get-settings"
                ? (p![0] as string[]).map((n) => ({ value: settings[n] }))
                : label === "blind"
                  ? [
                      ...(script.blind ?? []).map((signature) => ({
                        signature,
                        expected: false,
                      })),
                      ...(script.expectedBlind ?? []).map((signature) => ({
                        signature,
                        expected: true,
                      })),
                    ]
                  : label === "invalid"
                    ? (script.invalid ?? []).map((object) => ({ object }))
                    : label === "plpgsql-facts"
                      ? [{ ...PLPGSQL_FACTS, ...script.plpgsql }]
                      : label === "plpgsql-check"
                        ? (script.plpgsqlGroups?.(plpgsqlCalls++) ?? [])
                        : label === "provider-setting"
                          ? [
                              {
                                value:
                                  script.providerSettings?.[String(p?.[0])] ??
                                  null,
                              },
                            ]
                          : label === "provider-tables"
                            ? (script.providerTables ?? [])
                            : label === "present"
                              ? (script.present ?? [])
                              : label === "environment"
                                ? (script.environment ?? []).map((r) => ({
                                    ...r,
                                  }))
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
                                                ? [
                                                    {
                                                      format:
                                                        script.ledgerFormat ??
                                                        1,
                                                    },
                                                  ]
                                                : []
                                              : sql.includes("encode(sha256")
                                                ? [
                                                    stepsRan
                                                      ? (script.resultSections ??
                                                        DESIRED.sections)
                                                      : (script.targetSections ??
                                                        TARGET.sections),
                                                  ]
                                                : []
          return rows as R[]
        },
        extract: async (): Promise<Extracted> => {
          log.push("extract")
          return script.extract === undefined
            ? ({
                model: { tables: [], enumTypes: [], units: [] },
                catalog: {},
                diagnostics: [],
                unpopulated: [],
              } as unknown as Extracted)
            : script.extract()
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
  return { db, log, params, seen }
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
      // 7. Базова лінія тіл під налаштуваннями ревалідації
      "get-settings",
      "set-settings",
      "validators",
      "set-settings",
      // 11. Кроки двигуна під преамбулою
      "get-settings",
      "set-settings",
      "ALTER TABLE app.t ADD COLUMN d int",
      "CREATE INDEX i ON app.u (id)",
      'ALTER TABLE app."x.y" ADD COLUMN e int',
      "set-settings",
      "set-constraints",
      // 15. Ревалідація й сліпі функції
      "get-settings",
      "set-settings",
      "validators",
      "blind",
      "set-settings",
      // 16. Валідність; далі відбиток результату
      "fingerprint",
      "invalid",
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
            ...tx,
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
      rehearsal: stubRehearsal,
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

  it("refuses before the locks when a foreign key of the footprint appeared after the plan", async () => {
    // Рішення 9 плану П3-2b-1: план прочитав FK таблиці сліду, коли FK поза
    // межею ще не було; на цілі він уже є
    const subjects = [{ schema: "app", name: "t" }]
    const r: LiveForeignKey = {
      schema: "other",
      table: "r",
      columns: ["t"],
      references: { schema: "app", table: "t", columns: ["id"] },
    }
    const watched = { ...plan, foreignKeys: { subjects, live: [] } }
    const { db, log, params } = fakeDb({ foreignKeys: [r] })
    expect(await executePlan(db, target, watched, options)).toMatchObject({
      status: "refused",
      attempts: 1,
      diagnostics: [
        {
          code: "apply.target-changed",
          params: { sections: "foreignKeys" },
        },
      ],
    })
    expect(params["foreign-keys"]).toEqual([JSON.stringify(subjects)])
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(1)
    expect(log.some((l) => l.startsWith("LOCK TABLE"))).toBe(false)
    // Після переліку провайдера й глобальних ADP (рішення 1)
    expect(log.indexOf("foreign-keys")).toBeGreaterThan(
      log.indexOf("environment")
    )
    // Ті самі FK, що й у плані, — застосування йде далі. Ключі FK плану — в
    // іншому порядку, ніж їх складає читач: план з артефакту розбирає Zod за
    // своєю схемою, тож звірка — канонічна, а не за порядком ключів
    const reordered = {
      references: {
        columns: r.references.columns,
        table: r.references.table,
        schema: r.references.schema,
      },
      columns: r.columns,
      table: r.table,
      schema: r.schema,
    } satisfies LiveForeignKey
    const same = fakeDb({ foreignKeys: [r] })
    expect(
      await executePlan(
        same.db,
        target,
        { ...plan, foreignKeys: { subjects, live: [reordered] } },
        options
      )
    ).toMatchObject({ status: "committed" })
    // Копія доказу несе лише межу: FK там не читаються
    const proof = fakeDb({ foreignKeys: [r] })
    expect(
      await executePlan(proof.db, target, watched, {
        ...options,
        mode: "proof",
      })
    ).toMatchObject({ status: "committed" })
    expect(proof.log).not.toContain("foreign-keys")
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
      rehearsal: stubRehearsal,
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
          // Ключі — в іншому порядку, ніж їх складає читач: звірка канонічна
          providerLocks: NO_PROVIDER_TABLES.map((set) =>
            set.setting === "supautils.policy_grants"
              ? {
                  tables: [{ name: "users", schema: "auth" }],
                  statements: set.statements,
                  setting: set.setting,
                }
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
      { ...options, mode: "rehearse", rehearsal: stubRehearsal }
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
      { ...options, mode: "rehearse", rehearsal: stubRehearsal }
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
      await executePlan(db, target, plan, withMode(mode))
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

  // R22 плану П3-2a і рішення 1 плану П3-2b-1: преамбула — лише навколо
  // блоку кроків двигуна разом із їхніми сторожами
  it("runs engine steps and their guards under the preamble, the other steps under the transaction settings", async () => {
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
    const environment = step("s5", "GRANT SELECT ON app.n TO anon", {
      origin: "environment",
    })
    const { db, seen } = fakeDb()
    const outcome = await executePlan(
      db,
      target,
      {
        ...plan,
        steps: [intent, ...engineSteps, environment],
        preamble: [
          { name: "search_path", value: "pg_catalog" },
          { name: "check_function_bodies", value: "off" },
        ],
      },
      options
    )
    expect(outcome).toMatchObject({ status: "committed" })
    const preamble = { search_path: "pg_catalog", check_function_bodies: "off" }
    expect(seen[guard]).toEqual([preamble])
    for (const s of engineSteps) expect(seen[s.sql]).toEqual([preamble])
    // Після блоку двигуна — знову налаштування транзакції
    expect(seen[intent.sql]).toEqual([SESSION])
    expect(seen[environment.sql]).toEqual([SESSION])
    expect(seen.marker).toEqual([SESSION])
    expect(seen.ledger).toEqual([SESSION])
  })

  it("runs a preamble of the search path alone as it is", async () => {
    const { db, seen } = fakeDb()
    const outcome = await executePlan(db, target, plan, options)
    expect(outcome).toMatchObject({ status: "committed" })
    expect(seen["CREATE INDEX i ON app.u (id)"]).toEqual([
      { search_path: "pg_catalog", check_function_bodies: "on" },
    ])
  })

  it("validates the bodies under the revalidation settings before and after the steps", async () => {
    const { db, seen } = fakeDb()
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
    const revalidation = {
      search_path: plan.revalidationSearchPath,
      check_function_bodies: "on",
    }
    expect(seen.validators).toEqual([revalidation, revalidation])
    expect(seen.blind).toEqual([revalidation])
    expect(seen.fingerprint!.at(-1)).toEqual(SESSION)
  })

  it("refuses a function error the steps brought in, naming the function", async () => {
    const before = {
      oid: "100",
      signature: "app.old()",
      sqlstate: "42P01",
      message: 'relation "gone" does not exist',
    }
    const broken = {
      oid: "200",
      signature: "app.fa()",
      sqlstate: "42703",
      message: 'column "a" does not exist',
    }
    const { db, log } = fakeDb({
      validators: (call) =>
        call === 0
          ? { total: 1, errors: [before] }
          : { total: 2, errors: [{ ...before, oid: "101" }, broken] },
    })
    const outcome = await executePlan(db, target, plan, options)
    expect(outcome).toMatchObject({
      status: "failed",
      attempts: 1,
      diagnostics: [
        {
          code: "apply.function-check-failed",
          severity: "error",
          params: {
            count: 1,
            functions: 'app.fa(): 42703 column "a" does not exist',
          },
        },
      ],
    })
    expect(log).not.toContain("marker")
    expect(log.at(-1)).toBe("ROLLBACK")
  })

  it("names at most ten new function errors and counts them all", async () => {
    const errors = Array.from({ length: 12 }, (_, i) => ({
      oid: String(i),
      signature: `app.f${i}()`,
      sqlstate: "42703",
      message: "x",
    }))
    const { db } = fakeDb({
      validators: (call) =>
        call === 0 ? { total: 0, errors: [] } : { total: 12, errors },
    })
    const outcome = await executePlan(db, target, plan, options)
    expect(outcome.diagnostics[0]!.params.count).toBe(12)
    expect(
      String(outcome.diagnostics[0]!.params.functions).split("; ")
    ).toHaveLength(10)
  })

  it.each([
    ["the baseline", 0, "baseline"],
    ["the check after the steps", 1, "after"],
  ])(
    "refuses to compare when the function error list was cut in %s, naming that side",
    async (_, cut, side) => {
      // Обрізаний бік несе 1001, інший — нуль: кількість мусить бути саме
      // обрізаного боку, а не «нових» помилок після кроків
      const { db } = fakeDb({
        validators: (call) =>
          call === cut ? { total: 1001, errors: [] } : { total: 0, errors: [] },
      })
      const outcome = await executePlan(db, target, plan, options)
      expect(outcome).toMatchObject({
        status: "failed",
        diagnostics: [
          {
            code: "apply.function-check-failed",
            params: { cut: side, count: 1001, limit: 1000 },
          },
        ],
      })
      expect(outcome.diagnostics[0]!.message).toContain(
        `${side === "baseline" ? "before" : "after"} the plan's steps: there are at least 1001`
      )
    }
  )

  it("checks plpgsql bodies with a transient extension in a savepoint, before and after the steps", async () => {
    const { db, log, seen } = fakeDb()
    const outcome = await executePlan(
      db,
      target,
      { ...plan, plpgsqlCheck: "transient" },
      options
    )
    expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
    const plpgsql = [
      "SAVEPOINT simetra_plpgsql_check",
      "plpgsql-facts",
      "CREATE SCHEMA simetra_plpgsql_check",
      "CREATE EXTENSION plpgsql_check SCHEMA simetra_plpgsql_check",
      "plpgsql-check",
      "ROLLBACK TO SAVEPOINT simetra_plpgsql_check",
      "RELEASE SAVEPOINT simetra_plpgsql_check",
    ]
    const at = log.indexOf("fingerprint")
    expect(log.slice(at + 1, at + 5 + plpgsql.length)).toEqual([
      "get-settings",
      "set-settings",
      "validators",
      ...plpgsql,
      "set-settings",
    ])
    expect(log.filter((l) => l === "plpgsql-check")).toHaveLength(2)
    const revalidation = {
      search_path: plan.revalidationSearchPath,
      check_function_bodies: "on",
    }
    expect(seen["plpgsql-check"]).toEqual([revalidation, revalidation])
    // Режим звіряється лише для встановленого розширення
    expect(log.indexOf("plpgsql-facts")).toBeGreaterThan(at)
  })

  it("refuses a plpgsql error the steps brought in, with the trigger table", async () => {
    const kept = {
      oid: "100",
      signature: "app.old()",
      relationOid: null,
      relation: null,
      sqlstate: "42P01",
      message: "x",
      n: 2,
    }
    const { db } = fakeDb({
      plpgsqlGroups: (call) =>
        call === 0
          ? [kept]
          : [
              { ...kept, oid: "101" },
              {
                oid: "200",
                signature: "app.tf()",
                relationOid: "7",
                relation: "app.t",
                sqlstate: "42703",
                message: 'record "new" has no field "a"',
                n: 1,
              },
            ],
    })
    const outcome = await executePlan(
      db,
      target,
      { ...plan, plpgsqlCheck: "transient" },
      options
    )
    expect(outcome).toMatchObject({
      status: "failed",
      diagnostics: [
        {
          code: "apply.function-check-failed",
          params: {
            count: 1,
            functions: 'app.tf() on app.t: 42703 record "new" has no field "a"',
          },
        },
      ],
    })
  })

  it("fails when the extension cannot be taken", async () => {
    const { db, log } = fakeDb({
      fail: (label) =>
        label.startsWith("CREATE EXTENSION")
          ? new ApplyDbError("extension is not allowed", "0A000")
          : undefined,
    })
    const outcome = await executePlan(
      db,
      target,
      { ...plan, plpgsqlCheck: "transient" },
      options
    )
    expect(outcome).toMatchObject({
      status: "failed",
      attempts: 1,
      diagnostics: [
        {
          code: "apply.plpgsql-check-unavailable",
          severity: "error",
          params: { sqlstate: "0A000", error: "extension is not allowed" },
        },
      ],
    })
    expect(log).not.toContain("ALTER TABLE app.t ADD COLUMN d int")
  })

  it("refuses when the installed extension is gone", async () => {
    const installed: ExecutablePlan = { ...plan, plpgsqlCheck: "installed" }
    const live = fakeDb()
    expect(
      await executePlan(live.db, target, installed, options)
    ).toMatchObject({
      status: "refused",
      diagnostics: [
        {
          code: "apply.target-changed",
          params: { sections: "plpgsqlCheck" },
        },
      ],
    })
    // До блокувань, як інші звірки фази 4
    expect(live.log).toContain("plpgsql-facts")
    expect(live.log).not.toContain(
      'LOCK TABLE app.t, app."x.y" IN ACCESS EXCLUSIVE MODE'
    )
    // Копія доказу розширення цілі може не мати: раннер ставить його сам
    const copy = fakeDb()
    expect(
      await executePlan(copy.db, target, installed, {
        ...options,
        mode: "proof",
      })
    ).toMatchObject({ status: "committed", diagnostics: [] })
    expect(copy.log).toContain(
      "CREATE EXTENSION plpgsql_check SCHEMA simetra_plpgsql_check"
    )
  })

  it("fails, not refuses, when the role lost its rights on the installed extension", async () => {
    // Рішення 4, крок 3: розширення на місці — ціль та сама, а взяти його
    // перевірка не може
    const { db, log } = fakeDb({
      plpgsql: {
        installed: true,
        schema: "ext",
        schemaUsage: false,
        functionExecute: true,
      },
    })
    expect(
      await executePlan(
        db,
        target,
        { ...plan, plpgsqlCheck: "installed" },
        options
      )
    ).toMatchObject({
      status: "failed",
      diagnostics: [
        {
          code: "apply.plpgsql-check-unavailable",
          params: { sqlstate: "42501" },
        },
      ],
    })
    // Звірка фази 4 пройшла: блокування взято
    expect(log).toContain(
      'LOCK TABLE app.t, app."x.y" IN ACCESS EXCLUSIVE MODE'
    )
    expect(log).not.toContain("ALTER TABLE app.t ADD COLUMN d int")
  })

  it("applies an installed plan with the extension in place", async () => {
    const { db, log } = fakeDb({
      plpgsql: {
        installed: true,
        schema: "ext",
        schemaUsage: true,
        functionExecute: true,
      },
    })
    expect(
      await executePlan(
        db,
        target,
        { ...plan, plpgsqlCheck: "installed" },
        options
      )
    ).toMatchObject({ status: "committed" })
    expect(log).not.toContain("CREATE SCHEMA simetra_plpgsql_check")
    expect(log.filter((l) => l === "plpgsql-check")).toHaveLength(2)
  })

  it("warns on a copy without the extension", async () => {
    const fail = (label: string) =>
      label.startsWith("CREATE EXTENSION")
        ? new ApplyDbError("could not open extension control file", "58P01")
        : undefined
    const copy = fakeDb({ fail })
    const proof = { ...options, mode: "proof" as const }
    const outcome = await executePlan(
      copy.db,
      target,
      { ...plan, plpgsqlCheck: "transient" },
      proof
    )
    expect(outcome).toMatchObject({
      status: "committed",
      diagnostics: [
        {
          code: "plan.plpgsql-check-unavailable",
          severity: "warning",
          params: { on: "copy", sqlstate: "58P01" },
        },
      ],
    })
    // Пропущена до кроків перевірка не повторюється після них
    expect(
      copy.log.filter((l) => l === "SAVEPOINT simetra_plpgsql_check")
    ).toHaveLength(1)
    // Промоція вимагає перевірки: та сама відмова
    const promotion = fakeDb({ fail })
    expect(
      await executePlan(
        promotion.db,
        target,
        { ...promoted, plpgsqlCheck: "transient" },
        { ...proof, allow: ["access:app.party"] }
      )
    ).toMatchObject({
      status: "failed",
      diagnostics: [
        {
          code: "plan.plpgsql-check-unavailable",
          severity: "error",
          params: { on: "copy" },
        },
      ],
    })
  })

  it("refuses a taken check schema", async () => {
    const { db } = fakeDb({ plpgsql: { checkSchemaTaken: true } })
    expect(
      await executePlan(
        db,
        target,
        { ...plan, plpgsqlCheck: "transient" },
        options
      )
    ).toMatchObject({
      status: "refused",
      diagnostics: [
        {
          code: "apply.temp-name-taken",
          params: { name: "simetra_plpgsql_check" },
        },
      ],
    })
  })

  it("refuses to compare a cut plpgsql_check list", async () => {
    const { db } = fakeDb({
      plpgsqlGroups: (call) =>
        call === 1
          ? Array.from({ length: 1001 }, (_, i) => ({
              oid: String(i),
              signature: `app.f${i}()`,
              relationOid: null,
              relation: null,
              sqlstate: "42703",
              message: "x",
              n: 1,
            }))
          : [],
    })
    expect(
      await executePlan(
        db,
        target,
        { ...plan, plpgsqlCheck: "transient" },
        options
      )
    ).toMatchObject({
      status: "failed",
      diagnostics: [
        {
          code: "apply.function-check-failed",
          params: { cut: "after", count: 1001, limit: 1000 },
        },
      ],
    })
  })

  it("does not warn about the provider's expected blind functions", async () => {
    const { db, params } = fakeDb({
      blind: ["app.fh()"],
      expectedBlind: ["pgbouncer.get_auth(text)"],
    })
    const outcome = await executePlan(
      db,
      target,
      { ...plan, plpgsqlCheck: "transient" },
      options
    )
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({
        code: "apply.function-check-blind",
        params: { count: 1, functions: "app.fh()" },
      }),
    ])
    expect(params.blind![0]).toBe(true)
    expect(params.blind![1]).toContain("pgbouncer.get_auth(text)")
  })

  it("throws when the validator block ends without its result", async () => {
    const { db, log } = fakeDb({ validators: () => "none" })
    await expect(executePlan(db, target, plan, options)).rejects.toThrow(
      /without its result/
    )
    expect(log.at(-1)).toBe("ROLLBACK")
  })

  it("retries the attempt when a validator waits on a lock past the timeout", async () => {
    const { db, log } = fakeDb({
      fail: (label, attempt) =>
        label === "validators" && attempt === 1
          ? new ApplyDbError("canceling statement due to lock timeout", "55P03")
          : undefined,
    })
    const outcome = await executePlan(db, target, plan, options)
    expect(outcome).toMatchObject({ status: "committed", attempts: 2 })
    expect(log.filter((l) => l === "COMMIT")).toHaveLength(1)
  })

  it("stops with the sqlstate when a deferred constraint fails before the end", async () => {
    const { db, log } = fakeDb({
      fail: (label) =>
        label === "set-constraints"
          ? new ApplyDbError("insert or update violates", "23503")
          : undefined,
    })
    const outcome = await executePlan(db, target, plan, options)
    expect(outcome).toMatchObject({
      status: "failed",
      diagnostics: [
        {
          code: "apply.deferred-constraint-failed",
          params: { sqlstate: "23503" },
        },
      ],
    })
    expect(log).not.toContain("COMMIT")
  })

  it("retries the attempt when SET CONSTRAINTS waits on a lock", async () => {
    const { db } = fakeDb({
      fail: (label, attempt) =>
        label === "set-constraints" && attempt === 1
          ? new ApplyDbError("canceling statement due to lock timeout", "55P03")
          : undefined,
    })
    expect(await executePlan(db, target, plan, options)).toMatchObject({
      status: "committed",
      attempts: 2,
    })
  })

  it("refuses an invalid object the desired state does not have, before the result fingerprint", async () => {
    const { db, log } = fakeDb({
      invalid: ["constraint app.t t_a", "index app.i"],
    })
    const outcome = await executePlan(
      db,
      target,
      { ...plan, desiredInvalid: ["index app.i"] },
      options
    )
    expect(outcome).toMatchObject({
      status: "failed",
      diagnostics: [
        {
          code: "apply.constraint-invalid",
          params: { objects: "constraint app.t t_a" },
        },
      ],
    })
    expect(log).not.toContain("COMMIT")
    expect(log.filter((l) => l === "fingerprint")).toHaveLength(2)
  })

  it("names the differing catalog paths before it rolls back", async () => {
    const enums = Array.from({ length: 21 }, (_, i) => ({
      schema: "app",
      name: `e${String(i).padStart(2, "0")}`,
      values: [],
    }))
    const extracted = (enumTypes: typeof enums): Extracted =>
      ({
        model: { tables: [], enumTypes, units: [] },
        catalog: {},
        diagnostics: [],
        unpopulated: [],
      }) as unknown as Extracted
    const diverging = { ...DESIRED.sections, relations: "other" }
    for (const mode of ["apply", "rehearse"] as const) {
      const { db, log } = fakeDb({
        resultSections: diverging,
        extract: async () => extracted(enums.slice(0, 2)),
      })
      expect(await executePlan(db, target, plan, withMode(mode))).toMatchObject(
        {
          status: "failed",
          diagnostics: [
            {
              code: "apply.verify-failed",
              params: {
                sections: "relations",
                paths: "enumTypes.app.e00, enumTypes.app.e01",
              },
            },
          ],
        }
      )
      expect(log.slice(-2)).toEqual(["extract", "ROLLBACK"])
    }
    const many = await executePlan(
      fakeDb({
        resultSections: diverging,
        extract: async () => extracted(enums),
      }).db,
      target,
      plan,
      options
    )
    const paths = String(many.diagnostics[0]!.params.paths).split(", ")
    expect(paths).toHaveLength(21)
    expect(paths.at(-2)).toBe("enumTypes.app.e19")
    expect(paths.at(-1)).toBe("…")
    const same = await executePlan(
      fakeDb({ resultSections: diverging, extract: async () => extracted([]) })
        .db,
      target,
      plan,
      options
    )
    expect(same.diagnostics[0]!.params.paths).toBe(
      "(the catalog model shows no difference)"
    )
  })

  it("keeps verify-failed when the diagnostic extract fails", async () => {
    const outcome = await executePlan(
      fakeDb({
        resultSections: { ...DESIRED.sections, relations: "other" },
        extract: () => Promise.reject(new Error("engine broke")),
      }).db,
      target,
      plan,
      options
    )
    expect(outcome).toMatchObject({
      status: "failed",
      diagnostics: [
        {
          code: "apply.verify-failed",
          params: {
            sections: "relations",
            paths: "(the diagnostic extract failed: engine broke)",
          },
        },
      ],
    })
  })

  describe("the engine proof of a rehearsal (phase 18)", () => {
    const refusing = (
      actions: { sql: string }[],
      diagnostics: { severity: string; message: string }[] = []
    ): ExecuteOptions => ({
      ...options,
      mode: "rehearse",
      rehearsal: {
        engine: {
          plan: () =>
            ({
              actions,
              empty: actions.length === 0,
              preamble: [],
              diagnostics,
            }) as unknown as ReturnType<RehearsalProof["engine"]["plan"]>,
        },
        desired: {} as EngineCatalog,
      },
    })

    it("fails when the engine still plans actions, naming the first", async () => {
      const { db, log } = fakeDb()
      const outcome = await executePlan(
        db,
        target,
        plan,
        refusing([{ sql: "ALTER TABLE app.t ADD COLUMN z int" }, { sql: "x" }])
      )
      expect(outcome).toMatchObject({
        status: "failed",
        diagnostics: [
          {
            code: "apply.rehearsal-proof-failed",
            params: { count: 2, first: "ALTER TABLE app.t ADD COLUMN z int" },
          },
        ],
      })
      expect(log.slice(-2)).toEqual(["extract", "ROLLBACK"])
      expect(log).not.toContain("ledger")
    })

    it("fails on an error diagnostic of the engine plan, ignores warnings", async () => {
      const outcome = await executePlan(
        fakeDb().db,
        target,
        plan,
        refusing([], [{ severity: "error", message: "unplannable" }])
      )
      expect(outcome).toMatchObject({
        status: "failed",
        diagnostics: [
          {
            code: "apply.rehearsal-proof-failed",
            params: { count: 1, first: "unplannable" },
          },
        ],
      })
      expect(
        await executePlan(
          fakeDb().db,
          target,
          plan,
          refusing([], [{ severity: "warning", message: "meh" }])
        )
      ).toMatchObject({ status: "rolledBack" })
    })

    it("turns a failing extract into the same refusal", async () => {
      const outcome = await executePlan(
        fakeDb({ extract: () => Promise.reject(new Error("engine broke")) }).db,
        target,
        plan,
        { ...options, mode: "rehearse", rehearsal: stubRehearsal }
      )
      expect(outcome).toMatchObject({
        status: "failed",
        diagnostics: [
          {
            code: "apply.rehearsal-proof-failed",
            params: { first: "(the extract failed: engine broke)" },
          },
        ],
      })
    })

    it("lets a lost connection of the extract propagate to the lookup", async () => {
      const { db } = fakeDb({
        extract: () => Promise.reject(new ApplyConnectionLost("gone")),
      })
      const outcome = await executePlan(db, target, plan, {
        ...options,
        mode: "rehearse",
        rehearsal: stubRehearsal,
      })
      // Обрив — не провал доказу: його розбирає пошук за id застосування, а
      // пустушка ledger запису не має, тож «не застосовано»
      expect(outcome).toMatchObject({
        status: "failed",
        diagnostics: [
          {
            code: "apply.connection-lost",
            params: { outcome: "not-applied" },
          },
        ],
      })
    })

    it("does not run for apply and proof", async () => {
      for (const mode of ["apply", "proof"] as const) {
        const { db, log } = fakeDb()
        await executePlan(db, target, plan, { ...options, mode })
        expect(log).not.toContain("extract")
      }
    })
  })

  it("does not extract on the proof copy", async () => {
    const { db, log } = fakeDb({
      resultSections: { ...DESIRED.sections, relations: "other" },
    })
    const outcome = await executePlan(db, target, plan, {
      ...options,
      mode: "proof",
      planHash: "proof",
    })
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({
        code: "apply.verify-failed",
        params: { sections: "relations" },
      }),
    ])
    expect(log).not.toContain("extract")
  })

  it("accepts an invalid object the desired state has", async () => {
    const { db } = fakeDb({ invalid: ["index app.i"] })
    const outcome = await executePlan(
      db,
      target,
      { ...plan, desiredInvalid: ["index app.i"] },
      options
    )
    expect(outcome).toMatchObject({ status: "committed" })
  })

  it.each(["apply", "rehearse"] as const)(
    "warns in %s mode about functions the check cannot see",
    async (mode) => {
      const blind = Array.from(
        { length: 11 },
        (_, i) => `app.b${String(i).padStart(2, "0")}()`
      )
      const { db } = fakeDb({ blind })
      const outcome = await executePlan(db, target, plan, withMode(mode))
      expect(outcome.diagnostics).toEqual([
        expect.objectContaining({
          code: "apply.function-check-blind",
          severity: "warning",
          params: {
            count: 11,
            functions: blind.slice(0, 10).join(", "),
          },
        }),
      ])
    }
  )

  it("does not warn about blind functions on the proof copy", async () => {
    const { db, log } = fakeDb({ blind: ["app.b()"] })
    const outcome = await executePlan(db, target, plan, {
      ...options,
      mode: "proof",
    })
    expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
    expect(log).not.toContain("blind")
  })

  it.each([
    ["whose intent step follows an engine step", ["engine", "intent"] as const],
    [
      "whose environment step precedes an engine step",
      ["environment", "engine"] as const,
    ],
  ])("refuses a plan %s before BEGIN", async (_, origins) => {
    const { db, log } = fakeDb()
    const run = executePlan(
      db,
      target,
      {
        ...plan,
        steps: origins.map((origin, i) =>
          step(`s${i + 1}`, `CREATE TABLE app.t${i} (id int)`, { origin })
        ),
      },
      options
    )
    await expect(run).rejects.toThrow(
      "plan steps are out of origin order: intent, engine, environment"
    )
    expect(log).toEqual([])
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
      rehearsal: stubRehearsal,
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
        ...withMode(mode),
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
      {
        ...options,
        mode: "rehearse",
        rehearsal: stubRehearsal,
        allow: ["access:app.party"],
      }
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
        { ...options, mode: "rehearse", rehearsal: stubRehearsal }
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
      { ...options, mode: "rehearse", rehearsal: stubRehearsal }
    )
    expect(outcome).toMatchObject({ status: "rolledBack", diagnostics: [] })
    expect(
      log.slice(
        log.indexOf('LOCK TABLE app.t, app."x.y" IN ACCESS EXCLUSIVE MODE') + 1
      )
    ).toEqual([
      "fingerprint",
      "get-settings",
      "set-settings",
      "measure app.t",
      "set-settings",
      "existing",
      "get-settings",
      "set-settings",
      "validators",
      "set-settings",
      "get-settings",
      "set-settings",
      "ALTER TABLE app.t ADD COLUMN d int",
      "CREATE INDEX i ON app.u (id)",
      'ALTER TABLE app."x.y" ADD COLUMN e int',
      "set-settings",
      "set-constraints",
      // Заміри «після» — до ревалідації (рішення 1 плану П3-2b-1)
      "get-settings",
      "set-settings",
      "measure app.u",
      "set-settings",
      "get-settings",
      "set-settings",
      "validators",
      "blind",
      "set-settings",
      "fingerprint",
      "invalid",
      "fingerprint",
      // Фаза 18: повний доказ двигуна — лише репетиція, після відбитка
      "extract",
      "marker",
      "ledger",
      "held-locks",
      "ROLLBACK",
    ])
  })

  it("measures preservation under the pinned data settings", async () => {
    const { db, log, seen } = fakeDb()
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
      { ...options, mode: "rehearse", rehearsal: stubRehearsal }
    )
    expect(outcome).toMatchObject({ status: "rolledBack", diagnostics: [] })
    const pinned = {
      ...SESSION,
      ...Object.fromEntries(DATA_SETTINGS.map((s) => [s.name, s.value])),
    }
    // Обидва заміри — під усіма парами, і після кожного налаштування
    // транзакції повертаються
    expect(seen["measure app.t"]).toEqual([pinned])
    expect(seen["measure app.u"]).toEqual([pinned])
    expect(seen.existing).toEqual([SESSION])
    expect(seen["set-constraints"]).toEqual([SESSION])
    for (const label of ["measure app.t", "measure app.u"]) {
      const i = log.indexOf(label)
      expect(log.slice(i - 2, i + 2), label).toEqual([
        "get-settings",
        "set-settings",
        label,
        "set-settings",
      ])
    }
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
      { ...options, mode: "rehearse", rehearsal: stubRehearsal }
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

  describe("a measurement error that is not a cast failure", () => {
    /** План із одним заміром `app.t → app.u`; `columns` — пари заміру. */
    const measured = (
      columns: PreservedTable["columns"] = [{ before: "c", after: "d" }]
    ): ExecutablePlan => ({
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
            columns,
          },
        ],
      },
    })
    const rehearse = { ...options, mode: "rehearse" as const }
    const run = (script: Script, p: ExecutablePlan = measured()) =>
      executePlan(fakeDb(script).db, target, p, {
        ...rehearse,
        rehearsal: stubRehearsal,
      })

    it("names a failed before measurement with its table and side", async () => {
      const missing = new ApplyDbError(
        'relation "app.t" does not exist',
        "42P01"
      )
      expect(
        await run({
          fail: (label) => (label === "measure app.t" ? missing : undefined),
        })
      ).toMatchObject({
        status: "failed",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.preservation-measure-failed",
            params: {
              table: "app.t",
              side: "before",
              sqlstate: "42P01",
              error: 'relation "app.t" does not exist',
            },
          },
        ],
      })
    })

    it.each([
      ["42P01", 'relation "app.u" does not exist'],
      // Після кроків змін типу вже немає: звуження назвати нічим
      ["22003", "integer out of range"],
    ])(
      "names a failed after measurement with SQLSTATE %s",
      async (sqlstate, message) => {
        const error = new ApplyDbError(message, sqlstate)
        expect(
          await run({
            fail: (label) => (label === "measure app.u" ? error : undefined),
          })
        ).toMatchObject({
          status: "failed",
          diagnostics: [
            {
              code: "apply.preservation-measure-failed",
              params: { table: "app.u", side: "after", sqlstate },
            },
          ],
        })
      }
    )

    it("names a before failure that no single cast explains", async () => {
      const overflow = new ApplyDbError("integer out of range", "22003")
      expect(
        await run(
          {
            fail: (label) => (label === "measure app.t" ? overflow : undefined),
          },
          measured([
            { before: "(x::integer)", after: "x", typeChangeStep: "s7" },
          ])
        )
      ).toMatchObject({
        status: "failed",
        diagnostics: [
          {
            code: "apply.preservation-measure-failed",
            params: { table: "app.t", side: "before", sqlstate: "22003" },
          },
        ],
      })
    })

    it("names a probe that fails with something other than a cast failure", async () => {
      const overflow = new ApplyDbError("integer out of range", "22003")
      const denied = new ApplyDbError("permission denied for table t", "42501")
      expect(
        await run(
          {
            fail: (label) =>
              label === "measure app.t"
                ? overflow
                : label === "probe (x::integer)"
                  ? denied
                  : undefined,
          },
          measured([
            { before: "(x::integer)", after: "x", typeChangeStep: "s7" },
          ])
        )
      ).toMatchObject({
        status: "failed",
        diagnostics: [
          {
            code: "apply.preservation-measure-failed",
            params: { table: "app.t", side: "before", sqlstate: "42501" },
          },
        ],
      })
    })

    it("lets a lock conflict through to the retry", async () => {
      const conflict = new ApplyDbError("lock timeout", "55P03")
      const { db, log } = fakeDb({
        fail: (label, attempt) =>
          label === "measure app.t" && attempt === 1 ? conflict : undefined,
      })
      expect(
        await executePlan(db, target, measured(), {
          ...rehearse,
          rehearsal: stubRehearsal,
        })
      ).toMatchObject({ status: "rolledBack", attempts: 2 })
      expect(log.filter((l) => l === "BEGIN")).toHaveLength(2)
    })
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
            ...tx,
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
        rehearsal: stubRehearsal,
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
      await executePlan(db, target, plan, {
        ...options,
        mode: "rehearse",
        rehearsal: stubRehearsal,
      })
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
