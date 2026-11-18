// Сирий HTTP-клієнт для безпекових кейсів: потрібні заголовки, які браузер й
// `fetch` забороняють (`Host`, `Sec-Fetch-Site`), chunked-тіло без
// `Content-Length` і адреса сокета клієнта (`localAddress`, 127.0.0.x), бо межа
// частоти рахує саме її.
import http from "node:http"

export interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  setCookie: string[]
  text: string
}

export interface RawRequest {
  method?: string
  path: string
  headers?: Record<string, string>
  /** Тіло одним шматком; з `chunked` — шматками без `Content-Length`. */
  body?: string | Buffer
  /** Скільки байтів тіла піде chunked-потоком (без `Content-Length`). */
  chunkedBytes?: number
  /** Адреса сокета клієнта; типово — не задається. */
  localAddress?: string
}

const CHUNK = Buffer.alloc(64 * 1024, 0x61)

export function send(
  server: { port: number },
  request: RawRequest
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let replied = false
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: request.method ?? "GET",
        path: request.path,
        headers: request.headers,
        localAddress: request.localAddress,
        // Без повторного використання сокета: адреса клієнта — властивість з'єднання
        agent: false,
      },
      (res) => {
        replied = true
        const parts: Buffer[] = []
        res.on("data", (c: Buffer) => parts.push(c))
        res.on("end", () => {
          // Сервер міг відмовити, не дочитавши тіло: далі нічого не шлемо
          req.destroy()
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            setCookie: res.headers["set-cookie"] ?? [],
            text: Buffer.concat(parts).toString("utf8"),
          })
        })
        res.on("error", () => undefined)
      }
    )
    // Скидання з'єднання після відповіді — наслідок відмови без дочитування тіла
    req.on("error", (error) => {
      if (!replied) reject(error)
    })
    if (request.chunkedBytes !== undefined) {
      let left = request.chunkedBytes
      const pump = (): void => {
        while (left > 0) {
          const part = left >= CHUNK.length ? CHUNK : CHUNK.subarray(0, left)
          left -= part.length
          if (!req.write(part)) {
            req.once("drain", pump)
            return
          }
        }
        req.end()
      }
      pump()
    } else {
      req.end(request.body)
    }
  })
}

/** `name=value` пари з `Set-Cookie` для заголовка `Cookie`. */
export function cookieHeader(setCookie: string[]): string {
  return setCookie.map((c) => c.split(";")[0]).join("; ")
}
