import { afterEach, describe, expect, it, vi } from "vitest"
import { createRuntimeHolder, type DataRuntime } from "simetra/data"
import { createTabBus, type TabChannel } from "../src/tab-bus"

const runtimeOf = (subject: string) =>
  ({ subject, dispose: vi.fn() }) as unknown as DataRuntime

/** Канал-двійник: лише слухач, `postMessage` і `close`, як у `BroadcastChannel`. */
function fakeChannel() {
  const posted: unknown[] = []
  const channel: TabChannel & { closed: boolean } = {
    onmessage: null,
    closed: false,
    postMessage: (message) => void posted.push(message),
    close() {
      channel.closed = true
    },
  }
  return { channel, posted }
}

function setup(held: string | null = "alice") {
  const holder = createRuntimeHolder()
  if (held !== null) holder.replace(runtimeOf(held))
  const replace = vi.spyOn(holder, "replace")
  const toLogin = vi.fn()
  const channels: ReturnType<typeof fakeChannel>[] = []
  const bus = createTabBus({
    holder,
    toLogin,
    createChannel: () => {
      const made = fakeChannel()
      channels.push(made)
      return made.channel
    },
  })
  const receive = (data: unknown) =>
    channels.at(-1)!.channel.onmessage?.({ data })
  return { holder, replace, toLogin, bus, channels, receive }
}

afterEach(() => vi.unstubAllGlobals())

describe("receiver", () => {
  it("own subject: replaces the holder with signed-out and goes to login", () => {
    const { bus, receive, holder, replace, toLogin } = setup("alice")
    bus.start()
    receive({ type: "signed-out", subject: "alice" })
    expect(replace).toHaveBeenCalledExactlyOnceWith(undefined, "signed-out")
    expect(holder.current()).toBeUndefined()
    expect(holder.closed()).toBe("signed-out")
    expect(toLogin).toHaveBeenCalledOnce()
  })

  it.each([
    ["a foreign subject", { type: "signed-out", subject: "bob" }],
    ["another type", { type: "signed-in", subject: "alice" }],
    ["no subject", { type: "signed-out" }],
    ["a non-string subject", { type: "signed-out", subject: 7 }],
    ["null", null],
    ["a string", "signed-out"],
    ["an empty object", {}],
  ])("%s: the holder stays untouched", (_name, data) => {
    const { bus, receive, holder, replace, toLogin } = setup("alice")
    const before = holder.current()
    bus.start()
    receive(data)
    expect(replace).not.toHaveBeenCalled()
    expect(holder.current()).toBe(before)
    expect(toLogin).not.toHaveBeenCalled()
  })

  it("a tab with no runtime ignores the event and never opens one", () => {
    const { bus, receive, holder, replace, toLogin } = setup(null)
    bus.start()
    receive({ type: "signed-out", subject: "alice" })
    expect(replace).not.toHaveBeenCalled()
    expect(holder.current()).toBeUndefined()
    expect(toLogin).not.toHaveBeenCalled()
  })

  it("closes only the subject held now: a later user in the tab is not signed out by an old event", () => {
    const { bus, receive, holder, toLogin } = setup("alice")
    bus.start()
    const bob = runtimeOf("bob")
    holder.replace(bob)
    receive({ type: "signed-out", subject: "alice" })
    expect(holder.current()).toBe(bob)
    expect(toLogin).not.toHaveBeenCalled()
  })
})

describe("lifecycle", () => {
  it("start twice listens once; close closes the channel and stops the receiver", () => {
    const { bus, channels, holder } = setup("alice")
    bus.start()
    bus.start()
    expect(channels).toHaveLength(1)
    const { channel } = channels[0]!
    bus.close()
    expect(channel.closed).toBe(true)
    expect(channel.onmessage).toBeNull()
    expect(holder.current()?.subject).toBe("alice")
  })

  it("start after close listens again (StrictMode effect twice)", () => {
    const { bus, channels, receive, holder } = setup("alice")
    bus.start()
    bus.close()
    bus.start()
    expect(channels).toHaveLength(2)
    receive({ type: "signed-out", subject: "alice" })
    expect(holder.current()).toBeUndefined()
  })

  it("close without start is harmless", () => {
    const { bus, channels } = setup("alice")
    bus.close()
    expect(channels).toHaveLength(0)
  })
})

describe("publish", () => {
  it("posts the one event shape and closes its one-shot channel", () => {
    const { bus, channels } = setup("alice")
    bus.publishSignedOut("alice")
    expect(channels).toHaveLength(1)
    expect(channels[0]!.posted).toEqual([
      { type: "signed-out", subject: "alice" },
    ])
    expect(channels[0]!.channel.closed).toBe(true)
  })
})

describe("without BroadcastChannel", () => {
  it("is silent: no throw on publish, start or close", () => {
    vi.stubGlobal("BroadcastChannel", undefined)
    const holder = createRuntimeHolder()
    const bus = createTabBus({ holder, toLogin: vi.fn() })
    expect(() => {
      bus.publishSignedOut("alice")
      bus.start()
      bus.close()
    }).not.toThrow()
  })
})
