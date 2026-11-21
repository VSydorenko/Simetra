import type { SignalError, SignalTransport, Unsubscribe } from "simetra/model"

/** Фейковий канал сигналів для unit-тестів приймача: керується з тесту. */
export interface FakeSignalTransport extends SignalTransport {
  /** Доставляє сигнал підписникам каналу топіка (топік = канал у фейку). */
  emit(topic: string, payload: unknown): void
  /** Імітує (пере)підписку каналу: кличе `onSubscribed`. */
  join(channel: string, recovered: boolean): void
  /** Кличе `onError` усіх підписників. */
  fail(error: SignalError): void
  /** Канали, яким сервер відмовляє: `refreshTokens` їх закриває. */
  readonly refused: Set<string>
  /** Скільки підписок зараз живе на кожному каналі. */
  subscribed(): ReadonlyMap<string, number>
  /** Чи закрито транспорт `close()`. */
  closed(): boolean
}

interface Subscription {
  channels: ReadonlySet<string>
  onSignal: (topic: string, payload: unknown) => void
  onError: (error: SignalError) => void
}

export function createFakeSignalTransport(): FakeSignalTransport {
  const subscriptions = new Set<Subscription>()
  const subscribedHandlers = new Set<
    (event: { channel: string; recovered: boolean }) => void
  >()
  const refused = new Set<string>()
  let isClosed = false

  return {
    refused,
    subscribe(channels, onSignal, onError): Unsubscribe {
      if (isClosed) return () => {}
      const subscription: Subscription = {
        channels: new Set(channels),
        onSignal,
        onError,
      }
      subscriptions.add(subscription)
      return () => {
        subscriptions.delete(subscription)
      }
    },
    onSubscribed(handler): Unsubscribe {
      subscribedHandlers.add(handler)
      return () => {
        subscribedHandlers.delete(handler)
      }
    },
    async refreshTokens(channels) {
      const targets = [...refused].filter(
        (channel) => channels === undefined || channels.includes(channel)
      )
      for (const channel of targets) {
        for (const subscription of [...subscriptions]) {
          if (!subscription.channels.has(channel)) continue
          const rest = new Set(subscription.channels)
          rest.delete(channel)
          subscription.channels = rest
          subscription.onError({ kind: "auth", channel })
        }
      }
    },
    close() {
      isClosed = true
      subscriptions.clear()
      subscribedHandlers.clear()
    },
    emit(topic, payload) {
      for (const subscription of [...subscriptions]) {
        if (subscription.channels.has(topic)) {
          subscription.onSignal(topic, payload)
        }
      }
    },
    join(channel, recovered) {
      for (const handler of [...subscribedHandlers]) {
        handler({ channel, recovered })
      }
    },
    fail(error) {
      for (const subscription of [...subscriptions]) subscription.onError(error)
    },
    subscribed() {
      const counts = new Map<string, number>()
      for (const subscription of subscriptions) {
        for (const channel of subscription.channels) {
          counts.set(channel, (counts.get(channel) ?? 0) + 1)
        }
      }
      return counts
    },
    closed: () => isClosed,
  }
}
