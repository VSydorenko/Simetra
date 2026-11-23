import { describe, expect, it, vi } from "vitest"
import { createRuntimeHolder } from "simetra/data"

const transport = {
  subscribe: vi.fn(),
  close: vi.fn(),
}
const created: Array<{
  url: string
  getConnectionToken(): Promise<string>
  getChannelToken(channel: string): Promise<string>
}> = []

// Реальний `centrifuge` у вузлі не потрібен: перевіряється проводка колбеків
vi.mock("simetra/data/centrifugo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("simetra/data/centrifugo")>()),
  createCentrifugoTransport: vi.fn((options) => {
    created.push(options)
    return transport
  }),
}))

import { clientSignals } from "../src/signals-client"

describe("clientSignals", () => {
  it("builds the transport on the given url with token callbacks of that subject", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ token: "jwt", expiresAt: "x" })
    )
    vi.stubGlobal("fetch", fetchMock)
    const scope = { holder: createRuntimeHolder(), toLogin: vi.fn() }
    clientSignals(scope, "ws://centrifugo.test/ws")("alice")
    expect(created[0]!.url).toBe("ws://centrifugo.test/ws")
    expect(await created[0]!.getConnectionToken()).toBe("jwt")
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      subject: "alice",
    })
    vi.unstubAllGlobals()
  })

  it("closing the transport closes the token callbacks too", async () => {
    const scope = { holder: createRuntimeHolder(), toLogin: vi.fn() }
    const signals = clientSignals(scope, "ws://centrifugo.test/ws")("alice")
    const { getChannelToken } = created.at(-1)!
    signals.close()
    expect(transport.close).toHaveBeenCalledOnce()
    // Колбеки закриті разом із транспортом: пакет, що чекає, не пережив рантайм
    await expect(getChannelToken("c")).rejects.toThrow(/closed/)
  })
})
