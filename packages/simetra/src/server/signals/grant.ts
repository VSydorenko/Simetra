/**
 * The permission to sign signal tokens: the subject (`current_user_id()`, or
 * `null` for an invalid user) and the channels `runtime.authorizeChannels`
 * allowed it. Only that function produces one; a plain object of the same
 * shape is refused by the token port.
 */
export interface ChannelGrant {
  readonly subject: string | null
  readonly channels: readonly string[]
}

// Клеймо гранту — у модулі, а не в полі об'єкта: поле можна скопіювати в
// підробку, а членство в приватному `WeakSet` — ні. Модуль внутрішній: його
// конструктор не входить у публічний вхід `simetra/server/signals`, тож грант
// дає лише `authorizeChannels` після перевірки прав під роллю запиту.
const grants = new WeakSet<object>()

/** Internal: the only producer is `runtime.authorizeChannels`. */
export function createChannelGrant(
  subject: string | null,
  channels: readonly string[]
): ChannelGrant {
  // Заморожена копія: канал, дописаний у грант після перевірки прав, токена
  // не отримує.
  const grant: ChannelGrant = Object.freeze({
    subject,
    channels: Object.freeze([...channels]),
  })
  grants.add(grant)
  return grant
}

export function isChannelGrant(value: unknown): value is ChannelGrant {
  return typeof value === "object" && value !== null && grants.has(value)
}
