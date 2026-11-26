// Монтування сервера авторизації агентів у Fetch-entry (спека П4-F §5.4,
// Р-F4-5). Модуль легкий: `oidc-provider` і `srvx/node` вантажаться
// справжнім `import()` на першому запиті свого шляху (знахідка 7 F0).
import { appOrigin } from "../config"
import { AGENT_MCP_PATH, isAgentOauthPath } from "./paths"

type Fetch<Rest extends unknown[]> = (
  request: Request,
  ...rest: Rest
) => Response | Promise<Response>

type Handler = (request: Request) => Response | Promise<Response>

// Заголовок адреси клієнта, який entry ставить сам (`src/server.ts`)
const CLIENT_IP_HEADER = "x-simetra-client-ip"

// Типи гранту, чий ресурс перевіряється до бібліотеки (Р-F4-7 і рішення
// архітекторки): бібліотека вживає код (`consumeGrantSource`) і токен
// оновлення (`refreshToken.consume()`) раніше, ніж розв'язує ресурс, тож її
// відмова `invalid_target` спалила б їх, а повтор клієнта відкликав би грант
const PRECHECKED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"])

async function loadHandler(): Promise<Handler> {
  const [{ toFetchHandler }, { agentOauthProvider }] = await Promise.all([
    import("srvx/node"),
    import("./provider"),
  ])
  return toFetchHandler(agentOauthProvider().callback())
}

function invalidTarget(): Response {
  return Response.json(
    {
      error: "invalid_target",
      error_description: `resource must be ${AGENT_MCP_PATH} of this application, at most once`,
    },
    { status: 400, headers: { "cache-control": "no-store" } }
  )
}

/**
 * Перевірка `resource` на `/token` над клоном тіла (уже за межею тіла entry:
 * перевищення дає 413 entry, а не помилку OAuth). Кілька `resource` чи чужий —
 * відмова без виклику бібліотеки; без `resource` — рішення бібліотеки
 * (`useGrantedResource`).
 */
async function tokenResourceRefusal(
  request: Request,
  resource: string
): Promise<Response | undefined> {
  if (request.method !== "POST") return undefined
  const type = request.headers.get("content-type") ?? ""
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded"))
    return undefined
  const form = new URLSearchParams(await request.clone().text())
  if (!PRECHECKED_GRANT_TYPES.has(form.get("grant_type") ?? ""))
    return undefined
  const requested = form.getAll("resource")
  if (requested.length > 1) return invalidTarget()
  if (requested.length === 1 && requested[0] !== resource)
    return invalidTarget()
  return undefined
}

/**
 * Запит, закріплений за `appOrigin()` (рішення архітекторки): адреси кінцевих
 * точок бібліотека будує з `Host` і `X-Forwarded-*` запиту, тож клієнтські
 * стираються, а свої ставляться від канонічного походження. Адреса клієнта —
 * лише та, що визначив entry.
 */
export function pinnedToOrigin(request: Request, origin: string): Request {
  const canonical = new URL(origin)
  const url = new URL(request.url)
  const headers = new Headers()
  for (const [name, value] of request.headers) {
    if (name.startsWith("x-forwarded-") || name === "forwarded") continue
    headers.append(name, value)
  }
  headers.set("host", canonical.host)
  headers.set("x-forwarded-proto", canonical.protocol.slice(0, -1))
  const client = request.headers.get(CLIENT_IP_HEADER)
  if (client !== null) headers.set("x-forwarded-for", client)
  const hasBody =
    request.body !== null &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  return new Request(`${canonical.origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    duplex: "half",
    signal: request.signal,
  } as RequestInit & { duplex: "half" })
}

/**
 * Шляхи сервера авторизації йдуть у `oidc-provider`, решта — у `inner` (Start).
 * `load` підставляє тест (інший пул, адаптер, транспорт CIMD).
 */
export function withAgentOauth<Rest extends unknown[]>(
  inner: Fetch<Rest>,
  load: () => Promise<Handler> = loadHandler
): (request: Request, ...rest: Rest) => Promise<Response> {
  let handler: Promise<Handler> | undefined
  return async (request, ...rest) => {
    const { pathname } = new URL(request.url)
    if (!isAgentOauthPath(pathname)) return inner(request, ...rest)
    const origin = appOrigin()
    if (pathname === "/token") {
      const refusal = await tokenResourceRefusal(
        request,
        `${origin}${AGENT_MCP_PATH}`
      )
      if (refusal !== undefined) return refusal
    }
    // Невдале завантаження не кешується: наступний запит пробує знову
    handler ??= load().catch((error: unknown) => {
      handler = undefined
      throw error
    })
    return (await handler)(pinnedToOrigin(request, origin))
  }
}
