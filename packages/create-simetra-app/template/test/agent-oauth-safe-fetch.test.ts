import { readFileSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
  CimdRejectedError,
  ForbiddenAddressError,
  isForbiddenAddress,
  normalizeClientMetadata,
  safeFetch,
  withCimdNormalization,
} from "../src/server/agent-oauth/safe-fetch"

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/cimd/${name}.json`, import.meta.url),
      "utf8"
    )
  ) as Record<string, unknown>

describe("isForbiddenAddress (RFC 6890)", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.8",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "2001:db8::1",
    "2002::1",
    "fe80::1%eth0",
    "not-an-ip",
  ])("refuses %s", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true)
  })

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "allows the public address %s",
    (ip) => {
      expect(isForbiddenAddress(ip)).toBe(false)
    }
  )
})

describe("normalizeClientMetadata (Р-F4-6)", () => {
  it("makes every stored document a public client without keys", () => {
    for (const name of ["claude-code", "claude-ai", "chatgpt"]) {
      const out = normalizeClientMetadata(fixture(name))
      expect(out.token_endpoint_auth_method).toBe("none")
      for (const key of ["jwks_uri", "jwks", "token_endpoint_auth_signing_alg"])
        expect(out).not.toHaveProperty(key)
    }
  })

  it("marks only an all-loopback document without application_type as native", () => {
    expect(
      normalizeClientMetadata(fixture("claude-code")).application_type
    ).toBe("native")
    expect(normalizeClientMetadata(fixture("claude-ai"))).not.toHaveProperty(
      "application_type"
    )
    expect(normalizeClientMetadata(fixture("chatgpt"))).not.toHaveProperty(
      "application_type"
    )
    expect(
      normalizeClientMetadata({
        ...fixture("claude-code"),
        application_type: "web",
      }).application_type
    ).toBe("web")
  })

  it("treats any http loopback redirect as native: any port, any path", () => {
    for (const redirect_uris of [
      ["http://localhost/oauth/callback"],
      ["http://127.0.0.1:8080/"],
      ["http://[::1]:5555/cb?x=1", "http://localhost/callback"],
    ])
      expect(
        normalizeClientMetadata<Record<string, unknown>>({
          ...fixture("claude-code"),
          redirect_uris,
        }).application_type,
        redirect_uris.join(" ")
      ).toBe("native")
  })

  it("keeps a document with any non-loopback redirect a web client", () => {
    for (const redirect_uris of [
      ["http://localhost/callback", "https://app.example/callback"],
      ["https://localhost/callback"],
      ["http://localhost.example/callback"],
      ["http://10.0.0.1/callback"],
    ])
      expect(
        normalizeClientMetadata({ ...fixture("claude-code"), redirect_uris }),
        redirect_uris.join(" ")
      ).not.toHaveProperty("application_type")
  })

  it("refuses a document that neither declares nor supports none", () => {
    const doc = {
      ...fixture("chatgpt"),
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
    }
    expect(() => normalizeClientMetadata(doc)).toThrow(CimdRejectedError)
    expect(() =>
      normalizeClientMetadata({
        ...fixture("claude-ai"),
        token_endpoint_auth_method: "client_secret_basic",
      })
    ).toThrow(CimdRejectedError)
  })

  it("the transport wrapper turns a refused document into a fetch failure", async () => {
    const inner = (async () =>
      Response.json({
        ...fixture("claude-ai"),
        token_endpoint_auth_method: "private_key_jwt",
      })) as unknown as typeof fetch
    await expect(
      withCimdNormalization(inner)("https://claude.ai/x")
    ).rejects.toBeInstanceOf(CimdRejectedError)
  })

  it("the transport wrapper hands the library a normalised document", async () => {
    const inner = (async () =>
      Response.json(fixture("chatgpt"))) as unknown as typeof fetch
    const res = await withCimdNormalization(inner)("https://chatgpt.com/x")
    const body = (await res.json()) as Record<string, unknown>
    expect(body.token_endpoint_auth_method).toBe("none")
    expect(body).not.toHaveProperty("jwks_uri")
  })
})

// Справжні слухачі: «публічна» за тестовою політикою `127.0.0.2` і приватна
// `127.0.0.1` на тому самому порту
const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r)))
  )
})

async function listen(
  host: string,
  port: number,
  body: string
): Promise<{ port: number; accepted: () => number }> {
  let accepted = 0
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(body)
  })
  server.on("connection", () => accepted++)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, resolve)
  })
  return {
    port: (server.address() as AddressInfo).port,
    accepted: () => accepted,
  }
}

describe("safeFetch", () => {
  it("connects only to the address checked at resolution (pinned lookup)", async () => {
    const pub = await listen("127.0.0.2", 0, '{"from":"public"}')
    const priv = await listen("127.0.0.1", pub.port, '{"from":"private"}')
    // Ребіндинг: перевірка бачить публічну адресу, будь-який повторний
    // резолв — приватну
    let calls = 0
    const resolve = ((
      _host: string,
      _opts: unknown,
      cb: (e: null, a: { address: string; family: number }[]) => void
    ) => {
      calls++
      cb(null, [
        { address: calls === 1 ? "127.0.0.2" : "127.0.0.1", family: 4 },
      ])
    }) as never
    const res = await safeFetch(
      `https://rebind.test:${pub.port}/doc.json`,
      {},
      {
        resolve,
        transport: http.request as never,
        isForbidden: (ip) => ip === "127.0.0.1",
      }
    )
    expect(await res.json()).toEqual({ from: "public" })
    expect(calls).toBe(1)
    expect(priv.accepted()).toBe(0)
  })

  it("refuses a resolution to a forbidden address before connecting", async () => {
    const priv = await listen("127.0.0.1", 0, "{}")
    const resolve = ((
      _h: string,
      _o: unknown,
      cb: (e: null, a: { address: string; family: number }[]) => void
    ) => cb(null, [{ address: "127.0.0.1", family: 4 }])) as never
    await expect(
      safeFetch(
        `https://private.test:${priv.port}/doc.json`,
        {},
        { resolve, transport: http.request as never }
      )
    ).rejects.toBeInstanceOf(ForbiddenAddressError)
    expect(priv.accepted()).toBe(0)
  })

  it("refuses a forbidden IP literal, http and userinfo", async () => {
    await expect(safeFetch("https://127.0.0.1/x")).rejects.toBeInstanceOf(
      ForbiddenAddressError
    )
    await expect(safeFetch("https://[::1]/x")).rejects.toBeInstanceOf(
      ForbiddenAddressError
    )
    await expect(safeFetch("http://example.com/x")).rejects.toThrow(/https/)
    await expect(safeFetch("https://u:p@example.com/x")).rejects.toThrow(
      /userinfo/
    )
  })

  it("does not follow redirects and caps the body", async () => {
    let port = 0
    const server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.statusCode = 302
        res.setHeader("location", "https://elsewhere.test/")
        res.end()
        return
      }
      res.end("x".repeat(6 * 1024))
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, "127.0.0.2", r))
    port = (server.address() as AddressInfo).port
    const o = {
      resolve: ((
        _h: string,
        _o: unknown,
        cb: (e: null, a: { address: string; family: number }[]) => void
      ) => cb(null, [{ address: "127.0.0.2", family: 4 }])) as never,
      transport: http.request as never,
      isForbidden: () => false,
    }
    const redirected = await safeFetch(`https://a.test:${port}/redirect`, {}, o)
    expect(redirected.status).toBe(302)
    await expect(
      safeFetch(`https://a.test:${port}/big`, {}, o)
    ).rejects.toThrow(/exceeds the limit/)
  })
})
