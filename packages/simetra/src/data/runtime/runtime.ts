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
import { createCore } from "../store/core"
import { createCoreSource, createReadLimiter } from "../store/source"
import {
  DEFAULT_CORE_LIMITS,
  type CloseReason,
  type CoreLimits,
  type CoreLogEntry,
} from "../store/types"
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
  /** Called once when the server reports `session-changed`. */
  onSessionChanged?: () => void
  /** The runtime journal (default `console.warn`); see {@link DataLogEntry}. */
  log?: (entry: DataLogEntry) => void
  /**
   * Source adapters (P4-B spec §5.1). `override` maps a logical object name
   * `"<kind>.<name>"` to a factory of its adapter; a name outside the catalog
   * is a `TypeError`. Each factory is called once on creation with this
   * runtime's `subject` and transport wrapper `send`: the adapter either
   * reads through `send` (it sets `subject`) or checks the `sub` of its own
   * credentials against `subject` itself (PostgREST adapter, §5.3).
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

const isSessionChanged = (response: DataResponse) =>
  !response.ok &&
  response.error.code === "command.unauthenticated" &&
  response.error.reason === LIMIT_REASONS.sessionChanged

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
  const limits: Partial<CoreLimits> = {
    ...options.limits,
    ...(fullLimit === undefined ? {} : { fullLimit }),
  }
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
  // відправив запиту; збій закриття (виклик з `commit`) лишає рантайм живим,
  // як і ядро.
  const close = (error: CommandError, reason: CloseReason) => {
    if (closedWith !== undefined) return
    closedWith = error
    try {
      core.close(reason)
    } catch (thrown) {
      closedWith = undefined
      throw thrown
    }
  }

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
    if (isSessionChanged(response)) {
      // Спершу закрити, потім колбек: host у колбеку створює рантайм нового
      // користувача, і старий на цей момент уже не відповідає нікому. Сюди
      // доходимо лише після `await`, тобто поза будь-яким `commit` ядра.
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
    throw new CommandFailure(error)
  }

  // Межі перевіряє ядро; обмежувачу потрібна лише паралельність після
  // злиття з типовими.
  const parallel = { ...DEFAULT_CORE_LIMITS, ...limits }.readParallel
  const serverFunction = serverFunctionAdapter(send)
  const adapters = new Map<string, SourceAdapter>()
  const source = createCoreSource(
    (object) =>
      selectSource({
        profile: catalog.provider,
        override: adapters.get(`${object.kind}.${object.name}`),
        serverFunction,
      }),
    index,
    createReadLimiter(parallel)
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
    adapters.set(name, factory({ subject, send }))
  }

  const runtime: DataRuntime = {
    subject,
    get disposed() {
      return closedWith !== undefined
    },
    dispose: () => close(DISPOSED, "disposed"),
  }
  bindRuntimeHandle(runtime, { send, core })
  return runtime
}
