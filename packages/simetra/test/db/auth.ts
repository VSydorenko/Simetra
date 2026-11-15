import { randomUUID } from "node:crypto"
import {
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_LOGIN_ROLES,
  quoteIdent,
} from "simetra/model"

import type { RoleClient } from "./connection"
import { testProvider } from "./profile"

/** Поля облікового запису провайдера, які задає тест; решта — типові. */
export interface Account {
  email?: string | null
  phone?: string
  meta?: Record<string, unknown> | null
  anonymous?: boolean
}

/**
 * Реєстрація облікового запису так, як її робить сервіс автентифікації:
 * провізія створює рядок «Користувачів» з тим самим id. Таблиця й роль
 * сервісу — з даних профілю прогону.
 */
export async function signUp(
  client: RoleClient,
  account: Account = {}
): Promise<string> {
  if (testProvider() === "postgres") return signUpBetterAuth(client, account)
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO auth.users (id, email, phone, raw_user_meta_data, is_anonymous)
     VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [
      account.email === undefined
        ? `${randomUUID()}@example.test`
        : account.email,
      account.phone ?? null,
      account.meta === undefined ? null : account.meta,
      account.anonymous ?? false,
    ]
  )
  return rows[0]!.id
}

/**
 * Роль входу Better Auth профілю `postgres` — єдиний елемент
 * `PROVIDER_LOGIN_ROLES.postgres`: інший склад переліку робив би вибір ролі
 * вгадуванням.
 */
export function authLoginRole(): string {
  const logins = PROVIDER_LOGIN_ROLES.postgres
  if (logins.length !== 1)
    throw new Error(
      `the postgres profile must name one auth login role, it names ${logins.length}`
    )
  return logins[0]!
}

/**
 * Better Auth вставляє від своєї ролі входу, як у проді: тригер провізії
 * бачить `current_user` сервісу, а DML-гранту власнику на `better_auth` немає.
 * Тож вставка йде від суперкористувача входу (`SESSION AUTHORIZATION
 * DEFAULT`) через `SET LOCAL ROLE` ролі сервісу в точці збереження, а стан
 * викликача — `session_user` і `current_user` — повертається явно на обох
 * шляхах: `SET LOCAL` у точці збереження переживає `RELEASE`, а виклик
 * зсередини `asSessionLogin(власник)` інакше лишив би решту засіву
 * суперкористувачем.
 */
async function signUpBetterAuth(
  client: RoleClient,
  account: Account
): Promise<string> {
  // Better Auth тримає `email` як `NOT NULL`, а аналога телефону й метаданих
  // не має: мовчки відкинуте поле дало б інший обліковий запис, ніж просив тест
  if (account.email === null)
    throw new Error("signUp: email cannot be null on the postgres profile")
  for (const field of ["phone", "meta"] as const)
    if (account[field] !== undefined)
      throw new Error(
        `signUp: ${field} has no Better Auth analogue on the postgres profile`
      )
  const auth = quoteIdent(authLoginRole())
  const { schema, name } = PROVIDER_IDENTITY_SOURCES.postgres.table
  const email = account.email ?? `${randomUUID()}@example.test`
  await client.query("SAVEPOINT sign_up")
  const { rows } = await client.query<{ session: string; role: string }>(
    "SELECT session_user AS session, current_user AS role"
  )
  const before = rows[0]!
  const restore = async (): Promise<void> => {
    await client.query(
      `SET LOCAL SESSION AUTHORIZATION ${quoteIdent(before.session)}`
    )
    await client.query(`SET LOCAL ROLE ${quoteIdent(before.role)}`)
  }
  let id: string
  try {
    await client.query("SET LOCAL SESSION AUTHORIZATION DEFAULT")
    await client.query(`SET LOCAL ROLE ${auth}`)
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(name)} (id, name, email, "emailVerified", "createdAt", "updatedAt", "isAnonymous")
       VALUES (pg_catalog.gen_random_uuid(), $1, $1, false, pg_catalog.now(), pg_catalog.now(), $2) RETURNING id`,
      [email, account.anonymous ?? false]
    )
    id = inserted.rows[0]!.id
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT sign_up")
    await restore()
    throw error
  }
  await restore()
  await client.query("RELEASE SAVEPOINT sign_up")
  return id
}
