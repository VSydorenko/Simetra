import { describe, expect, it, vi } from "vitest"
import { createRuntimeHolder, type DataRuntime } from "simetra/data"
import { SignalAuthRefused } from "simetra/data/centrifugo"
import { createSignalTokenCallbacks } from "../src/signal-tokens-client"

const runtimeOf = (subject: string) =>
  ({ subject, dispose: vi.fn() }) as unknown as DataRuntime

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

/** Відповідь на channel-tokens: токен `t:<канал>` для каналів, що не в `absent`. */
function grantAll(absent: string[] = []) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const { channels } = JSON.parse(String(init?.body)) as {
      channels: string[]
    }
    return json(200, {
      tokens: channels
        .filter((c) => !absent.includes(c))
        .map((channel) => ({ channel, token: `t:${channel}` })),
    })
  })
}

function setup(fetchFn: ReturnType<typeof vi.fn>, held = "u") {
  const holder = createRuntimeHolder()
  holder.replace(runtimeOf(held), "signed-in" as never)
  const replace = vi.spyOn(holder, "replace")
  const navigateToLogin = vi.fn()
  const callbacks = createSignalTokenCallbacks({
    subject: "u",
    holder,
    navigateToLogin,
    fetch: fetchFn as never,
  })
  return { callbacks, holder, replace, navigateToLogin, fetchFn }
}

const bodyOf = (fetchFn: ReturnType<typeof vi.fn>, n: number) =>
  JSON.parse(String(fetchFn.mock.calls[n]![1].body)) as {
    subject: string
    channels: string[]
  }

describe("getChannelToken batching", () => {
  it("sends one request for calls of one tick", async () => {
    const { callbacks, fetchFn } = setup(grantAll())
    const tokens = await Promise.all(
      ["a", "b", "c"].map((c) => callbacks.getChannelToken(c))
    )
    expect(tokens).toEqual(["t:a", "t:b", "t:c"])
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0]![0]).toBe("/simetra/signals/channel-tokens")
    expect(bodyOf(fetchFn, 0)).toEqual({
      subject: "u",
      channels: ["a", "b", "c"],
    })
  })

  it("splits 300 channels into 256 + 44", async () => {
    const { callbacks, fetchFn } = setup(grantAll())
    const channels = Array.from({ length: 300 }, (_, i) => `c${i}`)
    await Promise.all(channels.map((c) => callbacks.getChannelToken(c)))
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(bodyOf(fetchFn, 0).channels).toHaveLength(256)
    expect(bodyOf(fetchFn, 1).channels).toHaveLength(44)
  })

  it("collapses a duplicate channel and resolves every caller", async () => {
    const { callbacks, fetchFn } = setup(grantAll())
    const tokens = await Promise.all([
      callbacks.getChannelToken("a"),
      callbacks.getChannelToken("a"),
    ])
    expect(tokens).toEqual(["t:a", "t:a"])
    expect(bodyOf(fetchFn, 0).channels).toEqual(["a"])
  })

  it("does not cache between packets (I6)", async () => {
    const { callbacks, fetchFn } = setup(grantAll())
    await callbacks.getChannelToken("a")
    await callbacks.getChannelToken("a")
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})

describe("refusals", () => {
  it("refuses only an absent channel and leaves the holder", async () => {
    const { callbacks, replace, navigateToLogin } = setup(grantAll(["b"]))
    const [a, b] = await Promise.allSettled([
      callbacks.getChannelToken("a"),
      callbacks.getChannelToken("b"),
    ])
    expect(a).toEqual({ status: "fulfilled", value: "t:a" })
    expect(b.status === "rejected" && b.reason).toBeInstanceOf(
      SignalAuthRefused
    )
    expect(replace).not.toHaveBeenCalled()
    expect(navigateToLogin).not.toHaveBeenCalled()
  })

  it.each([
    ["session-changed", { reason: "session-changed" }, "session-changed"],
    ["bare", {}, "signed-out"],
  ])("401 %s refuses all and replaces the holder", async (_n, body, why) => {
    const { callbacks, replace, navigateToLogin } = setup(
      vi.fn(async () => json(401, body))
    )
    const results = await Promise.allSettled([
      callbacks.getChannelToken("a"),
      callbacks.getChannelToken("b"),
    ])
    for (const r of results) {
      expect(r.status === "rejected" && r.reason).toBeInstanceOf(
        SignalAuthRefused
      )
    }
    expect(replace).toHaveBeenCalledExactlyOnceWith(undefined, why)
    expect(navigateToLogin).toHaveBeenCalledTimes(1)
  })

  it("401 leaves a holder of another subject alone", async () => {
    const { callbacks, replace, navigateToLogin } = setup(
      vi.fn(async () => json(401, { reason: "session-changed" })),
      "other"
    )
    await expect(callbacks.getChannelToken("a")).rejects.toBeInstanceOf(
      SignalAuthRefused
    )
    await expect(callbacks.getConnectionToken()).rejects.toBeInstanceOf(
      SignalAuthRefused
    )
    expect(replace).not.toHaveBeenCalled()
    expect(navigateToLogin).not.toHaveBeenCalled()
  })

  /** 401, тіло якого віддається лише після `release()`: вікно між перевіркою й заміною. */
  function slowBody(body: unknown) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const response = new Response(null, { status: 401 })
    response.json = async () => {
      await gate
      return body
    }
    return { response, release }
  }

  it("a holder that changed while the 401 body was read is left alone", async () => {
    const slow = slowBody({ reason: "session-changed" })
    const { callbacks, holder, replace, navigateToLogin } = setup(
      vi.fn(async () => slow.response)
    )
    const refused = callbacks.getConnectionToken()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Інший користувач увійшов, поки читалося тіло відповіді для «u»
    const other = runtimeOf("other")
    holder.replace(other)
    replace.mockClear()
    slow.release()
    await expect(refused).rejects.toBeInstanceOf(SignalAuthRefused)
    expect(replace).not.toHaveBeenCalled()
    expect(navigateToLogin).not.toHaveBeenCalled()
    expect(holder.current()).toBe(other)
  })

  it("a late 401 of a closed transport leaves a new runtime of the same subject alone", async () => {
    const slow = slowBody({ reason: "session-changed" })
    const { callbacks, holder, replace, navigateToLogin } = setup(
      vi.fn(async () => slow.response)
    )
    const refused = callbacks.getConnectionToken()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Транспорт закрито, а на місці рантайму вже новий того самого суб'єкта
    callbacks.close()
    const next = runtimeOf("u")
    holder.replace(next)
    replace.mockClear()
    slow.release()
    await expect(refused).rejects.toBeInstanceOf(SignalAuthRefused)
    expect(replace).not.toHaveBeenCalled()
    expect(navigateToLogin).not.toHaveBeenCalled()
    expect(holder.current()).toBe(next)
  })

  it("concurrent 401 of one packet replace the holder and go to login once", async () => {
    const slow = [slowBody({}), slowBody({})]
    let n = 0
    const { callbacks, replace, navigateToLogin } = setup(
      vi.fn(async () => slow[n++]!.response)
    )
    const results = Promise.allSettled([
      callbacks.getConnectionToken(),
      callbacks.getChannelToken("a"),
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Обидві відповіді вже тут і чекають тіла: жодна заміна ще не пройшла
    expect(replace).not.toHaveBeenCalled()
    for (const { release } of slow) release()
    for (const r of await results) expect(r.status).toBe("rejected")
    expect(replace).toHaveBeenCalledTimes(1)
    expect(navigateToLogin).toHaveBeenCalledTimes(1)
  })

  it("403 refuses all without touching the holder", async () => {
    const { callbacks, replace, navigateToLogin } = setup(
      vi.fn(async () => json(403, { reason: "origin" }))
    )
    await expect(callbacks.getChannelToken("a")).rejects.toBeInstanceOf(
      SignalAuthRefused
    )
    await expect(callbacks.getConnectionToken()).rejects.toBeInstanceOf(
      SignalAuthRefused
    )
    expect(replace).not.toHaveBeenCalled()
    expect(navigateToLogin).not.toHaveBeenCalled()
  })

  it.each([
    ["500", () => json(500, { reason: "internal" })],
    ["unparsable", () => new Response("<html>", { status: 200 })],
    [
      "network",
      () => {
        throw new TypeError("fetch failed")
      },
    ],
  ])("%s gives a plain Error", async (_n, respond) => {
    const { callbacks, replace } = setup(vi.fn(async () => respond()))
    for (const call of [
      () => callbacks.getChannelToken("a"),
      () => callbacks.getConnectionToken(),
    ]) {
      const error = await call().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(SignalAuthRefused)
    }
    expect(replace).not.toHaveBeenCalled()
  })
})

describe("getConnectionToken", () => {
  it("posts the subject and returns the token, fresh every time (I6)", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(200, { token: "ct" })
    )
    const { callbacks } = setup(fetchFn)
    expect(await callbacks.getConnectionToken()).toBe("ct")
    expect(await callbacks.getConnectionToken()).toBe("ct")
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[0]![0]).toBe("/simetra/signals/connection-token")
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]!.body))).toEqual({
      subject: "u",
    })
  })
})

describe("close", () => {
  it("rejects later calls, but a packet in flight resolves", async () => {
    const { callbacks } = setup(grantAll())
    const inFlight = callbacks.getChannelToken("a")
    await Promise.resolve() // пачка вже пішла
    await Promise.resolve()
    callbacks.close()
    expect(await inFlight).toBe("t:a")
    await expect(callbacks.getChannelToken("b")).rejects.not.toBeInstanceOf(
      SignalAuthRefused
    )
    await expect(callbacks.getConnectionToken()).rejects.toThrow(/closed/)
  })
})
