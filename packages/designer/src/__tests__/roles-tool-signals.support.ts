import { randomBytes } from "node:crypto"
import pg from "pg"
import { PROVIDER_OWNER_ROLES, quoteIdent } from "simetra/model"
import {
  ensurePlatformRoles,
  platformRoleRefusals,
  readPlatformRoles,
  type PlatformRoleSet,
} from "simetra/schema"
import { describe, expect, it } from "vitest"
import {
  asStackSuperuser,
  loginUrl,
  rollbackDatabase,
  superuserClient,
  testDatabaseUrl,
  testProvider,
  testRoleName,
  withRollback,
} from "../../../simetra/test/support"
import { createApplyDatabase } from "../schema-engine"
import { asSuperuser, dropRoles } from "./support/db"

/**
 * `roles` для ролей сигналів (спека профілю postgres §3.1, інваріант 2 плану
 * ПГ-4/B2): група споживача й роль входу з парою та налаштуванням `role`.
 * DB-рівень, бо рядки `pg_auth_members`, `pg_db_role_setting` і роль, яку
 * Postgres ставить новій сесії, вирішує Postgres. Імена — теговані: справжні
 * ролі кластерні. Спільне тіло для профілів `postgres` і `supabase`; файл
 * профілю лише його кличе.
 */

const TARGET = [{ server: "target" as const, db: { url: testDatabaseUrl() } }]
const SESSION_OWNER = PROVIDER_OWNER_ROLES[testProvider()]
const id = quoteIdent
/** Тегований виконавець з CREATEROLE без SUPERUSER: так `roles` запускає оператор. */
const EXECUTOR = testRoleName("sig_exec")

/** Набір `roles` з тегованими групою споживача й роллю входу сигналів. */
function signalRoles(label: string): {
  consumer: string
  signals: string
  roles: PlatformRoleSet
} {
  const consumer = testRoleName(`${label}_sgc`)
  const signals = testRoleName(`${label}_sgl`)
  return {
    consumer,
    signals,
    roles: {
      names: [consumer],
      login: [
        { name: signals, memberOf: [consumer], settings: { role: consumer } },
      ],
    },
  }
}

/** Атрибути, членства й налаштування ролей `names` — те, що звіряє §3.1. */
async function stateOf(client: pg.Client, names: readonly string[]) {
  return {
    roles: (
      await client.query(
        `SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls,
                rolcreaterole, rolcreatedb, rolreplication, rolconfig
           FROM pg_catalog.pg_roles WHERE rolname = ANY($1) ORDER BY 1`,
        [names]
      )
    ).rows,
    members: (
      await client.query(
        `SELECT g.rolname AS role, u.rolname AS member, a.admin_option,
                a.inherit_option, a.set_option
           FROM pg_catalog.pg_auth_members a
           JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
           JOIN pg_catalog.pg_roles u ON u.oid = a.member
          WHERE g.rolname = ANY($1) OR u.rolname = ANY($1) ORDER BY 1, 2`,
        [names]
      )
    ).rows,
  }
}

const shape = (
  rolname: string,
  login: boolean,
  rolconfig: string[] | null
) => ({
  rolname,
  rolcanlogin: login,
  rolinherit: false,
  rolsuper: false,
  rolbypassrls: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  rolconfig,
})

export function describeSignalRoles(): void {
  describe("roles: the signals consumer and its login role", () => {
    it("creates them in the shape of the profile, and a repeat changes nothing", async () => {
      await withRollback(async (client) => {
        await asStackSuperuser(client, async () => {
          await client.query(`CREATE ROLE ${EXECUTOR} NOLOGIN CREATEROLE`)
          await client.query(
            `GRANT ${EXECUTOR} TO ${id(SESSION_OWNER)} WITH SET TRUE`
          )
        })
        await client.query(`SET LOCAL ROLE ${EXECUTOR}`)
        const dbs = rollbackDatabase(client)
        const { consumer, signals, roles } = signalRoles("shape")

        expect(await ensurePlatformRoles(dbs, TARGET, roles)).toEqual({
          created: [
            { server: "target", name: consumer, outcome: "created" },
            { server: "target", name: signals, outcome: "created" },
          ],
        })
        const state = await stateOf(client, [consumer, signals])
        expect(state.roles).toEqual(
          [
            shape(consumer, false, null),
            shape(signals, true, [`role=${consumer}`]),
          ].sort((a, b) => (a.rolname < b.rolname ? -1 : 1))
        )
        // Пара сигналів — єдине членство з правами; творець має лише ADMIN
        const pair = (role: string, member: string, admin: boolean) => ({
          role,
          member,
          admin_option: admin,
          inherit_option: false,
          set_option: !admin,
        })
        expect(state.members).toHaveLength(3)
        expect(state.members).toEqual(
          expect.arrayContaining([
            pair(consumer, signals, false),
            pair(consumer, EXECUTOR, true),
            pair(signals, EXECUTOR, true),
          ])
        )
        const found = await dbs.transaction(TARGET[0]!.db, "rollback", (tx) =>
          readPlatformRoles(tx, [consumer, signals])
        )
        expect(found.find((r) => r.name === signals)?.roleSetting).toBe(
          consumer
        )
        expect(
          platformRoleRefusals(
            [consumer, signals],
            found,
            "target",
            roles.login
          )
        ).toEqual([])

        expect(await ensurePlatformRoles(dbs, TARGET, roles)).toEqual({
          created: [
            { server: "target", name: consumer, outcome: "present" },
            { server: "target", name: signals, outcome: "present" },
          ],
        })
        expect(await stateOf(client, [consumer, signals])).toEqual(state)
      })
    })

    // Налаштування ролі бачить лише нова сесія: роль входить сама, без
    // стартового `-c role=` адреси тестів (`loginUrl` його знімає)
    it("a new session of the login role runs as the consumer group", async () => {
      const label = `sess_${randomBytes(3).toString("hex")}`
      const { consumer, signals, roles } = signalRoles(label)
      const password = randomBytes(12).toString("hex")
      const database = new URL(testDatabaseUrl()).pathname.slice(1)
      const su = await superuserClient()
      try {
        expect(
          await ensurePlatformRoles(
            createApplyDatabase({ readOnly: false }),
            [
              {
                server: "target",
                db: { url: asSuperuser(testDatabaseUrl()) },
              },
            ],
            roles
          )
        ).toMatchObject({ created: [{ name: consumer }, { name: signals }] })
        await su.query(`ALTER ROLE ${id(signals)} PASSWORD '${password}'`)
        await su.query(
          `GRANT CONNECT ON DATABASE ${id(database)} TO ${id(signals)}`
        )
        const login = new pg.Client({
          connectionString: loginUrl(testDatabaseUrl(), signals, password),
        })
        await login.connect()
        try {
          expect(
            (await login.query("SELECT current_user, session_user")).rows
          ).toEqual([{ current_user: consumer, session_user: signals }])
        } finally {
          await login.end()
        }
      } finally {
        await su.query(
          "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = $1",
          [signals]
        )
        await su
          .query(
            `REVOKE CONNECT ON DATABASE ${id(database)} FROM ${id(signals)}`
          )
          .catch(() => undefined)
        await su.end()
        await dropRoles(signals, consumer)
      }
    })
  })
}
