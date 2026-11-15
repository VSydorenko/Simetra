import { beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import type { CompiledModel } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import {
  PLATFORM_ROLES,
  PROVIDER_OWNER_ROLES,
  type ApiRolePurpose,
} from "simetra/model"
import { accessPolicyNames } from "../../src/compiler/access-units"
import { signUp } from "./auth"
import { claimsFor, queryAs, testRoleFor, withRollback } from "./connection"
import {
  PRIVILEGES,
  SCENARIOS,
  claimsOf,
  compiled,
  hasPrivilege,
  tenant,
} from "./access.support"
import { testProvider } from "./profile"

/**
 * Доступ до таблиць виду на справжньому Postgres (платформна спека §6.7,
 * §6.8): згенеровані гранти й політики читання вперше виконуються тут, а не
 * лише звіряються текстом. Два сценарії — `access.support.ts`. Кейси
 * сервісної ролі провайдера — `access.supabase.db.test.ts`.
 */

const user = (sub: string) => claimsFor("user", sub)

/** Ролі запиту профілю: сервісна — не роль запиту, і профіль її може не мати. */
const REQUEST_PURPOSES = [
  "user",
  "anonymous",
] as const satisfies readonly ApiRolePurpose[]

/** Усі значення `Parent Relationship` дерева плану `EXPLAIN (FORMAT JSON)`. */
function parentRelationships(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(parentRelationships)
  if (node === null || typeof node !== "object") return []
  return Object.entries(node).flatMap(([key, value]) =>
    key === "Parent Relationship" && typeof value === "string"
      ? [value]
      : parentRelationships(value)
  )
}

describe.each(SCENARIOS)("kind table access in schema $schema", (scenario) => {
  const { schema } = scenario
  let model: CompiledModel
  let sql: string

  beforeAll(async () => {
    model = await compiled(scenario)
    sql = renderDesiredState(model).sql
  })

  const deploy = (client: pg.Client) => client.query(sql)

  it("a member reads only the rows of own scope in every scoped table", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const alice = await signUp(client)
      const bob = await signUp(client)
      const own = await tenant(client, schema, alice)
      await tenant(client, schema, bob)
      // Носій скоупу кожної форми: власна колонка, ключ кореня, `parent_id`
      // рядка ТЧ кореня, власна колонка похідних таблиць регістра.
      const carriers: [string, string][] = [
        ["item", "org_id"],
        ["item_lines", "org_id"],
        ["organization", "id"],
        ["organization_lines", "parent_id"],
        ["stock", "org_id"],
        ["stock_totals", "org_id"],
        ["stock_turnovers_month", "org_id"],
      ]
      for (const [table, carrier] of carriers) {
        expect(
          await queryAs<{ s: string }>(
            client,
            "user",
            user(alice),
            `SELECT ${carrier} AS s FROM ${schema}.${table}`
          ),
          table
        ).toEqual({ rows: [{ s: own.org }] })
      }
      // Рядок ТЧ — саме рядок свого `Item`, не лише своєї організації.
      expect(
        await queryAs<{ p: string }>(
          client,
          "user",
          user(alice),
          `SELECT parent_id AS p FROM ${schema}.item_lines`
        )
      ).toEqual({ rows: [{ p: own.item }] })
    })
  })

  it("public read on anon opens every row to anon and authenticated", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const alice = await signUp(client)
      await client.query(
        `INSERT INTO ${schema}.currency (id, code) VALUES (gen_random_uuid(), 'UAH'), (gen_random_uuid(), 'EUR')`
      )
      for (const role of ["anonymous", "user"] as const) {
        expect(
          await queryAs<{ code: string }>(
            client,
            role,
            claimsOf(role, alice),
            `SELECT code FROM ${schema}.currency ORDER BY code`
          ),
          role
        ).toEqual({ rows: [{ code: "EUR" }, { code: "UAH" }] })
      }
    })
  })

  it("unscoped table without public read: no rows for users, no access for anon", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const alice = await signUp(client)
      await tenant(client, schema, alice)
      await client.query(
        `INSERT INTO ${schema}.secret (id) VALUES (gen_random_uuid())`
      )
      expect(
        await queryAs(
          client,
          "user",
          user(alice),
          `SELECT * FROM ${schema}.secret`
        )
      ).toEqual({ rows: [] })
      for (const table of ["secret", "item"]) {
        expect(
          await queryAs(
            client,
            "anonymous",
            claimsOf("anonymous", alice),
            `SELECT * FROM ${schema}.${table}`
          ),
          `anonymous on ${table}`
        ).toEqual({ code: "42501" })
      }
    })
  })

  it("table privileges: select for readers only, nothing else for any API role", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const has = (role: string, table: string, privilege: string) =>
        hasPrivilege(client, role, `${schema}.${table}`, privilege)
      const userRole = testRoleFor("user")!
      const anonRole = testRoleFor("anonymous")!
      expect(await has(userRole, "item", "INSERT")).toBe(false)
      expect(await has(anonRole, "currency", "INSERT")).toBe(false)
      expect(await has(anonRole, "currency", "TRUNCATE")).toBe(false)
      // Повна матриця: типові привілеї схеми не лишають ролям запиту нічого
      // понад згенерований `SELECT`.
      for (const contract of model.contracts.access) {
        const table = contract.table.name
        for (const purpose of REQUEST_PURPOSES) {
          const role = testRoleFor(purpose)!
          const granted: string[] = []
          for (const privilege of PRIVILEGES)
            if (await has(role, table, privilege)) granted.push(privilege)
          const reads =
            purpose === "user" || contract.publicRead.includes("anonymous")
          expect(granted, `${role} on ${table}`).toEqual(
            reads ? ["SELECT"] : []
          )
        }
      }
    })
  })

  it("no role outside the profile holds a privilege on a kind table", async () => {
    // Сервісної ролі в обхід RLS профіль може не мати (`postgres`), а грант
    // таблиці чи колонки ролі поза профілем — ні `PUBLIC`, ні ролі входу —
    // відкрив би рядки повз політики читання.
    await withRollback(async (client) => {
      await deploy(client)
      const allowed = [
        PROVIDER_OWNER_ROLES[testProvider()],
        ...REQUEST_PURPOSES.map((purpose) => testRoleFor(purpose)!),
        ...Object.values(PLATFORM_ROLES),
      ]
      const tables = model.contracts.access.map(
        (contract) => `${schema}.${contract.table.name}`
      )
      expect(tables.length).toBeGreaterThan(0)
      const { rows } = await client.query<{ object: string; grantee: string }>(
        `WITH t AS (SELECT c.oid, c.relowner, n.nspname || '.' || c.relname AS name
                      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname || '.' || c.relname = ANY ($1::text[])),
              acl AS (SELECT t.name AS object, a.grantee
                        FROM t, pg_catalog.aclexplode(coalesce((SELECT relacl FROM pg_catalog.pg_class WHERE oid = t.oid), pg_catalog.acldefault('r', t.relowner))) a
                      UNION ALL
                      SELECT t.name || '.' || att.attname, a.grantee
                        FROM t JOIN pg_catalog.pg_attribute att ON att.attrelid = t.oid AND att.attacl IS NOT NULL,
                             pg_catalog.aclexplode(att.attacl) a)
         SELECT DISTINCT object, CASE grantee WHEN 0 THEN 'PUBLIC' ELSE grantee::regrole::text END AS grantee
           FROM acl
          WHERE grantee = 0 OR NOT grantee::regrole::text = ANY ($2::text[])
          ORDER BY 1, 2`,
        [tables, allowed]
      )
      expect(rows).toEqual([])
    })
  })

  it.runIf(schema === "app")(
    "the adopted schema USAGE survives the deployment",
    async () => {
      await withRollback(async (client) => {
        await deploy(client)
        for (const purpose of REQUEST_PURPOSES) {
          const role = testRoleFor(purpose)!
          const { rows } = await client.query<{ ok: boolean }>(
            "SELECT has_schema_privilege($1, 'app', 'USAGE') AS ok",
            [role]
          )
          expect(rows[0]!.ok, role).toBe(true)
        }
      })
    }
  )

  it("every read policy plans its sets once (InitPlan, no SubPlan)", async () => {
    // Причина DB-рівня: форму плану (InitPlan проти SubPlan на рядок) вирішує
    // планувальник Postgres, а не текст політики (§5.4).
    await withRollback(async (client) => {
      await deploy(client)
      const alice = await signUp(client)
      await tenant(client, schema, alice)
      // Політики читання кожної таблиці: межа тенанта чи «Користувачів»
      // (`scope_read`) і кожна політика прав (`read_*`). Команду політики
      // бере дерево (`FOR SELECT`), а не перелік імен: так політики запису
      // не потрапляють у порівняння з `cmd = 'SELECT'`.
      const expected = new Map<string, string[]>()
      for (const contract of model.contracts.access) {
        const names = accessPolicyNames(contract.table)
        const reads = model.sqlUnits
          .filter((u) => {
            const statement = (
              u.tree as {
                CreatePolicyStmt: {
                  table: { relname: string }
                  cmd_name: string
                }
              }
            ).CreatePolicyStmt
            return (
              u.generator === "access" &&
              u.class === "policy" &&
              u.ownerObjectId === contract.objectId &&
              statement.table.relname === contract.table.name &&
              statement.cmd_name === "select" &&
              u.name !== names.publicRead
            )
          })
          .map((u) => u.name)
          .sort()
        if (reads.length === 0) continue
        if (contract.scope !== undefined && contract.publicRead.length === 0) {
          expect(reads, contract.table.name).toContain(names.scopeRead)
        }
        expect(
          reads.filter((name) => name !== names.scopeRead).length,
          contract.table.name
        ).toBeGreaterThan(0)
        expected.set(contract.table.name, reads)
      }
      const { rows: policies } = await client.query<{
        table: string
        policy: string
      }>(
        `SELECT tablename AS table, policyname AS policy FROM pg_policies
         WHERE schemaname = $1 AND cmd = 'SELECT' AND roles @> ARRAY[$2]::name[]
         ORDER BY 1, 2`,
        [schema, testRoleFor("user")]
      )
      const deployed = new Map<string, string[]>()
      for (const { table, policy } of policies) {
        if (policy === accessPolicyNames({ name: table }).publicRead) continue
        deployed.set(table, [...(deployed.get(table) ?? []), policy].sort())
      }
      expect(deployed).toEqual(expected)
      for (const [table, reads] of expected) {
        const result = await queryAs<{ "QUERY PLAN": unknown }>(
          client,
          "user",
          user(alice),
          `EXPLAIN (FORMAT JSON) SELECT * FROM ${schema}.${table}`
        )
        expect("rows" in result, table).toBe(true)
        const plan = (result as { rows: { "QUERY PLAN": unknown }[] }).rows[0]![
          "QUERY PLAN"
        ]
        // Кожна політика читання тут — множина `ARRAY(SELECT …)` чи булева
        // перевірка `(SELECT …)`: щонайменше одна InitPlan на політику.
        expect(
          parentRelationships(plan).filter((r) => r === "InitPlan").length,
          table
        ).toBeGreaterThanOrEqual(reads.length)
        expect(JSON.stringify(plan), table).not.toContain("SubPlan")
      }
    })
  })
})
