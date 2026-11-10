// Крок `db:pg:start` до ПГ-3 (рішення Р13): міграція Better Auth у базі
// `simetra` від ролі `auth` і тимчасові гранти власнику на її схему. Запуск:
// `node --import tsx packages/simetra/test/db/better-auth-cli.ts`, DSN — лише
// зі змінних середовища (argv видно в `ps`).
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { PROVIDER_OWNER_ROLES, quoteIdent } from "simetra/model"
import { STACK_LOCK_ENV } from "../../../../scripts/db-stack.mjs"
import {
  CLUSTER_TRANSACTION_PRELUDE,
  postgresClusterSet,
} from "../../src/schema/apply/postgres-cluster"
import { migrateBetterAuth } from "./better-auth"

/** Env variable with the superuser DSN of the database `simetra`. */
export const SUPERUSER_URL_ENV = "SIMETRA_SUPERUSER_URL"
/** Env variable with the DSN of the identity login role (`auth`). */
export const AUTH_URL_ENV = "SIMETRA_AUTH_URL"

/** Транзакція суперкористувача з прелюдією `roles`: без неї підмінена роль чи `search_path` виконали б SQL не від суперкористувача. */
async function superuserTransaction<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query("BEGIN")
    for (const sql of CLUSTER_TRANSACTION_PRELUDE) await client.query(sql)
    const { rows } = await client.query<{ ok: boolean }>(
      `SELECT (current_user = session_user) AND COALESCE((SELECT r.rolsuper
         FROM pg_catalog.pg_roles r WHERE r.rolname = session_user), false) AS ok`
    )
    if (rows[0]?.ok !== true)
      throw new Error("The superuser DSN does not open a superuser session")
    const value = await fn(client)
    await client.query("COMMIT")
    return value
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

const TABLE_FACTS = `SELECT c.relkind::text AS kind, o.rolname::text AS owner
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
 WHERE n.nspname = 'better_auth' AND c.relname = 'user'`

/**
 * Migrates Better Auth as the `auth` role, then gives `owner` the temporary
 * grants it needs until the platform grants them itself (USAGE on schema
 * `better_auth`, TRIGGER on `better_auth."user"`). Grants are revoked first
 * and given only after a successful migration, so a failed migration never
 * leaves them over a half-migrated schema. Repeating changes nothing.
 */
export async function prepareStackIdentity(o: {
  superuserUrl: string
  authUrl: string
  /** Роль входу Better Auth з даних профілю; DSN мусить відкривати саме її. */
  auth: string
  owner: string
  migrate?: (authUrl: string) => Promise<void>
}): Promise<void> {
  if (decodeURIComponent(new URL(o.authUrl).username) !== o.auth)
    throw new Error(
      "The auth DSN does not log in as the auth role of the profile; nothing was changed"
    )
  const owner = quoteIdent(o.owner)
  await superuserTransaction(o.superuserUrl, async (client) => {
    // REVOKE на відсутню схему чи таблицю — помилка: на свіжій базі відкликати нічого
    const { rows } = await client.query<{ schema: boolean; tbl: boolean }>(
      `SELECT pg_catalog.to_regnamespace('better_auth') IS NOT NULL AS schema,
              pg_catalog.to_regclass('better_auth."user"') IS NOT NULL AS tbl`
    )
    if (rows[0]?.schema === true)
      await client.query(`REVOKE USAGE ON SCHEMA better_auth FROM ${owner}`)
    if (rows[0]?.tbl === true)
      await client.query(`REVOKE TRIGGER ON better_auth."user" FROM ${owner}`)
  })
  await (o.migrate ?? migrateBetterAuth)(o.authUrl)
  await superuserTransaction(o.superuserUrl, async (client) => {
    const { rows } = await client.query<{ kind: string; owner: string }>(
      TABLE_FACTS
    )
    const table = rows[0]
    if (table?.kind !== "r" || table.owner !== o.auth)
      throw new Error(
        'better_auth."user" must be a table owned by the auth role; no grants were given'
      )
    await client.query(`GRANT USAGE ON SCHEMA better_auth TO ${owner}`)
    await client.query(`GRANT TRIGGER ON better_auth."user" TO ${owner}`)
  })
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
  // Міграція й гранти — під замком стека, як і решта `db:pg:start`: запуск
  // повз скрипт ішов би посеред чужого DB-прогону
  if (!process.env[STACK_LOCK_ENV]) {
    console.error(
      `better-auth-cli: ${STACK_LOCK_ENV} is not set; run it through pnpm db:pg:start, which holds the stack lock`
    )
    process.exit(1)
  }
  prepareStackIdentity({
    superuserUrl: requiredEnv(SUPERUSER_URL_ENV),
    authUrl: requiredEnv(AUTH_URL_ENV),
    auth: postgresClusterSet("simetra").auth,
    owner: PROVIDER_OWNER_ROLES.postgres,
  }).catch((error: unknown) => {
    console.error(
      `better-auth-cli: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  })
}
