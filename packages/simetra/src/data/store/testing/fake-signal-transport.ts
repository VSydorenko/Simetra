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
  /** Скільки разів `subscribe` викликано після `close()`: порт цього не визначає. */
  subscribesAfterClose(): number
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
  let afterClose = 0

  // Відмова каналу: лише його тримачі дізнаються, канал для них закрито.
  const refuse = (channel: string) => {
    for (const subscription of [...subscriptions]) {
      if (!subscription.channels.has(channel)) continue
      const rest = new Set(subscription.channels)
      rest.delete(channel)
      subscription.channels = rest
      subscription.onError({ kind: "auth", channel })
    }
  }

  return {
    refused,
    subscribe(channels, onSignal, onError): Unsubscribe {
      if (isClosed) {
        afterClose++
        return () => {}
      }
      const allowed = channels.filter((channel) => !refused.has(channel))
      const subscription: Subscription = {
        channels: new Set(allowed),
        onSignal,
        onError,
      }
      subscriptions.add(subscription)
      for (const channel of channels) {
        if (refused.has(channel)) onError({ kind: "auth", channel })
      }
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
      const named = (channel: string) =>
        channels === undefined || channels.includes(channel)
      for (const channel of [...refused].filter(named)) refuse(channel)
      // Дозволені канали перепідписуються: кожен дає onSubscribed(recovered: false).
      const held = new Set<string>()
      for (const subscription of subscriptions) {
        for (const channel of subscription.channels) held.add(channel)
      }
      for (const channel of held) {
        if (named(channel) && !refused.has(channel)) {
          for (const handler of [...subscribedHandlers]) {
            handler({ channel, recovered: false })
          }
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
      if (error.channel !== undefined) {
        if (error.kind === "auth") {
          refuse(error.channel)
        } else {
          for (const subscription of [...subscriptions]) {
            if (subscription.channels.has(error.channel)) {
              subscription.onError(error)
            }
          }
        }
        return
      }
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
    subscribesAfterClose: () => afterClose,
  }
}
