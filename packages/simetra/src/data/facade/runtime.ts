import { QueryClient } from "@tanstack/query-core"
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
} from "simetra/model"
import { bindFacade, type RuntimeRequest } from "./handle"

/** The data runtime of one user session (P4-B spec §6.1). */
export interface DataRuntime {
  /** The session `sub`; every request of this runtime carries it. */
  readonly subject: string
  /** Drops the runtime cache; later requests are refused without the transport. */
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
}

/**
 * An entry of the runtime journal (P4-B spec §6.1). `transport-failed`: the
 * transport threw or rejected; the caller saw `command.unavailable`.
 */
// Об'єднання з одного виду: наступні види (`full-truncated`, B3-2b)
// додаються гілками, без перейменування опції.
export type DataLogEntry = { kind: "transport-failed"; error: unknown }

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
  const sink = options.log ?? ((entry: DataLogEntry) => console.warn(entry))
  const log = (entry: DataLogEntry) => {
    try {
      sink(entry)
    } catch {
      // Журнал недоступний — результат запиту від нього не залежить.
    }
  }
  // Власний клієнт і nonce у префіксі ключів: кеш одного рантайму не видно
  // іншому, навіть з тим самим `subject` (спека §6.1, «Ізоляція кешу»).
  const queryClient = new QueryClient()
  const keyPrefix = ["simetra", subject, crypto.randomUUID()] as const
  // Причина закриття: після неї кожна відповідь, зокрема пізня, відхиляється
  // нею — рядки попереднього користувача викликачу не доходять.
  let closedWith: CommandError | undefined

  const close = (error: CommandError) => {
    if (closedWith !== undefined) return
    closedWith = error
    queryClient.clear()
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
      // результат невідомий, і фасад перечитує ключі без повтору. Оригінал
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
      // користувача, і старий на цей момент уже не відповідає нікому.
      close(error)
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

  const runtime: DataRuntime = {
    subject,
    get disposed() {
      return closedWith !== undefined
    },
    dispose: () => close(DISPOSED),
  }
  bindFacade(runtime, { queryClient, keyPrefix, send })
  return runtime
}
