// Вхід MCP у Fetch-entry (спека П4-F §5.4, Р-F4-5): `/mcp` і PRM поряд із
// сервером авторизації, а не маршрутом Start. Модуль легкий: адаптер MCP,
// каталог інструментів, порт токена й `oidc-provider` вантажаться справжнім
// `import()` на першому запиті свого шляху (знахідка 7 F0).
import type { RuntimeCatalog } from "simetra/model"
import { isAgentEntryPath } from "./agent-oauth/paths"

type Fetch<Rest extends unknown[]> = (
  request: Request,
  ...rest: Rest
) => Response | Promise<Response>

type Handler = (request: Request) => Promise<Response>

async function loadEntry(): Promise<Handler> {
  const [
    { createMcpEntry },
    { createAgentToolCatalog },
    { getRuntime },
    { getAuthPool },
    { agentOauthKeys, appOrigin },
    { agentOauthProvider },
    { agentInputHashKey },
    { createVerifyAgentToken },
    { AGENT_MCP_PATH },
    { createAgentCallLog },
  ] = await Promise.all([
    import("simetra/shell/mcp"),
    import("simetra/server"),
    import("./runtime"),
    import("./auth-db"),
    import("./config"),
    import("./agent-oauth/provider"),
    import("./agent-oauth/keys"),
    import("./agent-oauth/verify-token"),
    import("./agent-oauth/paths"),
    import("../agent-call-log"),
  ])
  // Той самий рантайм процесу, що й у Server Function даних: агент не має
  // свого шляху до бази
  const runtime = await getRuntime()
  const origin = appOrigin()
  const entry = createMcpEntry({
    catalog: createAgentToolCatalog({ runtime }),
    runtimeCatalog: runtime.catalog,
    resource: `${origin}${AGENT_MCP_PATH}`,
    // Issuer сервера авторизації — походження застосунку (`provider.ts`)
    authorizationServer: origin,
    verifyAgentToken: createVerifyAgentToken({
      provider: agentOauthProvider(),
      pool: getAuthPool(),
      requiresTenant: hasScopeKinds(runtime.catalog),
    }),
    onAgentCall: createAgentCallLog(),
    appOrigin: origin,
    inputHashKey: agentInputHashKey(agentOauthKeys()),
  })
  return (request) => entry.fetch(request)
}

// Правило Р-F4-4, те саме, що в адаптера (`createMcpEntry`): будь-який
// скоуплений об'єкт або корінь виду скоупу — закріплення обов'язкове
function hasScopeKinds(catalog: RuntimeCatalog): boolean {
  return catalog.objects.some(
    (o) => o.scopeKindId !== undefined || o.rights?.root !== undefined
  )
}

/**
 * Шляхи входу MCP ідуть в адаптер, решта — у `inner`. `load` підставляє
 * тест (сховище стенду, каталог без застосованої бази).
 */
export function withAgentEntry<Rest extends unknown[]>(
  inner: Fetch<Rest>,
  load: () => Promise<Handler> = loadEntry
): (request: Request, ...rest: Rest) => Promise<Response> {
  let handler: Promise<Handler> | undefined
  return async (request, ...rest) => {
    const { pathname } = new URL(request.url)
    if (!isAgentEntryPath(pathname)) return inner(request, ...rest)
    // Невдале завантаження (зокрема старт рантайму) не кешується: наступний
    // запит пробує знову
    handler ??= load().catch((error: unknown) => {
      handler = undefined
      throw error
    })
    return (await handler)(request)
  }
}
