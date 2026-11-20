import {
  createServerEntry,
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server"
import { LIMIT_REASONS, PAYLOAD_MAX_BYTES } from "simetra/model"
import { appOrigin, authSecret, signalsConfig } from "./server/config"
import { BodyTooLarge, bodyExceeded, limitBody } from "./server/body-limit"
import { serverHash } from "./server/runtime"
// Server Function потрапляє в маніфест збірки лише через граф модулів. Явний
// імпорт тримає `dataFn` у production-збірці незалежно від того, хто з клієнтського
// коду його кличе, тож перевірки правила походження на HTTP-шляху завжди
// мають що перевіряти
import "./server/data-fn"

// Відмова старту (§4.1): хибне оточення має зупинити сервер при імпорті entry,
// а не першим запитом
appOrigin()
authSecret()
// Лише синхронна перевірка форми; порт (невідповідні `x`/`d`) перевіряє плагін
// старту (асинхронно, зупиняючи процес)
signalsConfig()

// Заголовок, який читає Better Auth (`ipAddressHeaders` у `auth.ts`)
const CLIENT_IP_HEADER = "x-simetra-client-ip"

type Fetch<Rest extends unknown[]> = (
  request: Request,
  ...rest: Rest
) => Response | Promise<Response>

function refusal(): Response {
  return Response.json(
    {
      ok: false,
      error: { code: "command.invalid", reason: LIMIT_REASONS.payloadTooLarge },
      serverHash,
    },
    { status: 413, headers: { "cache-control": "no-store" } }
  )
}

/** Адреса сокета: `request.ip` (srvx) або сокет Node. */
function socketAddress(request: Request): string | undefined {
  const raw = request as Request & {
    ip?: string
    runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } }
  }
  return raw.ip ?? raw.runtime?.node?.req?.socket?.remoteAddress
}

/**
 * Адреса клієнта за `SIMETRA_CLIENT_IP_SOURCE` (§4.3): `socket` (за
 * замовчуванням) чи ім'я заголовка довіреного проксі.
 */
function clientAddress(request: Request): string | undefined {
  const source = (process.env.SIMETRA_CLIENT_IP_SOURCE ?? "").trim()
  if (source === "" || source.toLowerCase() === "socket") {
    return socketAddress(request)
  }
  return request.headers.get(source)?.trim() || undefined
}

/** Копія запиту зі своїм `x-simetra-client-ip`; клієнтське значення стирається завжди. */
function withClientAddress(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.delete(CLIENT_IP_HEADER)
  const address = clientAddress(request)
  if (address !== undefined) headers.set(CLIENT_IP_HEADER, address)
  const hasBody =
    request.body !== null &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  return new Request(request.url, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    duplex: "half",
    signal: request.signal,
  } as RequestInit & { duplex: "half" })
}

function isAsset(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/assets/")
}

/** Кеш і безпекові заголовки неасетних відповідей (§4.4); `sign-out` чистить кеш клієнта. */
function decorate(request: Request, response: Response): Response {
  if (isAsset(request)) return response
  const headers = new Headers(response.headers)
  const html = (headers.get("content-type") ?? "").includes("text/html")
  headers.set("cache-control", html ? "private, no-store" : "no-store")
  if (html) headers.append("vary", "Cookie")
  headers.set("x-content-type-options", "nosniff")
  headers.set("referrer-policy", "same-origin")
  headers.set("content-security-policy", "frame-ancestors 'none'")
  const { pathname } = new URL(request.url)
  if (
    pathname === "/api/auth/sign-out" &&
    response.status >= 200 &&
    response.status < 300
  ) {
    headers.set("clear-site-data", '"cache"')
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Обгортка обробника Start: адреса клієнта, межа тіла, заголовки. Винесено для тесту. */
export function createEntryFetch<Rest extends unknown[]>(inner: Fetch<Rest>) {
  return async (request: Request, ...rest: Rest): Promise<Response> => {
    let limited: Request
    try {
      limited = limitBody(withClientAddress(request), PAYLOAD_MAX_BYTES)
    } catch (error) {
      if (error instanceof BodyTooLarge) return decorate(request, refusal())
      throw error
    }
    let response: Response
    try {
      response = await inner(limited, ...rest)
    } catch (error) {
      if (error instanceof BodyTooLarge || bodyExceeded(limited)) {
        return decorate(request, refusal())
      }
      throw error
    }
    if (bodyExceeded(limited)) return decorate(request, refusal())
    return decorate(request, response)
  }
}

export default createServerEntry({
  fetch: createEntryFetch(createStartHandler(defaultStreamHandler)),
})
