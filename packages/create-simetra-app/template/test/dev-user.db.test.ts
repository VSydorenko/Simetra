import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import pg from "pg"
import { ensurePostgresCluster, type PostgresClusterSet } from "simetra/schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApplyDatabase } from "../../../designer/src/schema-engine"
import {
  dropTaggedCluster,
  prepareStackIdentity,
  roleUrl,
  setTestPasswords,
  taggedClusterSet,
  testSuperuserUrl,
} from "../../../simetra/test/support"
import { authSchemaOptions, withAuthOptions } from "../scripts/auth-options.mjs"
import { DevGuardRefusal, createDevUser } from "../scripts/dev-user.mjs"

/**
 * `dev-user` на тегованій базі прогону. DB-рівень, бо запобіжник читає
 * каталог бази (`pg_db_role_setting`), а запис користувача робить справжній
 * Better Auth під ролею `simetra_auth` зі схемою `better_auth`.
 */
/** DSN той самий, база інша. */
function withDatabaseName(dsn: string, database: string): string {
  const url = new URL(dsn)
  url.pathname = `/${database}`
  return url.toString()
}

const ORIGIN = "http://localhost:3000"
const SECRET = "simetra-dev-user-test-secret-0123456789"
const FLAG = "simetra.environment"

let set: PostgresClusterSet
let authUrl: string

async function superuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: withDatabaseName(testSuperuserUrl(), set.database),
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const userCount = () =>
  superuser(async (client) =>
    Number(
      (await client.query('SELECT count(*) AS n FROM better_auth."user"'))
        .rows[0].n
    )
  )

const credentialHash = (email: string) =>
  superuser(
    async (client) =>
      (
        await client.query(
          `SELECT a.password FROM better_auth.account a
             JOIN better_auth."user" u ON u.id = a."userId"
            WHERE u.email = $1 AND a."providerId" = 'credential'`,
          [email]
        )
      ).rows[0]?.password as string | undefined
  )

const emailVerified = (email: string) =>
  superuser(
    async (client) =>
      (
        await client.query(
          'SELECT "emailVerified" AS v FROM better_auth."user" WHERE email = $1',
          [email]
        )
      ).rows[0]?.v as boolean | undefined
  )

const sessionCount = (email: string) =>
  superuser(async (client) =>
    Number(
      (
        await client.query(
          `SELECT count(*) AS n FROM better_auth.session s
             JOIN better_auth."user" u ON u.id = s."userId"
            WHERE u.email = $1`,
          [email]
        )
      ).rows[0].n
    )
  )

const run = (dsn: string, email = "dev@example.test", password?: string) =>
  createDevUser({
    dsn,
    email,
    name: "Dev",
    origin: ORIGIN,
    secret: SECRET,
    password,
  })

/** Вхід звичайним екземпляром застосунку (без реєстрації): чи діє пароль. */
async function signsIn(email: string, password: string): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: withAuthOptions(authUrl) })
  try {
    const auth = betterAuth(
      authSchemaOptions(pool, { origin: ORIGIN, secret: SECRET })
    )
    return await auth.api
      .signInEmail({ body: { email, password } })
      .then(() => true)
      .catch(() => false)
  } finally {
    await pool.end()
  }
}

beforeAll(async () => {
  set = taggedClusterSet("devusr")
  const url = testSuperuserUrl()
  const result = await ensurePostgresCluster(
    createApplyDatabase({ readOnly: false }),
    {
      maintenance: { url: withDatabaseName(url, "postgres") },
      target: { url: withDatabaseName(url, set.database) },
      template: { url: withDatabaseName(url, set.template) },
    },
    set
  )
  if (!result.ok)
    throw new Error(`roles refused: ${result.error.map((d) => d.code)}`)
  await setTestPasswords(set)
  authUrl = roleUrl(set, set.auth)
  // Міграція за опціями скрипта, як у `db-setup`: так схема має ту саму форму
  await prepareStackIdentity({
    authUrl,
    auth: set.auth,
    migrate: async (url) => {
      const pool = new pg.Pool({ connectionString: withAuthOptions(url) })
      try {
        const { runMigrations } = await getMigrations(
          authSchemaOptions(pool, { origin: ORIGIN, secret: SECRET })
        )
        await runMigrations()
      } finally {
        await pool.end()
      }
    },
  })
}, 120_000)

afterAll(async () => {
  if (set !== undefined) await dropTaggedCluster(set)
}, 60_000)

describe("dev-user", () => {
  it("refuses a database without the database-level flag and writes nothing", async () => {
    await expect(run(authUrl)).rejects.toThrow(DevGuardRefusal)
    await expect(run(authUrl)).rejects.toThrow("database-level flag")
    expect(await userCount()).toBe(0)
  }, 60_000)

  it("is not fooled by the flag in the session options of the DSN", async () => {
    const forged = new URL(authUrl)
    forged.searchParams.set("options", `-c ${FLAG}=development`)
    // Підробка справді діє на сесії: саме її `current_setting` повірив би
    const client = new pg.Client({ connectionString: forged.toString() })
    await client.connect()
    try {
      const { rows } = await client.query("SELECT current_setting($1) AS v", [
        FLAG,
      ])
      expect(rows[0].v).toBe("development")
    } finally {
      await client.end()
    }
    await expect(run(forged.toString())).rejects.toThrow(DevGuardRefusal)
    expect(await userCount()).toBe(0)
  }, 60_000)

  it("is not fooled by a role-level setting, in this database or in all", async () => {
    const role = `"${set.auth}"`
    const db = `"${set.database}"`
    for (const scope of [`IN DATABASE ${db}`, ""]) {
      await superuser((client) =>
        client.query(`ALTER ROLE ${role} ${scope} SET ${FLAG} = 'development'`)
      )
      try {
        await expect(run(authUrl)).rejects.toThrow(DevGuardRefusal)
        expect(await userCount()).toBe(0)
      } finally {
        await superuser((client) =>
          client.query(`ALTER ROLE ${role} ${scope} RESET ${FLAG}`)
        )
      }
    }
  }, 60_000)

  it("refuses a non-loopback host and writes nothing", async () => {
    await superuser((client) =>
      client.query(
        `ALTER DATABASE "${set.database}" SET ${FLAG} = 'development'`
      )
    )
    const remote = new URL(authUrl)
    remote.hostname = "db.example.test"
    await expect(run(remote.toString())).rejects.toThrow("not loopback")
    // `host` у параметрах DSN перекриває хост адреси: loopback у ній не рятує
    const hidden = new URL(authUrl)
    hidden.searchParams.set("host", "db.example.test")
    await expect(run(hidden.toString())).rejects.toThrow("not loopback")
    // Повторний `host`: `URL` бере перший, `pg` — останній, а ходить пул
    for (const order of [
      ["127.0.0.1", "db.example.test"],
      ["localhost", "db.example.test"],
    ]) {
      const twice = new URL(authUrl)
      for (const host of order) twice.searchParams.append("host", host)
      await expect(run(twice.toString())).rejects.toThrow("not loopback")
    }
    expect(await userCount()).toBe(0)
  }, 60_000)

  it("creates a user on a development database", async () => {
    const result = await run(authUrl)
    expect(result.created).toBe(true)
    expect(result.password.length).toBeGreaterThanOrEqual(20)
    expect(await userCount()).toBe(1)
    expect(await signsIn("dev@example.test", result.password)).toBe(true)
    expect(await emailVerified("dev@example.test")).toBe(true)
  }, 60_000)

  it("marks an existing user verified and revokes their sessions on a password change", async () => {
    await superuser(async (client) => {
      await client.query(
        'UPDATE better_auth."user" SET "emailVerified" = false WHERE email = $1',
        ["dev@example.test"]
      )
      await client.query(
        `INSERT INTO better_auth.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), 'devusr-token', id, now() + interval '1 day', now(), now()
           FROM better_auth."user" WHERE email = $1`,
        ["dev@example.test"]
      )
    })
    expect(await emailVerified("dev@example.test")).toBe(false)
    expect(await sessionCount("dev@example.test")).toBeGreaterThan(0)
    const result = await run(authUrl)
    expect(result.created).toBe(false)
    expect(await emailVerified("dev@example.test")).toBe(true)
    expect(await sessionCount("dev@example.test")).toBe(0)
  }, 60_000)

  it("changes the password of an existing user on a repeat run", async () => {
    const before = await credentialHash("dev@example.test")
    const first = await run(authUrl)
    expect(first.created).toBe(false)
    expect(await userCount()).toBe(1)
    expect(await credentialHash("dev@example.test")).not.toBe(before)
    expect(await signsIn("dev@example.test", first.password)).toBe(true)
    const second = await run(authUrl)
    expect(second.password).not.toBe(first.password)
    expect(await signsIn("dev@example.test", second.password)).toBe(true)
    expect(await signsIn("dev@example.test", first.password)).toBe(false)
    expect(await userCount()).toBe(1)
  }, 60_000)
})
