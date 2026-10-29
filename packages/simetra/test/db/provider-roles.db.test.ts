import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { PLATFORM_LOGIN_ROLES, PLATFORM_ROLES } from "simetra/model"
import { platformRoleRefusals, readPlatformRoles } from "simetra/schema"
import { rollbackDatabase, testRoleName, withRollback } from "./connection"

/**
 * `supabase/roles.sql` — роль команд і роль входу локального стеку (Р2a1-1,
 * Р-A1-4). DB-рівень, бо `CREATE ROLE`, грант творцеві за
 * `createrole_self_grant` і опції членства вирішує Postgres. Файл засіває
 * CLI під `postgres`, тож і тест — від нього.
 */
const ROLES_SQL = resolve(import.meta.dirname, "../../../../supabase/roles.sql")

describe("provider roles", () => {
  it("roles.sql creates an ADMIN-only grant role and a SET-only login role under postgres whatever createrole_self_grant says", async () => {
    // Справжні імена кластерні: файл виконується на тегованих, батько
    // `authenticated` — справжній, у відкатній транзакції
    const command = testRoleName("command")
    const runtime = testRoleName("runtime")
    const sql = (await readFile(ROLES_SQL, "utf8"))
      .replaceAll(PLATFORM_ROLES.command, command)
      .replaceAll(PLATFORM_LOGIN_ROLES.runtime, runtime)
    expect(sql).toContain(command)
    expect(sql).toContain(runtime)
    await withRollback(async (client) => {
      await client.query("SET LOCAL createrole_self_grant = 'set, inherit'")
      await client.query(sql)
      const found = await rollbackDatabase(client).transaction(
        { url: "" },
        "rollback",
        (tx) => readPlatformRoles(tx, [command, runtime])
      )
      expect(found.map((r) => r.name).sort()).toEqual([command, runtime].sort())
      expect(
        platformRoleRefusals([command, runtime], found, "target", [runtime], {
          name: runtime,
          memberOf: [command, "authenticated"],
        })
      ).toEqual([])
    })
  })
})
