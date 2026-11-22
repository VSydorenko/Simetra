import type { SignalError } from "simetra/model"
import { afterEach, describe, expect, it, vi } from "vitest"

/*
 * Транспорт Centrifugo (план B5b-4, задача 1; спека П4-B §8.5) над фейковим
 * клієнтом `centrifuge`. Фейк повторює лише ту поведінку SDK 5.8.0, на яку
 * спирається адаптер (`build/index.mjs`): `UnauthorizedError` з `getToken`
 * підписки — `unsubscribed` з кодом `unauthorized` без повтору
 * (`Subscription._handleTokenError` → `_failUnauthorized`); інша помилка —
 * подія `error` і повтор за backoff; підписка з закешованим токеном
 * `getToken` не кличе (`_canSubscribeWithoutGettingToken`); `UnauthorizedError`
 * з `getToken` з'єднання — `disconnected` з кодом `unauthorized`
 * (`Centrifuge._failUnauthorized`), токен з'єднання клієнт тримає, доки його
 * не скинуто (`setToken`, `_startReconnecting`: `needTokenRefresh`). Справжній
 * клієнт проти стенду — задача 3.
 */

const fake = vi.hoisted(() => {
  type Handler = (ctx: never) => void

  class Emitter {
    private handlers = new Map<string, Set<Handler>>()
    on(event: string, handler: Handler) {
      let set = this.handlers.get(event)
      if (set === undefined) this.handlers.set(event, (set = new Set()))
      set.add(handler)
      return this
    }
    emit(event: string, ctx: unknown) {
      for (const handler of [...(this.handlers.get(event) ?? [])]) {
        ;(handler as (ctx: unknown) => void)(ctx)
      }
    }
  }

  interface Recovery {
    wasRecovering: boolean
    recovered: boolean
  }

  class FakeSubscription extends Emitter {
    state: "unsubscribed" | "subscribing" | "subscribed" = "unsubscribed"
    private token = ""
    getTokenCalls = 0
    constructor(
      readonly client: FakeCentrifuge,
      readonly channel: string,
      private readonly options: {
        getToken: (ctx: { channel: string }) => Promise<string>
      },
      private readonly UnauthorizedError: new (message: string) => Error
    ) {
      super()
    }
    subscribe() {
      if (this.state !== "unsubscribed") return
      this.state = "subscribing"
      if (this.client.state === "connected") this.start()
    }
    unsubscribe() {
      this.toUnsubscribed(0)
    }
    start() {
      if (this.token !== "") {
        queueMicrotask(() => this.join())
        return
      }
      this.getTokenCalls++
      this.options.getToken({ channel: this.channel }).then(
        (token) => {
          if (this.state !== "subscribing") return
          if (!token) return this.toUnsubscribed(1)
          this.token = token
          this.join()
        },
        (error: unknown) => {
          if (this.state !== "subscribing") return
          if (error instanceof this.UnauthorizedError) {
            return this.toUnsubscribed(1)
          }
          this.emit("error", {
            channel: this.channel,
            type: "subscribeToken",
            error: { code: 8, message: String(error) },
          })
        }
      )
    }
    /** (Пере)підписка з відповіддю сервера про відновлення. */
    join(recovery: Recovery = { wasRecovering: false, recovered: false }) {
      this.state = "subscribed"
      this.emit("subscribed", { channel: this.channel, ...recovery })
    }
    publish(data: unknown) {
      this.emit("publication", { channel: this.channel, data })
    }
    fail() {
      this.emit("error", {
        channel: this.channel,
        type: "subscribe",
        error: { code: 100, message: "internal" },
      })
    }
    toUnsubscribed(code: number) {
      this.state = "unsubscribed"
      this.emit("unsubscribed", { channel: this.channel, code, reason: "" })
    }
  }

  class FakeCentrifuge extends Emitter {
    state: "disconnected" | "connecting" | "connected" = "disconnected"
    token = ""
    connectCalls = 0
    getTokenCalls = 0
    setTokens: string[] = []
    disconnectCalls = 0
    readonly subs = new Map<string, FakeSubscription>()
    readonly created: FakeSubscription[] = []
    constructor(
      readonly url: string,
      private readonly options: { getToken: () => Promise<string> },
      private readonly UnauthorizedError: new (message: string) => Error
    ) {
      super()
    }
    private setState(next: FakeCentrifuge["state"]) {
      const old = this.state
      this.state = next
      this.emit("state", { oldState: old, newState: next })
      if (old === "connected") {
        for (const sub of this.subs.values()) {
          if (sub.state === "subscribed") sub.state = "subscribing"
        }
      }
    }
    connect() {
      this.connectCalls++
      if (this.state !== "disconnected") return
      this.setState("connecting")
      this.emit("connecting", { code: 0, reason: "connect called" })
      this.attempt()
    }
    private attempt() {
      if (this.token !== "") return this.open()
      this.getTokenCalls++
      this.options.getToken().then(
        (token) => {
          if (this.state !== "connecting") return
          this.token = token
          this.open()
        },
        (error: unknown) => {
          if (this.state !== "connecting") return
          if (error instanceof this.UnauthorizedError) {
            return this.failUnauthorized()
          }
          this.emit("error", {
            type: "connectToken",
            error: { code: 5, message: String(error) },
          })
        }
      )
    }
    private open() {
      this.setState("connected")
      this.emit("connected", { client: "c", transport: "websocket" })
      for (const sub of [...this.subs.values()]) {
        if (sub.state === "subscribing") sub.start()
      }
    }
    private failUnauthorized() {
      this.setState("disconnected")
      this.emit("disconnected", { code: 1, reason: "unauthorized" })
    }
    /** Поновлення токена живого з'єднання (`Centrifuge._refresh`). */
    refresh() {
      this.getTokenCalls++
      this.options.getToken().then(
        (token) => {
          this.token = token
        },
        (error: unknown) => {
          if (error instanceof this.UnauthorizedError) this.failUnauthorized()
        }
      )
    }
    /** Розрив транспорту: клієнт перепідключається сам. */
    loseTransport() {
      this.setState("connecting")
      this.emit("connecting", { code: 1, reason: "transport closed" })
    }
    /** Перепідключення з тим самим токеном. */
    restore() {
      this.open()
    }
    setToken(token: string) {
      this.setTokens.push(token)
      this.token = token
    }
    disconnect() {
      this.disconnectCalls++
      if (this.state === "disconnected") return
      this.setState("disconnected")
      this.emit("disconnected", { code: 0, reason: "disconnect called" })
    }
    newSubscription(
      channel: string,
      options: { getToken: (ctx: { channel: string }) => Promise<string> }
    ) {
      if (this.subs.has(channel)) throw new Error(`duplicate ${channel}`)
      const sub = new FakeSubscription(
        this,
        channel,
        options,
        this.UnauthorizedError
      )
      this.subs.set(channel, sub)
      this.created.push(sub)
      return sub
    }
    getSubscription(channel: string) {
      return this.subs.get(channel) ?? null
    }
    removeSubscription(sub: FakeSubscription) {
      if (this.subs.get(sub.channel) !== sub) return
      this.subs.delete(sub.channel)
      if (sub.state !== "unsubscribed") sub.unsubscribe()
    }
  }

  return { FakeCentrifuge, FakeSubscription, clients: [] as FakeCentrifuge[] }
})

vi.mock("centrifuge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("centrifuge")>()
  return {
    ...actual,
    Centrifuge: function Centrifuge(
      url: string,
      options: { getToken: () => Promise<string> }
    ) {
      const client = new fake.FakeCentrifuge(
        url,
        options,
        actual.UnauthorizedError
      )
      fake.clients.push(client)
      return client
    },
  }
})

const { SignalAuthRefused, createCentrifugoTransport } =
  await import("../index")

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

interface Tokens {
  connection?: () => Promise<string>
  channel?: (channel: string) => Promise<string>
}

function deferred() {
  let resolve: (token: string) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Транспорт і тримач каналів, підписаний до першої відповіді токена. */
function setup(tokens: Tokens = {}, channels: readonly string[] = ["a"]) {
  const getConnectionToken = vi.fn(
    tokens.connection ?? (() => Promise.resolve("conn"))
  )
  const getChannelToken = vi.fn(
    tokens.channel ?? ((channel: string) => Promise.resolve(`tok-${channel}`))
  )
  const transport = createCentrifugoTransport({
    url: "ws://signals.test/connection/websocket",
    getConnectionToken,
    getChannelToken,
  })
  const client = fake.clients.at(-1)!
  const joined: { channel: string; recovered: boolean }[] = []
  transport.onSubscribed((event) => joined.push(event))
  const h = holder()
  const off = transport.subscribe(channels, h.onSignal, h.onError)
  return {
    transport,
    client,
    joined,
    h,
    off,
    getConnectionToken,
    getChannelToken,
  }
}

function holder() {
  const signals: [string, unknown][] = []
  const errors: SignalError[] = []
  return {
    signals,
    errors,
    onSignal: (topic: string, payload: unknown) =>
      signals.push([topic, payload]),
    onError: (error: SignalError) => errors.push(error),
  }
}

afterEach(() => {
  fake.clients.length = 0
})

describe("createCentrifugoTransport: events (Р2)", () => {
  it("maps a publication to onSignal and every subscription to onSubscribed", async () => {
    const { client, joined, h } = setup()
    await settle()
    expect(joined).toEqual([{ channel: "a", recovered: false }])
    client.getSubscription("a")!.publish({ id: "s1" })
    expect(h.signals).toEqual([["a", { id: "s1" }]])

    // Перепідключення дає ще один onSubscribed: свіжість вирішує приймач.
    client.loseTransport()
    client.restore()
    await settle()
    expect(joined).toEqual([
      { channel: "a", recovered: false },
      { channel: "a", recovered: false },
    ])
  })

  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])(
    "wasRecovering %s, recovered %s → recovered %s",
    async (wasRecovering, recovered, expected) => {
      const { client, joined } = setup()
      await settle()
      joined.length = 0
      client.getSubscription("a")!.join({ wasRecovering, recovered })
      expect(joined).toEqual([{ channel: "a", recovered: expected }])
    }
  )

  it("reports a connection loss as transport without a channel to every holder", async () => {
    const { transport, client, h } = setup()
    const two = holder()
    transport.subscribe(["b"], two.onSignal, two.onError)
    await settle()
    client.loseTransport()
    expect(h.errors).toEqual([{ kind: "transport" }])
    expect(two.errors).toEqual([{ kind: "transport" }])
  })

  it("reports a failure of one subscription as transport of its channel only", async () => {
    const { transport, client, h } = setup()
    const two = holder()
    transport.subscribe(["b"], two.onSignal, two.onError)
    await settle()
    client.getSubscription("a")!.fail()
    expect(h.errors).toEqual([{ kind: "transport", channel: "a" }])
    expect(two.errors).toEqual([])
  })
})

describe("createCentrifugoTransport: channel tokens (Р1)", () => {
  it("maps a refused channel token to auth of the channel, without a retry, and closes it", async () => {
    const { client, h, getChannelToken } = setup(
      {
        channel: (channel) =>
          channel === "b"
            ? Promise.reject(new SignalAuthRefused())
            : Promise.resolve(`tok-${channel}`),
      },
      ["a", "b"]
    )
    await settle()
    expect(h.errors).toEqual([{ kind: "auth", channel: "b" }])
    expect(client.getSubscription("b")).toBeNull()
    client.loseTransport()
    client.restore()
    await settle()
    expect(getChannelToken.mock.calls).toEqual([["a"], ["b"]])
    expect(client.getSubscription("a")!.state).toBe("subscribed")
  })

  it("maps a 5xx of the channel token to transport of the channel", async () => {
    const { client, h } = setup({
      channel: () => Promise.reject(new Error("503")),
    })
    await settle()
    expect(h.errors).toEqual([{ kind: "transport", channel: "a" }])
    expect(client.getSubscription("a")).not.toBeNull()
  })
})

describe("createCentrifugoTransport: connection tokens (Р1)", () => {
  it("first refusal: auth and one connect() after setToken(''); second in a row: final, no connect()", async () => {
    const { client, h, getConnectionToken } = setup({
      connection: () => Promise.reject(new SignalAuthRefused()),
    })
    await settle()
    expect(h.errors).toEqual([{ kind: "auth" }, { kind: "auth", final: true }])
    expect(getConnectionToken).toHaveBeenCalledTimes(2)
    // Перший connect() — фабрики, другий — після першої відмови.
    expect(client.connectCalls).toBe(2)
    expect(client.setTokens).toEqual([""])
  })

  it("a refused refresh of a live connection asks a fresh token instead of the held one", async () => {
    let refuse = false
    const { client, h, getConnectionToken } = setup({
      connection: () =>
        refuse
          ? Promise.reject(new SignalAuthRefused())
          : Promise.resolve("conn"),
    })
    await settle()
    refuse = true
    client.refresh()
    await settle()
    // Розрив живого з'єднання — теж втрата сигналів.
    expect(h.errors).toEqual([
      { kind: "transport" },
      { kind: "auth" },
      { kind: "auth", final: true },
    ])
    expect(getConnectionToken).toHaveBeenCalledTimes(3)
    expect(client.connectCalls).toBe(2)
  })

  it("a successful connection between two refusals resets the count", async () => {
    const answers = [
      () => Promise.reject(new SignalAuthRefused()),
      () => Promise.resolve("conn"),
      () => Promise.reject(new SignalAuthRefused()),
      () => Promise.resolve("conn"),
    ]
    const { client, h } = setup({ connection: () => answers.shift()!() })
    await settle()
    expect(client.state).toBe("connected")
    client.refresh()
    await settle()
    expect(h.errors).toEqual([
      { kind: "auth" },
      { kind: "transport" },
      { kind: "auth" },
    ])
    expect(client.state).toBe("connected")
  })

  it("a channel subscribed between two refusals does not reset the count", async () => {
    const third = deferred()
    const answers = [
      () => Promise.resolve("conn"),
      () => Promise.reject(new SignalAuthRefused()),
      () => third.promise,
    ]
    const { client, h } = setup({ connection: () => answers.shift()!() })
    await settle()
    client.refresh()
    await settle()
    expect(h.errors).toEqual([{ kind: "transport" }, { kind: "auth" }])
    client.getSubscription("a")!.join()
    third.reject(new SignalAuthRefused())
    await settle()
    expect(h.errors).toEqual([
      { kind: "transport" },
      { kind: "auth" },
      { kind: "auth", final: true },
    ])
  })

  it("maps a 5xx of the connection token to transport and leaves the retry to the client", async () => {
    const { client, h } = setup({
      connection: () => Promise.reject(new Error("503")),
    })
    await settle()
    expect(h.errors).toEqual([{ kind: "transport" }])
    expect(client.connectCalls).toBe(1)
  })
})

describe("createCentrifugoTransport: subscriptions (Р3, Р4)", () => {
  it("keeps one client subscription per channel; Unsubscribe drops only its own channels", async () => {
    const { transport, client, h, off } = setup({}, ["a", "b"])
    const two = holder()
    transport.subscribe(["b", "c"], two.onSignal, two.onError)
    await settle()
    expect(client.created.map((sub) => sub.channel)).toEqual(["a", "b", "c"])

    off()
    expect(client.getSubscription("a")).toBeNull()
    expect(client.getSubscription("b")!.state).toBe("subscribed")
    expect(client.getSubscription("c")!.state).toBe("subscribed")
    client.getSubscription("b")!.publish(1)
    client.getSubscription("c")!.publish(2)
    expect(h.signals).toEqual([])
    expect(two.signals).toEqual([
      ["b", 1],
      ["c", 2],
    ])
    expect(two.errors).toEqual([])
  })

  it("refreshTokens replaces the subscriptions with fresh tokens and closes a refused one", async () => {
    const refused = new Set<string>()
    const { transport, client, joined, h, getChannelToken } = setup(
      {
        channel: (channel) =>
          refused.has(channel)
            ? Promise.reject(new SignalAuthRefused())
            : Promise.resolve(`tok-${channel}`),
      },
      ["a", "b"]
    )
    await settle()
    joined.length = 0
    getChannelToken.mockClear()
    refused.add("b")
    await transport.refreshTokens()
    await settle()
    expect(getChannelToken.mock.calls).toEqual([["a"], ["b"]])
    expect(joined).toEqual([{ channel: "a", recovered: false }])
    expect(h.errors).toEqual([{ kind: "auth", channel: "b" }])
    expect(client.getSubscription("b")).toBeNull()
    client.getSubscription("a")!.publish(1)
    expect(h.signals).toEqual([["a", 1]])
  })

  it("refreshTokens with channels replaces only the named ones", async () => {
    const { transport, joined, getChannelToken } = setup({}, ["a", "b"])
    await settle()
    joined.length = 0
    getChannelToken.mockClear()
    await transport.refreshTokens(["b"])
    await settle()
    expect(getChannelToken.mock.calls).toEqual([["b"]])
    expect(joined).toEqual([{ channel: "b", recovered: false }])
  })

  it("after close() no event reaches a holder", async () => {
    const { transport, client, joined, h } = setup({}, ["a"])
    await settle()
    const sub = client.getSubscription("a")!
    joined.length = 0
    transport.close()
    expect(client.disconnectCalls).toBe(1)
    expect(client.getSubscription("a")).toBeNull()
    sub.publish(1)
    sub.join()
    sub.fail()
    sub.toUnsubscribed(1)
    client.loseTransport()
    client.restore()
    await settle()
    expect(h.signals).toEqual([])
    expect(h.errors).toEqual([])
    expect(joined).toEqual([])

    const late = holder()
    transport.subscribe(["b"], late.onSignal, late.onError)
    expect(client.getSubscription("b")).toBeNull()
  })
})
