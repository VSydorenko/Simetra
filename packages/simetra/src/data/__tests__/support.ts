import type {
  ClientCatalog,
  DataRequest,
  DataResponse,
  DataTransport,
  WireCommandError,
} from "simetra/model"
import { OBJECT_ID, catalogEntry } from "../../model/runtime/__tests__/entries"

/**
 * Спільні фікстури тестів T4: каталог береться з будівника записів T0, а не
 * інлайн-JSON, і транспорт керований — тест сам вирішує, коли й чим
 * відповісти, бо кейси «відповідь після `dispose()`» і «два запити в польоті»
 * залежать від порядку.
 */

export { OBJECT_ID }

export const SUBJECT = "user-1"
export const SERVER_HASH = "server-hash"

/** A client catalog with the default T0 test object (`Catalog.Task`). */
export const clientCatalog = (): ClientCatalog => ({
  format: 1,
  snapshotHash: "snapshot-hash",
  provider: "supabase",
  objects: [catalogEntry()],
})

export const ok = (value: unknown): DataResponse => ({
  ok: true,
  value,
  serverHash: SERVER_HASH,
})

export const failed = (error: WireCommandError): DataResponse => ({
  ok: false,
  error,
  serverHash: SERVER_HASH,
})

export const sessionChanged = (): DataResponse =>
  failed({ code: "command.unauthenticated", reason: "session-changed" })

interface Pending {
  readonly request: DataRequest
  respond(response: DataResponse): void
  fail(reason: unknown): void
}

/**
 * A transport that holds every request until the test answers it: `calls`
 * logs what was sent, `pending` holds the unanswered requests in order.
 */
export function controlledTransport() {
  const calls: DataRequest[] = []
  const pending: Pending[] = []
  const transport: DataTransport = (request) => {
    calls.push(request)
    return new Promise<DataResponse>((resolve, reject) => {
      pending.push({ request, respond: resolve, fail: reject })
    })
  }
  /** Answers the oldest unanswered request. */
  const respond = (response: DataResponse) => {
    const next = pending.shift()
    if (next === undefined) throw new Error("no request in flight")
    next.respond(response)
  }
  return { transport, calls, pending, respond }
}

/** A transport that answers every request at once with `response`. */
export function answeringTransport(response: DataResponse) {
  const calls: DataRequest[] = []
  const transport: DataTransport = (request) => {
    calls.push(request)
    return Promise.resolve(response)
  }
  return { transport, calls }
}
