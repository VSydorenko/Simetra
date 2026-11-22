// Клієнтські колбеки токенів сигналів (Р9, Р12 D5): по одному екземпляру на
// транспорт і суб'єкта. Нічого не кешується (Р7, І6): токен і грант свіжі на
// кожне з'єднання та кожну пачку каналів — відкликання права діє одразу.
import type { RuntimeHolder } from "simetra/data"
import {
  SignalAuthRefused,
  type CentrifugoTransportOptions,
} from "simetra/data/centrifugo"

const CONNECTION_TOKEN_URL = "/simetra/signals/connection-token"
const CHANNEL_TOKENS_URL = "/simetra/signals/channel-tokens"
/** Стеля каналів в одному запиті: більше — наступний запит. */
const MAX_CHANNELS_PER_REQUEST = 256

export type SignalTokenCallbacks = Pick<
  CentrifugoTransportOptions,
  "getConnectionToken" | "getChannelToken"
> & {
  /** Скидає пакетувальник: виклики після закриття відхиляються. */
  close(): void
}

export interface SignalTokenCallbacksOptions {
  subject: string
  holder: RuntimeHolder
  navigateToLogin: () => void
  /** Лише для тестів; у браузері — глобальний `fetch` (той самий origin). */
  fetch?: typeof fetch
}

interface Waiter {
  resolve: (token: string) => void
  reject: (error: unknown) => void
}

export function createSignalTokenCallbacks(
  options: SignalTokenCallbacksOptions
): SignalTokenCallbacks {
  const { subject, holder, navigateToLogin } = options
  const doFetch = options.fetch ?? ((...args) => fetch(...args))
  let closed = false
  let pending = new Map<string, Waiter[]>()
  let scheduled = false

  /**
   * Відповідь, що не дає токенів: 401/403 — відмова (`SignalAuthRefused`),
   * решта — звичайна помилка, яку SDK повторить. Заміна тримача лише для
   * суб'єкта, якого він тримає зараз: пізня відповідь старого суб'єкта не має
   * закрити живий рантайм наступного (як `clientTransport`).
   */
  async function post(url: string, body: unknown): Promise<unknown> {
    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (response.status === 401 || response.status === 403) {
      if (response.status === 401) {
        let reason: unknown
        try {
          reason = ((await response.json()) as { reason?: unknown }).reason
        } catch {
          reason = undefined
        }
        // Звірка після `await`: за час читання тіла тримач міг змінитися (інший
        // суб'єкт, вихід) чи його вже закрила паралельна 401 цієї ж пачки.
        // Перша заміна обнуляє поточний рантайм, тож друга й наступні мовчать
        if (holder.current()?.subject === subject) {
          holder.replace(
            undefined,
            reason === "session-changed" ? "session-changed" : "signed-out"
          )
          navigateToLogin()
        }
      }
      throw new SignalAuthRefused(`signal token refused (${response.status})`)
    }
    if (!response.ok) throw new Error(`signal tokens: HTTP ${response.status}`)
    try {
      return await response.json()
    } catch {
      throw new Error("signal tokens: unparsable response")
    }
  }

  async function sendChunk(
    channels: string[],
    waiters: Map<string, Waiter[]>
  ): Promise<void> {
    try {
      const body = (await post(CHANNEL_TOKENS_URL, {
        subject,
        channels,
      })) as { tokens?: { channel: string; token: string }[] }
      if (!Array.isArray(body?.tokens)) {
        throw new Error("signal tokens: unparsable response")
      }
      const tokens = new Map(body.tokens.map((t) => [t.channel, t.token]))
      for (const channel of channels) {
        const token = tokens.get(channel)
        for (const waiter of waiters.get(channel) ?? []) {
          // Канал поза грантом — відмова лише йому, тримач не чіпаємо
          if (typeof token === "string") waiter.resolve(token)
          else waiter.reject(new SignalAuthRefused())
        }
      }
    } catch (error) {
      for (const list of waiters.values()) {
        for (const waiter of list) waiter.reject(error)
      }
    }
  }

  function flush(): void {
    scheduled = false
    const batch = pending
    pending = new Map()
    const channels = [...batch.keys()]
    for (let i = 0; i < channels.length; i += MAX_CHANNELS_PER_REQUEST) {
      const chunk = channels.slice(i, i + MAX_CHANNELS_PER_REQUEST)
      void sendChunk(
        chunk,
        new Map(chunk.map((channel) => [channel, batch.get(channel)!]))
      )
    }
  }

  return {
    async getConnectionToken() {
      if (closed) throw new Error("signal token callbacks are closed")
      const body = (await post(CONNECTION_TOKEN_URL, { subject })) as {
        token?: unknown
      }
      if (typeof body?.token !== "string") {
        throw new Error("signal tokens: unparsable response")
      }
      return body.token
    },
    getChannelToken(channel) {
      if (closed) {
        return Promise.reject(new Error("signal token callbacks are closed"))
      }
      return new Promise<string>((resolve, reject) => {
        const waiters = pending.get(channel) ?? []
        waiters.push({ resolve, reject })
        pending.set(channel, waiters)
        if (!scheduled) {
          scheduled = true
          queueMicrotask(flush)
        }
      })
    },
    close() {
      closed = true
      const dropped = pending
      pending = new Map()
      for (const list of dropped.values()) {
        for (const waiter of list) {
          waiter.reject(new Error("signal token callbacks are closed"))
        }
      }
    },
  }
}
