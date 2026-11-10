import type pg from "pg"
import { compile, type CompiledModel } from "simetra/compiler"
import { quoteIdent, type ApiRolePurpose } from "simetra/model"
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
import { claimsFor, testRoleFor } from "./connection"
import { testProvider } from "./profile"
import { inMaintenance } from "./rights-seed"

/**
 * Спільна модель і засів DB-тестів доступу до таблиць виду обох стеків
 * (`access`, `access.supabase`): два сценарії — схема `public`, де на стеку
 * Supabase типові привілеї провайдера дають ролям API усе на кожну нову
 * таблицю, і власна схема застосунку з прийнятим дослівним `USAGE`, який
 * генерація не чіпає.
 */

export const SCENARIOS = [
  { schema: "public", defaultSchema: undefined },
  { schema: "app", defaultSchema: "app" },
] as const

export type Scenario = (typeof SCENARIOS)[number]

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

/** Модель сценарію під профіль прогону. */
export async function compiled(scenario: Scenario): Promise<CompiledModel> {
  const entries: Record<string, unknown> = {
    "project.meta.json": project({
      database: { provider: testProvider() },
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
    // схемою: генерація грантів схеми не дає й не відкликає. Ролі — профілю.
    files.set(
      "sql/app/usage.sql",
      (["user", "anonymous"] as const)
        .map(
          (purpose) =>
            `GRANT USAGE ON SCHEMA app TO ${quoteIdent(testRoleFor(purpose)!)};\n`
        )
        .join("")
    )
    files = await acceptDebt(files)
  }
  const result = await compile(files)
  expectClean(result, { allow: ["rights.scope-kind-unread"] })
  return result.model!
}

export interface Tenant {
  org: string
  item: string
}

/**
 * Організація з одним рядком у кожній таблиці, яку перевіряє тест, і
 * користувачем — учасником з роллю `OrgReader`: читання тепер дає право, а
 * межа тенанта лише звужує (спека прав §5.2). Пише власник таблиць: RLS його не
 * обмежує, а запис від ролей API тут не перевіряється.
 */
export async function tenant(
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
  await inMaintenance(client, () =>
    client.query(
      `INSERT INTO ${schema}.org_role_assignments (id, org_id, subject, archetype) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [org, member, ORG_READER_ID]
    )
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

/** Claims призначення: `sub` — лише в сесії користувача. */
export const claimsOf = (purpose: ApiRolePurpose, sub: string) =>
  claimsFor(purpose, purpose === "user" ? sub : undefined)

export const PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const

/** Привілей ролі на таблиці схеми сценарію. */
export async function hasPrivilege(
  client: pg.Client,
  role: string,
  table: string,
  privilege: string
): Promise<boolean> {
  return (
    await client.query<{ ok: boolean }>(
      "SELECT has_table_privilege($1, $2, $3) AS ok",
      [role, table, privilege]
    )
  ).rows[0]!.ok
}
