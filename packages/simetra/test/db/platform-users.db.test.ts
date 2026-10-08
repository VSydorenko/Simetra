import { randomInt, randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile } from "simetra/compiler"
import { PROVIDER_IDENTITY_SOURCES } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  attribute,
  catalog,
  metaFiles,
  project,
} from "../../src/compiler/__tests__/helpers"
import { asRole, queryAs, withRollback } from "./connection"

/**
 * Платформний шар `simetra` на справжньому стеку Supabase (спека користувачів
 * §3–§7): провізія з реєстрації в `auth.users`, недійсність при видаленні,
 * поточний користувач під claims ролей API. Тести писано проти спеки, а не
 * проти згенерованого тексту: предмет — поведінка, яку бачить провайдер.
 */

/**
 * Довжина найменування, відмінна від типової: обрізання мусить брати її з
 * моделі, а не з константи.
 */
const DESCRIPTION_LENGTH = 40

async function deploy(client: pg.Client): Promise<void> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project(),
      // Власний обов'язковий реквізит зі значенням заповнення: провізія
      // вставляє лише ключ і найменування, тож решту мусить дати DEFAULT
      // (Review Focus 1).
      "catalogs/Users/Users.meta.json": catalog("Users", {
        role: "users",
        scope: "none",
        descriptionLength: DESCRIPTION_LENGTH,
        attributes: [
          attribute("locale", {
            type: "String",
            length: 5,
            required: true,
            defaultValue: "uk",
          }),
        ],
      }),
    })
  )
  expect(result.diagnostics).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
}

interface Account {
  email?: string | null
  phone?: string
  meta?: Record<string, unknown> | null
  anonymous?: boolean
}

/** Реєстрація облікового запису так, як її робить сервіс автентифікації. */
async function signUp(
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

interface UserRow {
  id: string
  description: string
  invalid: boolean
  user_kind: string
  locale: string
}

async function users(client: pg.Client, id: string): Promise<UserRow[]> {
  const { rows } = await client.query<UserRow>(
    "SELECT id, description, invalid, user_kind, locale FROM public.users WHERE id = $1",
    [id]
  )
  return rows
}

async function identities(
  client: pg.Client,
  subject: string
): Promise<{ provider: string; subject: string; user_id: string }[]> {
  const { rows } = await client.query<{
    provider: string
    subject: string
    user_id: string
  }>(
    "SELECT provider, subject, user_id FROM simetra.identities WHERE subject = $1",
    [subject]
  )
  return rows
}

async function count(client: pg.Client, table: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`
  )
  return rows[0]!.n
}

const authenticated = (sub: string) => ({ sub, role: "authenticated" })

describe("platform users layer in Postgres", () => {
  it("signup provisions one identity and one user", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const id = await signUp(client, {
        email: "ada@example.test",
        meta: { full_name: "Ada Lovelace", name: "ada" },
      })
      expect(await identities(client, id)).toEqual([
        { provider: "supabase", subject: id, user_id: id },
      ])
      // id користувача = id облікового запису (С8); власний реквізит — зі
      // значення заповнення, платформні — з типових.
      expect(await users(client, id)).toEqual([
        {
          id,
          description: "Ada Lovelace",
          invalid: false,
          user_kind: "human",
          locale: "uk",
        },
      ])
    })
  })

  it("provisioning twice keeps one user", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const id = await signUp(client, { meta: { name: "Grace" } })
      const before = [
        await count(client, "public.users"),
        await count(client, "simetra.identities"),
      ]
      // Повторний виклик тієї самої ідентичності, навіть з іншим id і ім'ям,
      // повертає наявного користувача.
      const { rows } = await client.query<{ user_id: string }>(
        "SELECT simetra.provision_user('supabase', $1, gen_random_uuid(), 'Other') AS user_id",
        [id]
      )
      expect(rows).toEqual([{ user_id: id }])
      expect([
        await count(client, "public.users"),
        await count(client, "simetra.identities"),
      ]).toEqual(before)
      expect((await users(client, id)).map((u) => u.description)).toEqual([
        "Grace",
      ])
    })
  })

  it("anonymous signup is not provisioned", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const id = await signUp(client, { email: null, anonymous: true })
      expect(await identities(client, id)).toEqual([])
      expect(await users(client, id)).toEqual([])
    })
  })

  it("phone signup gets a neutral display name", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const id = await signUp(client, {
        email: null,
        phone: `380${randomInt(100_000_000, 999_999_999)}`,
        meta: null,
      })
      expect((await users(client, id)).map((u) => u.description)).toEqual([
        `user ${id.slice(0, 8)}`,
      ])
    })
  })

  it("a long display name is truncated", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const long = "N".repeat(DESCRIPTION_LENGTH * 3)
      const id = await signUp(client, { meta: { full_name: long } })
      expect((await users(client, id)).map((u) => u.description)).toEqual([
        long.slice(0, DESCRIPTION_LENGTH),
      ])
    })
  })

  it("deleting the account invalidates the user and keeps the row", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const id = await signUp(client)
      await client.query("DELETE FROM auth.users WHERE id = $1", [id])
      expect(await identities(client, id)).toEqual([])
      expect((await users(client, id)).map((u) => u.invalid)).toEqual([true])
    })
  })

  it("soft-deleting the account invalidates the user", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const id = await signUp(client)
      await client.query(
        "UPDATE auth.users SET deleted_at = now() WHERE id = $1",
        [id]
      )
      expect(await identities(client, id)).toEqual([])
      expect((await users(client, id)).map((u) => u.invalid)).toEqual([true])
    })
  })

  it.each([
    ["valid", "id"],
    ["invalid", "null"],
    ["non-uuid sub", "null"],
    ["anon without sub", "null"],
  ] as const)("current_user_id for %s", async (situation, expected) => {
    await withRollback(async (client) => {
      await deploy(client)
      const id = await signUp(client)
      if (situation === "invalid") {
        // Платформа заблокувала людину: ідентичність жива, токен чинний.
        await client.query(
          "UPDATE public.users SET invalid = true WHERE id = $1",
          [id]
        )
      }
      const [role, claims] =
        situation === "anon without sub"
          ? (["anon", { role: "anon" }] as const)
          : ([
              "authenticated",
              authenticated(situation === "non-uuid sub" ? "not-a-uuid" : id),
            ] as const)
      const result = await queryAs<{ u: string | null }>(
        client,
        role,
        claims,
        "SELECT simetra.current_user_id() AS u"
      )
      expect(result).toEqual({ rows: [{ u: expected === "id" ? id : null }] })
    })
  })

  it("authenticated sees rows through a wrapped policy and cannot read identities", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const alice = await notesOf(client)
      const bob = await signUp(client)
      await client.query(
        "INSERT INTO public.platform_note (owner_id) VALUES ($1), ($2)",
        [alice, bob]
      )
      expect(
        await queryAs<{ owner_id: string }>(
          client,
          "authenticated",
          authenticated(alice),
          "SELECT owner_id FROM public.platform_note"
        )
      ).toEqual({ rows: [{ owner_id: alice }] })
      expect(
        await queryAs(
          client,
          "authenticated",
          authenticated(alice),
          "SELECT * FROM simetra.identities"
        )
      ).toEqual({ code: "42501" })
    })
  })

  it("an invalid user with a valid token sees nothing", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const alice = await notesOf(client)
      await client.query(
        "INSERT INTO public.platform_note (owner_id) VALUES ($1)",
        [alice]
      )
      await client.query(
        "UPDATE public.users SET invalid = true WHERE id = $1",
        [alice]
      )
      // Перемикання ролі без точки збереження: решта транзакції — запит
      // користувача, як у PostgREST.
      await asRole(client, "authenticated", authenticated(alice))
      const { rows } = await client.query(
        "SELECT owner_id FROM public.platform_note"
      )
      expect(rows).toEqual([])
    })
  })

  it("identity source columns exist in the stack", async () => {
    // Факт провайдера в T0: колонка, якої немає в стеку, зірвала б
    // створення тригерів чи реєстрацію.
    const source = PROVIDER_IDENTITY_SOURCES.supabase
    const wanted = [
      source.keyColumn,
      ...source.nameSources.map((s) => ("column" in s ? s.column : s.json)),
      ...(source.anonymousColumn === undefined ? [] : [source.anonymousColumn]),
      ...(source.deletedAtColumn === undefined ? [] : [source.deletedAtColumn]),
    ]
    await withRollback(async (client) => {
      const { rows } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2`,
        [source.table.schema, source.table.name]
      )
      const present = new Set(rows.map((r) => r.column_name))
      expect(wanted.filter((c) => !present.has(c))).toEqual([])
    })
  })
})

/**
 * Таблиця застосунку з RLS і політикою в обгортці `(select …)` (С9) і
 * зареєстрований власник її рядків. Таблиця — поза моделлю: предмет — функція
 * сесії в політиці, а не генерація політик (П3).
 */
async function notesOf(client: pg.Client): Promise<string> {
  await client.query(`
    CREATE TABLE public.platform_note (owner_id uuid NOT NULL);
    ALTER TABLE public.platform_note ENABLE ROW LEVEL SECURITY;
    CREATE POLICY platform_note_own ON public.platform_note FOR SELECT
      TO authenticated USING (owner_id = (select simetra.current_user_id()));
    GRANT SELECT ON public.platform_note TO authenticated;
  `)
  return signUp(client)
}
