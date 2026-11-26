import { createHmac } from "node:crypto"
import { betterAuth, type BetterAuthOptions } from "better-auth"
import { anonymous, emailOTP } from "better-auth/plugins"
import type { Pool } from "pg"
import { getAuthPool } from "./auth-db"
import {
  appOrigin,
  authSecret,
  authSettings,
  type AuthSettings,
  type OAuthProviderSettings,
} from "./config"
import { defer } from "./defer"
import type { MailTransport } from "./mail"
import { mailTransport } from "./mail-dev"

// Ключ хешу коду без секрету auth; секрету немає лише поза production
// (`authSecret`), тож стала не захищає жодного справжнього коду
const DEV_OTP_KEY = "simetra-dev-email-otp-key"

/**
 * Код у сховищі — HMAC коду з префіксом призначення на секреті auth (Р-D5-4):
 * `"hashed"` плагіна — несолений SHA-256 (`defaultKeyHasher`), а шість цифр
 * перебираються за мить. Порівняння лишається штатним `constantTimeEqual`
 * (`verifyStoredOTP`, `plugins/email-otp/otp-token.mjs`).
 */
function otpHash(secret: string | undefined) {
  const key = secret ?? DEV_OTP_KEY
  return (otp: string): Promise<string> =>
    Promise.resolve(
      createHmac("sha256", key).update(`email-otp:${otp}`).digest("base64url")
    )
}

function emailCodePlugin(
  settings: AuthSettings,
  secret: string | undefined,
  mail: MailTransport | undefined
) {
  if (mail === undefined) {
    // Без транспорту код не дійшов би до людини; production це відсікає ще
    // на старті (`assertAuthStartable`)
    throw new Error("email-code sign-in needs a mail transport")
  }
  return emailOTP({
    disableSignUp: settings.signUp === "closed",
    allowedAttempts: 5,
    expiresIn: 600,
    storeOTP: { hash: otpHash(secret) },
    rateLimit: { window: 60, max: 3 },
    sendVerificationOTP: ({ email, otp }) =>
      mail.send({
        to: email,
        subject: "Your sign-in code",
        text: `Your sign-in code is ${otp}. It expires in 10 minutes.`,
      }),
  })
}

// `disableSignUp` — у самих опціях провайдера: колбек читає лише
// `provider.options?.disableSignUp` (`api/routes/callback.mjs`), а
// `disableImplicitSignUp` знімає `requestSignUp` клієнта
function socialProviders(settings: AuthSettings) {
  return Object.fromEntries(
    settings.providers.map((provider: OAuthProviderSettings) => [
      provider.id,
      {
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        disableSignUp: settings.signUp === "closed",
      },
    ])
  )
}

/**
 * Конфіг Better Auth шаблону (спека П4-D §4.3, Р-D5-3). Окрема функція від
 * пула, походження, налаштувань входу й транспорту — щоб тест читав таблицю
 * опцій рядок за рядком без бази. `session.cookieCache` свідомо відсутній: кеш
 * cookie тримав би відкликану сесію до закінчення кешу. `account.accountLinking`
 * не задається: неявне зв'язування OAuth вимагає перевіреної адреси запису
 * (`requireLocalEmailVerified` типово `true`, `oauth2/link-account.mjs`), а
 * `trustedProviders` немає.
 */
export function authOptions(
  database: Pool,
  origin: string,
  secret: string | undefined,
  settings: AuthSettings,
  mail: MailTransport | undefined,
  // Годинник слота надсилання (Р-D5-6); тест ставить керований
  now: () => Date = () => new Date()
) {
  return {
    database,
    baseURL: origin,
    trustedOrigins: [origin],
    secret,
    // Пароль не реєструє за жодного `signUp`; `sendVerificationEmail` не
    // задається, тож запис з `emailVerified: false` паролем не входить (`403`,
    // `signInEmail`, `api/routes/sign-in.mjs`)
    emailAndPassword: {
      enabled: settings.password,
      disableSignUp: true,
      requireEmailVerification: true,
    },
    socialProviders: socialProviders(settings),
    user: {
      // Запис з неперевіреною адресою не створює жоден спосіб (І-8): виклик —
      // у `createUser` (`db/internal-adapter.mjs`). Лише створення: `sign-in` і
      // `link-account` несуть дані провайдера, а не новий запис
      validateUserInfo: ({ user, source }) =>
        source.action === "create-user" && user.emailVerified !== true
          ? { error: "email_not_verified" }
          : undefined,
    },
    plugins: [
      anonymous(),
      ...(settings.emailCode ? [emailCodePlugin(settings, secret, mail)] : []),
    ],
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
      // Лист коду йде після відповіді (`runInBackgroundOrAwait`,
      // `context/create-context.mjs`)
      backgroundTasks: { handler: defer },
    },
  } satisfies BetterAuthOptions
}

function createAuth() {
  return betterAuth(
    authOptions(
      getAuthPool(),
      appOrigin(),
      authSecret(),
      authSettings(),
      mailTransport()
    )
  )
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
