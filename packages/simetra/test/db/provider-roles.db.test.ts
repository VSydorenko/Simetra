import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { PLATFORM_ROLES } from "simetra/model"
import { platformRoleRefusals, readPlatformRoles } from "simetra/schema"
import { rollbackDatabase, testRoleName, withRollback } from "./connection"

/**
 * `supabase/roles.sql` — роль команд локального стеку (Р2a1-1). DB-рівень,
 * бо `CREATE ROLE` і грант творцеві за `createrole_self_grant` вирішує
 * Postgres. Файл засіває CLI під `postgres`, тож і тест — від нього.
 */
const ROLES_SQL = resolve(import.meta.dirname, "../../../../supabase/roles.sql")

describe("provider roles", () => {
  it("roles.sql creates an ADMIN-only role under postgres whatever createrole_self_grant says", async () => {
    const name = testRoleName("command")
    const sql = (await readFile(ROLES_SQL, "utf8")).replaceAll(
      PLATFORM_ROLES.command,
      name
    )
    expect(sql).toContain(name)
    await withRollback(async (client) => {
      await client.query("SET LOCAL createrole_self_grant = 'set, inherit'")
      await client.query(sql)
      const found = await rollbackDatabase(client).transaction(
        { url: "" },
        "rollback",
        (tx) => readPlatformRoles(tx, [name])
      )
      expect(found.map((r) => r.name)).toEqual([name])
      expect(platformRoleRefusals([name], found, "target")).toEqual([])
    })
  })
})
