// Шина вкладок host-а (Р11 D5): вихід в одній вкладці гасить рантайм в усіх
// вкладках цього браузера, що тримають того самого суб'єкта. Шина лише гасить:
// вона нічого не відкриває й не міняє суб'єкта (подія не несе прав, лише факт
// виходу, тому чужа подія за іншого суб'єкта ігнорується).
import type { RuntimeHolder } from "simetra/data"

const CHANNEL_NAME = "simetra-session"

/** Те, що шина бере від `BroadcastChannel`: інакше її не перевірити без браузера. */
export interface TabChannel {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

export interface TabBus {
  /** Повідомляє інші вкладки, що суб'єкт вийшов. Без `BroadcastChannel` мовчить. */
  publishSignedOut(subject: string): void
  /** Починає слухати події інших вкладок; повторний виклик без `close()` нічого не робить. */
  start(): void
  /** Припиняє слухати й закриває канал; після цього `start()` відкриває його знову (StrictMode). */
  close(): void
}

export interface TabBusOptions {
  holder: RuntimeHolder
  toLogin: () => void
  /** Лише для тестів; у браузері — `BroadcastChannel`, а де його немає — `undefined`. */
  createChannel?: () => TabChannel | undefined
}

function defaultChannel(): TabChannel | undefined {
  return typeof BroadcastChannel === "undefined"
    ? undefined
    : (new BroadcastChannel(CHANNEL_NAME) as unknown as TabChannel)
}

/** Подія рівно такої форми: інша форма — не наша подія. */
function signedOutSubject(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const { type, subject } = data as { type?: unknown; subject?: unknown }
  if (type !== "signed-out" || typeof subject !== "string") return undefined
  return subject
}

export function createTabBus(options: TabBusOptions): TabBus {
  const { holder, toLogin } = options
  const createChannel = options.createChannel ?? defaultChannel
  let listening: TabChannel | undefined

  return {
    publishSignedOut(subject) {
      // Одноразовий канал: надсилання не залежить від того, чи вкладка слухає
      const channel = createChannel()
      if (channel === undefined) return
      try {
        channel.postMessage({ type: "signed-out", subject })
      } finally {
        channel.close()
      }
    },
    start() {
      if (listening !== undefined) return
      const channel = createChannel()
      if (channel === undefined) return
      channel.onmessage = (event) => {
        const subject = signedOutSubject(event.data)
        // Лише для суб'єкта, якого ця вкладка тримає зараз: пізня чи чужа подія
        // не має закрити рантайм іншого користувача
        if (subject === undefined || subject !== holder.current()?.subject) {
          return
        }
        holder.replace(undefined, "signed-out")
        toLogin()
      }
      listening = channel
    },
    close() {
      const channel = listening
      listening = undefined
      if (channel === undefined) return
      channel.onmessage = null
      channel.close()
    },
  }
}
