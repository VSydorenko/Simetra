// Конфіг сервера з оточення (спека П4-D §4.1). Усе читається під час виклику,
// а не при імпорті: збірка й клієнтський бандл не мають падати без оточення.

/** Канонічне походження застосунку: схема, хост, порт без шляху. */
export function appOrigin(): string {
  const value = process.env.SIMETRA_APP_ORIGIN
  if (value === undefined || value === "") {
    throw new Error("SIMETRA_APP_ORIGIN is not set")
  }
  // `new URL(v).origin === v` відсікає шлях, слеш наприкінці й "null"
  let canonical: boolean
  try {
    canonical = new URL(value).origin === value
  } catch {
    canonical = false
  }
  if (!canonical) {
    throw new Error(
      "SIMETRA_APP_ORIGIN must be a canonical origin (scheme, host, optional port, no path)"
    )
  }
  return value
}

/** Секрет Better Auth; у production без нього сервер не стартує. */
export function authSecret(): string | undefined {
  const value = process.env.BETTER_AUTH_SECRET
  if (value !== undefined && value !== "") return value
  if (process.env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET is required in production")
  }
  return undefined
}

/** Обов'язкове значення оточення (DSN пулів). */
export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is not set`)
  return value
}
