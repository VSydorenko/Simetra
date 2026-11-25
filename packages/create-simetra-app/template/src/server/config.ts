// Конфіг сервера з оточення (спека П4-D §4.1). Усе читається під час виклику,
// а не при імпорті: збірка й клієнтський бандл не мають падати без оточення.
import { createPrivateKey, createPublicKey } from "node:crypto"
import type { SigningKey } from "simetra/server/signals"

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

/** Налаштовані сигнали: WebSocket-адреса Centrifugo для браузера й ключі підпису. */
export interface SignalsConfig {
  url: string
  keys: SigningKey[]
}

const KEYS_VARIABLE = "SIMETRA_SIGNALS_KEYS"
const URL_VARIABLE = "SIMETRA_SIGNALS_URL"

// Лише ISO 8601 з часом: `new Date("5")` чи `new Date("2020")` розбирає і не те
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

function parseDate(value: unknown, what: string): Date {
  const date =
    typeof value === "string" && ISO_DATE_TIME.test(value)
      ? new Date(value)
      : undefined
  if (date === undefined || Number.isNaN(date.getTime())) {
    throw new Error(`${KEYS_VARIABLE}: ${what} must be an ISO date string`)
  }
  return date
}

// Невідповідний `x` опублікував би ключ, яким жоден токен не перевіряється.
// Перевірка синхронна, щоб зупиняти старт так само, як інші відмови конфігу:
// асинхронна відмова плагіна Nitro процес не зупиняє.
function keyPairMatches(x: string, d: string): boolean {
  try {
    const privateKey = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", x, d },
      format: "jwk",
    })
    const derived = createPublicKey(privateKey).export({ format: "jwk" })
    // Порівняння — сама перевірка: Node 24.15 (`.node-version`, CI) імпортує
    // приватний JWK, ігноруючи `x`; новіші версії відмовляють ще на імпорті
    return derived.x === x
  } catch {
    return false
  }
}

// Повідомлення помилок не несуть значень зі змінної: там приватні ключі, а
// текст помилки потрапляє в журнал процесу
function parseKeys(raw: string): SigningKey[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${KEYS_VARIABLE} is not valid JSON`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${KEYS_VARIABLE} must be a non-empty JSON array`)
  }
  const seen = new Set<string>()
  return parsed.map((item: unknown, index): SigningKey => {
    const at = `${KEYS_VARIABLE}[${index}]`
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${at} must be an object`)
    }
    const { kid, privateJwk, addedAt, retiredAt } = item as Record<
      string,
      unknown
    >
    if (typeof kid !== "string" || kid === "") {
      throw new Error(`${at}.kid must be a non-empty string`)
    }
    if (seen.has(kid)) {
      throw new Error(`${KEYS_VARIABLE}: kid "${kid}" is repeated`)
    }
    seen.add(kid)
    if (
      typeof privateJwk !== "object" ||
      privateJwk === null ||
      Array.isArray(privateJwk)
    ) {
      throw new Error(`${at}.privateJwk must be an object`)
    }
    const jwk = privateJwk as Record<string, unknown>
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
      throw new Error(`${at}.privateJwk must be an Ed25519 key (OKP)`)
    }
    if (typeof jwk.x !== "string" || typeof jwk.d !== "string") {
      throw new Error(`${at}.privateJwk needs both x and d`)
    }
    if (!keyPairMatches(jwk.x, jwk.d)) {
      throw new Error(
        `${KEYS_VARIABLE}: key "${kid}" is not an Ed25519 key pair (x must match d)`
      )
    }
    const key: SigningKey = {
      kid,
      privateJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d },
      addedAt: parseDate(addedAt, `${at}.addedAt`),
    }
    if (retiredAt !== undefined) {
      key.retiredAt = parseDate(retiredAt, `${at}.retiredAt`)
    }
    return key
  })
}

/**
 * Сигнали — опційна частина конфігу: обидві змінні або жодної. Одна без іншої,
 * не `ws:`/`wss:` адреса чи хибні ключі зупиняють старт (як `appOrigin`), а не
 * мовчки вимикають сигнали.
 */
export function signalsConfig(): SignalsConfig | undefined {
  const url = process.env[URL_VARIABLE]
  const keys = process.env[KEYS_VARIABLE]
  const hasUrl = url !== undefined && url !== ""
  const hasKeys = keys !== undefined && keys !== ""
  if (!hasUrl && !hasKeys) return undefined
  if (!hasUrl || !hasKeys) {
    throw new Error(
      `${URL_VARIABLE} and ${KEYS_VARIABLE} must be set together or not at all`
    )
  }
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    protocol = ""
  }
  if (protocol !== "ws:" && protocol !== "wss:") {
    throw new Error(`${URL_VARIABLE} must be a ws: or wss: URL`)
  }
  return { url, keys: parseKeys(keys) }
}

/** Ключі сервера авторизації агентів (спека П4-F §5.4, §6). */
export interface AgentOauthKeys {
  /** Перший підписує cookie, решта лише перевіряють (ротація). */
  cookieKeys: string[]
  signingKey: { kty: "OKP"; crv: "Ed25519"; x: string; d: string }
}

const COOKIE_KEYS_VARIABLE = "SIMETRA_AGENT_OAUTH_COOKIE_KEYS"
const SIGNING_KEY_VARIABLE = "SIMETRA_AGENT_OAUTH_SIGNING_KEY"
// Ключ cookie коротший за 32 символи легко перебрати
const COOKIE_KEY_MIN_LENGTH = 32

function parseCookieKeys(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${COOKIE_KEYS_VARIABLE} is not valid JSON`)
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(
      (k): k is string =>
        typeof k === "string" && k.length >= COOKIE_KEY_MIN_LENGTH
    )
  ) {
    throw new Error(
      `${COOKIE_KEYS_VARIABLE} must be a non-empty JSON array of strings of at least ${COOKIE_KEY_MIN_LENGTH} characters`
    )
  }
  return parsed
}

function parseSigningKey(raw: string): AgentOauthKeys["signingKey"] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${SIGNING_KEY_VARIABLE} is not valid JSON`)
  }
  const jwk = (
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {}
  ) as Record<string, unknown>
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    typeof jwk.d !== "string"
  ) {
    throw new Error(
      `${SIGNING_KEY_VARIABLE} must be a private Ed25519 JWK (kty OKP, crv Ed25519, x and d)`
    )
  }
  if (!keyPairMatches(jwk.x, jwk.d)) {
    throw new Error(
      `${SIGNING_KEY_VARIABLE} is not an Ed25519 key pair (x must match d)`
    )
  }
  return { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }
}

/**
 * Ключі сервера авторизації агентів (Р-F4-1): обидві змінні або жодної. Одна
 * без іншої чи хибне значення зупиняють старт будь-де; без обох production не
 * стартує, а розробка дістає `undefined` — ефемерні ключі процесу бере вже
 * модуль сервера авторизації, щоб легкий конфіг їх не генерував на імпорті.
 */
export function agentOauthKeys(): AgentOauthKeys | undefined {
  const cookie = process.env[COOKIE_KEYS_VARIABLE]
  const signing = process.env[SIGNING_KEY_VARIABLE]
  const hasCookie = cookie !== undefined && cookie !== ""
  const hasSigning = signing !== undefined && signing !== ""
  if (!hasCookie && !hasSigning) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `${COOKIE_KEYS_VARIABLE} and ${SIGNING_KEY_VARIABLE} are required in production`
      )
    }
    return undefined
  }
  if (!hasCookie || !hasSigning) {
    throw new Error(
      `${COOKIE_KEYS_VARIABLE} and ${SIGNING_KEY_VARIABLE} must be set together or not at all`
    )
  }
  return {
    cookieKeys: parseCookieKeys(cookie),
    signingKey: parseSigningKey(signing),
  }
}
