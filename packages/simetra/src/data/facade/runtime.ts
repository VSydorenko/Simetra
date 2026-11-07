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
  /**
   * Receives the original exception of the transport; the caller sees
   * `command.unavailable` (default `console.error`).
   */
  log?: (error: unknown) => void
}

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
  const log = options.log ?? ((error: unknown) => console.error(error))
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
      log(error)
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
      onSessionChanged?.()
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
