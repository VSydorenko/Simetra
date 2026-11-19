import { isChannelGrant, type ChannelGrant } from "./grant"

/** The host path that serves `SignalTokens.jwks()` (postgres profile spec §6.3). */
export const SIGNALS_JWKS_PATH = "/simetra/signals/jwks"

/** A private Ed25519 key in JWK form (`kty: "OKP"`, `crv: "Ed25519"`, `x`, `d`). */
export interface PrivateJwk {
  kty?: string
  crv?: string
  x?: string
  d?: string
  [member: string]: unknown
}

/**
 * One signing key of the host. A new key is added to the JWKS first and signs
 * no earlier than 65 minutes after `addedAt`; `retiredAt` is when it stopped
 * signing, and it stays in the JWKS for 20 minutes more (postgres profile spec
 * §6.3).
 */
export interface SigningKey {
  kid: string
  privateJwk: PrivateJwk
  addedAt: Date
  retiredAt?: Date
}

/** A public key of the JWKS: exactly these members, never a private one. */
export interface SignalPublicJwk {
  kty: "OKP"
  crv: "Ed25519"
  x: string
  kid: string
  alg: "EdDSA"
  use: "sig"
}

/** A signed JWT and the moment it stops being valid. */
export interface SignalToken {
  token: string
  expiresAt: Date
}

/** A subscription token bound to one channel. */
export interface SignalChannelToken extends SignalToken {
  channel: string
}

/**
 * Signs Centrifugo tokens (P4-B spec §8.3). It reads no database: what it
 * signs comes only from a `ChannelGrant` of `runtime.authorizeChannels`.
 */
export interface SignalTokens {
  /** The connection token of the grant's subject; a grant without a user has none. */
  connectionToken(grant: ChannelGrant): Promise<SignalToken>
  /** One token per channel of the grant, exactly those channels. */
  channelTokens(grant: ChannelGrant): Promise<SignalChannelToken[]>
  /** The keys Centrifugo verifies with: active ones and ones retired under 20 minutes ago; never throws. */
  jwks(): { keys: SignalPublicJwk[] }
}

export interface CentrifugoTokensOptions {
  /** The host's signing keys; at least one must be active and, after a retirement, mature. */
  keys: readonly SigningKey[]
  /** `centrifugo:<project.name>`. */
  audience: string
  /** The host origin. */
  issuer: string
  /** The clock; defaults to the system time, replaced in tests. */
  now?: () => Date
}

/**
 * Why signing failed; a host maps the code to its response.
 * - `signals.invalid-key`, `signals.duplicate-kid`: a configuration error, fail at start-up.
 * - `signals.no-signing-key`, `signals.no-mature-key`: no key may sign now, answer 503 and alert.
 * - `signals.forged-grant`: the grant did not come from `authorizeChannels`, a host bug, answer 500.
 * - `signals.no-user`: the grant has no valid user, answer 401.
 */
export type SignalTokenErrorCode =
  | "signals.invalid-key"
  | "signals.duplicate-kid"
  | "signals.no-signing-key"
  | "signals.no-mature-key"
  | "signals.forged-grant"
  | "signals.no-user"

export class SignalTokenError extends Error {
  readonly code: SignalTokenErrorCode
  constructor(code: SignalTokenErrorCode, message: string) {
    super(message)
    this.name = "SignalTokenError"
    this.code = code
  }
}

const MINUTE = 60_000
// Centrifugo v6 кешує JWKS 5 хв (профіль §6.3). 65 хв — свідомо консервативний
// запас над строком кешу, а не величина, виведена з «до години»: ключ, доданий
// пізніше за останнє читання кешу, підписувати не можна, доки кеш не перечитано.
const MATURE_AFTER = 65 * MINUTE
// Найдовший TTL токена (15 хв) плюс запас: токен, підписаний перед
// відставкою ключа, перевіряється до кінця свого строку.
const JWKS_GRACE = 20 * MINUTE
const CONNECTION_TTL = 15 * MINUTE
const CHANNEL_TTL = 5 * MINUTE

const ED25519 = { name: "Ed25519" } as const

// Тип ключа WebCrypto — з самого API: глобальний `CryptoKey` у типах Node —
// значення, а не тип.
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

interface LoadedKey {
  key: SigningKey
  privateKey: CryptoKey
  publicJwk: SignalPublicJwk
}

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const encodeJson = (value: object) =>
  base64url(encoder.encode(JSON.stringify(value)))

async function load(key: SigningKey): Promise<LoadedKey> {
  const jwk = key.privateJwk
  const invalid = (why: string) =>
    new SignalTokenError(
      "signals.invalid-key",
      `Signing key "${key.kid}": ${why}.`
    )
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519")
    throw invalid('only Ed25519 keys (kty "OKP", crv "Ed25519") are accepted')
  if (typeof jwk.x !== "string" || typeof jwk.d !== "string")
    throw invalid("a private JWK with both x and d is required")
  const publicJwk: SignalPublicJwk = {
    kty: "OKP",
    crv: "Ed25519",
    x: jwk.x,
    kid: key.kid,
    alg: "EdDSA",
    use: "sig",
  }
  // Імпорт приватного JWK звіряє `x` з `d` (WebCrypto Node — `DataError`):
  // невідповідний `x` опублікував би ключ, яким жоден токен не перевіряється,
  // і Centrifugo відкидав би всі з'єднання без пояснення.
  let privateKey: CryptoKey
  try {
    privateKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d },
      ED25519,
      false,
      ["sign"]
    )
  } catch {
    throw invalid("the JWK is not an Ed25519 key pair (x must match d)")
  }
  return { key, privateKey, publicJwk }
}

const retiredBy = (key: SigningKey, now: number) =>
  key.retiredAt !== undefined && key.retiredAt.getTime() <= now

/**
 * The port over Centrifugo: Ed25519 JWTs (`alg: "EdDSA"`, a `kid` in every
 * header), a 15-minute connection token and 5-minute channel tokens. Throws
 * `SignalTokenError` on a non-Ed25519 key or a repeated `kid`.
 */
export async function createCentrifugoTokens(
  options: CentrifugoTokensOptions
): Promise<SignalTokens> {
  const { audience, issuer } = options
  const now = options.now ?? (() => new Date())
  const seen = new Set<string>()
  for (const key of options.keys) {
    if (seen.has(key.kid))
      throw new SignalTokenError(
        "signals.duplicate-kid",
        `Signing key id "${key.kid}" is repeated; every key needs its own kid.`
      )
    seen.add(key.kid)
  }
  const keys = await Promise.all(options.keys.map(load))
  // Перший запуск — жоден ключ ще не відставлено: старого ключа в кеші JWKS
  // Centrifugo немає, тож найстаріший ключ підписує одразу. Після першої
  // відставки незрілий наступник ще може бути відсутній у кеші — тоді
  // відмова, а не токен, який Centrifugo не перевірить.
  const firstRun = options.keys.every((k) => k.retiredAt === undefined)

  function signer(at: number): LoadedKey {
    const active = keys.filter((k) => !retiredBy(k.key, at))
    if (active.length === 0)
      throw new SignalTokenError(
        "signals.no-signing-key",
        "No signing key is active: every key is retired."
      )
    const byAdded = [...active].sort(
      (a, b) => a.key.addedAt.getTime() - b.key.addedAt.getTime()
    )
    const mature = byAdded.filter(
      (k) => k.key.addedAt.getTime() <= at - MATURE_AFTER
    )
    const newest = mature.at(-1)
    if (newest !== undefined) return newest
    if (firstRun) return byAdded[0]!
    throw new SignalTokenError(
      "signals.no-mature-key",
      "A key is retired but no active key was added at least 65 minutes ago; Centrifugo may not know the successor yet."
    )
  }

  async function sign(
    claims: Record<string, string | number>,
    ttl: number
  ): Promise<SignalToken> {
    const at = now().getTime()
    const { key, privateKey } = signer(at)
    const expiresAt = new Date(at + ttl)
    const head = `${encodeJson({ alg: "EdDSA", typ: "JWT", kid: key.kid })}.${encodeJson(
      {
        ...claims,
        aud: audience,
        iss: issuer,
        exp: Math.floor(expiresAt.getTime() / 1000),
      }
    )}`
    const signature = await crypto.subtle.sign(
      ED25519,
      privateKey,
      encoder.encode(head)
    )
    return {
      token: `${head}.${base64url(new Uint8Array(signature))}`,
      expiresAt,
    }
  }

  function subjectOf(grant: ChannelGrant): string {
    if (!isChannelGrant(grant))
      throw new SignalTokenError(
        "signals.forged-grant",
        "Tokens are signed only for a grant of runtime.authorizeChannels."
      )
    if (grant.subject === null)
      throw new SignalTokenError(
        "signals.no-user",
        "The grant has no valid user; signals need a signed-in user."
      )
    return grant.subject
  }

  return {
    // `async`: відмова — відхилений проміс, а не синхронний виняток.
    connectionToken: async (grant) =>
      sign({ sub: subjectOf(grant) }, CONNECTION_TTL),
    channelTokens: async (grant) => {
      const sub = subjectOf(grant)
      return Promise.all(
        grant.channels.map(async (channel) => ({
          channel,
          ...(await sign({ sub, channel }, CHANNEL_TTL)),
        }))
      )
    },
    jwks: () => {
      const at = now().getTime()
      return {
        keys: keys
          .filter(
            ({ key }) =>
              key.retiredAt === undefined ||
              key.retiredAt.getTime() > at - JWKS_GRACE
          )
          .map(({ publicJwk }) => ({ ...publicJwk })),
      }
    },
  }
}
