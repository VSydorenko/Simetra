import { Centrifuge, type Subscription } from "centrifuge"
import type { SignalErrorKind } from "simetra/model"
import type { SignalPort } from "./receiver"

/**
 * Порт каналу над Centrifugo (профіль `postgres`, ПП3) для стенду спайку 3.
 * `recovered` з події `subscribed` доходить до приймача: лише він дозволяє
 * пропустити перечитування після короткого розриву. Коректність на ньому не
 * стоїть: recovery «все або нічого», доставка at-most-once.
 */
export function centrifugoTransport(options: {
  url: string
  /** `ws` у Node; у браузері — глобальний `WebSocket`. */
  websocket?: unknown
  /** Додаткова затримка доставки сервер → клієнт, мс (емуляція мережі). */
  downDelayMs?: number
}): SignalPort & { client: Centrifuge; close(): void } {
  const client = new Centrifuge(options.url, {
    ...(options.websocket !== undefined
      ? { websocket: options.websocket }
      : {}),
    minReconnectDelay: 50,
    maxReconnectDelay: 500,
  })
  const subscribed = new Set<(info: { recovered: boolean }) => void>()
  const delay = options.downDelayMs ?? 0
  const later = (f: () => void) => (delay > 0 ? setTimeout(f, delay) : f())
  let subs: Subscription[] = []

  return {
    client,
    subscribe(channels, onSignal, onError) {
      subs = channels.map((channel) => {
        const sub = client.newSubscription(channel)
        sub.on("publication", (ctx) =>
          later(() => onSignal(ctx.channel, ctx.data))
        )
        sub.on("subscribed", (ctx) =>
          later(() => {
            for (const h of subscribed)
              h({ recovered: ctx.wasRecovering && ctx.recovered })
          })
        )
        sub.on("subscribing", (ctx) => {
          // Перехід у `subscribing` після підписки — розрив чи повторне приєднання.
          if (ctx.code !== 0) onError("transport" satisfies SignalErrorKind)
        })
        sub.on("error", () => onError("transport"))
        sub.subscribe()
        return sub
      })
      client.connect()
      return () => {
        for (const s of subs) {
          s.removeAllListeners()
          s.unsubscribe()
          client.removeSubscription(s)
        }
        subs = []
      }
    },
    onSubscribed(handler) {
      subscribed.add(handler)
      return () => subscribed.delete(handler)
    },
    close() {
      client.disconnect()
    },
  }
}
