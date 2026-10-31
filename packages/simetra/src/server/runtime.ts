import {
  APPLIED_SNAPSHOT_HASH_FUNCTION_NAME,
  LOGIN_ROLE_REQUEST_PURPOSES,
  OBJECT_MODULE_KEYS,
  PLATFORM_SCHEMA,
  PROVIDER_API_ROLES,
  runtimeCatalogSchema,
  type CommandError,
  type CommandResult,
  type DatabaseProvider,
  type ObjectModule,
  type Operation,
  type ProviderApiRoles,
  type RequestRolePurpose,
  type RuntimeCatalog,
  type SessionClaims,
} from "simetra/model"
import { z } from "zod"
import { CommandFailure } from "./errors"
import {
  normalizeError,
  type CommandDatabase,
  type DatabaseClient,
} from "./port"
import { ident } from "./read"
import {
  COMMAND_ROLE,
  COMMIT,
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
  /** Receives errors that never leave the runtime; default `console.error`. */
  log?: (entry: LogEntry) => void
}

/** The command runtime of one catalog and database. */
export interface CommandRuntime {
  /** Runs an operation or a batch in one transaction; rejects with `CommandFailure`. */
  run(
    session: SessionClaims,
    input: Operation | readonly Operation[]
  ): Promise<CommandResult>
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
const MEMBER = "SELECT pg_has_role(session_user, $1, 'SET') AS member"
const APPLIED_HASH = `SELECT ${ident(PLATFORM_SCHEMA)}.${ident(APPLIED_SNAPSHOT_HASH_FUNCTION_NAME)}() AS hash`
// База до функції хеша (`42883`) чи без схеми платформи (`3F000`) — модель
// не застосована, а не збій.
const NO_APPLIED_STATE = new Set(["42883", "3F000"])
// `pg_has_role` на ролі, якої немає в базі.
const UNDEFINED_OBJECT = "42704"
// Межі повтору й глибини — помилка конфігурації host-а, як і каталог.
const limitSchema = z.int().min(1).optional()

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
  const fail = (raw: unknown, lost: boolean): CommandFailure => {
    if (lost) return new CommandFailure({ code: "command.unavailable" })
    log({ kind: "database", error: raw })
    return new CommandFailure({ code: "command.internal" })
  }
  let client: DatabaseClient
  try {
    client = await database.connect()
  } catch (raw) {
    throw fail(raw, normalizeError(raw).connectionLost)
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
      throw fail(new Error(`runtime check answered ${command}`), false)
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
    throw fail(raw, error.connectionLost)
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
    // Профіль без ролі запиту чи явний запасний шлях — читання під роллю команд.
    readRole: member ? role : undefined,
  }
  return { run: (session, input) => runCommand(state, session, input) }
}
