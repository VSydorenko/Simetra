import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { withRollback } from "./connection"

const ROLES_SQL = readFileSync(
  fileURLToPath(new URL("../../../../supabase/roles.sql", import.meta.url)),
  "utf8"
)

// Ролі Simetra — лише ті, що створює roles.sql; членства — де вони учасник чи
// група, щоб поява нового члена в чужій ролі теж стала б дрейфом
const SNAPSHOT = `
  SELECT 'role' AS kind, r.rolname AS a, concat_ws(',', r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreaterole, r.rolbypassrls) AS b
    FROM pg_catalog.pg_roles r WHERE r.rolname LIKE 'simetra\\_%'
  UNION ALL
  SELECT 'member', g.rolname || '<-' || m.rolname, concat_ws(',', am.inherit_option, am.set_option, am.admin_option)
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
   WHERE g.rolname LIKE 'simetra\\_%' OR m.rolname LIKE 'simetra\\_%'
  ORDER BY 1, 2`

describe("supabase/roles.sql on a stack that already has its roles", () => {
  it("leaves the Simetra roles and memberships unchanged on a repeat", async () => {
    await withRollback(async (client) => {
      // Перший прогін гарантує, що ролі є (на свіжому томі їх уже створив CLI)
      await client.query(ROLES_SQL)
      const before = (await client.query(SNAPSHOT)).rows
      expect(before.length).toBeGreaterThan(0)
      await client.query(ROLES_SQL)
      expect((await client.query(SNAPSHOT)).rows).toEqual(before)
    })
  })
})
