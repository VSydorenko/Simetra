import { randomUUID } from "node:crypto"
import type pg from "pg"

/** Поля облікового запису провайдера, які задає тест; решта — типові. */
export interface Account {
  email?: string | null
  phone?: string
  meta?: Record<string, unknown> | null
  anonymous?: boolean
}

/**
 * Реєстрація облікового запису так, як її робить сервіс автентифікації:
 * провізія створює рядок «Користувачів» з тим самим id.
 */
export async function signUp(
  client: pg.Client,
  account: Account = {}
): Promise<string> {
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
