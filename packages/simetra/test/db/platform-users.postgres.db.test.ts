import { randomUUID } from "node:crypto"
import pg from "pg"
import { compile } from "simetra/compiler"
import {
  PROVIDER_EVENT_SOURCES,
  PROVIDER_IDENTITY_SOURCES,
  quoteIdent,
} from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  catalog,
  metaFiles,
  project,
} from "../../src/compiler/__tests__/helpers"
import { identityGrantSql } from "../../src/schema/apply/postgres-cluster"
import { migrateBetterAuth, testAuth, type TestAuth } from "./better-auth"
import {
  commandAs,
  loginUrl,
  testDatabaseName,
  testRoleName,
  testSuperuserUrl,
  withRollback,
  withSessionOptions,
} from "./connection"

/**
 * Платформний шар користувачів на таблицях справжньої міграції Better Auth
 * (спека профілю postgres §4): реєстрація, анонімний вхід, прив'язка,
 * конвертація й видалення йдуть подіями Better Auth або тими самими
 * операторами від його ролі входу, тож тригери провізії бачать рядки тієї
 * форми, яку пише бібліотека. DB-рівень, бо події комітить сам Better Auth
 * своїм пулом, а провізію, гонку й claims вирішує сервер. База — тегована:
 * транзакції тесту закомічені, тож відкат не прибрав би їх.
 */

const SOURCE = PROVIDER_IDENTITY_SOURCES.postgres
const PROVIDER = SOURCE.providerKey
const IDENTITY = `${quoteIdent(SOURCE.table.schema)}.${quoteIdent(SOURCE.table.name)}`
const PASSWORD = "platform-users-login"
const USER_PASSWORD = "correct-horse-battery"

const owner = testRoleName("pu_own")
const auth = testRoleName("pu_auth")
const database = testDatabaseName("pu")

/** Та сама адреса, що й у суперкористувача стека, до тегованої бази. */
function inDatabase(): string {
  const url = new URL(testSuperuserUrl())
  url.pathname = `/${database}`
  return url.toString()
}

/** Вхід суперкористувача з роллю тегованого власника — модель з'єднань тестів. */
const ownerUrl = (): string =>
  withSessionOptions(inDatabase(), `-c role=${owner}`)
const authUrl = (): string => loginUrl(inDatabase(), auth, PASSWORD)

async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Модель з «Користувачами» профілю `postgres`. */
async function desiredSql(): Promise<string> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project({ database: { provider: "postgres" } }),
      "catalogs/Users/Users.meta.json": catalog("Users", {
        role: "users",
        scope: "none",
      }),
    })
  )
  expect(result.diagnostics).toEqual([])
  return renderDesiredState(result.model!).sql
}

let instance: { auth: TestAuth; close(): Promise<void> } | undefined
const api = (): TestAuth["api"] => instance!.auth.api

beforeAll(async () => {
  await withClient(testSuperuserUrl(), async (admin) => {
    await admin.query(`CREATE ROLE ${quoteIdent(owner)} NOLOGIN`)
    await admin.query(
      `CREATE ROLE ${quoteIdent(auth)} LOGIN PASSWORD '${PASSWORD}'`
    )
    await admin.query(
      `ALTER ROLE ${quoteIdent(auth)} SET search_path = ${quoteIdent(SOURCE.table.schema)}`
    )
    await admin.query(
      `CREATE DATABASE ${quoteIdent(database)} OWNER ${quoteIdent(owner)}`
    )
  })
  await withClient(inDatabase(), (admin) =>
    admin.query(
      `CREATE SCHEMA ${quoteIdent(SOURCE.table.schema)} AUTHORIZATION ${quoteIdent(auth)}`
    )
  )
  await migrateBetterAuth(authUrl())
  // Гранти власнику тим самим SQL, що дає `roles` після міграції
  const grants = identityGrantSql(owner, SOURCE.table)
  await withClient(inDatabase(), async (admin) => {
    await admin.query(grants.usage)
    await admin.query(grants.table)
  })
  const sql = await desiredSql()
  await withClient(ownerUrl(), async (client) => {
    await client.query("BEGIN")
    await client.query(sql)
    await client.query("COMMIT")
  })
  instance = testAuth(authUrl())
}, 60_000)

afterAll(async () => {
  const failures: unknown[] = []
  await instance?.close().catch((e: unknown) => failures.push(e))
  // База спершу: роль, що володіє схемою в ній, разом із базою не зникне.
  // Кожен крок незалежний від збою попереднього
  await withClient(testSuperuserUrl(), async (admin) => {
    for (const sql of [
      `DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`,
      `DROP ROLE IF EXISTS ${quoteIdent(auth)}`,
      `DROP ROLE IF EXISTS ${quoteIdent(owner)}`,
    ])
      await admin.query(sql).catch((e: unknown) => failures.push(e))
  })
  if (failures.length > 0) throw failures[0]
}, 60_000)

interface UserRow {
  id: string
  description: string
  invalid: boolean
}

const users = (id: string): Promise<UserRow[]> =>
  withClient(
    ownerUrl(),
    async (c) =>
      (
        await c.query<UserRow>(
          "SELECT id, description, invalid FROM public.users WHERE id = $1",
          [id]
        )
      ).rows
  )

const identities = (
  subject: string
): Promise<{ provider: string; subject: string; user_id: string }[]> =>
  withClient(
    ownerUrl(),
    async (c) =>
      (
        await c.query<{ provider: string; subject: string; user_id: string }>(
          "SELECT provider, subject, user_id FROM simetra.identities WHERE subject = $1",
          [subject]
        )
      ).rows
  )

/** Рядок Better Auth: є він чи ні, — від суперкористувача-спостерігача. */
const accountExists = (id: string): Promise<boolean> =>
  withClient(
    inDatabase(),
    async (c) =>
      (await c.query(`SELECT 1 FROM ${IDENTITY} WHERE id = $1`, [id]))
        .rowCount === 1
  )

const asAuth = (sql: string, params: unknown[]): Promise<unknown> =>
  withClient(authUrl(), (c) => c.query(sql, params))

const email = (): string => `${randomUUID()}@example.test`

async function signUpEmail(name: string, mail = email()): Promise<string> {
  const { user } = await api().signUpEmail({
    body: { email: mail, password: USER_PASSWORD, name },
  })
  return user.id
}

async function signInAnonymous(): Promise<{ id: string; cookie: string }> {
  const { headers, response } = await api().signInAnonymous({
    returnHeaders: true,
  })
  // Cookie сесії аноніма — так браузер несе її на реєстрацію
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")
  return { id: response!.user.id, cookie }
}

/** Бекенд, що чекає важкого замка, — з іншої сесії. */
async function waitForLock(observer: pg.Client, pid: number): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 50) {
    const { rows } = await observer.query<{ wait: string | null }>(
      "SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = $1",
      [pid]
    )
    if (rows[0]?.wait === "Lock") return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`backend ${pid} never waited on a lock`)
}

describe("platform users layer on Better Auth", () => {
  it("signUpEmail provisions one identity and one user named after name", async () => {
    const id = await signUpEmail("Ada Lovelace")
    expect(await identities(id)).toEqual([
      { provider: PROVIDER, subject: id, user_id: id },
    ])
    expect(await users(id)).toEqual([
      { id, description: "Ada Lovelace", invalid: false },
    ])
  })

  it("signUpEmail with an empty name names the user after the email", async () => {
    const mail = email()
    const id = await signUpEmail("", mail)
    expect((await users(id)).map((u) => u.description)).toEqual([mail])
  })

  it("signInAnonymous is not provisioned", async () => {
    const { id } = await signInAnonymous()
    expect(await accountExists(id)).toBe(true)
    expect(await identities(id)).toEqual([])
    expect(await users(id)).toEqual([])
  })

  it("linking: signUpEmail from an anonymous session provisions the new user and deletes the anonymous one", async () => {
    const anonymous = await signInAnonymous()
    const { user } = await api().signUpEmail({
      body: { email: email(), password: USER_PASSWORD, name: "Linked" },
      headers: new Headers({ cookie: anonymous.cookie }),
    })
    expect(user.id).not.toBe(anonymous.id)
    expect(await users(user.id)).toEqual([
      { id: user.id, description: "Linked", invalid: false },
    ])
    // Анонім не мав ідентичності: його видалення нікого не робить недійсним
    expect(await accountExists(anonymous.id)).toBe(false)
    expect(await identities(anonymous.id)).toEqual([])
    expect(await users(anonymous.id)).toEqual([])
  })

  it("in-place conversion by UPDATE provisions once; a repeated UPDATE adds nothing", async () => {
    const { id } = await signInAnonymous()
    const convert = () =>
      asAuth(`UPDATE ${IDENTITY} SET "isAnonymous" = false WHERE id = $1`, [id])
    await convert()
    expect(await identities(id)).toEqual([
      { provider: PROVIDER, subject: id, user_id: id },
    ])
    const once = await users(id)
    expect(once.map((u) => ({ id: u.id, invalid: u.invalid }))).toEqual([
      { id, invalid: false },
    ])
    await convert()
    expect(await identities(id)).toHaveLength(1)
    expect(await users(id)).toEqual(once)
  })

  it("deleting the account as Better Auth does removes the identity and keeps the user invalid", async () => {
    const id = await signUpEmail("Gone")
    // Так видаляє `deleteUser`; API вимагав би `user.deleteUser.enabled` і
    // верифікацію, тож тест іде тим самим оператором від ролі `auth`
    await asAuth(`DELETE FROM ${IDENTITY} WHERE id = $1`, [id])
    expect(await identities(id)).toEqual([])
    expect(await users(id)).toEqual([
      { id, description: "Gone", invalid: true },
    ])
  })

  // Review Focus: дві паралельні провізії тієї самої ідентичності. Порядок
  // фіксований: B стартує, коли A тримає незакомічену вставку, і чекає її
  it("two concurrent provisionings of one subject keep one identity and both return the first user", async () => {
    const subject = randomUUID()
    const first = randomUUID()
    const second = randomUUID()
    const provision = (c: pg.Client, user: string, name: string) =>
      c.query<{ user_id: string }>(
        "SELECT simetra.provision_user($1, $2, $3, $4) AS user_id",
        [PROVIDER, subject, user, name]
      )
    await withClient(ownerUrl(), (a) =>
      withClient(ownerUrl(), (b) =>
        withClient(inDatabase(), async (observer) => {
          const pidB = (
            await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]!.pid
          await a.query("BEGIN")
          const resultA = await provision(a, first, "A")
          await b.query("BEGIN")
          const pendingB = provision(b, second, "B")
          try {
            await waitForLock(observer, pidB)
            await a.query("COMMIT")
          } finally {
            // Шлях збою: B не має висіти на замку A після тесту
            await a.query("ROLLBACK").catch(() => undefined)
          }
          const resultB = await pendingB
          await b.query("COMMIT")
          expect([resultA.rows, resultB.rows]).toEqual([
            [{ user_id: first }],
            [{ user_id: first }],
          ])
        })
      )
    )
    expect(await identities(subject)).toEqual([
      { provider: PROVIDER, subject, user_id: first },
    ])
    expect(await users(second)).toEqual([])
  })

  it("a second insert of the same Better Auth id is 23505 on its key and keeps one user", async () => {
    const id = randomUUID()
    const insert = () =>
      asAuth(
        `INSERT INTO ${IDENTITY} (id, name, email, "emailVerified", "createdAt", "updatedAt", "isAnonymous")
         VALUES ($1, 'Twice', $2, false, now(), now(), false)`,
        [id, email()]
      )
    await insert()
    await expect(insert()).rejects.toMatchObject({
      code: "23505",
      constraint: "user_pkey",
    })
    expect(await users(id)).toEqual([
      { id, description: "Twice", invalid: false },
    ])
    expect(await identities(id)).toHaveLength(1)
  })

  it("current_user_id under the command role reads sub of Better Auth claims", async () => {
    const id = await signUpEmail("Claims")
    const { id: guest } = await signInAnonymous()
    const current = (claims: Record<string, unknown>) =>
      withRollback(
        (c) =>
          commandAs<{ u: string | null }>(
            c,
            claims,
            undefined,
            "SELECT simetra.current_user_id() AS u"
          ),
        ownerUrl()
      )
    expect({
      user: await current({ sub: id, is_anonymous: false }),
      // Анонім не провізований — ідентичності, з якої читає функція, немає
      anonymous: await current({ sub: guest, is_anonymous: true }),
      // Ключ claim — `sub` у нижньому регістрі (спека профілю §4.4)
      upperCase: await current({ SUB: id, is_anonymous: false }),
    }).toEqual({
      user: { rows: [{ u: id }] },
      anonymous: { rows: [{ u: null }] },
      upperCase: { rows: [{ u: null }] },
    })
  })

  it("the columns of the event source of the preset exist in the migrated table", async () => {
    const source = PROVIDER_EVENT_SOURCES.postgres.find(
      (s) => s.schema === SOURCE.table.schema && s.table === SOURCE.table.name
    )
    expect(source).toBeDefined()
    const present = await withClient(
      inDatabase(),
      async (c) =>
        new Set(
          (
            await c.query<{ column_name: string }>(
              `SELECT column_name FROM information_schema.columns
                WHERE table_schema = $1 AND table_name = $2`,
              [SOURCE.table.schema, SOURCE.table.name]
            )
          ).rows.map((r) => r.column_name)
        )
    )
    expect(source!.columns.filter((c) => !present.has(c))).toEqual([])
  })
})
