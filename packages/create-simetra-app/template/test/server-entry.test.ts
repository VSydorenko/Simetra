import { afterEach, describe, expect, it, vi } from "vitest"

// Entry перевіряє оточення при імпорті, а статичні імпорти піднімаються нагору
vi.hoisted(() => {
  process.env.SIMETRA_APP_ORIGIN = "https://app.test"
})

vi.mock("@tanstack/react-start/server", () => ({
  createServerEntry: (entry: unknown) => entry,
  createStartHandler: () => () => new Response("unused"),
  defaultStreamHandler: () => undefined,
}))
vi.mock("../src/server/runtime", () => ({ serverHash: "hash" }))

import { PAYLOAD_MAX_BYTES } from "simetra/model"
import { createEntryFetch } from "../src/server"

afterEach(() => vi.unstubAllEnvs())

const html = () =>
  new Response("<html></html>", { headers: { "content-type": "text/html" } })

/** Запит, що дійшов до «Start»: фіксуємо його і повертаємо задану відповідь. */
function entry(
  respond: (request: Request) => Response | Promise<Response> = html
) {
  const seen: Request[] = []
  const fetch = createEntryFetch(async (request: Request) => {
    seen.push(request)
    return respond(request)
  })
  return { fetch, seen }
}

const get = (headers: Record<string, string> = {}, path = "/") =>
  new Request(`https://app.test${path}`, { headers })

function socketRequest(headers: Record<string, string>, ip: string) {
  const request = get(headers)
  Object.defineProperty(request, "ip", { value: ip })
  return request
}

describe("client address", () => {
  it("socket source: overwrites a forged header with the socket address", async () => {
    const { fetch, seen } = entry()
    await fetch(socketRequest({ "x-simetra-client-ip": "6.6.6.6" }, "10.0.0.7"))
    expect(seen[0]!.headers.get("x-simetra-client-ip")).toBe("10.0.0.7")
  })

  it("socket source is the default and is named explicitly", async () => {
    vi.stubEnv("SIMETRA_CLIENT_IP_SOURCE", "socket")
    const { fetch, seen } = entry()
    await fetch(socketRequest({}, "10.0.0.8"))
    expect(seen[0]!.headers.get("x-simetra-client-ip")).toBe("10.0.0.8")
  })

  it("socket source without an address leaves no forged value", async () => {
    const { fetch, seen } = entry()
    await fetch(get({ "x-simetra-client-ip": "6.6.6.6" }))
    expect(seen[0]!.headers.get("x-simetra-client-ip")).toBeNull()
  })

  it("proxy source: takes the proxy header, a forged value never passes", async () => {
    vi.stubEnv("SIMETRA_CLIENT_IP_SOURCE", "x-real-ip")
    const { fetch, seen } = entry()
    await fetch(
      get({ "x-real-ip": "203.0.113.9", "x-simetra-client-ip": "6.6.6.6" })
    )
    expect(seen[0]!.headers.get("x-simetra-client-ip")).toBe("203.0.113.9")
  })

  it("proxy source without the proxy header drops the forged value", async () => {
    vi.stubEnv("SIMETRA_CLIENT_IP_SOURCE", "x-real-ip")
    const { fetch, seen } = entry()
    await fetch(get({ "x-simetra-client-ip": "6.6.6.6" }))
    expect(seen[0]!.headers.get("x-simetra-client-ip")).toBeNull()
  })
})

describe("body limit", () => {
  it("refuses an oversized Content-Length without calling Start", async () => {
    const { fetch, seen } = entry()
    const response = await fetch(
      new Request("https://app.test/api/auth/sign-in/email", {
        method: "POST",
        body: "x",
        headers: { "content-length": String(PAYLOAD_MAX_BYTES + 1) },
      })
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "command.invalid", reason: "payload-too-large" },
    })
    expect(seen).toHaveLength(0)
  })

  it("refuses a chunked body over the limit even when Start swallows the error", async () => {
    const { fetch } = entry(async (request) => {
      await request.text().catch(() => undefined)
      return html()
    })
    const chunk = new Uint8Array(PAYLOAD_MAX_BYTES / 2 + 1)
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk)
        c.enqueue(chunk)
        c.close()
      },
    })
    const response = await fetch(
      new Request("https://app.test/api/auth/sign-in/email", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" })
    )
    expect(response.status).toBe(413)
  })

  it("passes a body within the limit to Start", async () => {
    const { fetch, seen } = entry(
      async (request) => new Response(await request.text())
    )
    const response = await fetch(
      new Request("https://app.test/_serverFn/a", {
        method: "POST",
        body: "ok",
      })
    )
    expect(await response.text()).toBe("ok")
    expect(seen).toHaveLength(1)
  })
})

describe("response headers", () => {
  it("HTML: private no-store, Vary Cookie and the security headers", async () => {
    const response = await entry().fetch(get())
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("vary")).toContain("Cookie")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("referrer-policy")).toBe("same-origin")
    expect(response.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'"
    )
  })

  it("non-asset non-HTML response: no-store", async () => {
    const { fetch } = entry(() => Response.json({ a: 1 }))
    const response = await fetch(get({}, "/_serverFn/x"))
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("asset response is left untouched", async () => {
    const { fetch } = entry(
      () => new Response("js", { headers: { "cache-control": "immutable" } })
    )
    const response = await fetch(get({}, "/assets/app.js"))
    expect(response.headers.get("cache-control")).toBe("immutable")
  })

  it("sign-out response clears the client cache", async () => {
    const { fetch } = entry(() => Response.json({ success: true }))
    const response = await fetch(
      new Request("https://app.test/api/auth/sign-out", { method: "POST" })
    )
    expect(response.headers.get("clear-site-data")).toBe('"cache"')
  })

  it("other responses do not clear the client cache", async () => {
    const response = await entry().fetch(get())
    expect(response.headers.get("clear-site-data")).toBeNull()
  })
})
