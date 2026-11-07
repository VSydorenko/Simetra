import {
  APPLIED_SNAPSHOT_HASH_FUNCTION_NAME,
  LOGIN_ROLE_REQUEST_PURPOSES,
  OBJECT_MODULE_KEYS,
  PLATFORM_SCHEMA,
  PROVIDER_API_ROLES,
  runtimeCatalogSchema,
  sessionClaimsSchema,
  type CommandError,
  type CommandResult,
  type DatabaseProvider,
  type ObjectModule,
  type Operation,
  type ProviderApiRoles,
  type ReadQuery,
  type ReadResult,
  type ReadResultOf,
  type RequestRolePurpose,
  type RuntimeCatalog,
  type SessionClaims,
  CommandFailure,
} from "simetra/model"
import { z } from "zod"
import { logsDatabaseError, mapDatabaseError, type ErrorPhase } from "./errors"
import { rejectNested } from "./hook-context"
import {
  normalizeError,
  type CommandDatabase,
  type DatabaseClient,
} from "./port"
import { executeRead, ident, prepareRead } from "./read"
import {
  COMMAND_ROLE,
  COMMIT,
  claimsStatement,
  endFailed,
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
   * `statement_timeout` of a server read in milliseconds (integer ≥ 1);
   * default 15 000. A read past it rejects with `command.timeout`.
   */
  readStatementTimeoutMs?: number
  /**
   * Time budget of one `run` call, retries and their pauses included, in
   * milliseconds (integer ≥ 1000); default 60 000. A command past it rejects
   * with `command.timeout`.
   */
  commandBudgetMs?: number
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
   * strict.
   */
  fullTabularArrays?: true
}

/** The command runtime of one catalog and database. */
export interface CommandRuntime {
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
// Значення — зв'язаним параметром: текстовий `SET` не приймає `$1`.
const READ_TIMEOUT = "SELECT set_config('statement_timeout', $1, true)"
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
  const catalog = runtimeCatalogSchema.parse(options.catalog)
  const objectModules = options.objectModules ?? {}
  checkModules(catalog, objectModules)
  const maxAttempts = limitSchema.parse(options.maxAttempts) ?? 3
  const maxDepth = limitSchema.parse(options.maxDepth) ?? 8
  const readTimeout =
    limitSchema.parse(options.readStatementTimeoutMs) ?? 15_000
  const budgetMs = budgetSchema.parse(options.commandBudgetMs) ?? 60_000
  const lockTimeoutMs = limitSchema.parse(options.lockTimeoutMs) ?? 5_000
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
    readTimeout,
    budgetMs,
    lockTimeoutMs,
    // Профіль без ролі запиту чи явний запасний шлях — читання під роллю команд.
    readRole: member ? role : undefined,
  }
  return {
    run: (session, input, options) =>
      runCommand(state, session, input, options?.fullTabularArrays === true),
    // Форму результату задає форма запиту; `readRows` будує її з плану.
    read: <Q extends ReadQuery>(session: SessionClaims, query: Q) =>
      readRows(state, session, query) as Promise<ReadResultOf<Q>>,
  }
}

/** Відмова бази в читанні, уже змапована; будь-що інше в транзакції — аномалія. */
class Refused {
  constructor(
    readonly refusal: { failure: CommandFailure; destroy: boolean }
  ) {}
}

/**
 * Серверне читання (спека П4 §6.11): одна транзакція `READ ONLY` під роллю
 * запиту — політики бачать рівно те, що PostgREST з тими самими claims
 * (інваріант 10). Без повтору: §6.11 його не передбачає, `40001` тут — `command.internal`.
 */
async function readRows(
  state: RuntimeState,
  session: SessionClaims,
  query: unknown
): Promise<ReadResult> {
  // До будь-якого I/O: друге з'єднання в хуку чекало б на замок своєї ж
  // команди (Р-A3-11).
  rejectNested()
  let claims: string
  try {
    // Без `sub` політики бачили б анонімний запит, а не користувача: читання
    // не йде в базу, як і команда без користувача (Рт8).
    if (!sessionClaimsSchema.safeParse(session).success) {
      throw new CommandFailure({ code: "command.unauthenticated" })
    }
    claims = JSON.stringify(session)
  } catch (error) {
    if (error instanceof CommandFailure) throw error
    throw new CommandFailure({ code: "command.internal" })
  }
  const prepared = prepareRead(state.catalog, query)
  if ("error" in prepared) throw new CommandFailure(prepared.error)
  const { object, plan } = prepared
  const fail = (raw: unknown, phase: ErrorPhase | undefined) => {
    const error = normalizeError(raw)
    const mapped = mapDatabaseError(error, state.catalog, phase)
    if (logsDatabaseError(error, mapped)) {
      state.log({ kind: "database", error: raw })
    }
    return {
      failure: new CommandFailure(mapped),
      destroy: error.connectionLost,
    }
  }
  let client: DatabaseClient
  try {
    client = await state.database.connect()
  } catch (raw) {
    throw fail(raw, undefined).failure
  }
  // Запасний шлях — роль команд одразу після claims, без `simetra.command`.
  const role =
    state.readRole === undefined
      ? COMMAND_ROLE
      : { text: `SET LOCAL ROLE ${ident(state.readRole)}`, params: [] }
  // Фаза читання — лише для операторів будівника: `22P02` там — вхід клієнта.
  const send = async (
    statement: { text: string; params: readonly (string | null)[] },
    phase?: ErrorPhase
  ) => {
    try {
      return await client.query(statement.text, statement.params)
    } catch (raw) {
      throw new Refused(fail(raw, phase))
    }
  }
  let result: ReadResult | { error: CommandError }
  let tag: string
  try {
    await send({ text: BEGIN_READ_ONLY, params: [] })
    // `SET LOCAL`-семантика (`true`): межа живе до кінця транзакції читання й
    // не переходить на наступного користувача з'єднання пулу.
    await send({ text: READ_TIMEOUT, params: [String(state.readTimeout)] })
    await send(claimsStatement(claims))
    await send(role)
    // Рядки декодуються до `COMMIT`: з них оператор `include` бере id.
    result = await executeRead(
      object,
      plan,
      async (statement, target) =>
        (await send(statement, { kind: "read", object: target })).rows
    )
    ;({ command: tag } = await send(COMMIT))
  } catch (error) {
    if (error instanceof Refused) {
      await endFailed(client, error.refusal.destroy)
      throw error.refusal.failure
    }
    // Відповідь не тієї форми: транзакцію відкочено, назовні — лише код.
    state.log({ kind: "database", error })
    await endFailed(client, false)
    throw new CommandFailure({ code: "command.internal" })
  }
  client.release()
  // Перервана транзакція відповідає на `COMMIT` тегом `ROLLBACK`.
  if (tag !== "COMMIT") {
    state.log({ kind: "database", error: new Error(`COMMIT answered ${tag}`) })
    throw new CommandFailure({ code: "command.internal" })
  }
  if ("error" in result) throw new CommandFailure(result.error)
  return result
}
