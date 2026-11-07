import {
  PLATFORM_ROLES,
  PLATFORM_SCHEMA,
  CURRENT_USER_FUNCTION_NAME,
  SESSION_CLAIMS_SETTING,
  type Change,
  type CommandError,
  type CommandResult,
  type ObjectModule,
  type RuntimeCatalog,
  type SessionClaims,
  CommandFailure,
} from "simetra/model"
import { logsDatabaseError, mapDatabaseError, type ErrorPhase } from "./errors"
import { inCommand, outsideCommand, rejectNested } from "./hook-context"
import { prepareInput, runPhase, type PreparedOperation } from "./phase"
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
  /** Operations of a `run` batch, ≤ `BATCH_MAX`; `ctx.run` phases are not counted. */
  maxBatch: number
  /** Rows of one tabular section of an operation, `run` and `ctx.run` alike. */
  maxTabularLines: number
  /** `statement_timeout` of a server read, ms; `ctx.read` sets none (B1b budget). */
  readTimeout: number
  /** The request role of reads; `undefined` — the fallback path (§6.11). */
  readRole: string | undefined
  /** Time budget of one `run` call with its retries, ms (P4-B spec §7.1). */
  budgetMs: number
  /** `lock_timeout` of a command transaction, ms. */
  lockTimeoutMs: number
}

type QueryResult = Awaited<ReturnType<DatabaseClient["query"]>>

/** Відмова, якою завершиться спроба: повтор, знищення з'єднання. */
interface Terminal {
  failure: CommandFailure
  retry: boolean
  destroy: boolean
  /** SQLSTATE відмови бази, якщо вона є: за ним обирається пауза повтору. */
  code?: string
}

// Серіалізація й взаємне блокування: повтор усієї транзакції (§6.5).
const RETRY_CODES = new Set(["40001", "40P01"])
// Запобіжники простою (`idle_in_transaction_session_timeout`) і транзакції
// (`transaction_timeout`): сервер уже закрив сесію `FATAL`-ом.
const SESSION_TIMEOUT_CODES = new Set(["25P03", "25P04"])
// Взаємне блокування повторюється з паузою: дві транзакції, що одночасно
// повторили той самий порядок замків, знову зійшлися б у ньому. Джитер
// розводить їх у часі. `40001` — без паузи: конфлікт знімку не залежить від
// того, коли почати знову.
const DEADLOCK = "40P01"
const DEADLOCK_PAUSE_BASE_MS = 20

/** Пауза перед повтором після `n`-ї невдалої спроби, мс. */
function pauseOf(code: string | undefined, n: number): number {
  if (code !== DEADLOCK) return 0
  const step = DEADLOCK_PAUSE_BASE_MS * 2 ** (n - 1)
  return step + Math.random() * step
}
const INTERNAL: CommandError = { code: "command.internal" }

const statement = (text: string, ...params: (string | null)[]) => ({
  text,
  params,
})
const TIMEOUT: CommandError = { code: "command.timeout" }
// Стеля одного оператора команди (спека П4-B §7.1, Ф6).
const STATEMENT_CEILING_MS = 30_000
// Значення — зв'язаним параметром: текстовий `SET` не приймає `$1`.
const STATEMENT_TIMEOUT = "SELECT set_config('statement_timeout', $1, true)"
// Мілісекунди межі: округлення вгору й ≥ 1 — `statement_timeout = 0` вимкнув
// би межу зовсім.
const timeoutMs = (remaining: number) => Math.max(1, Math.ceil(remaining))

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
/** Claims, `TimeZone` і `bytea_output` транзакції читання; команда додає межі часу. */
export const claimsStatement = (claims: string) =>
  statement(CLAIMS_TEXT, claims)
// Межі часу команди — у тому самому операторі claims, без кругового запиту
// (Ф4, Ф6). Запобіжники простою й транзакції — бюджет + 1 с: бюджет
// спрацьовує раніше, вони ловлять завислий хук чи обірваного клієнта.
// `transaction_timeout` є лише з PostgreSQL 17; умова — у самому SQL, щоб
// не питати версію окремо.
const COMMAND_CLAIMS_TEXT =
  `${CLAIMS_TEXT}, set_config('statement_timeout', $2, true), ` +
  `set_config('lock_timeout', $3, true), ` +
  `set_config('idle_in_transaction_session_timeout', $4, true), ` +
  `CASE WHEN current_setting('server_version_num')::int >= 170000 ` +
  `THEN set_config('transaction_timeout', $4, true) END`
const CURRENT_USER = statement(
  `SELECT ${ident(PLATFORM_SCHEMA)}.${ident(CURRENT_USER_FUNCTION_NAME)}() AS user_id`
)

/**
 * Помилка порту як відмова спроби. Кожен `command.internal` мапінгу йде в
 * журнал з повною помилкою: назовні — лише код. `commitSent` — помилка
 * прийшла на `COMMIT`, уже надісланий базі.
 */
export function terminalOf(
  raw: unknown,
  state: RuntimeState,
  phase: ErrorPhase | undefined,
  commitSent: boolean
): Terminal {
  const error = normalizeError(raw)
  const { code } = error
  const sessionTimeout = SESSION_TIMEOUT_CODES.has(code ?? "")
  // Сесія закрита після надсилання `COMMIT`: фіксацію могло бути виконано до
  // обриву, тож результат невідомий — і `25P03`, збережений драйвером раніше,
  // тут не доводить відкату. Відмова бази з іншим SQLSTATE на `COMMIT` —
  // відомий відкат і мапиться як завжди.
  const closed = error.connectionLost || sessionTimeout
  let terminal: Omit<Terminal, "code">
  if (commitSent && closed) {
    const mapped: CommandError = { code: "command.unavailable" }
    if (logsDatabaseError(error, mapped)) {
      state.log({ kind: "database", error: raw })
    }
    terminal = {
      failure: new CommandFailure(mapped),
      retry: false,
      destroy: true,
    }
  } else if (!error.connectionLost && RETRY_CODES.has(code ?? "")) {
    terminal = {
      failure: new CommandFailure({ code: "command.retry-exhausted" }),
      retry: true,
      destroy: false,
    }
  } else if (sessionTimeout) {
    // До `COMMIT` транзакцію відкочено, але сесії вже немає: `ROLLBACK`
    // слати нікуди, з'єднання — знищити.
    terminal = {
      failure: new CommandFailure(TIMEOUT),
      retry: false,
      destroy: true,
    }
  } else {
    const mapped = mapDatabaseError(error, state.catalog, phase)
    if (logsDatabaseError(error, mapped)) {
      state.log({ kind: "database", error: raw })
    }
    terminal = {
      failure: new CommandFailure(mapped),
      retry: false,
      destroy: error.connectionLost,
    }
  }
  return code === undefined ? terminal : { ...terminal, code }
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
  /** Фази, які вже почав `ctx.run` у цій спробі (межа `BATCH_MAX`, Ф1). */
  nestedPhases = 0
  private tail: Promise<unknown> = Promise.resolve()
  /**
   * `statement_timeout` у силі, мс; `undefined` — до claims: поза транзакцією
   * `set_config(…, true)` нічого не дає, а claims ставить його сам.
   */
  private statementTimeout: number | undefined
  /** `COMMIT` надіслано: обрив далі — невідомий результат, не відкат. */
  private commitSent = false

  /** `deadline` — мітка `performance.now()`, до якої має завершитися `run`. */
  constructor(
    private readonly client: DatabaseClient,
    readonly state: RuntimeState,
    private readonly deadline: number
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
        await this.budget(phase)
        // Після бюджету й прелюдії: їхні відмови ще до `COMMIT`.
        if (text === COMMIT.text) this.commitSent = true
        last = await this.send(text, params, phase)
      }
      return last
    })
    this.tail = result.catch(() => undefined)
    return result
  }

  /**
   * Claims команди з межами часу; `statement_timeout` — від залишку бюджету,
   * тож повтор після витраченого часу не отримує повної стелі.
   */
  async claims(claims: string): Promise<void> {
    const ms = timeoutMs(
      Math.min(STATEMENT_CEILING_MS, this.deadline - performance.now())
    )
    const guard = String(this.state.budgetMs + 1000)
    await this.enqueue([
      statement(
        COMMAND_CLAIMS_TEXT,
        claims,
        String(ms),
        String(this.state.lockTimeoutMs),
        guard
      ),
    ])
    this.statementTimeout = ms
  }

  /**
   * Перевірка бюджету перед оператором (єдина точка — `enqueue`): вичерпаний
   * залишок — `command.timeout` без оператора; залишок, менший за чинну
   * межу, — спершу нижча межа. Ціна — ще один круговий запит на оператор в
   * останні 30 с бюджету.
   */
  private async budget(phase: ErrorPhase | undefined): Promise<void> {
    const remaining = this.deadline - performance.now()
    if (remaining <= 1) {
      throw this.close({
        failure: new CommandFailure(TIMEOUT),
        retry: false,
        destroy: false,
      })
    }
    // Порівняння в цілих мілісекундах межі: дробовий залишок інакше завжди
    // менший за своє ж округлення вгору й слав би прелюдію щоразу.
    const ms = timeoutMs(remaining)
    if (this.statementTimeout === undefined || ms >= this.statementTimeout) {
      return
    }
    await this.send(STATEMENT_TIMEOUT, [String(ms)], phase)
    this.statementTimeout = ms
  }

  private async send(
    text: string,
    params: readonly (string | null)[],
    phase: ErrorPhase | undefined
  ): Promise<QueryResult> {
    try {
      return await this.client.query(text, params)
    } catch (raw) {
      throw this.close(terminalOf(raw, this.state, phase, this.commitSent))
    }
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
  ops: readonly PreparedOperation[],
  deadline: number,
  fullTabularArrays: boolean
): Promise<Outcome> {
  let client: DatabaseClient
  try {
    client = await state.database.connect()
  } catch (raw) {
    return { terminal: terminalOf(raw, state, undefined, false) }
  }
  // Явний тип: виклики `never` звужують типи лише так.
  const tx: Transaction = new Transaction(client, state, deadline)
  tx.act = act
  const rows: Record<string, unknown>[] = []
  let tag: string
  try {
    tag = await inCommand({ command, tx, depth: 0 }, async () => {
      await tx.enqueue([BEGIN])
      await tx.claims(claims)
      await tx.enqueue([COMMAND_ROLE])
      const { rows: users } = await tx.enqueue([CURRENT_USER])
      const user = users[0]?.user_id
      // Без дійсного користувача — жодної фази (Рт8).
      if (user == null) tx.abort({ code: "command.unauthenticated" })
      if (typeof user !== "string") tx.anomaly(new Error("user id is not text"))
      tx.user = user
      for (const op of ops) {
        rows.push(await runPhase(tx, op, fullTabularArrays))
      }
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
  input: unknown,
  fullTabularArrays = false
): Promise<CommandResult> {
  rejectNested()
  const ops = prepareInput(state.catalog, input, state)
  // Повний масив сам видаляє пропущені рядки: `deleteIds` поруч із ним не
  // діяв би, а мовчазний ігнор сховав би помилку викликача.
  const withDeletes = fullTabularArrays
    ? ops.find((op) => op.action === "update" && op.deleteIds !== undefined)
    : undefined
  if (withDeletes !== undefined) {
    // Об'єкт операції, що відмовила: `prepareInput` уже знайшов його в каталозі.
    throw new CommandFailure({
      code: "command.invalid",
      path: "deleteIds",
      object: withDeletes.object,
    })
  }
  let claims: string
  try {
    claims = JSON.stringify(session)
  } catch {
    throw new CommandFailure(INTERNAL)
  }
  // Знімок входу одразу й копія на кожну спробу: ні викликач після виклику,
  // ні невдала спроба не змінюють того, що виконує наступна. Id, які
  // згенерував `prepareInput`, — у знімку: повтор бере ті самі (Р-A6-20).
  const snapshot = structuredClone(ops)
  const act =
    typeof session.act?.sub === "string" ? { sub: session.act.sub } : undefined
  const command = { active: true }
  // Бюджет — на весь виклик `run`, разом із повторами (Ф2).
  const deadline = performance.now() + state.budgetMs
  // `maxAttempts` ≥ 1, тож хоч одна спроба відбудеться.
  let outcome: Outcome | undefined
  try {
    for (let n = 1; n <= state.maxAttempts; n++) {
      outcome = await attempt(
        state,
        command,
        claims,
        act,
        structuredClone(snapshot),
        deadline,
        fullTabularArrays
      )
      if (!("terminal" in outcome) || !outcome.terminal.retry) break
      if (n === state.maxAttempts) break
      const pause = pauseOf(outcome.terminal.code, n)
      if (pause === 0) continue
      // Повтор після паузи не встиг би й першого оператора: це тайм-аут
      // бюджету, а не вичерпаний повтор (бюджет — і на паузи, Ф2).
      if (deadline - performance.now() - pause <= 1) {
        outcome = {
          terminal: {
            failure: new CommandFailure(TIMEOUT),
            retry: false,
            destroy: false,
          },
        }
        break
      }
      await new Promise((resolve) => setTimeout(resolve, pause))
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
