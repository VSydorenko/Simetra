import { betterAuth } from "better-auth"
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
import { DevUserRefusal, createDevUser } from "../scripts/dev-user.mjs"

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
  await prepareStackIdentity({ authUrl, auth: set.auth })
}, 120_000)

afterAll(async () => {
  if (set !== undefined) await dropTaggedCluster(set)
}, 60_000)

describe("dev-user", () => {
  it("refuses a database without the database-level flag and writes nothing", async () => {
    await expect(run(authUrl)).rejects.toThrow(DevUserRefusal)
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
    await expect(run(forged.toString())).rejects.toThrow(DevUserRefusal)
    expect(await userCount()).toBe(0)
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
    expect(await userCount()).toBe(0)
  }, 60_000)

  it("creates a user on a development database", async () => {
    const result = await run(authUrl)
    expect(result.created).toBe(true)
    expect(result.password.length).toBeGreaterThanOrEqual(20)
    expect(await userCount()).toBe(1)
    expect(await signsIn("dev@example.test", result.password)).toBe(true)
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
