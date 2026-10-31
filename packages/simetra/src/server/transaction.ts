import {
  PLATFORM_ROLES,
  PLATFORM_SCHEMA,
  CURRENT_USER_FUNCTION_NAME,
  SESSION_CLAIMS_SETTING,
  type Change,
  type CommandError,
  type CommandResult,
  type ObjectModule,
  type Operation,
  type RuntimeCatalog,
  type SessionClaims,
} from "simetra/model"
import { CommandFailure, mapDatabaseError, type ErrorPhase } from "./errors"
import { inCommand, outsideCommand, rejectNested } from "./hook-context"
import { prepareInput, runPhase } from "./phase"
import {
  normalizeError,
  type CommandDatabase,
  type DatabaseClient,
} from "./port"
import { ident, literal } from "./read"

/** One bound statement of the transaction. */
export interface Statement {
  text: string
  params: (string | null)[]
}

/** A runtime log entry: the full error stays inside the process. */
export type LogEntry = {
  kind: "afterCommit" | "hook" | "defer" | "database"
  error: unknown
}

/** What a created runtime holds; every command reads it. */
export interface RuntimeState {
  database: CommandDatabase
  catalog: RuntimeCatalog
  objectModules: Readonly<Record<string, ObjectModule<object>>>
  defer: ((work: Promise<unknown>) => void) | undefined
  log: (entry: LogEntry) => void
  maxAttempts: number
  maxDepth: number
  /** The request role of reads; `undefined` — the fallback path (§6.11). */
  readRole: string | undefined
}

type QueryResult = Awaited<ReturnType<DatabaseClient["query"]>>

/** Відмова, якою завершиться спроба: повтор, знищення з'єднання. */
interface Terminal {
  failure: CommandFailure
  retry: boolean
  destroy: boolean
}

// Серіалізація й взаємне блокування: повтор усієї транзакції (§6.5).
const RETRY_CODES = new Set(["40001", "40P01"])
const INTERNAL: CommandError = { code: "command.internal" }

const statement = (text: string, ...params: (string | null)[]) => ({
  text,
  params,
})

const BEGIN = statement("BEGIN ISOLATION LEVEL READ COMMITTED")
export const COMMIT = statement("COMMIT")
const ROLLBACK = statement("ROLLBACK")
/** `SET LOCAL ROLE` на роль команд — і в транзакції створення рантайму. */
export const COMMAND_ROLE = statement(
  `SET LOCAL ROLE ${ident(PLATFORM_ROLES.command)}`
)
// Claims, час і формат `bytea` — одним оператором: рядок ядра декодується
// в UTC і hex незалежно від налаштувань бази (Р-A3-7).
const CLAIMS_TEXT =
  `SELECT set_config(${literal(SESSION_CLAIMS_SETTING)}, $1, true), ` +
  `set_config('TimeZone', 'UTC', true), set_config('bytea_output', 'hex', true)`
/** Claims, `TimeZone` і `bytea_output` транзакції — і команди, і читання. */
export const claimsStatement = (claims: string) =>
  statement(CLAIMS_TEXT, claims)
const CURRENT_USER = statement(
  `SELECT ${ident(PLATFORM_SCHEMA)}.${ident(CURRENT_USER_FUNCTION_NAME)}() AS user_id`
)

/**
 * Помилка порту як відмова спроби. Кожен `command.internal` мапінгу йде в
 * журнал з повною помилкою: назовні — лише код.
 */
export function terminalOf(
  raw: unknown,
  state: RuntimeState,
  phase: ErrorPhase | undefined
): Terminal {
  const error = normalizeError(raw)
  if (!error.connectionLost && RETRY_CODES.has(error.code ?? "")) {
    return {
      failure: new CommandFailure({ code: "command.retry-exhausted" }),
      retry: true,
      destroy: false,
    }
  }
  const mapped = mapDatabaseError(error, state.catalog, phase)
  if (mapped.code === "command.internal") {
    state.log({ kind: "database", error: raw })
  }
  return {
    failure: new CommandFailure(mapped),
    retry: false,
    destroy: error.connectionLost,
  }
}

/**
 * One attempt of a command on one connection: the statement queue
 * (Р-A3-15). Одиниця черги — оператор чи неподільна пара; перша відмова
 * закриває чергу, і далі порт отримує лише `ROLLBACK`.
 */
export class Transaction {
  terminal: Terminal | undefined
  readonly changes: Change[] = []
  readonly afterCommit: (() => unknown)[] = []
  /** The current user of the attempt (step 4 of §6.5). */
  user = ""
  act: { sub: string } | undefined
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly client: DatabaseClient,
    readonly state: RuntimeState
  ) {}

  /** Runs a unit after the previous ones; resolves to its last result. */
  enqueue(
    unit: readonly Statement[],
    phase?: ErrorPhase
  ): Promise<QueryResult> {
    const result = this.tail.then(async () => {
      let last: QueryResult = { rows: [], command: "" }
      for (const { text, params } of unit) {
        if (this.terminal !== undefined) throw this.terminal.failure
        try {
          last = await this.client.query(text, params)
        } catch (raw) {
          throw this.close(terminalOf(raw, this.state, phase))
        }
      }
      return last
    })
    this.tail = result.catch(() => undefined)
    return result
  }

  /** Closes the queue; the first failure decides the attempt. */
  close(terminal: Terminal): CommandFailure {
    this.terminal ??= terminal
    return terminal.failure
  }

  /** Fails the attempt with a non-database error. */
  abort(error: CommandError): never {
    throw this.close({
      failure: new CommandFailure(error),
      retry: false,
      destroy: false,
    })
  }

  /**
   * Fails the attempt with `command.internal` for an anomaly — a database
   * answer of the wrong shape or an unexpected exception — and logs it.
   */
  anomaly(error: unknown): never {
    this.state.log({ kind: "database", error })
    this.abort(INTERNAL)
  }

  /** Resolves once no unit is running. */
  settled(): Promise<unknown> {
    return this.tail
  }
}

/**
 * Завершує невдалу спробу: обірване з'єднання знищується без `ROLLBACK`;
 * `ROLLBACK`, що сам упав, — теж (стан з'єднання невідомий).
 */
export async function endFailed(
  client: DatabaseClient,
  destroy: boolean
): Promise<void> {
  if (!destroy) {
    try {
      await client.query(ROLLBACK.text, ROLLBACK.params)
      client.release()
      return
    } catch {
      // нижче — знищення
    }
  }
  client.release(true)
}

type Outcome =
  | { result: CommandResult; afterCommit: (() => unknown)[] }
  | { terminal: Terminal }

/** Кроки 1–7 транзакції команди (спека П4 §6.5). */
async function attempt(
  state: RuntimeState,
  command: { active: boolean },
  claims: string,
  act: { sub: string } | undefined,
  ops: readonly Operation[]
): Promise<Outcome> {
  let client: DatabaseClient
  try {
    client = await state.database.connect()
  } catch (raw) {
    return { terminal: terminalOf(raw, state, undefined) }
  }
  // Явний тип: виклики `never` звужують типи лише так.
  const tx: Transaction = new Transaction(client, state)
  tx.act = act
  const rows: Record<string, unknown>[] = []
  let tag: string
  try {
    tag = await inCommand({ command, tx, depth: 0 }, async () => {
      await tx.enqueue([BEGIN])
      await tx.enqueue([claimsStatement(claims)])
      await tx.enqueue([COMMAND_ROLE])
      const { rows: users } = await tx.enqueue([CURRENT_USER])
      const user = users[0]?.user_id
      // Без дійсного користувача — жодної фази (Рт8).
      if (user == null) tx.abort({ code: "command.unauthenticated" })
      if (typeof user !== "string") tx.anomaly(new Error("user id is not text"))
      tx.user = user
      for (const op of ops) rows.push(await runPhase(tx, op))
      return (await tx.enqueue([COMMIT])).command
    })
  } catch (error) {
    // Непередбачений виняток (не відмова черги) — теж термінальний.
    if (tx.terminal === undefined) {
      if (error instanceof CommandFailure) {
        tx.close({ failure: error, retry: false, destroy: false })
      } else {
        try {
          tx.anomaly(error)
        } catch {
          // відмову вже записано в `tx.terminal`
        }
      }
    }
    await tx.settled()
    const terminal = tx.terminal!
    await endFailed(client, terminal.destroy)
    return { terminal }
  }
  client.release()
  if (tag !== "COMMIT") {
    // Перервана транзакція відповідає на `COMMIT` тегом `ROLLBACK`: це не успіх.
    state.log({ kind: "database", error: new Error(`COMMIT answered ${tag}`) })
    return {
      terminal: {
        failure: new CommandFailure(INTERNAL),
        retry: false,
        destroy: false,
      },
    }
  }
  return { result: { rows, changes: tx.changes }, afterCommit: tx.afterCommit }
}

/**
 * Runs `afterCommit` actions in order; a failing action is logged and the
 * next one still runs.
 */
export async function runAfterCommit(
  actions: readonly (() => unknown)[],
  log: (entry: LogEntry) => void
): Promise<void> {
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      log({ kind: "afterCommit", error })
    }
  }
}

/** A command: validation, attempts with retry, then `afterCommit` (§6.5). */
export async function runCommand(
  state: RuntimeState,
  session: SessionClaims,
  input: unknown
): Promise<CommandResult> {
  rejectNested()
  const ops = prepareInput(state.catalog, input)
  let claims: string
  try {
    claims = JSON.stringify(session)
  } catch {
    throw new CommandFailure(INTERNAL)
  }
  // Знімок входу одразу й копія на кожну спробу: ні викликач після виклику,
  // ні невдала спроба не змінюють того, що виконує наступна.
  const snapshot = structuredClone(ops)
  const act =
    typeof session.act?.sub === "string" ? { sub: session.act.sub } : undefined
  const command = { active: true }
  // `maxAttempts` ≥ 1, тож хоч одна спроба відбудеться.
  let outcome: Outcome | undefined
  try {
    for (let n = 0; n < state.maxAttempts; n++) {
      outcome = await attempt(
        state,
        command,
        claims,
        act,
        structuredClone(snapshot)
      )
      if (!("terminal" in outcome) || !outcome.terminal.retry) break
    }
  } finally {
    // Команда завершена: продовження, які запланував хук, — не вкладені.
    command.active = false
  }
  // Вичерпаний повтор несе `command.retry-exhausted` (`terminalOf`).
  if ("terminal" in outcome!) throw outcome.terminal.failure
  const { result, afterCommit } = outcome!
  if (afterCommit.length > 0) {
    // Поза сховищем: команда, яку запускає дія, не вкладена (Р-A3-11).
    const chain = outsideCommand(() => runAfterCommit(afterCommit, state.log))
    if (state.defer === undefined) {
      await chain
    } else {
      try {
        state.defer(chain)
      } catch (error) {
        state.log({ kind: "defer", error })
      }
    }
  }
  return result
}
