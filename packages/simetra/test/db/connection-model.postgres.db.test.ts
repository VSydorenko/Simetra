// Модель з'єднання тестів на стеку `postgres` (спека профілю §10.3,
// запобіжники 1–4): кожне з'єднання з адреси тестів стартує власником, вихід
// у суперкористувача й інша роль входу повертають попередній стан на обох
// шляхах, а дрейф ролі ловить `withRollback`. З'єднання рушія й pg-delta з
// тієї самої адреси перевіряє парний тест designer-а.
import pg from "pg"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
} from "simetra/model"
import { afterEach, describe, expect, it, vi } from "vitest"
import { maintenanceSql } from "../../src/compiler/rights/guard-units"
import {
  asSessionLogin,
  asStackSuperuser,
  expectFileEndRoles,
  expectPoolRole,
  restoreOwnerRole,
  setLocalSetting,
  testDatabaseUrl,
  testOwnerLoginUrl,
  testRoleName,
  testSuperuserUrl,
  withRollback,
  withSessionOptions,
} from "./connection"
import { testProvider } from "./profile"

const provider = testProvider()
const OWNER = PROVIDER_OWNER_ROLES[provider]
const SUPERUSER = new URL(testSuperuserUrl()).username
// Інша роль входу стека для вкладеного `asSessionLogin`
const OTHER_LOGIN = PROVIDER_LOGIN_ROLES[provider][0]!

interface Who {
  current: string
  session: string
  path: string
}

async function who(client: pg.Client | pg.PoolClient): Promise<Who> {
  const { rows } = await client.query<Who>(
    "SELECT current_user AS current, session_user AS session, current_setting('search_path') AS path"
  )
  return rows[0]!
}

async function roleExists(client: pg.Client, name: string): Promise<boolean> {
  const { rows } = await client.query(
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
    [name]
  )
  return rows.length > 0
}

describe("every connection from the test URL starts as the owner", () => {
  it("(i) two pooled connections held at once: the owner, with the superuser as the session", async () => {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 })
    try {
      const [a, b] = await Promise.all([pool.connect(), pool.connect()])
      try {
        for (const client of [a!, b!]) {
          expect(await who(client)).toMatchObject({
            current: OWNER,
            session: SUPERUSER,
          })
          const { rows } = await client.query(
            "SELECT rolsuper, rolbypassrls, rolcreatedb FROM pg_catalog.pg_roles WHERE rolname = current_user"
          )
          expect(rows[0]).toEqual({
            rolsuper: false,
            rolbypassrls: true,
            rolcreatedb: true,
          })
        }
      } finally {
        a!.release()
        b!.release()
      }
    } finally {
      await pool.end()
    }
  })

  it("(iii) the owner reaches the command and request roles without a grant to itself", async () => {
    await withRollback(async (client) => {
      await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
      expect((await who(client)).current).toBe(PLATFORM_ROLES.command)
      await restoreOwnerRole(client)
      await client.query(`SET LOCAL ROLE ${PROVIDER_API_ROLES[provider].user}`)
      expect((await who(client)).current).toBe(
        PROVIDER_API_ROLES[provider].user
      )
      await restoreOwnerRole(client)
      expect((await who(client)).current).toBe(OWNER)
    })
  })

  it("(v) withSessionOptions keeps the owner and adds the setting", async () => {
    const client = new pg.Client({
      connectionString: withSessionOptions(
        testDatabaseUrl(),
        "-c bytea_output=escape"
      ),
    })
    await client.connect()
    try {
      expect((await who(client)).current).toBe(OWNER)
      const { rows } = await client.query("SHOW bytea_output")
      expect(rows[0]).toEqual({ bytea_output: "escape" })
    } finally {
      await client.end()
    }
  })

  it("(vi) testOwnerLoginUrl logs the owner in directly", async () => {
    const client = new pg.Client({ connectionString: testOwnerLoginUrl() })
    await client.connect()
    try {
      expect(await who(client)).toMatchObject({
        current: OWNER,
        session: OWNER,
      })
    } finally {
      await client.end()
    }
  })
})

describe("(ii) asStackSuperuser", () => {
  const PROBE = "connection_model_probe"

  it("restores the owner and search_path after a successful fn", async () => {
    await withRollback(async (client) => {
      await client.query(`CREATE TABLE public.${PROBE} (x int)`)
      const before = await who(client)
      const role = testRoleName("cm_ok")
      const inside = await asStackSuperuser(client, async () => {
        await client.query(`CREATE ROLE ${role} NOLOGIN`)
        return who(client)
      })
      expect(inside.current).toBe(SUPERUSER)
      expect(inside.path).toBe("pg_catalog, pg_temp")
      expect(await who(client)).toEqual(before)
      expect(await roleExists(client, role)).toBe(true)
      // Некваліфіковане ім'я знову знаходить таблицю `public`
      await client.query(`SELECT x FROM ${PROBE}`)
    })
  })

  it("restores the owner and search_path and drops the work of a failed fn", async () => {
    await withRollback(async (client) => {
      await client.query(`CREATE TABLE public.${PROBE} (x int)`)
      const before = await who(client)
      const role = testRoleName("cm_fail")
      await expect(
        asStackSuperuser(client, async () => {
          await client.query(`CREATE ROLE ${role} NOLOGIN`)
          throw new Error("fn failed")
        })
      ).rejects.toThrow("fn failed")
      expect(await who(client)).toEqual(before)
      expect(await roleExists(client, role)).toBe(false)
      await client.query(`SELECT x FROM ${PROBE}`)
    })
  })

  it("returns to the command role it was called from", async () => {
    await withRollback(async (client) => {
      await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
      await asStackSuperuser(client, () => client.query("SELECT 1"))
      expect((await who(client)).current).toBe(PLATFORM_ROLES.command)
    })
  })

  it("puts an extension created with SCHEMA into that schema", async () => {
    await withRollback(async (client) => {
      await asStackSuperuser(client, () =>
        client.query("CREATE EXTENSION citext SCHEMA extensions")
      )
      const { rows } = await client.query(
        "SELECT extnamespace::regnamespace::text AS schema FROM pg_catalog.pg_extension WHERE extname = 'citext'"
      )
      expect(rows).toEqual([{ schema: "extensions" }])
    })
  })
})

// Шлях виклику помічника: успіх має завершитися, збій — відмовою саме `fn`
async function settle(path: string, run: Promise<unknown>): Promise<void> {
  if (path === "failure") await expect(run).rejects.toThrow("fn failed")
  else await run
}

describe("(ii′) asSessionLogin", () => {
  it.each([
    ["success", (): Promise<void> => Promise.resolve()],
    ["failure", (): Promise<void> => Promise.reject(new Error("fn failed"))],
  ] as const)(
    "returns the stack superuser session and the owner on %s",
    async (_path, end) => {
      await withRollback(async (client) => {
        const before = await who(client)
        let inside: Who | undefined
        await settle(
          _path,
          asSessionLogin(client, OWNER, async () => {
            inside = await who(client)
            await end()
          })
        )
        expect(inside).toMatchObject({ current: OWNER, session: OWNER })
        expect(await who(client)).toEqual(before)
        expect(before).toMatchObject({ current: OWNER, session: SUPERUSER })
      })
    }
  )

  it.each([
    ["success", (): Promise<void> => Promise.resolve()],
    ["failure", (): Promise<void> => Promise.reject(new Error("fn failed"))],
  ] as const)(
    "nested in another login, returns the outer login and search_path on %s",
    async (_path, end) => {
      await withRollback(async (client) => {
        await asSessionLogin(client, OTHER_LOGIN, async () => {
          await client.query(
            "SELECT set_config('search_path', 'extensions, public', true)"
          )
          const outer = await who(client)
          expect(outer).toMatchObject({
            current: OTHER_LOGIN,
            session: OTHER_LOGIN,
          })
          await settle(
            _path,
            asSessionLogin(client, OWNER, async () => {
              await client.query(
                "SELECT set_config('search_path', 'pg_catalog', true)"
              )
              await end()
            })
          )
          expect(await who(client)).toEqual(outer)
        })
      })
    }
  )

  it("returns to the command role it was called from", async () => {
    await withRollback(async (client) => {
      await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
      await asSessionLogin(client, OWNER, () => client.query("SELECT 1"))
      expect(await who(client)).toMatchObject({
        current: PLATFORM_ROLES.command,
        session: SUPERUSER,
      })
    })
  })

  // Гард режиму обслуговування вимагає `session_user = current_user`: на
  // адресі тестів сесія — суперкористувач, і засів пройде лише під входом
  // власника
  it("lets a seed under the maintenance mode pass the maintenance guard", async () => {
    await withRollback(async (client) => {
      const guard = `SELECT ${maintenanceSql(provider)} AS ok`
      await setLocalSetting(client, RIGHTS_MAINTENANCE_SETTING, "on")
      expect((await client.query(guard)).rows).toEqual([{ ok: false }])
      await asSessionLogin(client, OWNER, async () => {
        await setLocalSetting(client, RIGHTS_MAINTENANCE_SETTING, "on")
        expect((await client.query(guard)).rows).toEqual([{ ok: true }])
      })
    })
  })
})

describe("(vii) withRollback catches a role drift in the test that caused it", () => {
  it("a legal command role until the end of the transaction passes", async () => {
    await withRollback(async (client) => {
      await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
    })
  })

  // Збій `fn` у перерваній транзакції: першопричина, а не помилка перевірки
  it("a failing fn in an aborted transaction gives the root cause", async () => {
    await expect(
      withRollback(async (client) => {
        await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
        await client.query("SELECT 1 / 0")
      })
    ).rejects.toMatchObject({ code: "22012" })
  })

  // Кожен кейс — на власному клієнті: перевірка одного не бачить ролі іншого
  const holdRole = async (client: pg.Client, role: string): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await who(client)).current).toBe(role)
  }

  it.concurrent(
    "concurrent cases with different roles: the command role",
    async () => {
      await withRollback(async (client) => {
        await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
        await holdRole(client, PLATFORM_ROLES.command)
      })
    }
  )

  it.concurrent(
    "concurrent cases with different roles: the request role",
    async () => {
      await withRollback(async (client) => {
        await client.query(
          `SET LOCAL ROLE ${PROVIDER_API_ROLES[provider].user}`
        )
        await holdRole(client, PROVIDER_API_ROLES[provider].user)
      })
    }
  )
})

describe("the checks of the setup file", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // Нове з'єднання з адреси тестів наприкінці файлу: не власник — збій
  it("a test URL that no longer starts as the owner fails the end-of-file check", async () => {
    vi.stubEnv("SIMETRA_TEST_DATABASE_URL", testSuperuserUrl())
    await expect(expectFileEndRoles()).rejects.toThrow(
      `runs as ${SUPERUSER} (superuser), not ${OWNER}`
    )
  })

  // Клієнт, якого тест не повернув, інакше вішав би перевірку пулу
  it("a pool with a client still checked out fails within the deadline, with its counters", async () => {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 })
    const held = await pool.connect()
    try {
      await expect(expectPoolRole(pool, 300)).rejects.toThrow(
        /within 300 ms \(totalCount 1, idleCount 0, waitingCount 1\)/
      )
    } finally {
      held.release()
      await pool.end()
    }
  })

  it("a pool whose clients run as its start role passes", async () => {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 })
    try {
      const [a, b] = await Promise.all([pool.connect(), pool.connect()])
      a!.release()
      b!.release()
      await expectPoolRole(pool)
    } finally {
      await pool.end()
    }
  })
})
