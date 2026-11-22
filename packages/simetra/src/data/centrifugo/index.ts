import {
  Centrifuge,
  State,
  UnauthorizedError,
  disconnectedCodes,
  unsubscribedCodes,
  type Subscription,
} from "centrifuge"
import type { SignalError, SignalTransport, Unsubscribe } from "simetra/model"

/**
 * Thrown by a host token function to say the server refuses the token: the
 * channel is outside the `authorizeChannels` grant, the grant has no user
 * (`signals.no-user`), or the host endpoint answered 401 or 403. Any other
 * failure (network, 5xx) is not a refusal and is retried by the client.
 */
export class SignalAuthRefused extends Error {
  constructor(message = "signal token refused") {
    super(message)
    this.name = "SignalAuthRefused"
  }
}

/** Options of `createCentrifugoTransport`. */
export interface CentrifugoTransportOptions {
  /** WebSocket endpoint of Centrifugo. */
  url: string
  /** A connection token; rejects with `SignalAuthRefused` on a refusal. */
  getConnectionToken(): Promise<string>
  /** A subscription token of one channel; rejects with `SignalAuthRefused` on a refusal. */
  getChannelToken(channel: string): Promise<string>
}

interface Holder {
  channels: Set<string>
  onSignal: (topic: string, payload: unknown) => void
  onError: (error: SignalError) => void
}

interface Entry {
  sub: Subscription
  holders: Set<Holder>
}

/**
 * A `SignalTransport` over the `centrifuge` client: one client connection,
 * one client subscription per channel shared by every holder of the channel.
 */
export function createCentrifugoTransport(
  options: CentrifugoTransportOptions
): SignalTransport {
  const entries = new Map<string, Entry>()
  const holders = new Set<Holder>()
  const subscribedHandlers = new Set<
    (event: { channel: string; recovered: boolean }) => void
  >()
  let closed = false
  // Відмови токена з'єднання поспіль: скидає лише успішне з'єднання клієнта,
  // бо `subscribed` каналу не доводить, що новий токен з'єднання видано (§8.5).
  let refusals = 0

  // Відмову host-а клієнт розуміє лише як `UnauthorizedError`: тоді він не
  // повторює спробу, а знімає підписку (`unsubscribed`, `unauthorized`) чи
  // з'єднання (`disconnected`, `unauthorized`). Решта помилок — повтор за backoff.
  const refusalAsUnauthorized = (error: unknown): never => {
    if (error instanceof SignalAuthRefused) throw new UnauthorizedError("")
    throw error
  }

  const client = new Centrifuge(options.url, {
    getToken: () => options.getConnectionToken().catch(refusalAsUnauthorized),
  })

  const failAll = (error: SignalError) => {
    for (const holder of [...holders]) holder.onError(error)
  }
  const failChannel = (channel: string, error: SignalError) => {
    const entry = entries.get(channel)
    if (entry === undefined) return
    for (const holder of [...entry.holders]) holder.onError(error)
  }

  // Канал, якому відмовлено: підписку закрито, тримачі більше його не мають.
  const refuse = (channel: string) => {
    const entry = entries.get(channel)
    if (entry === undefined) return
    entries.delete(channel)
    client.removeSubscription(entry.sub)
    for (const holder of entry.holders) holder.channels.delete(channel)
    for (const holder of [...entry.holders]) {
      holder.onError({ kind: "auth", channel })
    }
  }

  // Підписку ставить у `entries` викликач до `subscribe()`: інакше її події
  // вважалися б застарілими.
  const create = (channel: string): Subscription => {
    const sub = client.newSubscription(channel, {
      getToken: () =>
        options.getChannelToken(channel).catch(refusalAsUnauthorized),
    })
    // Подія застарілої підписки (знятої `refreshTokens` чи відпусканням) уже
    // не стосується каналу.
    const current = () => !closed && entries.get(channel)?.sub === sub
    sub.on("publication", (ctx) => {
      if (!current()) return
      for (const holder of [...(entries.get(channel)?.holders ?? [])]) {
        holder.onSignal(ctx.channel, ctx.data)
      }
    })
    sub.on("subscribed", (ctx) => {
      if (!current()) return
      // Пропущене віддано лише тоді, коли клієнт відновлював з позиції й
      // відновив; свіжість вирішує приймач за епохами (§8.4), не адаптер.
      const recovered = ctx.wasRecovering && ctx.recovered
      for (const handler of [...subscribedHandlers]) {
        handler({ channel, recovered })
      }
    })
    sub.on("unsubscribed", (ctx) => {
      // `unsubscribeCalled` — власне зняття адаптера (`removeSubscription`
      // відпусканням чи заміною `refreshTokens`), не втрата каналу.
      if (!current() || ctx.code === unsubscribedCodes.unsubscribeCalled) return
      if (ctx.code === unsubscribedCodes.unauthorized) return refuse(channel)
      // Сервер зняв підписку без повторної: сигналів каналу більше немає.
      failChannel(channel, { kind: "transport", channel })
    })
    sub.on("error", () => {
      if (!current()) return
      failChannel(channel, { kind: "transport", channel })
    })
    return sub
  }

  client.on("state", (ctx) => {
    if (closed) return
    // Будь-який вихід зі стану «з'єднано» — втрата сигналів усіх каналів.
    if (ctx.oldState === State.Connected) failAll({ kind: "transport" })
  })
  client.on("connected", () => {
    refusals = 0
  })
  client.on("error", () => {
    if (closed) return
    failAll({ kind: "transport" })
  })
  client.on("disconnected", (ctx) => {
    if (closed || ctx.code !== disconnectedCodes.unauthorized) return
    refusals++
    if (refusals > 1) return failAll({ kind: "auth", final: true })
    failAll({ kind: "auth" })
    // Без скидання клієнт тримає попередній токен з'єднання й не кличе
    // `getConnectionToken`: нова спроба пішла б зі старим токеном.
    client.setToken("")
    client.connect()
  })

  client.connect()

  return {
    subscribe(channels, onSignal, onError): Unsubscribe {
      if (closed) return () => {}
      const holder: Holder = { channels: new Set(channels), onSignal, onError }
      holders.add(holder)
      for (const channel of holder.channels) {
        const entry = entries.get(channel)
        if (entry !== undefined) {
          entry.holders.add(holder)
          continue
        }
        const sub = create(channel)
        entries.set(channel, { sub, holders: new Set([holder]) })
        sub.subscribe()
      }
      return () => {
        if (!holders.delete(holder)) return
        for (const channel of holder.channels) {
          const entry = entries.get(channel)
          if (entry === undefined) continue
          entry.holders.delete(holder)
          if (entry.holders.size > 0) continue
          entries.delete(channel)
          client.removeSubscription(entry.sub)
        }
      }
    },
    onSubscribed(handler): Unsubscribe {
      subscribedHandlers.add(handler)
      return () => {
        subscribedHandlers.delete(handler)
      }
    },
    async refreshTokens(channels) {
      if (closed) return
      const named = channels ?? [...entries.keys()]
      for (const channel of named) {
        const entry = entries.get(channel)
        if (entry === undefined) continue
        // Заміна, а не unsubscribe()/subscribe(): підписка кешує свій токен і
        // без порожнього не кличе `getToken`, тож відкликання не виявилося б.
        client.removeSubscription(entry.sub)
        entry.sub = create(channel)
        entry.sub.subscribe()
      }
    },
    close() {
      if (closed) return
      closed = true
      for (const entry of entries.values()) client.removeSubscription(entry.sub)
      entries.clear()
      holders.clear()
      subscribedHandlers.clear()
      client.disconnect()
    },
  }
}
