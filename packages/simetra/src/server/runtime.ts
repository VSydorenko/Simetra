import {
  APPLIED_SNAPSHOT_HASH_FUNCTION_NAME,
  BATCH_MAX,
  LIMIT_REASONS,
  LOGIN_ROLE_REQUEST_PURPOSES,
  OBJECT_MODULE_KEYS,
  PLATFORM_ROLES,
  PLATFORM_SCHEMA,
  PROVIDER_API_ROLES,
  READ_BATCH_STATEMENTS_MAX,
  ROW_VERSION_EPOCH_FUNCTION_NAME,
  TABULAR_LINES_MAX,
  runtimeCatalogSchema,
  sessionClaimsSchema,
  versionEpochSchema,
  type CommandError,
  type CommandResult,
  type DatabaseProvider,
  type ObjectModule,
  type Operation,
  type ProviderApiRoles,
  type ReadPart,
  type ReadPartValue,
  type ReadQuery,
  type ReadResultOf,
  type RequestRolePurpose,
  type RuntimeCatalog,
  type RuntimeObject,
  type SessionClaims,
  CommandFailure,
} from "simetra/model"
import { z } from "zod"
import { logsDatabaseError, type ErrorPhase } from "./errors"
import { rejectNested } from "./hook-context"
import {
  normalizeError,
  type CommandDatabase,
  type DatabaseClient,
} from "./port"
import {
  executeRead,
  ident,
  prepareRead,
  type ReadPlan,
  type ReadStatementRunner,
} from "./read"
import {
  COMMAND_ROLE,
  COMMIT,
  ReadBudget,
  endFailed,
  readRefusal,
  readSetupStatement,
  runCommand,
  type LogEntry,
  type RuntimeState,
} from "./transaction"

/** Options of {@link createCommandRuntime}. */
export interface CommandRuntimeOptions {
  database: CommandDatabase
  /** The runtime catalog object (`runtime-catalog.json`); validated here. */
  catalog: unknown
  /** Object modules keyed `"<kind>.<name>"`, e.g. `"Catalog.Client"`. */
  objectModules?: Readonly<Record<string, ObjectModule<object>>>
  /** Hands `afterCommit` work to the platform (`waitUntil`); without it `run` awaits that work. */
  defer?: (work: Promise<unknown>) => void
  /** Reads through the fallback path when the login role lacks the request role. */
  readFallback?: boolean
  /** Attempts in total on serialization failure or deadlock; default 3. */
  maxAttempts?: number
  /** Depth limit of phases started by hooks; default 8. */
  maxDepth?: number
  /**
   * `statement_timeout` ceiling of a server read statement in milliseconds
   * (integer ≥ 1); default 15 000. A statement past it fails its part with
   * `command.timeout`.
   */
  readStatementTimeoutMs?: number
  /**
   * Time budget of one server read transaction, all its parts, in
   * milliseconds (integer ≥ 1000); default 15 000. A part not started
   * before it fails with `command.timeout`.
   */
  readBudgetMs?: number
  /**
   * Time budget of one `run` call, retries and their pauses included, in
   * milliseconds (integer ≥ 1000); default 60 000. A command past it rejects
   * with `command.timeout`.
   */
  commandBudgetMs?: number
  /**
   * Operations of one `run` batch (integer 1…`BATCH_MAX`); default
   * `BATCH_MAX`. A longer batch rejects with `command.invalid`
   * `reason: "batch-too-large"`. Phases started by `ctx.run` are not counted:
   * they stay bound by `BATCH_MAX`.
   */
  maxBatch?: number
  /**
   * Rows of one tabular section of an operation, of `run` and of every
   * `ctx.run` phase (integer 1…`TABULAR_LINES_MAX`); default
   * `TABULAR_LINES_MAX`. More rows reject with `command.invalid`
   * `reason: "tabular-too-large"`. Reads keep the `TABULAR_LINES_MAX` ceiling.
   */
  maxTabularLines?: number
  /**
   * `lock_timeout` of a command transaction in milliseconds (integer ≥ 1);
   * default 5 000. A lock wait past it rejects with `command.busy`.
   */
  lockTimeoutMs?: number
  /** Receives errors that never leave the runtime; default `console.error`. */
  log?: (entry: LogEntry) => void
}

/** Options of one {@link CommandRuntime.run} call. */
export interface CommandRunOptions {
  /**
   * A tabular section array of `update` replaces the section as given:
   * existing rows it leaves out are deleted. Without it (the default) such
   * rows must be named in `deleteIds`, or the phase fails with
   * `command.invalid` `reason: "tabular-rows-missing"`. `ctx.run` is always
   * strict. An operation with `deleteIds` under this option is
   * `command.invalid` with `path` `deleteIds`.
   */
  fullTabularArrays?: true
}

/** The outcome of one part of {@link CommandRuntime.readParts}. */
export type ReadPartOutcome =
  { ok: true; value: ReadPartValue } | { ok: false; error: CommandError }

/**
 * The result of {@link CommandRuntime.readParts}: the row version epoch of
 * its transaction (`null` without an epoch or without a transaction) and an
 * outcome per part, in request order.
 */
export interface ReadPartsResult {
  epoch: string | null
  items: ReadPartOutcome[]
}

/** Options of one {@link CommandRuntime.readParts} call. */
export interface ReadPartsOptions {
  /**
   * Called after each part that read its value, before the next part runs;
   * `"overflow"` stops the transaction there: the parts after it fail with
   * `command.unavailable` `reason: "batch-budget"` without running, and the
   * part keeps its value for the caller to cut or drop.
   */
  fit?: (index: number, value: ReadPartValue) => "accept" | "overflow"
}

/** The command runtime of one catalog and database. */
export interface CommandRuntime {
  /**
   * The runtime catalog the runtime was created with: parsed by
   * `runtimeCatalogSchema`, the runtime's own deep-frozen copy.
   */
  readonly catalog: RuntimeCatalog
  /** Runs an operation or a batch in one transaction; rejects with `CommandFailure`. */
  run(
    session: SessionClaims,
    input: Operation | readonly Operation[],
    options?: CommandRunOptions
  ): Promise<CommandResult>
  /**
   * Reads rows under the request role of the profile, or through the
   * fallback path (P4 spec §6.11); rejects with `CommandFailure`.
   */
  read<Q extends ReadQuery>(
    session: SessionClaims,
    query: Q
  ): Promise<ReadResultOf<Q>>
  /**
   * Reads the parts in one `REPEATABLE READ READ ONLY` transaction (P4-B spec
   * §4.2): every part sees the same snapshot. An invalid part fails alone,
   * before the database; past the deadline a part and those after it fail
   * with `command.timeout`; a database error fails its part, and those after
   * it fail with `command.unavailable` `reason: "batch-aborted"` (or without
   * a reason on a lost connection). Rejects with `CommandFailure` for the
   * whole request: `command.unauthenticated`, `command.invalid`
   * `reason: "batch-too-large"` over `READ_BATCH_STATEMENTS_MAX` statements.
   */
  readParts(
    session: SessionClaims,
    parts: readonly ReadPart[],
    options?: ReadPartsOptions
  ): Promise<ReadPartsResult>
}

/**
 * The request role the server reads under for a provider profile;
 * `undefined` — the profile names none (P4 spec Рт18). Таблиці — параметри,
 * щоб правило перевірялося на підставлених профілях.
 */
export function readRoleOf(
  provider: DatabaseProvider,
  purposes: Readonly<
    Record<DatabaseProvider, readonly RequestRolePurpose[]>
  > = LOGIN_ROLE_REQUEST_PURPOSES,
  roles: Readonly<
    Record<DatabaseProvider, ProviderApiRoles>
  > = PROVIDER_API_ROLES
): string | undefined {
  // Серверне читання — від імені користувача сесії, тож лише роль `user`.
  return purposes[provider].includes("user") ? roles[provider].user : undefined
}

/** Ключ модуля — `"<kind>.<name>"` об'єкта каталогу (Р-A3-17). */
function checkModules(
  catalog: RuntimeCatalog,
  modules: Readonly<Record<string, ObjectModule<object>>>
): void {
  for (const [name, module] of Object.entries(modules)) {
    if (!catalog.objects.some((o) => `${o.kind}.${o.name}` === name)) {
      throw new Error(`objectModules: unknown object "${name}"`)
    }
    for (const [key, hook] of Object.entries(module)) {
      if (
        !(OBJECT_MODULE_KEYS as readonly string[]).includes(key) ||
        typeof hook !== "function"
      ) {
        throw new Error(`objectModules: unknown hook "${name}.${key}"`)
      }
    }
  }
}

const BEGIN_READ_ONLY = "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"
// Читання частин: один знімок на всі; транзакція лише для читання на цьому
// рівні помилок серіалізації не дає (Рд41).
const BEGIN_READ = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
// Окремим оператором під роллю читання: `EXECUTE` функції перевіряється на
// старті виконавця, а в операторі налаштування роль ще — роль входу (Р1).
const EPOCH = `SELECT ${ident(PLATFORM_SCHEMA)}.${ident(ROW_VERSION_EPOCH_FUNCTION_NAME)}() AS epoch`
const MEMBER = "SELECT pg_has_role(session_user, $1, 'SET') AS member"
const APPLIED_HASH = `SELECT ${ident(PLATFORM_SCHEMA)}.${ident(APPLIED_SNAPSHOT_HASH_FUNCTION_NAME)}() AS hash`
// База до функції хеша (`42883`) чи без схеми платформи (`3F000`) — модель
// не застосована, а не збій.
const NO_APPLIED_STATE = new Set(["42883", "3F000"])
// `pg_has_role` на ролі, якої немає в базі.
const UNDEFINED_OBJECT = "42704"
// Межі повтору, глибини й часу читання — помилка конфігурації host-а, як і
// каталог; 0 для часу вимкнув би межу, тож теж відмова.
const limitSchema = z.int().min(1).optional()
// Зменшені межі входу — лише вниз від сталих T0: понад сталу вхід відмовила б
// ще схема, тож така опція була б оманою конфігурації.
const maxBatchSchema = z.int().min(1).max(BATCH_MAX).optional()
const maxTabularLinesSchema = z.int().min(1).max(TABULAR_LINES_MAX).optional()
// Бюджет менший за секунду не вміщує й одного кругового запиту з запасом.
const budgetSchema = z.int().min(1000).optional()

/**
 * Створення рантайму — одна транзакція `READ ONLY` (Р-A3-12): членство в
 * ролі запиту, роль команд, хеш застосованого знімка.
 */
async function inspect(
  database: CommandDatabase,
  catalog: RuntimeCatalog,
  role: string | undefined,
  log: (entry: LogEntry) => void
): Promise<{ member: boolean; applied: string | null }> {
  const fail = (raw: unknown, error = normalizeError(raw)): CommandFailure => {
    const mapped: CommandError = {
      code: error.connectionLost ? "command.unavailable" : "command.internal",
    }
    if (logsDatabaseError(error, mapped)) log({ kind: "database", error: raw })
    return new CommandFailure(mapped)
  }
  let client: DatabaseClient
  try {
    client = await database.connect()
  } catch (raw) {
    throw fail(raw)
  }
  let step = BEGIN_READ_ONLY
  try {
    await client.query(BEGIN_READ_ONLY, [])
    let member = true
    if (role !== undefined) {
      step = MEMBER
      member = (await client.query(MEMBER, [role])).rows[0]?.member === "t"
    }
    step = COMMAND_ROLE.text
    await client.query(COMMAND_ROLE.text, COMMAND_ROLE.params)
    step = APPLIED_HASH
    const hash = (await client.query(APPLIED_HASH, [])).rows[0]?.hash
    step = COMMIT.text
    const { command } = await client.query(COMMIT.text, COMMIT.params)
    client.release()
    if (command !== "COMMIT" || (typeof hash !== "string" && hash !== null)) {
      log({
        kind: "database",
        error: new Error(`runtime check answered ${command}`),
      })
      throw new CommandFailure({ code: "command.internal" })
    }
    return { member, applied: hash }
  } catch (raw) {
    if (raw instanceof CommandFailure) throw raw
    const error = normalizeError(raw)
    await endFailed(client, error.connectionLost)
    if (step === APPLIED_HASH && NO_APPLIED_STATE.has(error.code ?? "")) {
      return mismatch(catalog, null)
    }
    if (step === MEMBER && error.code === UNDEFINED_OBJECT) {
      // Ролі запиту в базі немає — членства теж; транзакція перервана, тож
      // хеш звіряє друга, уже без кроку членства.
      const { applied } = await inspect(database, catalog, undefined, log)
      return { member: false, applied }
    }
    throw fail(raw, error)
  }
}

function mismatch(catalog: RuntimeCatalog, applied: string | null): never {
  const error: CommandError = {
    code: "command.model-mismatch",
    hashes: { catalog: catalog.snapshotHash, applied },
  }
  throw new CommandFailure(error)
}

/**
 * Creates the command runtime (P4 spec §6.5): validates the catalog and the
 * object modules, checks the applied snapshot hash and the request-role
 * membership in one read-only transaction. Rejects with `CommandFailure`
 * (`command.model-mismatch`, `command.read-role-missing`, …); an invalid
 * catalog or module map throws before any database call.
 */
export async function createCommandRuntime(
  options: CommandRuntimeOptions
): Promise<CommandRuntime> {
  // Власна копія: обробник конверта бере з неї `serverHash` і `version`, тож
  // зміна об'єкта host-а після створення не розвела б їх з тим, що рантайм
  // перевірив проти бази.
  const catalog = deepFreeze(
    structuredClone(runtimeCatalogSchema.parse(options.catalog))
  )
  const objectModules = options.objectModules ?? {}
  checkModules(catalog, objectModules)
  const maxAttempts = limitSchema.parse(options.maxAttempts) ?? 3
  const maxDepth = limitSchema.parse(options.maxDepth) ?? 8
  const readTimeout =
    limitSchema.parse(options.readStatementTimeoutMs) ?? 15_000
  const readBudgetMs = budgetSchema.parse(options.readBudgetMs) ?? 15_000
  const budgetMs = budgetSchema.parse(options.commandBudgetMs) ?? 60_000
  const lockTimeoutMs = limitSchema.parse(options.lockTimeoutMs) ?? 5_000
  const maxBatch = maxBatchSchema.parse(options.maxBatch) ?? BATCH_MAX
  const maxTabularLines =
    maxTabularLinesSchema.parse(options.maxTabularLines) ?? TABULAR_LINES_MAX
  const sink = options.log ?? ((entry: LogEntry) => console.error(entry))
  // Журнал не має зламати шлях відмови: з'єднання звільняється після нього.
  const log = (entry: LogEntry) => {
    try {
      sink(entry)
    } catch {
      // журнал недоступний — відмова однаково йде назовні кодом
    }
  }
  const role = readRoleOf(catalog.provider)
  const { member, applied } = await inspect(
    options.database,
    catalog,
    role,
    log
  )
  if (applied !== catalog.snapshotHash) mismatch(catalog, applied)
  if (role !== undefined && !member && options.readFallback !== true) {
    throw new CommandFailure({ code: "command.read-role-missing", role })
  }
  const state: RuntimeState = {
    database: options.database,
    catalog,
    objectModules,
    defer: options.defer,
    log,
    maxAttempts,
    maxDepth,
    maxBatch,
    maxTabularLines,
    readTimeout,
    readBudgetMs,
    budgetMs,
    lockTimeoutMs,
    // Профіль без ролі запиту чи явний запасний шлях — читання під роллю команд.
    readRole: member ? role : undefined,
  }
  return {
    catalog,
    run: (session, input, options) =>
      runCommand(state, session, input, options?.fullTabularArrays === true),
    // Одиночне читання — пакет з однієї частини (Р3): та сама транзакційна
    // дисципліна; відмова частини — відмова читання.
    read: async <Q extends ReadQuery>(session: SessionClaims, query: Q) => {
      const { items } = await readParts(
        state,
        session,
        [{ type: "query", query }],
        undefined
      )
      const item = items[0]!
      if (!item.ok) throw new CommandFailure(item.error)
      // Форму результату задає форма запиту; без `known` маркерів нема.
      return item.value as ReadResultOf<Q>
    },
    readParts: (session, parts, options) =>
      readParts(state, session, parts, options),
  }
}

/** Заморожує дані каталогу до дна: каталог — чисті дані JSON, без циклів. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/** Відмова бази в читанні, уже змапована; будь-що інше в транзакції — аномалія. */
class Refused {
  constructor(readonly refusal: ReturnType<typeof readRefusal>) {}
}

// Дедлайн перед оператором частини: транзакція ціла, частина не виконана.
const EXPIRED = Symbol("expired")
const TIMEOUT: CommandError = { code: "command.timeout" }
const INTERNAL: CommandError = { code: "command.internal" }
const UNAVAILABLE: CommandError = { code: "command.unavailable" }
const ABORTED: CommandError = {
  code: "command.unavailable",
  reason: "batch-aborted",
}
const OVER_BUDGET: CommandError = {
  code: "command.unavailable",
  reason: "batch-budget",
}

/** Claims сесії текстом; без `sub` — відмова до бази (Рт8). */
function claimsOf(session: SessionClaims): string {
  try {
    // Без `sub` політики бачили б анонімний запит, а не користувача: читання
    // не йде в базу, як і команда без користувача (Рт8).
    if (!sessionClaimsSchema.safeParse(session).success) {
      throw new CommandFailure({ code: "command.unauthenticated" })
    }
    return JSON.stringify(session)
  } catch (error) {
    if (error instanceof CommandFailure) throw error
    throw new CommandFailure(INTERNAL)
  }
}

/** Епоха з відповіді оператора епохи: 64 hex чи `NULL` — інше аномалія. */
function epochOf(rows: readonly Record<string, unknown>[]): string | null {
  const epoch = rows[0]?.epoch
  if (rows.length === 1 && epoch === null) return null
  const parsed = versionEpochSchema.safeParse(epoch)
  if (rows.length !== 1 || !parsed.success) {
    throw new Error("row version epoch is not 64 hex")
  }
  return parsed.data
}

/**
 * Серверне читання (спека П4 §6.11, П4-B §4.2): усі частини — одна
 * транзакція `REPEATABLE READ READ ONLY` під роллю запиту, тож частини
 * бачать один знімок, а політики — рівно те, що PostgREST з тими самими
 * claims (інваріант 10). Без повтору: §6.11 його не передбачає.
 */
async function readParts(
  state: RuntimeState,
  session: SessionClaims,
  parts: readonly ReadPart[],
  options: ReadPartsOptions | undefined
): Promise<ReadPartsResult> {
  // До будь-якого I/O: друге з'єднання в хуку чекало б на замок своєї ж
  // команди (Р-A3-11).
  rejectNested()
  const claims = claimsOf(session)
  // Перевірка частин — до `BEGIN` (Р11): хибна частина відмовляє лише собі
  // й не займає з'єднання.
  const items: ReadPartOutcome[] = new Array(parts.length)
  const planned: { index: number; object: RuntimeObject; plan: ReadPlan }[] = []
  let statements = 0
  parts.forEach((part, index) => {
    const prepared = prepareRead(state.catalog, part.query, part.known)
    if ("error" in prepared) {
      items[index] = { ok: false, error: prepared.error }
      return
    }
    planned.push({ index, ...prepared })
    statements += 1 + (prepared.plan.include?.length ?? 0)
  })
  // Межа — за найбільшим числом операторів: ціль `include` без id оператора
  // не шле, але знати це можна лише після бази.
  if (statements > READ_BATCH_STATEMENTS_MAX) {
    throw new CommandFailure({
      code: "command.invalid",
      reason: LIMIT_REASONS.batchTooLarge,
    })
  }
  if (planned.length === 0) return { epoch: null, items }
  // Невиконаним частинам, починаючи з `from`-ї з плану, — `error`.
  const rest = (from: number, error: CommandError) => {
    for (const { index } of planned.slice(from)) {
      items[index] = { ok: false, error }
    }
  }
  const refusalOf = (error: unknown) => {
    if (error instanceof Refused) return error.refusal
    // Відповідь не тієї форми: транзакцію відкочено, назовні — лише код.
    state.log({ kind: "database", error })
    return { error: INTERNAL, destroy: false, lost: false }
  }
  // Бюджет — на всю транзакцію разом із чеканням з'єднання, як і в команди.
  const deadline = performance.now() + state.readBudgetMs
  let client: DatabaseClient
  try {
    client = await state.database.connect()
  } catch (raw) {
    rest(0, readRefusal(raw, state, undefined).error)
    return { epoch: null, items }
  }
  // Фаза читання — лише для операторів будівника: `22P02` там — вхід клієнта.
  const send = async (
    statement: { text: string; params: readonly (string | null)[] },
    phase?: ErrorPhase
  ) => {
    try {
      return await client.query(statement.text, statement.params)
    } catch (raw) {
      throw new Refused(readRefusal(raw, state, phase))
    }
  }
  let budget: ReadBudget
  let epoch: string | null
  try {
    await send({ text: BEGIN_READ, params: [] })
    budget = new ReadBudget(deadline, state.readTimeout)
    // Запасний шлях — роль команд, без `simetra.command`.
    await send(
      readSetupStatement(
        claims,
        budget.setup,
        state.readBudgetMs + 1000,
        state.readRole ?? PLATFORM_ROLES.command
      )
    )
    // Епоху бази знає лише транзакція: проєкцію з `known` будівник рендерить
    // після цього оператора (Р11).
    epoch = epochOf((await send({ text: EPOCH, params: [] })).rows)
  } catch (error) {
    // Жодна частина не виконана: збій прелюдії — помилка кожної.
    const refusal = refusalOf(error)
    await endFailed(client, refusal.destroy)
    rest(0, refusal.error)
    return { epoch: null, items }
  }
  const run: ReadStatementRunner = async (statement, target) => {
    const step = budget.next()
    if (step === "expired") throw EXPIRED
    if (step !== undefined) await send(step)
    return (await send(statement, { kind: "read", object: target })).rows
  }
  for (const [n, { index, object, plan }] of planned.entries()) {
    try {
      // Рядки декодуються до `COMMIT`: з них оператор `include` бере id.
      const value = await executeRead(object, plan, run, epoch)
      // Відмова частини без бази (`tabular-too-large`) транзакції не рве.
      if ("error" in value) {
        items[index] = { ok: false, error: value.error }
        continue
      }
      items[index] = { ok: true, value }
      if (options?.fit?.(index, value) === "overflow") {
        rest(n + 1, OVER_BUDGET)
        break
      }
    } catch (error) {
      // Дедлайн: транзакція ціла, виконані частини лишають результати.
      if (error === EXPIRED) {
        rest(n, TIMEOUT)
        break
      }
      // Помилка бази скасовує транзакцію (точок збереження немає): частина —
      // зі своєю помилкою, наступні — без виконання.
      const refusal = refusalOf(error)
      items[index] = { ok: false, error: refusal.error }
      rest(n + 1, refusal.lost ? UNAVAILABLE : ABORTED)
      await endFailed(client, refusal.destroy)
      return { epoch, items }
    }
  }
  // Транзакція лише читає, а кожна частина вже отримала рядки свого знімка:
  // збій `COMMIT` (і обрив з'єднання) результатів не скасовує — з'єднання
  // лише завершується як після відмови.
  let tag: string
  try {
    ;({ command: tag } = await send(COMMIT))
  } catch (error) {
    await endFailed(client, refusalOf(error).destroy)
    return { epoch, items }
  }
  client.release()
  // `ROLLBACK` на `COMMIT` — аномалія (перервану транзакцію відкочує
  // гілка відмови частини): у журнал, результати лишаються.
  if (tag !== "COMMIT") {
    state.log({ kind: "database", error: new Error(`COMMIT answered ${tag}`) })
  }
  return { epoch, items }
}
