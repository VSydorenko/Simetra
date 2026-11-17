import { betterAuth, type BetterAuthOptions } from "better-auth"
import { anonymous } from "better-auth/plugins"
import type { Pool } from "pg"
import { getAuthPool } from "./auth-db"
import { appOrigin, authSecret } from "./config"

/**
 * Конфіг Better Auth шаблону (спека П4-D §4.3). Окрема функція від пула й
 * походження — щоб тест читав таблицю опцій рядок за рядком без бази.
 * `session.cookieCache` свідомо відсутній: кеш cookie тримав би відкликану
 * сесію до закінчення кешу.
 */
export function authOptions(
  database: Pool,
  origin: string,
  secret: string | undefined
) {
  return {
    database,
    baseURL: origin,
    trustedOrigins: [origin],
    secret,
    emailAndPassword: { enabled: true, disableSignUp: true },
    plugins: [anonymous()],
    // Анонімного входу немає, доки немає екрана гостя: endpoint без екрана
    // лише плодить рядки `better_auth.user`
    disabledPaths: ["/sign-in/anonymous"],
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    advanced: {
      // Серверний entry ставить цей заголовок сам (адреса сокета чи довіреного
      // проксі); без нього лічильник був би один на всіх клієнтів
      ipAddress: { ipAddressHeaders: ["x-simetra-client-ip"] },
      database: { generateId: "uuid" },
      useSecureCookies: origin.startsWith("https://"),
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax", // правило П4-B §4.5 спирається на Lax
        secure: origin.startsWith("https://"),
      },
    },
  } satisfies BetterAuthOptions
}

function createAuth() {
  return betterAuth(authOptions(getAuthPool(), appOrigin(), authSecret()))
}

let auth: ReturnType<typeof createAuth> | undefined

/** Екземпляр Better Auth: ліниво, один на процес. */
export function getAuth(): ReturnType<typeof createAuth> {
  auth ??= createAuth()
  return auth
}

type GetSession = (args: { headers: Headers }) => Promise<{
  user: { id: string; isAnonymous?: boolean | null }
} | null>

/** Claims сесії застосунку; `sub` — UUID користувача нижнім регістром. */
export type AppClaims = { sub: string; is_anonymous: boolean }

/** Адаптер сесії → claims (спека профілю §4.4); `sub` — нижнім регістром. */
export function createVerifySession(getSession: GetSession) {
  return async (headers: Headers): Promise<AppClaims | null> => {
    const session = await getSession({ headers })
    if (session === null) return null
    return {
      sub: session.user.id.toLowerCase(),
      // Завжди булеве: профіль з `anonymousClaim` вимагає claim у запиті
      is_anonymous: session.user.isAnonymous === true,
    }
  }
}

export function verifySession(headers: Headers): Promise<AppClaims | null> {
  return createVerifySession((args) => getAuth().api.getSession(args))(headers)
}
