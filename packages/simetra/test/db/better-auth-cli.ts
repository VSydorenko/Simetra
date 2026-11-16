// Крок `db:pg:start`: міграція Better Auth у базі `simetra` від ролі `auth`.
// Гранти власнику на таблицю ідентичності дає повторний `simetra roles` після
// неї. Запуск:
// `node --import tsx packages/simetra/test/db/better-auth-cli.ts`, DSN — лише
// зі змінних середовища (argv видно в `ps`).
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { STACK_LOCK_ENV } from "../../../../scripts/db-stack.mjs"
import { postgresClusterSet } from "../../src/schema/apply/postgres-cluster"
import { migrateBetterAuth } from "./better-auth"

/** Env variable with the DSN of the identity login role (`auth`). */
export const AUTH_URL_ENV = "SIMETRA_AUTH_URL"

/**
 * Migrates Better Auth as the `auth` role of the profile. Refuses, before the
 * migration, a DSN that logs in as another role: the tables would get the
 * wrong owner. Grants nothing: the owner grants come from `simetra roles`.
 */
export async function prepareStackIdentity(o: {
  authUrl: string
  /** Роль входу Better Auth з даних профілю; DSN мусить відкривати саме її. */
  auth: string
  migrate?: (authUrl: string) => Promise<void>
}): Promise<void> {
  if (decodeURIComponent(new URL(o.authUrl).username) !== o.auth)
    throw new Error(
      "The auth DSN does not log in as the auth role of the profile; nothing was changed"
    )
  await (o.migrate ?? migrateBetterAuth)(o.authUrl)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is not set`)
  return value
}

// Лише як команда: тест імпортує `prepareStackIdentity`
function invokedAsCommand(): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return (
      realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
}

if (invokedAsCommand()) {
  // Міграція — під замком стека, як і решта `db:pg:start`: запуск
  // повз скрипт ішов би посеред чужого DB-прогону
  if (!process.env[STACK_LOCK_ENV]) {
    console.error(
      `better-auth-cli: ${STACK_LOCK_ENV} is not set; run it through pnpm db:pg:start, which holds the stack lock`
    )
    process.exit(1)
  }
  prepareStackIdentity({
    authUrl: requiredEnv(AUTH_URL_ENV),
    auth: postgresClusterSet("simetra").auth,
  }).catch((error: unknown) => {
    console.error(
      `better-auth-cli: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  })
}
