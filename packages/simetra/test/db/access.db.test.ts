import { beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import { compile, type CompiledModel } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import { accessPolicyNames } from "../../src/compiler/access-units"
import {
  expectClean,
  acceptDebt,
  attribute,
  catalog,
  document,
  metaFiles,
  project,
  uuid,
} from "../../src/compiler/__tests__/helpers"
import {
  grant,
  objects,
  role,
  systemCatalog,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import { queryAs, withRollback, type ApiRole } from "./connection"

/**
 * Доступ до таблиць виду на справжньому Postgres (платформна спека §6.7,
 * §6.8): згенеровані гранти й політики читання вперше виконуються тут, а не
 * лише звіряються текстом. Два сценарії: схема `public`, де типові привілеї
 * провайдера дають ролям API усе на кожну нову таблицю, і власна схема
 * застосунку з прийнятим дослівним `USAGE`, який генерація не чіпає.
 */

const SCENARIOS = [
  { schema: "public", defaultSchema: undefined },
  { schema: "app", defaultSchema: "app" },
] as const

type Scenario = (typeof SCENARIOS)[number]

/** ТЧ з однією колонкою: фізичне ім'я таблиці рядків задає файл. */
function lines(id: number, physicalName: string) {
  return {
    id: uuid(id),
    name: "lines",
    physicalName,
    attributes: [attribute("note", { type: "String", length: 20 })],
  }
}

/** Роль рівня `org`: `read@any` на скоуплених об'єктах тесту. */
const ORG_READER_ID = uuid(85)

/**
 * Системні довідники прав рівня `org` (спека прав §4.6) і роль, що читає
 * явний перелік скоуплених об'єктів — не `withAction`: інакше вона читала б і
 * нескоуплений `Secret`, а тест доводить, що його не читає ніхто.
 */
function orgRights(): Record<string, unknown> {
  return {
    "catalogs/OrgRoles/OrgRoles.meta.json": systemCatalog(
      uuid(86),
      "OrgRoles",
      "org_roles",
      "rightsRoles",
      "org"
    ),
    "catalogs/OrgRoleAssignments/OrgRoleAssignments.meta.json": systemCatalog(
      uuid(87),
      "OrgRoleAssignments",
      "org_role_assignments",
      "roleAssignments",
      "org"
    ),
    "roles/OrgReader/OrgReader.meta.json": role(
      ORG_READER_ID,
      "OrgReader",
      { scopeKind: "org" },
      {
        grants: [
          grant(
            objects(
              ["Catalog", "Organization"],
              ["Catalog", "Item"],
              ["Document", "Sale"],
              ["AccumulationRegister", "Stock"]
            ),
            ["read"],
            "any"
          ),
        ],
      }
    ),
  }
}

const itemRef = (physicalName: string) =>
  attribute("item", {
    physicalName,
    type: "Ref",
    ref: { kind: "Catalog", name: "Item" },
  })

async function compiled(scenario: Scenario): Promise<CompiledModel> {
  const entries: Record<string, unknown> = {
    "project.meta.json": project({
      ...(scenario.defaultSchema === undefined
        ? {}
        : { defaultSchema: scenario.defaultSchema }),
      scopeKinds: [
        {
          id: uuid(80),
          name: "org",
          physicalName: "org_id",
          root: { object: { kind: "Catalog", name: "Organization" } },
          setFunction: "membership",
        },
      ],
    }),
    "catalogs/Users/Users.meta.json": catalog("Users", {
      role: "users",
      scope: "none",
    }),
    "catalogs/OrgMember/OrgMember.meta.json": catalog("OrgMember", {
      scope: "org",
      membership: { user: "user" },
      attributes: [
        attribute("user", {
          physicalName: "user_id",
          type: "Ref",
          ref: { kind: "Catalog", name: "Users" },
        }),
      ],
    }),
    "catalogs/Organization/Organization.meta.json": catalog("Organization", {
      scope: "org",
      tabularSections: [lines(81, "organization_lines")],
    }),
    "catalogs/Item/Item.meta.json": catalog("Item", {
      scope: "org",
      tabularSections: [lines(82, "item_lines")],
    }),
    // Регістр накопичення потребує реєстратора; документ лише дає рухи.
    "documents/Sale/Sale.meta.json": document("Sale", {
      scope: "org",
      tabularSections: [
        {
          id: uuid(83),
          name: "goods",
          physicalName: "sale_goods",
          attributes: [
            itemRef("item_id"),
            attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
          ],
        },
      ],
      registerMovements: [{ kind: "AccumulationRegister", name: "Stock" }],
      posting: {
        movements: [
          {
            register: { kind: "AccumulationRegister", name: "Stock" },
            source: { tabularSection: "goods" },
            movementType: "Expense",
            fields: { item: "row.item", qty: "row.qty" },
          },
        ],
      },
    }),
    "accumulation-registers/Stock/Stock.meta.json": {
      id: uuid(84),
      kind: "AccumulationRegister",
      name: "Stock",
      physicalName: "stock",
      kindLabel: "stock",
      scope: "org",
      recorderTypes: [{ kind: "Document", name: "Sale" }],
      dimensions: [itemRef("item_id")],
      resources: [
        attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
      ],
    },
    "catalogs/Currency/Currency.meta.json": catalog("Currency", {
      scope: "none",
      publicRead: "anon",
    }),
    "catalogs/Secret/Secret.meta.json": catalog("Secret", { scope: "none" }),
    ...orgRights(),
  }
  let files = metaFiles(entries)
  if (scenario.schema === "app") {
    // Прийнятий грант схеми — дослівний борг, як у споживача з власною
    // схемою: генерація a1 грантів схеми не дає й не відкликає.
    files.set(
      "sql/app/usage.sql",
      "GRANT USAGE ON SCHEMA app TO authenticated;\nGRANT USAGE ON SCHEMA app TO anon;\n"
    )
    files = await acceptDebt(files)
  }
  const result = await compile(files)
  expectClean(result, { allow: ["rights.scope-kind-unread"] })
  return result.model!
}

interface Tenant {
  org: string
  item: string
}

/**
 * Організація з одним рядком у кожній таблиці, яку перевіряє тест, і
 * користувачем — учасником з роллю `OrgReader`: читання тепер дає право, а
 * межа тенанта лише звужує (Р2a2-1). Пише власник таблиць: RLS його не
 * обмежує, а запис від ролей API — поза a1.
 */
async function tenant(
  client: pg.Client,
  schema: string,
  user: string
): Promise<Tenant> {
  const one = async (sql: string, params: unknown[] = []) =>
    (await client.query<{ id: string }>(sql, params)).rows[0]?.id
  const org = (await one(
    `INSERT INTO ${schema}.organization (id) VALUES (gen_random_uuid()) RETURNING id`
  ))!
  await client.query(
    `INSERT INTO ${schema}.organization_lines (id, parent_id, line_number) VALUES (gen_random_uuid(), $1, 1)`,
    [org]
  )
  const member = (await one(
    `INSERT INTO ${schema}.org_member (id, org_id, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
    [org, user]
  ))!
  await client.query(
    `INSERT INTO ${schema}.org_role_assignments (id, org_id, subject, archetype) VALUES (gen_random_uuid(), $1, $2, $3)`,
    [org, member, ORG_READER_ID]
  )
  const item = (await one(
    `INSERT INTO ${schema}.item (id, org_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
    [org]
  ))!
  await client.query(
    `INSERT INTO ${schema}.item_lines (id, org_id, parent_id, line_number) VALUES (gen_random_uuid(), $1, $2, 1)`,
    [org, item]
  )
  await client.query(
    `INSERT INTO ${schema}.stock (org_id, period, recorder_type, recorder_id, line_number, movement_type, item_id, qty) VALUES ($1, now(), 'sale', gen_random_uuid(), 1, 'Expense', $2, 1)`,
    [org, item]
  )
  await client.query(
    `INSERT INTO ${schema}.stock_totals (org_id, item_id, qty) VALUES ($1, $2, 1)`,
    [org, item]
  )
  await client.query(
    `INSERT INTO ${schema}.stock_turnovers_month (org_id, item_id, month) VALUES ($1, $2, date_trunc('month', now())::date)`,
    [org, item]
  )
  return { org, item }
}

const user = (sub: string) => ({ sub, role: "authenticated" })
const claimsOf = (role: ApiRole, sub: string) =>
  role === "authenticated" ? user(sub) : { role }

const PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const

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
            "authenticated",
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
          "authenticated",
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
      for (const role of ["anon", "authenticated"] as const) {
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

  it("unscoped table without public read: no rows for users, no access for anon and service_role", async () => {
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
          "authenticated",
          user(alice),
          `SELECT * FROM ${schema}.secret`
        )
      ).toEqual({ rows: [] })
      for (const table of ["secret", "item"]) {
        for (const role of ["anon", "service_role"] as const) {
          expect(
            await queryAs(
              client,
              role,
              claimsOf(role, alice),
              `SELECT * FROM ${schema}.${table}`
            ),
            `${role} on ${table}`
          ).toEqual({ code: "42501" })
        }
      }
    })
  })

  it("table privileges: select for readers only, nothing else for any API role", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const has = async (role: string, table: string, privilege: string) =>
        (
          await client.query<{ ok: boolean }>(
            "SELECT has_table_privilege($1, $2, $3) AS ok",
            [role, `${schema}.${table}`, privilege]
          )
        ).rows[0]!.ok
      expect(await has("authenticated", "item", "INSERT")).toBe(false)
      expect(await has("anon", "currency", "INSERT")).toBe(false)
      expect(await has("anon", "currency", "TRUNCATE")).toBe(false)
      expect(await has("service_role", "currency", "SELECT")).toBe(false)
      // Повна матриця: типові привілеї схеми провайдера не лишають ролям API
      // нічого понад згенерований `SELECT`.
      for (const contract of model.contracts.access) {
        const table = contract.table.name
        for (const role of ["anon", "authenticated", "service_role"]) {
          const granted: string[] = []
          for (const privilege of PRIVILEGES)
            if (await has(role, table, privilege)) granted.push(privilege)
          const reads =
            role === "authenticated" ||
            (role === "anon" && contract.publicRead.includes("anonymous"))
          expect(granted, `${role} on ${table}`).toEqual(
            reads ? ["SELECT"] : []
          )
        }
      }
    })
  })

  it.runIf(schema === "app")(
    "the adopted schema USAGE survives the deployment",
    async () => {
      await withRollback(async (client) => {
        await deploy(client)
        for (const role of ["authenticated", "anon"]) {
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
      // (`scope_read`) і кожна політика прав (`read_*`); імена — з
      // `accessPolicyNames`, а не зі сталого суфікса.
      const expected = new Map<string, string[]>()
      for (const contract of model.contracts.access) {
        const names = accessPolicyNames(contract.table)
        const writes = new Set([
          names.scopeInsert,
          names.scopeUpdate,
          names.scopeDelete,
          names.publicRead,
        ])
        const reads = model.sqlUnits
          .filter(
            (u) =>
              u.generator === "access" &&
              u.class === "policy" &&
              u.ownerObjectId === contract.objectId &&
              (u.tree as { CreatePolicyStmt: { table: { relname: string } } })
                .CreatePolicyStmt.table.relname === contract.table.name &&
              !writes.has(u.name)
          )
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
         WHERE schemaname = $1 AND cmd = 'SELECT' AND roles @> ARRAY['authenticated']::name[]
         ORDER BY 1, 2`,
        [schema]
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
          "authenticated",
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
