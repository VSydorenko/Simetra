import { PLATFORM_ROLES } from "simetra/model"
import {
  ensurePlatformRoles,
  platformRoleRefusals,
  readPlatformRoles,
} from "simetra/schema"
import { describe, expect, it } from "vitest"
import {
  rollbackDatabase,
  testDatabaseUrl,
  testRoleName,
  withRollback,
} from "../../../simetra/test/support"

/**
 * Інструмент `roles` (Р2a1-3). DB-рівень, бо атрибути створеної ролі, грант
 * творцеві й право `CREATEROLE` вирішує Postgres. Кожен кейс — в одній
 * транзакції тесту з роллю під тегом прогону: роль відкочується.
 */
const TARGET = [{ server: "target" as const, db: { url: testDatabaseUrl() } }]

describe("roles", () => {
  it("creates a missing role NOLOGIN NOINHERIT and is idempotent", async () => {
    await withRollback(async (client) => {
      const dbs = rollbackDatabase(client)
      const name = testRoleName("command")
      expect(await ensurePlatformRoles(dbs, TARGET, [name])).toEqual([
        { server: "target", name, outcome: "created" },
      ])
      const found = await dbs.transaction(TARGET[0]!.db, "rollback", (tx) =>
        readPlatformRoles(tx, [name])
      )
      expect(found).toMatchObject([
        {
          name,
          attributes: {
            login: false,
            inherit: false,
            superuser: false,
            bypassRls: false,
            createRole: false,
            createDb: false,
            replication: false,
          },
          memberOf: [],
        },
      ])
      // Творець — член лише з ADMIN і сам має CREATEROLE: форму не ламає
      expect(platformRoleRefusals([name], found, "target")).toEqual([])
      expect(await ensurePlatformRoles(dbs, TARGET, [name])).toEqual([
        { server: "target", name, outcome: "present" },
      ])
    })
  })

  it("creates the role with an ADMIN-only self grant whatever createrole_self_grant says", async () => {
    await withRollback(async (client) => {
      const [{ rolsuper }] = (
        await client.query<{ rolsuper: boolean }>(
          "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
        )
      ).rows as [{ rolsuper: boolean }]
      // Налаштування діє лише на творця без SUPERUSER: від суперкористувача
      // тест перемикається в тегову роль з CREATEROLE тієї ж транзакції
      if (rolsuper) {
        const creator = testRoleName("creator")
        await client.query(`CREATE ROLE ${creator} NOLOGIN CREATEROLE`)
        await client.query(`SET LOCAL ROLE ${creator}`)
      }
      await client.query("SET LOCAL createrole_self_grant = 'set, inherit'")
      const dbs = rollbackDatabase(client)
      const name = testRoleName("command")
      await ensurePlatformRoles(dbs, TARGET, [name])
      const found = await dbs.transaction(TARGET[0]!.db, "rollback", (tx) =>
        readPlatformRoles(tx, [name])
      )
      expect(found[0]?.members.length).toBeGreaterThan(0)
      expect(found[0]?.members.filter((m) => m.inherit || m.set)).toEqual([])
    })
  })

  it("refuses without CREATEROLE and creates nothing", async () => {
    await withRollback(async (client) => {
      const dbs = rollbackDatabase(client)
      const name = testRoleName("command")
      await client.query("SET LOCAL ROLE authenticated")
      expect(await ensurePlatformRoles(dbs, TARGET, [name])).toMatchObject({
        refusal: [
          {
            code: "roles.create-role-denied",
            params: { role: name, server: "target" },
          },
        ],
      })
      await client.query("RESET ROLE")
      expect(
        (
          await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
            name,
          ])
        ).rows
      ).toEqual([])
    })
  })

  // Відповідність атрибута колонці `pg_roles` бачить лише Postgres: модульна
  // таблиця форм подає рядок уже готовим.
  it("reads a role attribute from its own catalog column", async () => {
    await withRollback(async (client) => {
      const name = testRoleName("command")
      await client.query(`CREATE ROLE ${name} NOLOGIN NOINHERIT CREATEDB`)
      const found = await rollbackDatabase(client).transaction(
        TARGET[0]!.db,
        "rollback",
        (tx) => readPlatformRoles(tx, [name])
      )
      expect(found[0]?.attributes).toEqual({
        login: false,
        inherit: false,
        superuser: false,
        bypassRls: false,
        createRole: false,
        createDb: true,
        replication: false,
      })
      expect(platformRoleRefusals([name], found, "target")).toMatchObject([
        { code: "plan.platform-role-shape", params: { violation: "createDb" } },
      ])
    })
  })

  it("the plan role of the local stack sees the command role", async () => {
    await withRollback(async (client) => {
      const found = await rollbackDatabase(client).transaction(
        TARGET[0]!.db,
        "rollback",
        (tx) => readPlatformRoles(tx, [PLATFORM_ROLES.command])
      )
      expect(
        platformRoleRefusals([PLATFORM_ROLES.command], found, "target")
      ).toEqual([])
    })
  })
})
