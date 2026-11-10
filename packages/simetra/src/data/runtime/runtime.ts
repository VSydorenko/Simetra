import {
  CommandFailure,
  LIMIT_REASONS,
  PAYLOAD_MAX_BYTES,
  catalogIndex,
  clientCatalogSchema,
  errorFromWire,
  jsonBytes,
  type CommandError,
  type DataRequest,
  type DataResponse,
  type DataTransport,
  type SourceAdapter,
} from "simetra/model"
import { selectSource, serverFunctionAdapter } from "../adapter"
import { createCore, limitsOf } from "../store/core"
import { createCoreSource, createReadLimiter } from "../store/source"
import type { CloseReason, CoreLimits, CoreLogEntry } from "../store/types"
import { bindRuntimeHandle, type RuntimeRequest } from "./handle"

/** The data runtime of one user session (P4-B spec §6.1). */
export interface DataRuntime {
  /** The session `sub`; every request of this runtime carries it. */
  readonly subject: string
  /** Closes the runtime; later requests are refused without the transport. */
  dispose(): void
  readonly disposed: boolean
}

export interface DataRuntimeOptions {
  /** The client catalog (`client-catalog.json`); validated on creation. */
  catalog: unknown
  transport: DataTransport
  /** The session `sub`. */
  subject: string
  /**
   * Called once when the server, or an override adapter, reports
   * `session-changed`; the runtime is already closed by then.
   */
  onSessionChanged?: () => void
  /** The runtime journal (default `console.warn`); see {@link DataLogEntry}. */
  log?: (entry: DataLogEntry) => void
  /**
   * Source adapters (P4-B spec §5.1). `override` maps a logical object name
   * `"<kind>.<name>"` to a factory of its adapter; a name outside the catalog
   * is a `TypeError`. Each factory is called once on creation with this
   * runtime's `subject` and transport wrapper `send`: the adapter either
   * reads through `send` (it sets `subject`) or checks the `sub` of its own
   * credentials against `subject` itself (PostgREST adapter, §5.3). A
   * `CommandFailure` `command.unauthenticated` `session-changed` from an
   * override closes the runtime and calls `onSessionChanged` once, as the
   * same response of the transport does.
   */
  sources?: {
    override?: Readonly<
      Record<
        string,
        (context: {
          subject: string
          send: (request: DataRequest["request"]) => Promise<unknown>
        }) => SourceAdapter
      >
    >
  }
  /** The row limit of a `full` view (default 5 000); overrides `limits.fullLimit`. */
  fullLimit?: number
  /** `full` over its limit fails with `data.full-too-large` (default `false`). */
  strict?: boolean
  /** Memory and request limits of the core (P4-B spec §6.2); positive integers. */
  limits?: Partial<CoreLimits>
}

/**
 * An entry of the runtime journal (P4-B spec §6.1). `transport-failed`: the
 * transport threw or rejected; the caller saw `command.unavailable`. The
 * other kinds come from the data core.
 */
export type DataLogEntry =
  { kind: "transport-failed"; error: unknown } | CoreLogEntry

// Відмова рантайму після звичайного `dispose()` (вихід, зміна користувача з
// боку host-а): сесії рантайму вже немає, а проміс викликача мусить
// завершитися, а не висіти. Окрема причина, бо write-back і перечитування
// B3-3 мусять відрізнити «рантайм закрито — нічого не робити» від «сервер
// недоступний — перечитати»: без неї таблиця §7.3 перечитувала б після
// `dispose()`.
const DISPOSED: CommandError = {
  code: "command.unavailable",
  reason: LIMIT_REASONS.disposed,
}

const isSessionChanged = (error: CommandError) =>
  error.code === "command.unauthenticated" &&
  error.reason === LIMIT_REASONS.sessionChanged

/** Creates the data runtime of one user session (P4-B spec §6.1). */
export function createDataRuntime(options: DataRuntimeOptions): DataRuntime {
  const catalog = clientCatalogSchema.parse(options.catalog)
  const index = catalogIndex(catalog.objects)
  const { transport, subject, onSessionChanged } = options
  // Усі перевірки — до першої фабрики адаптера: відмова створення не лишає
  // по собі адаптерів із побічними діями.
  const overrides = Object.entries(options.sources?.override ?? {})
  for (const [name] of overrides) {
    if (!index.byRef.has(name)) {
      throw new TypeError(`sources.override: unknown object ${name}`)
    }
  }
  const { fullLimit } = options
  if (
    fullLimit !== undefined &&
    (!Number.isSafeInteger(fullLimit) || fullLimit < 1)
  ) {
    throw new TypeError("fullLimit must be a positive integer")
  }
  // Межі перевіряються тут, до обмежувача й фабрик: кожна хибна межа —
  // той самий `TypeError` ядра, а не `RangeError` обмежувача.
  const limits = limitsOf({
    ...options.limits,
    ...(fullLimit === undefined ? {} : { fullLimit }),
  })
  const sink = options.log ?? ((entry: DataLogEntry) => console.warn(entry))
  const log = (entry: DataLogEntry) => {
    try {
      sink(entry)
    } catch {
      // Журнал недоступний — результат запиту від нього не залежить.
    }
  }
  // Причина закриття: після неї кожна відповідь, зокрема пізня, відхиляється
  // нею — рядки попереднього користувача викликачу не доходять.
  let closedWith: CommandError | undefined

  // Закриття рантайму — це закриття його ядра: одна purge-пачка (кожен
  // вигляд — `purged` з причиною), потім жодного запиту й запису (§6.1).
  // `closedWith` ставиться до `core.close`, щоб слухач purge-пачки вже не
  // відправив запиту.
  const close = (error: CommandError, reason: CloseReason) => {
    if (closedWith !== undefined) return
    closedWith = error
    try {
      core.close(reason)
    } catch {
      // Ядро не закривається всередині `commit` (кидає, лишаючись живим);
      // туди `dispose()` доходить, наприклад, з журналу host-а на
      // `full-truncated`. Закриття відкладається на мікрозадачу — вона
      // настає після `commit` і його сповіщення, — а запити рантайм
      // відхиляє вже зараз.
      queueMicrotask(() => core.close(reason))
    }
  }

  // `session-changed` з будь-якого шляху — відповідь транспорту чи відмова
  // адаптера-перевизначення, що сам звіряє `sub` (§5.3): спершу закрити,
  // потім колбек — host у колбеку створює рантайм нового користувача, і
  // старий на цей момент уже не відповідає нікому. Колбек — один раз: після
  // першого закриття решта відмов сюди не доходить. Обидва шляхи кличуть це
  // після `await` чи в обробнику промісу, тобто поза будь-яким `commit`.
  const sessionChanged = (error: CommandError) => {
    if (closedWith !== undefined) return
    close(error, "session-changed")
    try {
      onSessionChanged?.()
    } catch (thrown) {
      // Збій колбека host-а не підміняє відмову запиту: викликач однаково
      // бачить `session-changed`, а збій виходить окремо, як неперехоплений.
      queueMicrotask(() => {
        throw thrown
      })
    }
  }

  // Відмова `session-changed` адаптера-перевизначення закриває рантайм так
  // само, як відповідь транспорту: інакше лишились би тільки помилка
  // вигляду, а решта виглядів — з рядками старого суб'єкта. Обробник
  // промісу завжди виконується мікрозадачею, тож навіть синхронний кидок
  // `read` закриває рантайм поза `commit`.
  const watchSessionChanged = (adapter: SourceAdapter): SourceAdapter => ({
    capabilities: adapter.capabilities,
    read(query) {
      let pending: ReturnType<SourceAdapter["read"]>
      try {
        pending = adapter.read(query)
      } catch (error) {
        pending = Promise.reject(error)
      }
      return pending.catch((error: unknown) => {
        if (error instanceof CommandFailure && isSessionChanged(error.error))
          sessionChanged(error.error)
        throw error
      })
    },
  })

  const send = async (request: RuntimeRequest): Promise<unknown> => {
    if (closedWith !== undefined) throw new CommandFailure(closedWith)
    const body: DataRequest = { subject, request }
    // Та сама міра й той самий код, що в host-а (§4.5, Р2): межу хоста
    // ловить лише чужий клієнт.
    if (jsonBytes(body) > PAYLOAD_MAX_BYTES) {
      throw new CommandFailure({
        code: "command.invalid",
        reason: LIMIT_REASONS.payloadTooLarge,
      })
    }
    let response: DataResponse
    try {
      response = await transport(body)
    } catch (error) {
      // Закритий рантайм важить більше за збій: `AbortError` після
      // `dispose()` чи пізня відмова — це «закрито», а не «недоступно».
      if (closedWith !== undefined) throw new CommandFailure(closedWith)
      // Сирий виняток обійшов би таблицю §7.3: для `run` «недоступно» —
      // результат невідомий, і ядро перечитує ключі без повтору. Оригінал
      // іде в журнал, викликач бачить лише код.
      log({ kind: "transport-failed", error })
      throw new CommandFailure({ code: "command.unavailable" })
    }
    // Відповідь, що прийшла після закриття, нікуди не йде (спека §11, інв. 12).
    if (closedWith !== undefined) throw new CommandFailure(closedWith)
    if (response.ok) return response.value
    const error = errorFromWire(index, response.error)
    if (isSessionChanged(error)) sessionChanged(error)
    throw new CommandFailure(error)
  }

  const serverFunction = serverFunctionAdapter(send, index)
  const adapters = new Map<string, SourceAdapter>()
  const source = createCoreSource(
    (object) =>
      selectSource({
        profile: catalog.provider,
        override: adapters.get(`${object.kind}.${object.name}`),
        serverFunction,
      }),
    index,
    createReadLimiter(limits.readParallel)
  )
  const core = createCore({
    subject,
    source,
    index,
    limits,
    ...(options.strict === undefined ? {} : { strict: options.strict }),
    log,
  })
  // Фабрики — після обгортки `send` і ядра: адаптер отримує саме цей
  // `subject` і саме цю обгортку, тож його запити несуть суб'єкт рантайму.
  for (const [name, factory] of overrides) {
    adapters.set(name, watchSessionChanged(factory({ subject, send })))
  }

  const runtime: DataRuntime = {
    subject,
    get disposed() {
      return closedWith !== undefined
    },
    dispose: () => close(DISPOSED, "disposed"),
  }
  bindRuntimeHandle(runtime, { send, core, index })
  return runtime
}
