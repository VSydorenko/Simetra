/** Сентинел: тіло запиту перевищило межу. Entry ловить його й відповідає відмовою. */
export class BodyTooLarge extends Error {
  constructor() {
    super("request body exceeds the limit")
    this.name = "BodyTooLarge"
  }
}

// Запити, чий потік-лічильник дійшов до межі: Start може проковтнути виняток
// читання тіла у власну відповідь, тож entry звіряє стан після виклику, а не
// покладається лише на `catch`.
const exceeded = new WeakSet<Request>()

/** Чи потік-лічильник цього запиту дійшов до межі. */
export function bodyExceeded(request: Request): boolean {
  return exceeded.has(request)
}

/**
 * Межа тіла не-`GET`/`HEAD` запиту до розбору (спека П4-D §4.4). Шлях не
 * впливає: межа діє однаково на кожен маршрут, зокрема `/api/auth/*`.
 * `Content-Length` понад межу й `Content-Encoding`, відмінний від `identity`,
 * кидають `BodyTooLarge` до читання тіла; решту рахує потік, який на межі
 * обриває читання тим самим сентинелом (chunked чи неправдивий
 * `Content-Length`).
 */
export function limitBody(request: Request, maxBytes: number): Request {
  if (request.method === "GET" || request.method === "HEAD") return request

  const encoding = request.headers.get("content-encoding")
  // Стиснене тіло розпакував би розбір уже після межі: стиснення не міряємо
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    throw new BodyTooLarge()
  }
  const length = request.headers.get("content-length")
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
    throw new BodyTooLarge()
  }
  if (request.body === null) return request

  let seen = 0
  let limited!: Request
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > maxBytes) {
        exceeded.add(limited)
        controller.error(new BodyTooLarge())
        return
      }
      controller.enqueue(chunk)
    },
  })
  void request.body.pipeTo(counter.writable).catch(() => undefined)
  limited = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: counter.readable,
    duplex: "half",
    signal: request.signal,
  } as RequestInit & { duplex: "half" })
  return limited
}
