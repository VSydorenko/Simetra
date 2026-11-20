import {
  APPLIED_SNAPSHOT_HASH_FUNCTION_NAME,
  BATCH_MAX,
  CENTRIFUGO_CHANNEL_MAX,
  LIMIT_REASONS,
  LOGIN_ROLE_REQUEST_PURPOSES,
  OBJECT_MODULE_KEYS,
  PLATFORM_ROLES,
  PLATFORM_SCHEMA,
  PRIVILEGED_LOGIN_REASONS,
  PROVIDER_API_ROLES,
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
  READ_BATCH_MAX,
  READ_BATCH_STATEMENTS_MAX,
  SIGNAL_MERGE_THRESHOLD,
  SIGNAL_TOPIC_ALLOWED_FUNCTION_NAME,
  TABULAR_LINES_MAX,
  runtimeCatalogSchema,
  sessionClaimsSchema,
  type CommandError,
  type CommandResult,
  type DatabaseProvider,
  type IdentitySource,
  type ObjectModule,
  type Operation,
  type ProviderApiRoles,
  type ReadPart,
  type ReadPartValue,
  type ReadQuery,
  type ReadResultOf,
  type ReadRightsPart,
  type RequestRolePurpose,
  type RightsSnapshot,
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
  ANONYMOUS_SNAPSHOT,
  RIGHTS_SNAPSHOT_STATEMENT,
  rightsValueOf,
  snapshotFromRows,
} from "./rights-snapshot"
import { createChannelGrant, type ChannelGrant } from "./signals/grant"
import {
  COMMAND_ROLE,
  COMMIT,
  CURRENT_USER,
  EPOCH,
  ReadBudget,
  epochOf,
  endFailed,
  readRefusal,
  readSetupStatement,
  runCommand,
  type LogEntry,
  type RuntimeState,
} from "./transaction"

/** Options of {@link createCommandRuntime}. */
export interface CommandRuntimeOptions {
  /**
   * The database port. Its connections log in as the runtime login role
   * directly: the runtime judges `session_user`, which must reach neither
   * the owner nor a privileged role (`command.privileged-login`). A pool that
   * logs in as a superuser and switches with `SET SESSION AUTHORIZATION` is
   * outside this trust model — such a host already holds a superuser DSN.
   */
  database: CommandDatabase
  /** The runtime catalog object (`runtime-catalog.json`); validated here. */
  catalog: unknown
  /** Object modules keyed `"<kind>.<name>"`, e.g. `"Catalog.Client"`. */
  objectModules?: Readonly<Record<string, ObjectModule<object>>>
  /** Hands `afterCommit` work to the platform (`waitUntil`); without it `run` awaits that work. */
  defer?: (work: Promise<unknown>) => void
  /**
   * Reads through the fallback path when the login role lacks the user
   * request role. Membership in the anonymous request role of the profile is
   * always required.
   */
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
  /**
   * Signal phases of one command transaction, `ctx.run` phases included,
   * that each send a row signal (integer ≥ 1); default 90. The phases
   * after it run in signal merge mode: one `invalidate` per (scope, object)
   * pair instead of a signal per phase (P4-B spec §8.2). Keep it below the
   * channel history size, so the signals of one pair fit the history and a
   * short gap still recovers.
   */
  signalMergeThreshold?: number
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

/** The snapshot and its fingerprint, see {@link CommandRuntime.rightsSnapshot}. */
export interface RightsSnapshotValue {
  rightsVersion: string
  snapshot: RightsSnapshot
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
   * `reason: "batch-too-large"` over `READ_BATCH_MAX` parts or
   * `READ_BATCH_STATEMENTS_MAX` statements.
   */
  readParts(
    session: SessionClaims,
    parts: readonly ReadPart[],
    options?: ReadPartsOptions
  ): Promise<ReadPartsResult>
  /**
   * The rights snapshot of the session's user and its `rightsVersion` (P4-B
   * spec §9.1), read as a one-part batch: one `REPEATABLE READ READ ONLY`
   * transaction, one statement under the request role. An anonymous session
   * gets the empty snapshot without a database call. Rejects with
   * `CommandFailure`: `command.unauthenticated`; `command.invalid` when the
   * catalog has no rights functions; `command.internal` when the function's
   * output fails `rightsSnapshotSchema`.
   */
  rightsSnapshot(session: SessionClaims): Promise<RightsSnapshotValue>
  /**
   * The signal channels the session may subscribe to (P4-B spec §8.3), as
   * the `ChannelGrant` the token port of `simetra/server/signals` signs. One
   * `READ ONLY` transaction under the request role asks `current_user_id()`
   * and `signal_topic_allowed(<channel>, false)` for every channel.
   * `subject` is that user id, not the raw `sub`; `null` — an anonymous
   * session (no database call) or no valid user, and then no channels.
   * `channels` — the allowed ones, sorted, without duplicates. Rejects with
   * `CommandFailure`: `command.unauthenticated`; `command.invalid` before the
   * database — over 256 channels (`reason:
   * "batch-too-large"`) or a channel over `CENTRIFUGO_CHANNEL_MAX` UTF-8
   * bytes (`reason: "too-large"`, `path` — its index).
   */
  authorizeChannels(
    session: SessionClaims,
    channels: readonly string[]
  ): Promise<ChannelGrant>
}

// Межа каналів одного виклику `authorizeChannels` (Р5 плану B2).
const AUTHORIZE_CHANNELS_MAX = 256

/**
 * The request role of `purpose` the server reads under for a provider
 * profile; `undefined` — the profile names none (P4 spec Рт18). Таблиці —
 * параметри, щоб правило перевірялося на підставлених профілях.
 */
export function readRoleOf(
  provider: DatabaseProvider,
  purposes: Readonly<
    Record<DatabaseProvider, readonly RequestRolePurpose[]>
  > = LOGIN_ROLE_REQUEST_PURPOSES,
  roles: Readonly<
    Record<DatabaseProvider, ProviderApiRoles>
  > = PROVIDER_API_ROLES,
  purpose: RequestRolePurpose = "user"
): string | undefined {
  return purposes[provider].includes(purpose)
    ? roles[provider][purpose]
    : undefined
}

/**
 * The kind of a session by the anonymous claim of the provider
 * (`PROVIDER_IDENTITY_SOURCES[provider].anonymousClaim`): `true` or `"true"`
 * — `"anonymous"`, `false` or `"false"` — `"user"`, any other value or none —
 * `"invalid"`. A provider without anonymous sessions reads every session as
 * `"user"`. `sources` is a parameter so the rule is testable on a substituted
 * profile.
 */
export function sessionKind(
  provider: DatabaseProvider,
  claims: SessionClaims,
  sources: Readonly<
    Record<DatabaseProvider, IdentitySource>
  > = PROVIDER_IDENTITY_SOURCES
): "user" | "anonymous" | "invalid" {
  const claim = sources[provider].anonymousClaim
  if (claim === null) return "user"
  // Лише власний ключ: claim, успадкований від прототипу, — не claim сесії.
  const value: unknown = Object.hasOwn(claims, claim)
    ? (claims as Record<string, unknown>)[claim]
    : undefined
  // Текстова форма — як судить SQL (`->> … = 'true'`): інакше SQL бачив би
  // гостя під роллю користувача.
  if (value === true || value === "true") return "anonymous"
  if (value === false || value === "false") return "user"
  // Відсутній claim — відмова, а не користувач: адаптер host-а, що забув
  // claim, інакше тихо дав би анонімові права користувача.
  return "invalid"
}

/** Вид сесії для запиту; недійсна сесія — відмова до будь-якого I/O. */
function checkedKind(
  provider: DatabaseProvider,
  session: SessionClaims
): "user" | "anonymous" {
  let kind: ReturnType<typeof sessionKind>
  try {
    kind = sessionKind(provider, session)
  } catch {
    // Claims, читання яких кидає, — збій викликача, а не відмова сесії.
    throw new CommandFailure({ code: "command.internal" })
  }
  if (kind === "invalid") {
    throw new CommandFailure({ code: "command.unauthenticated" })
  }
  return kind
}

/** Ключ модуля — `"<kind>.<name>"` об'єкта каталогу. */
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
// Факти ролі входу судять `session_user`, а не ім'я: `'MEMBER'` бачить саму
// роль і будь-яке членство, зокрема без успадкування — `SET ROLE` однаково
// дає владу ролі. Відсутня роль дає `false`, а не `42704`: підзапити з
// `COALESCE` і `EXISTS`. Членство в `pg_database_owner` Postgres дає неявно
// власникові поточної бази, тож факт ловить і вхід, що володіє базою.
const LOGIN_FACTS = `SELECT
  COALESCE((SELECT pg_catalog.pg_has_role(session_user, n.nspowner, 'MEMBER')
            FROM pg_catalog.pg_namespace n WHERE n.nspname = $1), false)
    OR COALESCE((SELECT pg_catalog.pg_has_role(session_user, o.oid, 'MEMBER')
                 FROM pg_catalog.pg_roles o WHERE o.rolname = $2), false) AS owner,
  EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolsuper
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS superuser,
  EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolbypassrls
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS bypassrls,
  EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolcreaterole
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS createrole,
  EXISTS (SELECT FROM pg_catalog.pg_roles x
          WHERE x.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files')
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS server_files,
  EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolname = 'pg_read_all_data'
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS read_all_data,
  EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolname = 'pg_write_all_data'
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS write_all_data,
  EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolname = 'pg_database_owner'
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS database_owner,
  EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolname = ANY ($4::text[])
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS provider_login,
  COALESCE((SELECT pg_catalog.pg_has_role(session_user, s.oid, 'MEMBER')
            FROM pg_catalog.pg_roles s WHERE s.rolname = $3), false) AS service`
// Колонка факту → причина відмови, у порядку пріоритету причин.
const LOGIN_FACT_REASONS = [
  ["owner", PRIVILEGED_LOGIN_REASONS.owner],
  ["superuser", PRIVILEGED_LOGIN_REASONS.superuser],
  ["bypassrls", PRIVILEGED_LOGIN_REASONS.bypassRls],
  ["createrole", PRIVILEGED_LOGIN_REASONS.createRole],
  ["server_files", PRIVILEGED_LOGIN_REASONS.serverFiles],
  ["read_all_data", PRIVILEGED_LOGIN_REASONS.readAllData],
  ["write_all_data", PRIVILEGED_LOGIN_REASONS.writeAllData],
  ["database_owner", PRIVILEGED_LOGIN_REASONS.databaseOwner],
  ["provider_login", PRIVILEGED_LOGIN_REASONS.providerLogin],
  ["service", PRIVILEGED_LOGIN_REASONS.service],
] as const

// Порт передає лише текстові параметри, тож перелік ролей — літералом масиву
// Postgres; кожен елемент у лапках, щоб кома чи дужка в імені не розірвали його.
const textArray = (values: readonly string[]): string =>
  `{${values.map((v) => `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`

const loginFactsParams = (provider: DatabaseProvider): (string | null)[] => [
  PLATFORM_SCHEMA,
  PROVIDER_OWNER_ROLES[provider],
  PROVIDER_API_ROLES[provider].service,
  textArray(PROVIDER_LOGIN_ROLES[provider]),
]

/**
 * Причина відмови за рядком фактів; `null` — жодного факту. Відповідь не з
 * `t`/`f` — `undefined`: гейт не пропускає того, чого не зміг прочитати.
 */
function privilegedReason(
  row: Record<string, unknown> | undefined
): string | null | undefined {
  if (row === undefined) return undefined
  if (
    LOGIN_FACT_REASONS.some(
      ([column]) => row[column] !== "t" && row[column] !== "f"
    )
  )
    return undefined
  return LOGIN_FACT_REASONS.find(([column]) => row[column] === "t")?.[1] ?? null
}

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
 * Створення рантайму — одна транзакція `READ ONLY`: факти ролі входу,
 * членство в кожній ролі запиту профілю, роль команд, хеш застосованого
 * знімка.
 */
async function inspect(
  database: CommandDatabase,
  catalog: RuntimeCatalog,
  roles: Readonly<Partial<Record<RequestRolePurpose, string>>>,
  log: (entry: LogEntry) => void
): Promise<{
  members: Record<RequestRolePurpose, boolean>
  applied: string | null
}> {
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
  // Роль, членство в якій перевіряє поточний крок.
  let checking: RequestRolePurpose | undefined
  // Ролі без членства за замовчуванням: його доводить лише відповідь бази.
  const members: Record<RequestRolePurpose, boolean> = {
    user: false,
    anonymous: false,
  }
  try {
    await client.query(BEGIN_READ_ONLY, [])
    // Першим оператором кожної транзакції, і повтору теж: привілейована роль
    // входу відмовляє раніше, ніж рантайм щось про базу вирішив.
    step = LOGIN_FACTS
    const facts = (
      await client.query(LOGIN_FACTS, loginFactsParams(catalog.provider))
    ).rows[0]
    const reason = privilegedReason(facts)
    if (reason !== null) {
      await endFailed(client, false)
      if (reason === undefined) {
        log({
          kind: "database",
          error: new Error("runtime check answered no login facts"),
        })
        throw new CommandFailure({ code: "command.internal" })
      }
      throw new CommandFailure({ code: "command.privileged-login", reason })
    }
    for (const [purpose, role] of Object.entries(roles) as [
      RequestRolePurpose,
      string,
    ][]) {
      step = MEMBER
      checking = purpose
      members[purpose] =
        (await client.query(MEMBER, [role])).rows[0]?.member === "t"
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
    return { members, applied: hash }
  } catch (raw) {
    if (raw instanceof CommandFailure) throw raw
    const error = normalizeError(raw)
    await endFailed(client, error.connectionLost)
    if (step === APPLIED_HASH && NO_APPLIED_STATE.has(error.code ?? "")) {
      return mismatch(catalog, null)
    }
    if (step === MEMBER && error.code === UNDEFINED_OBJECT) {
      // Ролі запиту в базі немає — членства в ній теж; транзакція перервана,
      // тож решту ролей і хеш звіряє друга, уже без цієї ролі.
      const rest = { ...roles }
      delete rest[checking!]
      const second = await inspect(database, catalog, rest, log)
      return {
        members: { ...second.members, [checking!]: false },
        applied: second.applied,
      }
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
 * object modules, checks the facts of the login role, the request-role
 * membership and the applied snapshot hash in one read-only transaction.
 * Rejects with `CommandFailure` (`command.privileged-login`,
 * `command.model-mismatch`, `command.read-role-missing`, …); an invalid
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
  const signalMergeThreshold =
    limitSchema.parse(options.signalMergeThreshold) ?? SIGNAL_MERGE_THRESHOLD
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
  const roles: Partial<Record<RequestRolePurpose, string>> = {}
  for (const purpose of ["user", "anonymous"] as const) {
    const role = readRoleOf(catalog.provider, undefined, undefined, purpose)
    if (role !== undefined) roles[purpose] = role
  }
  const { members, applied } = await inspect(
    options.database,
    catalog,
    roles,
    log
  )
  if (applied !== catalog.snapshotHash) mismatch(catalog, applied)
  if (
    roles.user !== undefined &&
    !members.user &&
    options.readFallback !== true
  ) {
    throw new CommandFailure({
      code: "command.read-role-missing",
      role: roles.user,
    })
  }
  // Запасного шляху для аноніма немає: роль команд читала б від імені
  // користувача там, де профіль дає гостя.
  if (roles.anonymous !== undefined && !members.anonymous) {
    throw new CommandFailure({
      code: "command.read-role-missing",
      role: roles.anonymous,
    })
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
    signalMergeThreshold,
    readRoles: {
      // Профіль без ролі запиту чи явний запасний шлях — читання користувача
      // під роллю команд.
      user: members.user ? roles.user : undefined,
      anonymous: roles.anonymous,
    },
  }
  return {
    catalog,
    // Анонімна команда йде далі: її судить `current_user_id()` = `NULL`.
    run: async (session, input, options) => {
      checkedKind(catalog.provider, session)
      return runCommand(
        state,
        session,
        input,
        options?.fullTabularArrays === true
      )
    },
    // Одиночне читання — пакет з однієї частини: та сама транзакційна
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
    rightsSnapshot: async (session) => {
      const { items } = await readParts(
        state,
        session,
        [{ type: "rights" }],
        undefined
      )
      const item = items[0]!
      if (!item.ok) throw new CommandFailure(item.error)
      // Без `known` знімок іде завжди.
      return item.value as RightsSnapshotValue
    },
    authorizeChannels: (session, channels) =>
      authorizeChannels(state, session, channels),
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

type RightsEntry = { index: number; rights: ReadRightsPart }
/** Частина пакета після перевірки: запит із планом чи знімок прав. */
type PlannedPart =
  RightsEntry | { index: number; object: RuntimeObject; plan: ReadPlan }

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

/**
 * Роль читання сесії: гість — роль `anonymous` профілю, і ніколи не роль
 * користувача чи команд; користувач — роль `user` чи запасний шлях.
 */
function readRoleFor(state: RuntimeState, session: SessionClaims): string {
  if (checkedKind(state.catalog.provider, session) === "anonymous") {
    if (state.readRoles.anonymous === undefined) {
      throw new CommandFailure({ code: "command.unauthenticated" })
    }
    return state.readRoles.anonymous
  }
  // Запасний шлях — роль команд, без `simetra.command`.
  return state.readRoles.user ?? PLATFORM_ROLES.command
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
  // команди.
  rejectNested()
  const claims = claimsOf(session)
  const role = readRoleFor(state, session)
  // Межу частин тримає й конверт, але викликач у процесі його не проходить.
  if (parts.length > READ_BATCH_MAX) {
    throw new CommandFailure({
      code: "command.invalid",
      reason: LIMIT_REASONS.batchTooLarge,
    })
  }
  // Знімок — один на транзакцію. Викликач у процесі конверт не проходить, а
  // розібрані частини — звичайні дані: перевірка тут остаточна.
  if (parts.filter((part) => part.type === "rights").length > 1) {
    throw new CommandFailure({ code: "command.invalid" })
  }
  const anonymous = checkedKind(state.catalog.provider, session) === "anonymous"
  // Перевірка частин — до `BEGIN`: хибна частина відмовляє лише собі
  // й не займає з'єднання.
  const items: ReadPartOutcome[] = new Array(parts.length)
  const planned: PlannedPart[] = []
  let statements = 0
  parts.forEach((part, index) => {
    if (part.type === "rights") {
      // Без функцій прав у проєкті немає й функції знімка.
      if (state.catalog.rightsSnapshot !== true) {
        items[index] = { ok: false, error: { code: "command.invalid" } }
        return
      }
      planned.push({ index, rights: part })
      // Анонім до бази не йде (Р5).
      if (!anonymous) statements += 1
      return
    }
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
  // Значення частини `rights` з уже відомого знімка; `true` — бюджет відповіді
  // зупинив пакет після неї.
  const placeRights = async (
    index: number,
    part: ReadRightsPart,
    snapshot: RightsSnapshot
  ): Promise<boolean> => {
    const value = await rightsValueOf(snapshot, part.known)
    items[index] = { ok: true, value }
    return options?.fit?.(index, value) === "overflow"
  }
  // Пакет лише з анонімних `rights`: бази немає, транзакції теж.
  if (anonymous && planned.every((entry) => "rights" in entry)) {
    for (const [n, entry] of planned.entries()) {
      if (!("rights" in entry)) continue
      if (await placeRights(entry.index, entry.rights, ANONYMOUS_SNAPSHOT)) {
        rest(n + 1, OVER_BUDGET)
        break
      }
    }
    return { epoch: null, items }
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
    await send(
      readSetupStatement(claims, budget.setup, state.readBudgetMs + 1000, role)
    )
    // Епоху бази знає лише транзакція: проєкцію з `known` будівник рендерить
    // після цього оператора. Окремим оператором під роллю читання: `EXECUTE`
    // функції перевіряється на старті виконавця, а в операторі налаштування
    // роль ще — роль входу.
    epoch = epochOf((await send(EPOCH)).rows)
  } catch (error) {
    // Жодна частина не виконана: збій прелюдії — помилка кожної.
    const refusal = refusalOf(error)
    await endFailed(client, refusal.destroy)
    rest(0, refusal.error)
    return { epoch: null, items }
  }
  const runIn = async (
    statement: { text: string; params: readonly (string | null)[] },
    phase?: ErrorPhase
  ) => {
    const step = budget.next()
    if (step === "expired") throw EXPIRED
    if (step !== undefined) await send(step)
    return (await send(statement, phase)).rows
  }
  const run: ReadStatementRunner = (statement, target) =>
    runIn(statement, { kind: "read", object: target })
  for (const [n, entry] of planned.entries()) {
    const { index } = entry
    try {
      if ("rights" in entry) {
        let snapshot = ANONYMOUS_SNAPSHOT
        if (!anonymous) {
          const rows = await runIn(RIGHTS_SNAPSHOT_STATEMENT)
          try {
            snapshot = snapshotFromRows(rows)
          } catch (error) {
            // Функція відповіла не тим, що обіцяє схема: дефект бази чи
            // версій, не вхід клієнта. Транзакція ціла — частина лише
            // собі відмовляє.
            state.log({ kind: "database", error })
            items[index] = { ok: false, error: INTERNAL }
            continue
          }
        }
        if (await placeRights(index, entry.rights, snapshot)) {
          rest(n + 1, OVER_BUDGET)
          break
        }
        continue
      }
      const { object, plan } = entry
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

const CHANNELS_ALLOWED = `SELECT c AS channel FROM pg_catalog.unnest($1::text[]) AS c WHERE ${ident(PLATFORM_SCHEMA)}.${ident(SIGNAL_TOPIC_ALLOWED_FUNCTION_NAME)}(c, false)`
const utf8 = new TextEncoder()

/**
 * Канали запиту — відсортовані й без повторів; межі — до бази: запит на
 * тисячі каналів інакше тримав би з'єднання оракулом прав на кожен.
 */
function requestedChannels(channels: readonly string[]): string[] {
  const invalid = (error: Omit<CommandError, "code">) =>
    new CommandFailure({ code: "command.invalid", ...error })
  // Викликач у процесі типу не проходить: масив — із тіла запиту host-а.
  if (!Array.isArray(channels)) throw invalid({})
  if (channels.length > AUTHORIZE_CHANNELS_MAX) {
    throw invalid({ reason: LIMIT_REASONS.batchTooLarge })
  }
  channels.forEach((channel: unknown, index) => {
    if (typeof channel !== "string") throw invalid({ path: String(index) })
    // Межа Centrifugo — в октетах, не в символах.
    if (utf8.encode(channel).length > CENTRIFUGO_CHANNEL_MAX) {
      throw invalid({ reason: LIMIT_REASONS.tooLarge, path: String(index) })
    }
  })
  return [...new Set(channels)].sort()
}

/**
 * Дозвіл каналів сигналів (спека П4-B §8.3; Р5, Р12 плану B2): єдиний
 * виробник `ChannelGrant`. Користувача дає `current_user_id()` під claims
 * сесії, а не сирий `sub`; канал — лише той, який оракул пропустив у режимі
 * підписки під роллю запиту, як для PostgREST з тими самими claims.
 */
async function authorizeChannels(
  state: RuntimeState,
  session: SessionClaims,
  channels: readonly string[]
): Promise<ChannelGrant> {
  // До будь-якого I/O: друге з'єднання в хуку чекало б на замок своєї ж
  // команди.
  rejectNested()
  const kind = checkedKind(state.catalog.provider, session)
  const requested = requestedChannels(channels)
  // Гість не має ні з'єднання, ні каналів (інваріант 9): до бази не йде.
  if (kind === "anonymous") return createChannelGrant(null, [])
  const claims = claimsOf(session)
  const role = readRoleFor(state, session)
  let client: DatabaseClient
  try {
    client = await state.database.connect()
  } catch (raw) {
    throw new CommandFailure(readRefusal(raw, state, undefined).error)
  }
  const send = async (statement: {
    text: string
    params: readonly (string | null)[]
  }) => {
    try {
      return await client.query(statement.text, statement.params)
    } catch (raw) {
      throw new Refused(readRefusal(raw, state, undefined))
    }
  }
  let user: string | null
  let allowed: string[] = []
  let tag: string
  try {
    await send({ text: BEGIN_READ, params: [] })
    await send(
      readSetupStatement(
        claims,
        state.readTimeout,
        state.readBudgetMs + 1000,
        role
      )
    )
    const users = (await send(CURRENT_USER)).rows
    const id = users[0]?.user_id
    if (users.length !== 1 || (typeof id !== "string" && id !== null)) {
      throw new Error("current_user_id answered no user row")
    }
    user = id
    // Без дійсного користувача оракул каналу не відкриє жодного: запит зайвий.
    if (user !== null && requested.length > 0) {
      const { rows } = await send({
        text: CHANNELS_ALLOWED,
        params: [textArray(requested)],
      })
      const asked = new Set(requested)
      const answered = new Set(rows.map((row) => row.channel))
      // Відповідь поза запитом — аномалія: грант несе лише запитане.
      if ([...answered].some((c) => typeof c !== "string" || !asked.has(c))) {
        throw new Error("signal_topic_allowed answered a channel not asked")
      }
      allowed = requested.filter((channel) => answered.has(channel))
    }
    ;({ command: tag } = await send(COMMIT))
  } catch (error) {
    if (error instanceof Refused) {
      await endFailed(client, error.refusal.destroy)
      throw new CommandFailure(error.refusal.error)
    }
    state.log({ kind: "database", error })
    await endFailed(client, false)
    throw new CommandFailure(INTERNAL)
  }
  client.release()
  // Дозвіл — лише з зафіксованої транзакції: інакше грант не доведений.
  if (tag !== "COMMIT") {
    state.log({ kind: "database", error: new Error(`COMMIT answered ${tag}`) })
    throw new CommandFailure(INTERNAL)
  }
  return createChannelGrant(user, allowed)
}
