// Конфіг Better Auth для скриптів поза `src/`: Node не резолвить
// безрозширені імпорти `src/server/auth.ts`, тож скрипти тримають лише ту
// частину конфіга, що визначає форму схеми й запис користувача. Форма схеми —
// плагіни й `generateId` — мусить збігатися з `src/server/auth.ts`.
import { anonymous } from "better-auth/plugins"

/**
 * Опція з'єднання, що ставить схему Better Auth: зі `database.schemaName`
 * Better Auth шле `CREATE SCHEMA IF NOT EXISTS`, а Postgres вимагає `CREATE` на
 * базу ще до `IF NOT EXISTS` (спека П4-D §4.3).
 */
export const AUTH_SEARCH_PATH = "-c search_path=better_auth"

/** DSN з доданою опцією з'єднання; наявні `options` DSN зберігаються. */
export function withAuthOptions(dsn) {
  const url = new URL(dsn)
  const existing = url.searchParams.get("options")
  url.searchParams.set(
    "options",
    [existing, AUTH_SEARCH_PATH].filter(Boolean).join(" ")
  )
  return url.toString()
}

/** Опції, що визначають форму схеми; `signUp` — лише для `dev-user`. */
export function authSchemaOptions(pool, { origin, secret, signUp = false }) {
  return {
    database: pool,
    baseURL: origin,
    trustedOrigins: [origin],
    secret,
    emailAndPassword: { enabled: true, disableSignUp: !signUp },
    plugins: [anonymous()],
    // Таблицю `rateLimit` Better Auth додає до схеми лише за цього сховища
    rateLimit: { enabled: true, storage: /** @type {const} */ ("database") },
    // `const`-каст: без нього `tsc` розширює літерал до `string`
    advanced: { database: { generateId: /** @type {const} */ ("uuid") } },
  }
}
