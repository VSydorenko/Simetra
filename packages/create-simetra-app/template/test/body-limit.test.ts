import { describe, expect, it } from "vitest"
import { BodyTooLarge, limitBody } from "../src/server/body-limit"

const MAX = 16
const URL_ = "https://app.test/_serverFn/abc"

function post(
  body: BodyInit | null,
  headers: Record<string, string> = {},
  url = URL_
) {
  return new Request(url, {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit & { duplex: "half" })
}

function chunked(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return post(stream, headers)
}

const bytes = (n: number) => new Uint8Array(n).fill(97)

describe("limitBody", () => {
  it("passes a Content-Length equal to the limit", async () => {
    const request = post(bytes(MAX), { "content-length": String(MAX) })
    expect((await limitBody(request, MAX).arrayBuffer()).byteLength).toBe(MAX)
  })

  it("refuses Content-Length over the limit without reading the body", () => {
    const request = post(bytes(1), { "content-length": String(MAX + 1) })
    expect(() => limitBody(request, MAX)).toThrow(BodyTooLarge)
    expect(request.bodyUsed).toBe(false)
  })

  it("refuses a chunked body over the limit on the stream", async () => {
    const request = chunked([bytes(10), bytes(10)])
    await expect(limitBody(request, MAX).arrayBuffer()).rejects.toBeInstanceOf(
      BodyTooLarge
    )
  })

  it("refuses a chunked body over the limit on the auth sign-in path", async () => {
    const request = new Request("https://app.test/api/auth/sign-in/email", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes(10))
          c.enqueue(bytes(10))
          c.close()
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" })
    await expect(limitBody(request, MAX).text()).rejects.toBeInstanceOf(
      BodyTooLarge
    )
  })

  it("refuses a body that lies about a small Content-Length", async () => {
    const request = chunked([bytes(10), bytes(10)], { "content-length": "4" })
    await expect(limitBody(request, MAX).arrayBuffer()).rejects.toBeInstanceOf(
      BodyTooLarge
    )
  })

  it("passes a chunked body within the limit unchanged", async () => {
    const request = chunked([bytes(8), bytes(8)])
    const out = new Uint8Array(await limitBody(request, MAX).arrayBuffer())
    expect(out).toEqual(new Uint8Array(16).fill(97))
  })

  it("refuses Content-Encoding other than identity", () => {
    expect(() =>
      limitBody(post(bytes(1), { "content-encoding": "gzip" }), MAX)
    ).toThrow(BodyTooLarge)
    expect(() =>
      limitBody(post(bytes(1), { "content-encoding": "identity" }), MAX)
    ).not.toThrow()
  })

  it.each(["GET", "HEAD"])("does not check %s", (method) => {
    const request = new Request(URL_, {
      method,
      headers: {
        "content-length": String(MAX + 100),
        "content-encoding": "gzip",
      },
    })
    expect(limitBody(request, MAX)).toBe(request)
  })

  it("does not depend on the path", () => {
    for (const path of ["/", "/api/auth/sign-in/email", "/_serverFn/x"]) {
      const request = post(
        bytes(1),
        { "content-length": String(MAX + 1) },
        `https://app.test${path}`
      )
      expect(() => limitBody(request, MAX)).toThrow(BodyTooLarge)
    }
  })
})
