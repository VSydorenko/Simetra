/** Код помилки (`command.*`, `data.*`): єдине, що з помилки йде клієнту. */
const CODE = /^(?:command|data)\.[a-z][a-z-]*$/

/**
 * Код помилки без тексту: код у `code` (`DataError`, відмова команди) чи сам
 * `message`, якщо це вже код; усе інше — загальне `command.internal`.
 */
export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && CODE.test(code)) return code
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && CODE.test(message)) return message
  }
  return "command.internal"
}

/**
 * Роутер дегідрує помилку збігу разом з її `message` (ShallowErrorPlugin), а
 * текст помилки `pg` чи loader-а — хост, роль, запит — клієнту не належить
 * (§4.2). Тож помилка збігу замінюється помилкою з одним кодом.
 */
export function codedError(code: string): Error {
  return new Error(code)
}

interface MatchLike {
  error?: unknown
}

/**
 * Замінює помилки збігів кодованими; оригінал іде в журнал host-а. Викликається
 * на сервері після `router.load()` і до `dehydrate()`: після нього текст уже в
 * потоці. Помилка, що вже є кодом, лишається як є (повторний виклик нешкідливий).
 */
export function sanitizeMatchErrors(
  matches: readonly MatchLike[],
  log: (error: unknown) => void
): void {
  for (const match of matches) {
    const original = match.error
    if (original === undefined) continue
    if (
      original instanceof Error &&
      original.message === errorCode(original) &&
      Object.keys(original).length === 0
    ) {
      continue
    }
    log(original)
    match.error = codedError(errorCode(original))
  }
}
