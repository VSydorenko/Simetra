import { createHash, createHmac } from "node:crypto"
import { isLegacyRequest } from "@modelcontextprotocol/server"
import { buildRuntimeCatalog } from "simetra/compiler"
import type {
  AgentCallEvent,
  AgentTokenInfo,
  RuntimeCatalog,
  SessionClaims,
} from "simetra/model"
import {
  createAgentToolCatalog,
  type AgentToolCatalog,
  type AgentToolResult,
  type CommandRuntime,
} from "simetra/server"
import { beforeAll, describe, expect, it, vi } from "vitest"
import {
  commandCoreLayer,
  compileRights,
  policyDomain,
  PROJECT_FILE,
  singleTenantRights,
  writeRoles,
} from "../../../compiler/__tests__/fixtures/rights"
import { createMcpEntry, hasScopeKinds, type McpEntryOptions } from ".."

const APP = "https://app.example"
const RESOURCE = `${APP}/mcp`
const PRM_URL = `${APP}/.well-known/oauth-protected-resource/mcp`
const CHALLENGE = `Bearer resource_metadata="${PRM_URL}", scope="mcp"`
const KEY = new Uint8Array(32).fill(7)
const PIN = "00000000-0000-4000-8000-000000000042"
const SENTINEL = "sentinel-value-7f3a"

type Era = "legacy" | "modern"
const ERAS: Era[] = ["legacy", "modern"]

let unscoped: RuntimeCatalog
let scoped: RuntimeCatalog
beforeAll(async () => {
  const single = await compileRights(singleTenantRights({}, "postgres"))
  expect(single.diagnostics).toEqual([])
  unscoped = buildRuntimeCatalog(single.model!)
  const files = policyDomain(writeRoles(), commandCoreLayer())
  files.set(
    PROJECT_FILE,
    JSON.stringify({
      ...JSON.parse(files.get(PROJECT_FILE)!),
      database: { provider: "postgres" },
    })
  )
  const multi = await compileRights(files)
  expect(multi.diagnostics).toEqual([])
  scoped = buildRuntimeCatalog(multi.model!)
}, 60_000)

const good = (over: Partial<AgentTokenInfo> = {}): AgentTokenInfo => ({
  sub: "user-1",
  isAnonymous: false,
  clientId: "https://client.example/cimd.json",
  aud: [RESOURCE],
  ...over,
})

interface Harness {
  entry: ReturnType<typeof createMcpEntry>
  port: ReturnType<typeof vi.fn>
  calls: { claims: SessionClaims; name: string; input: unknown }[]
  events: AgentCallEvent[]
}

/** The entry over the real catalog of F3 with a fake runtime. */
function harness(
  options: {
    token?: unknown
    portThrows?: true
    runtimeCatalog?: RuntimeCatalog
    call?: AgentToolCatalog["call"]
    onAgentCall?: McpEntryOptions["onAgentCall"]
  } = {}
): Harness {
  const runtimeCatalog = options.runtimeCatalog ?? unscoped
  const runtime = {
    catalog: runtimeCatalog,
    read: async () => ({ rows: [{ ref: "a" }, { ref: "b" }] }),
    run: async () => ({ rows: [], changes: [], epoch: "e" }),
  } as unknown as CommandRuntime
  const real = createAgentToolCatalog({ runtime })
  const calls: Harness["calls"] = []
  const events: AgentCallEvent[] = []
  const port = vi.fn(async () => {
    if (options.portThrows) throw new Error("token store down")
    return "token" in options ? options.token : good()
  })
  const catalog: AgentToolCatalog = {
    ...real,
    call: async (claims, name, input) => {
      calls.push({ claims, name, input })
      return (options.call ?? real.call)(claims, name, input)
    },
  }
  const entry = createMcpEntry({
    catalog,
    runtimeCatalog,
    resource: RESOURCE,
    authorizationServer: APP,
    verifyAgentToken: port as McpEntryOptions["verifyAgentToken"],
    onAgentCall:
      options.onAgentCall ??
      ((event) => {
        events.push(event)
      }),
    appOrigin: APP,
    inputHashKey: KEY,
  })
  return { entry, port, calls, events }
}

// Сирий JSON-RPC запит кожної ери: модерна несе конверт `_meta`, легасі — ні.
function rpc(
  era: Era,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = { authorization: "Bearer t-1" }
): Request {
  const modern = era === "modern"
  return new Request(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      // Модерна ера дублює метод і ім'я інструмента в заголовках.
      ...(modern
        ? {
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            ...(typeof params.name === "string"
              ? { "mcp-name": params.name }
              : {}),
          }
        : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: modern
        ? {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "test",
                version: "1",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          }
        : params,
    }),
  })
}

const call = (
  era: Era,
  name: string,
  args: unknown,
  headers?: Record<string, string>
) => rpc(era, "tools/call", { name, arguments: args }, headers)

// Легасі-нога відповідає SSE навіть із `responseMode: "json"` (він лише для
// модерної), тож розбір приймає обидві форми.
async function body(response: Response): Promise<{
  result?: Record<string, unknown>
  error?: unknown
}> {
  const text = await response.text()
  if (!(response.headers.get("content-type") ?? "").includes("event-stream"))
    return JSON.parse(text)
  const data = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
  return JSON.parse(data.at(-1)!)
}

const describeInput = { object: { kind: "Catalog", name: "Project" } }

describe("the raw requests carry their era", () => {
  it.each(ERAS)("%s", async (era) => {
    expect(await isLegacyRequest(call(era, "describe", {}))).toBe(
      era === "legacy"
    )
  })
})

describe("default deny: 401 without a catalog call", () => {
  // Опції — функцією: скоуплений каталог з'являється лише в `beforeAll`.
  const cases: [
    string,
    () => Parameters<typeof harness>[0],
    Record<string, string>?,
  ][] = [
    ["no Authorization header", () => ({}), {}],
    ["not a bearer", () => ({}), { authorization: "Basic abc" }],
    ["the port gives null", () => ({ token: null })],
    ["the port throws", () => ({ portThrows: true })],
    [
      "the port gives another resource",
      () => ({ token: good({ aud: [`${APP}/other`] }) }),
    ],
    ["the port gives no audience", () => ({ token: good({ aud: [] }) })],
    ["an anonymous user", () => ({ token: good({ isAnonymous: true }) })],
    [
      "a malformed port output",
      () => ({ token: { sub: "user-1", clientId: "c" } }),
    ],
    ["a pin that is not a UUID", () => ({ token: good({ pin: "tenant-1" }) })],
    [
      "no pin while the application has scope kinds",
      () => ({ token: good(), runtimeCatalog: scoped }),
    ],
  ]

  for (const era of ERAS)
    it.each(cases)(`${era}: %s`, async (_, options, headers) => {
      const h = harness(options())
      const response = await h.entry.fetch(call(era, "describe", {}, headers))
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe(CHALLENGE)
      expect(h.calls).toEqual([])
      expect(h.events).toEqual([])
    })

  // Ворота токена — перед класифікацією запиту SDK, тож відмова однакова для
  // кожного методу, зокрема службових.
  for (const era of ERAS)
    it.each([
      ["tools/list", {}],
      [
        "initialize",
        {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      ],
      ["server/discover", {}],
    ])(`${era}: %s is refused too`, async (method, params) => {
      const h = harness({ token: null })
      const response = await h.entry.fetch(rpc(era, method, params))
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe(CHALLENGE)
      expect(h.port).toHaveBeenCalledTimes(1)
      expect(h.calls).toEqual([])
      expect(h.events).toEqual([])
    })

  it("the port gets the bearer token and the canonical resource", async () => {
    const h = harness({ token: null })
    await h.entry.fetch(call("modern", "describe", {}))
    expect(h.port).toHaveBeenCalledWith("t-1", RESOURCE)
  })

  it("GET and DELETE are refused before the transport", async () => {
    const h = harness({ token: null })
    for (const method of ["GET", "DELETE"]) {
      const response = await h.entry.fetch(new Request(RESOURCE, { method }))
      expect(response.status, method).toBe(401)
    }
  })
})

describe("a foreign Origin", () => {
  it.each(["https://evil.example", "null", "https://app.example:8443"])(
    "%s gets 403 without a port call",
    async (origin) => {
      const h = harness()
      const response = await h.entry.fetch(
        call(
          "modern",
          "describe",
          {},
          {
            authorization: "Bearer t-1",
            origin,
          }
        )
      )
      expect(response.status).toBe(403)
      expect(h.port).not.toHaveBeenCalled()
    }
  )

  it("the application's own origin passes", async () => {
    const h = harness()
    const response = await h.entry.fetch(
      call("modern", "describe", describeInput, {
        authorization: "Bearer t-1",
        origin: APP,
      })
    )
    expect(response.status).toBe(200)
  })
})

describe("a verified call", () => {
  it.each(ERAS)("%s: claims of the agent reach the catalog", async (era) => {
    const h = harness({
      runtimeCatalog: scoped,
      token: { ...good({ pin: PIN }), extra: "dropped", is_anonymous: true },
    })
    const response = await h.entry.fetch(call(era, "describe", {}))
    expect(response.status).toBe(200)
    expect(h.calls).toEqual([
      {
        claims: {
          sub: "user-1",
          act: { sub: "https://client.example/cimd.json" },
          is_anonymous: false,
          pin: PIN,
        },
        name: "describe",
        input: {},
      },
    ])
  })

  it.each(ERAS)("%s: without a pin the claims carry none", async (era) => {
    const h = harness()
    await h.entry.fetch(call(era, "describe", {}))
    expect(h.calls[0]!.claims).toEqual({
      sub: "user-1",
      act: { sub: "https://client.example/cimd.json" },
      is_anonymous: false,
    })
  })

  it.each(ERAS)("%s: a success is the catalog result for MCP", async (era) => {
    const h = harness()
    const { result } = await body(
      await h.entry.fetch(
        call(era, "read", {
          query: { object: { kind: "Catalog", name: "Project" }, limit: 2 },
        })
      )
    )
    expect(result!.isError).toBeUndefined()
    const structured = result!.structuredContent as AgentToolResult
    expect(structured).toMatchObject({
      state: "done",
      data: { rows: [{ ref: "a" }, { ref: "b" }] },
    })
    expect(result!.content).toEqual([
      { type: "text", text: JSON.stringify(structured) },
    ])
  })

  it.each(ERAS)(
    "%s: invalid input is the catalog's coded error, not the SDK's",
    async (era) => {
      const h = harness()
      const { result } = await body(
        await h.entry.fetch(call(era, "describe", { bogus: 1 }))
      )
      expect(result!.isError).toBe(true)
      expect(result!.structuredContent).toBeUndefined()
      const content = result!.content as { text: string }[]
      expect(JSON.parse(content[0]!.text)).toMatchObject({
        code: "catalog.invalid-input",
      })
      expect(h.events.map((e) => e.errorCode)).toEqual([
        "catalog.invalid-input",
      ])
    }
  )

  it.each(ERAS)(
    "%s: a throwing catalog gives a coded error without its text",
    async (era) => {
      const h = harness({
        call: async () => {
          throw new Error(`boom ${SENTINEL}`)
        },
      })
      const response = await h.entry.fetch(call(era, "describe", {}))
      expect(response.status).toBe(200)
      const { result } = await body(response)
      expect(result!.isError).toBe(true)
      const text = (result!.content as { text: string }[])[0]!.text
      expect(JSON.parse(text)).toMatchObject({ code: "command.internal" })
      expect(text).not.toContain(SENTINEL)
      expect(h.events).toMatchObject([
        { status: "error", errorCode: "command.internal" },
      ])
    }
  )
})

describe("outside the catalog", () => {
  it("GET and DELETE with a valid token are 405: no sessions", async () => {
    const h = harness()
    for (const method of ["GET", "DELETE"]) {
      const response = await h.entry.fetch(
        new Request(RESOURCE, {
          method,
          headers: { authorization: "Bearer t-1" },
        })
      )
      expect(response.status, method).toBe(405)
    }
  })

  // Невідоме ім'я SDK відхиляє до колбека інструмента: каталогу немає що
  // кликати, тож і події немає (відомий виняток з «події на кожен виклик»).
  it.each(ERAS)("%s: an unknown tool is a protocol error", async (era) => {
    const h = harness()
    const reply = await body(await h.entry.fetch(call(era, "drop_all", {})))
    expect(reply.error).toMatchObject({ code: -32602 })
    expect(h.calls).toEqual([])
  })
})

describe("tools/list", () => {
  it.each(ERAS)(
    "%s: lists the catalog tools with their annotations",
    async (era) => {
      const h = harness()
      const { result } = await body(await h.entry.fetch(rpc(era, "tools/list")))
      const listed = result!.tools as {
        name: string
        title: string
        description: string
        annotations: unknown
        inputSchema: { type: string }
        outputSchema?: unknown
      }[]
      const real = createAgentToolCatalog({
        runtime: { catalog: unscoped } as unknown as CommandRuntime,
      }).tools
      expect(
        listed.map((t) => [t.name, t.title, t.description, t.annotations])
      ).toEqual(
        real.map((t) => [t.name, t.title, t.description, t.annotations])
      )
      for (const t of listed) {
        expect(t.inputSchema.type).toBe("object")
        expect(t.outputSchema).toBeUndefined()
      }
      expect(h.events).toEqual([])
    }
  )
})

describe("the call event", () => {
  it.each(ERAS)("%s: one event per call, without values", async (era) => {
    const h = harness({ runtimeCatalog: scoped, token: good({ pin: PIN }) })
    const input = {
      query: {
        object: { kind: "Catalog", name: "Project" },
        limit: 2,
        where: { attribute: "code", op: "eq", value: SENTINEL },
      },
    }
    await h.entry.fetch(call(era, "read", input))
    await vi.waitFor(() => expect(h.events).toHaveLength(1))
    const [event] = h.events
    expect(Object.keys(event!).sort()).toEqual([
      "actor",
      "durationMs",
      "inputHash",
      "pin",
      "rows",
      "status",
      "sub",
      "time",
      "tool",
    ])
    expect(event).toMatchObject({
      tool: "read",
      sub: "user-1",
      actor: "https://client.example/cimd.json",
      pin: PIN,
    })
    expect(new Date(event!.time).toISOString()).toBe(event!.time)
    expect(event!.durationMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(event)).not.toContain(SENTINEL)
  })

  it("rows counts a page and status ok", async () => {
    const h = harness()
    await h.entry.fetch(
      call("modern", "read", {
        query: { object: { kind: "Catalog", name: "Project" }, limit: 2 },
      })
    )
    await vi.waitFor(() => expect(h.events).toHaveLength(1))
    expect(h.events[0]).toMatchObject({ status: "ok", rows: 2 })
    expect(h.events[0]!.errorCode).toBeUndefined()
  })

  it("the input hash is keyed, not a plain SHA-256", async () => {
    const h = harness()
    const input = { object: { name: "Project", kind: "Catalog" } }
    await h.entry.fetch(call("modern", "describe", input))
    await vi.waitFor(() => expect(h.events).toHaveLength(1))
    const canonical = '{"object":{"kind":"Catalog","name":"Project"}}'
    const { inputHash } = h.events[0]!
    expect(inputHash).not.toBe(
      createHash("sha256").update(canonical).digest("hex")
    )
    expect(inputHash).toBe(
      createHmac("sha256", KEY).update(canonical).digest("hex")
    )
  })

  it("no event for 401, initialize and tools/list", async () => {
    const denied = harness({ token: null })
    await denied.entry.fetch(call("modern", "describe", {}))
    const h = harness()
    await h.entry.fetch(
      rpc("legacy", "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      })
    )
    await h.entry.fetch(rpc("modern", "tools/list"))
    await new Promise((r) => setTimeout(r, 10))
    expect([...denied.events, ...h.events]).toEqual([])
  })

  it.each([
    [
      "throws",
      () => {
        throw new Error("sink down")
      },
    ],
    ["rejects", () => Promise.reject(new Error("sink down"))],
  ])("a sink that %s does not break the call", async (_, sink) => {
    const h = harness({ onAgentCall: sink })
    const response = await h.entry.fetch(
      call("modern", "describe", describeInput)
    )
    expect(response.status).toBe(200)
    const { result } = await body(response)
    expect(result!.isError).toBeUndefined()
  })
})

describe("PRM", () => {
  it("publishes the resource and the authorization server", async () => {
    const h = harness()
    expect(h.entry.paths).toEqual({
      mcp: "/mcp",
      protectedResourceMetadata: "/.well-known/oauth-protected-resource/mcp",
    })
    const response = await h.entry.fetch(new Request(PRM_URL))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [APP],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    })
    expect(h.port).not.toHaveBeenCalled()
  })
})

describe("creation", () => {
  it("refuses the supabase profile, naming it", () => {
    expect(() =>
      harness({ runtimeCatalog: { ...unscoped, provider: "supabase" } })
    ).toThrow(/"supabase" database profile/)
  })

  it("the pin rule reads the compiled catalog's scope kinds", () => {
    expect(scoped.objects.some((o) => o.scopeKindId !== undefined)).toBe(true)
    expect(
      unscoped.objects.some(
        (o) => o.scopeKindId !== undefined || o.rights?.root !== undefined
      )
    ).toBe(false)
  })

  it("hasScopeKinds: a scoped object or a scope kind root, nothing else", () => {
    expect(hasScopeKinds(scoped)).toBe(true)
    expect(hasScopeKinds(unscoped)).toBe(false)
    const [first, ...rest] = unscoped.objects
    const withRoot = (o: typeof first) => ({
      ...unscoped,
      objects: [o, ...rest],
    })
    expect(
      hasScopeKinds(
        withRoot({ ...first!, rights: { ...first!.rights!, root: {} } })
      )
    ).toBe(true)
    expect(hasScopeKinds(withRoot({ ...first!, scopeKindId: "kind-1" }))).toBe(
      true
    )
  })
})
