import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server"
import {
  agentTokenInfoSchema,
  type AgentCallEvent,
  type AgentTokenInfo,
  type OnAgentCall,
  type RuntimeCatalog,
  type SessionClaims,
  type VerifyAgentToken,
} from "simetra/model"
import {
  agentError,
  agentResultToMcp,
  type AgentTool,
  type AgentToolCatalog,
  type AgentToolResult,
} from "simetra/server"

/** Options of {@link createMcpEntry}. */
export interface McpEntryOptions {
  /** The agent tool catalog the entry serves. */
  catalog: AgentToolCatalog
  /** The runtime catalog of the application: its scope kinds decide whether a pin is required. */
  runtimeCatalog: RuntimeCatalog
  /** The canonical MCP resource URL (RFC 8707), e.g. `https://app.example/mcp`. */
  resource: string
  /** The issuer URL of the host's authorization server, published in the PRM. */
  authorizationServer: string
  /** The host's agent-token port. */
  verifyAgentToken: VerifyAgentToken
  /** The host's sink for agent call events. */
  onAgentCall: OnAgentCall
  /** The origin of the application; a request with another `Origin` is refused. */
  appOrigin: string
  /** The HMAC-SHA-256 key of the input hash in call events, at least 32 bytes. */
  inputHashKey: Uint8Array
}

/** The MCP entry: a Fetch handler of the MCP route and its PRM. */
export interface McpEntry {
  fetch(request: Request): Promise<Response>
  /** The paths the host routes to `fetch`. */
  readonly paths: {
    readonly mcp: string
    readonly protectedResourceMetadata: string
  }
}

// Ключ `authInfo.extra`: SDK передає `authInfo` фабриці як є, тож claims
// перевіреного запиту доходять до інструментів лише з цього запиту.
const IDENTITY = "simetra.agent"

interface AgentIdentity {
  claims: SessionClaims
  token: AgentTokenInfo
}

const MIN_KEY_BYTES = 32

/**
 * Creates the MCP entry over an agent tool catalog. Every request to the MCP
 * path is refused with 401 unless the host's token port verifies it for this
 * resource, for a signed-in user, with a pin when the application has scope
 * kinds. Throws on the `supabase` database profile.
 */
export function createMcpEntry(options: McpEntryOptions): McpEntry {
  const { provider } = options.runtimeCatalog
  // Вхід агентів спирається на сервер авторизації профілю `postgres`; на
  // іншому профілі (зокрема замороженому `supabase`, ADR-0117) відмова на
  // створенні, а не мовчазне 401 на кожному запиті.
  if (provider !== "postgres")
    throw new Error(
      `The MCP entry is not available on the "${provider}" database profile; agent sign-in needs the postgres profile`
    )
  if (options.inputHashKey.byteLength < MIN_KEY_BYTES)
    throw new Error(
      `The MCP entry needs an inputHashKey of at least ${MIN_KEY_BYTES} bytes`
    )

  const { resource } = options
  const resourceUrl = new URL(resource)
  const mcpPath = resourceUrl.pathname
  const prmPath = `/.well-known/oauth-protected-resource${mcpPath === "/" ? "" : mcpPath}`
  // Адреса PRM — від канонічного ресурсу, а не від `Host` запиту: інакше
  // підставлений заголовок вів би клієнта на чужий документ.
  const prmUrl = `${resourceUrl.origin}${prmPath}`
  const appOrigin = new URL(options.appOrigin).origin
  const requiresPin = hasScopeKinds(options.runtimeCatalog)
  const hashKey = crypto.subtle.importKey(
    "raw",
    options.inputHashKey as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  // Помилка ключа не має стати необробленою відмовою до першого виклику.
  hashKey.catch(() => {})

  const prm = JSON.stringify({
    resource,
    authorization_servers: [options.authorizationServer],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  })

  const unauthorized = () =>
    new Response(null, {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${prmUrl}", scope="mcp"`,
      },
    })

  const handler = createMcpHandler(
    (ctx) => {
      const identity = ctx.authInfo?.extra?.[IDENTITY] as
        AgentIdentity | undefined
      // Екземпляр без перевіреної особи не створюється: шлях повз ворота
      // токена — дефект, а не анонімний виклик.
      if (identity === undefined)
        throw new Error("MCP request without a verified agent identity")
      return buildServer(options, identity, hashKey)
    },
    { legacy: "stateless", responseMode: "json" }
  )

  async function verify(request: Request): Promise<AgentIdentity | null> {
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.get("authorization") ?? ""
    )
    if (match === null) return null
    // Збій порту — відмова, а не 500: без перевіреної особи доступу немає.
    let output: unknown
    try {
      output = await options.verifyAgentToken(match[1]!, resource)
    } catch {
      return null
    }
    const parsed = agentTokenInfoSchema.safeParse(output)
    if (!parsed.success) return null
    const token = parsed.data
    if (!token.aud.includes(resource)) return null
    if (token.isAnonymous) return null
    if (requiresPin && token.pin === undefined) return null
    // `pin` — лише з порту: claims збираються поле за полем, і чуже поле
    // виходу порту в сесію не потрапляє.
    const claims: SessionClaims = {
      sub: token.sub,
      act: { sub: token.clientId },
      is_anonymous: false,
      ...(token.pin === undefined ? {} : { pin: token.pin }),
    }
    return { claims, token }
  }

  return {
    paths: { mcp: mcpPath, protectedResourceMetadata: prmPath },
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === prmPath) {
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response(null, { status: 405, headers: { Allow: "GET" } })
        return new Response(prm, {
          headers: { "Content-Type": "application/json" },
        })
      }
      if (pathname !== mcpPath) return new Response(null, { status: 404 })
      // Захист від DNS rebinding: браузерний запит чужого сайту не доходить
      // навіть до порту токена. Без `Origin` — серверний клієнт, він проходить.
      const origin = request.headers.get("origin")
      if (origin !== null && origin !== appOrigin)
        return new Response("Forbidden origin", { status: 403 })
      const identity = await verify(request)
      if (identity === null) return unauthorized()
      const authInfo: AuthInfo = {
        token: "",
        clientId: identity.token.clientId,
        scopes: [],
        resource: resourceUrl,
        extra: { [IDENTITY]: identity },
      }
      return handler.fetch(request, { authInfo })
    },
  }
}

// Правило закрите (Р-F4-4): будь-який скоуплений об'єкт або корінь виду
// скоупу означає, що застосунок має види скоупу й токен без закріплення
// не проходить. Одне правило для адаптера й порту токена host-а.
/**
 * Whether the application declares scope kinds: any scoped object or any
 * scope kind root in the compiled catalog. Such an application requires a
 * token pinned to a tenant; the MCP entry applies it, and a host's
 * `VerifyAgentToken` port uses the same rule.
 */
export function hasScopeKinds(catalog: RuntimeCatalog): boolean {
  return catalog.objects.some(
    (o) => o.scopeKindId !== undefined || o.rights?.root !== undefined
  )
}

function buildServer(
  options: McpEntryOptions,
  identity: AgentIdentity,
  hashKey: Promise<CryptoKey>
): McpServer {
  const server = new McpServer({
    name: "simetra",
    version: options.runtimeCatalog.snapshotHash,
  })
  for (const tool of options.catalog.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: passThrough(tool),
        annotations: tool.annotations,
      },
      async (input: unknown) => {
        const started = Date.now()
        const result = await callCatalog(options.catalog, identity, tool, input)
        void emit(options.onAgentCall, {
          time: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          tool: tool.name,
          inputHash: await inputHash(hashKey, input),
          ...outcome(result),
          sub: identity.claims.sub,
          actor: identity.token.clientId,
          ...(identity.token.pin === undefined
            ? {}
            : { pin: identity.token.pin }),
        })
        // Тип `AgentMcpResult` уже має форму `CallToolResult`; копія потрібна
        // лише для індексної сигнатури типу SDK.
        return { ...agentResultToMcp(result) }
      }
    )
  }
  return server
}

// JSON Schema входу — з zod-схеми каталогу, а перевірку робить сам каталог:
// відмова SDK пройшла б повз `agentResultToMcp` і подію виклику.
function passThrough(tool: AgentTool): StandardSchemaWithJSON {
  const standard = tool.input["~standard"] as unknown as {
    jsonSchema: StandardSchemaWithJSON["~standard"]["jsonSchema"]
  }
  return {
    "~standard": {
      version: 1,
      vendor: "simetra",
      validate: (value: unknown) => ({ value }),
      jsonSchema: standard.jsonSchema,
    },
  }
}

async function callCatalog(
  catalog: AgentToolCatalog,
  identity: AgentIdentity,
  tool: AgentTool,
  input: unknown
): Promise<AgentToolResult> {
  try {
    return await catalog.call(identity.claims, tool.name, input)
  } catch {
    // Текст винятку агентові не йде: він може нести значення даних чи SQL.
    return agentError(
      "command.internal",
      "The tool call failed with an internal error"
    )
  }
}

function outcome(
  result: AgentToolResult
): Pick<AgentCallEvent, "status" | "errorCode" | "rows"> {
  if ("code" in result) return { status: "error", errorCode: result.code }
  const rows = (result.data as { rows?: unknown } | undefined)?.rows
  return Array.isArray(rows)
    ? { status: "ok", rows: rows.length }
    : { status: "ok" }
}

// Збій приймача події не ламає виклику: ні синхронний виняток, ні відмова
// проміса не доходять до відповіді й не лишаються необробленими.
async function emit(sink: OnAgentCall, event: AgentCallEvent): Promise<void> {
  try {
    await sink(event)
  } catch {
    // подія — спостереження, а не частина виклику
  }
}

// Ключований хеш, а не простий SHA-256: вхід із малою множиною значень
// (id, email у фільтрі) простий хеш віддав би перебором із журналу.
async function inputHash(
  key: Promise<CryptoKey>,
  input: unknown
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key,
    new TextEncoder().encode(canonicalJson(input))
  )
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// Ключі об'єкта відсортовано: однаковий вхід дає однаковий хеш.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`
      )
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
