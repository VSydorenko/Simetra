import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile, type CompiledModel } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import { toSnakeCase } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import { readCatalog } from "../../../test/db/catalog"
import { expectCatalogMatchesSnapshot } from "../../../test/db/compare"
import { withRollback } from "../../../test/db/connection"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  organization,
  SCOPE_FUNCTIONS_FILE,
  scopedProject,
  uuid,
} from "../../compiler/__tests__/helpers"

/**
 * Перший доказ на справжньому Postgres 17 (спека П2 §8.3, §10): скомпільована
 * модель розгортається, а каталог після розгортання збігається зі знімком.
 * Кожен збій тут — дефект компілятора (фізика) чи рендера (форма SQL).
 */

const ORG = "catalogs/Organization/Organization.meta.json"

/** Проєкт усіх фікстур: два види скоупу, схема `app`, пояс Києва. */
function domain(entries: Record<string, unknown>): Map<string, string> {
  return metaFiles({
    "project.meta.json": {
      ...scopedProject(),
      defaultSchema: "app",
      timezone: "Europe/Kyiv",
    },
    [ORG]: organization(),
    ...entries,
  })
}

const ref = (kind: string, name: string) => ({
  type: "Ref",
  ref: { kind, name },
})

function scopedCatalog(): Map<string, string> {
  return domain({
    "catalogs/Partner/Partner.meta.json": catalog("Partner", { scope: "org" }),
    "catalogs/Item/Item.meta.json": catalog("Item", {
      scope: "org",
      hierarchyType: "FoldersAndItems",
      owners: [{ kind: "Catalog", name: "Partner" }],
      codeType: "Number",
      codeLength: 8,
      predefinedItems: [
        { id: uuid(51), name: "Service", physicalName: "service" },
      ],
      attributes: [
        attribute("price", { type: "Numeric", precision: 15, scale: 2 }),
        attribute("sku", {
          type: "String",
          length: 20,
          indexed: true,
          unique: true,
        }),
      ],
    }),
  })
}

const SALE_FILE = "documents/Sale/Sale.meta.json"

function saleDocument(): Map<string, string> {
  return domain({
    "catalogs/Item/Item.meta.json": catalog("Item", { scope: "org" }),
    [SALE_FILE]: document("Sale", {
      scope: "org",
      numberPeriodicity: "Month",
      attributes: [
        attribute("customer", {
          ...ref("Catalog", "Organization"),
          physicalName: "customer_id",
          crossScope: true,
          required: true,
        }),
      ],
      tabularSections: [
        {
          id: uuid(61),
          name: "goods",
          physicalName: "sale_goods",
          attributes: [
            attribute("item", {
              ...ref("Catalog", "Item"),
              physicalName: "item_id",
            }),
            attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
          ],
        },
        {
          id: uuid(62),
          name: "services",
          physicalName: "sale_services",
          attributes: [attribute("note", { type: "String", length: 100 })],
        },
      ],
    }),
  })
}

/** ТЧ `goods` документа: товар, партія, кількість. */
function goods(n: number): Record<string, unknown> {
  return {
    id: uuid(n),
    name: "goods",
    physicalName: "sale_goods",
    attributes: [
      attribute("item", { ...ref("Catalog", "Item"), physicalName: "item_id" }),
      attribute("lot", { type: "String", length: 20 }),
      attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
    ],
  }
}

const STOCK_FILE = "accumulation-registers/Stock/Stock.meta.json"

function accumulationRegisters(): Map<string, string> {
  const register = (
    name: string,
    registerType: string
  ): Record<string, unknown> => ({
    id: uuid(name === "Stock" ? 71 : 72),
    kind: "AccumulationRegister",
    name,
    physicalName: name.toLowerCase(),
    scope: "org",
    registerType,
    recorderTypes: [{ kind: "Document", name: "Sale" }],
    dimensions: [
      attribute("item", { ...ref("Catalog", "Item"), physicalName: "item_id" }),
      attribute("lot", { type: "String", length: 20 }),
    ],
    resources: [attribute("qty", { type: "Numeric", precision: 15, scale: 3 })],
  })
  return domain({
    "catalogs/Item/Item.meta.json": catalog("Item", { scope: "org" }),
    [SALE_FILE]: document("Sale", {
      scope: "org",
      registerMovements: [
        { kind: "AccumulationRegister", name: "Stock" },
        { kind: "AccumulationRegister", name: "Sales" },
      ],
      tabularSections: [goods(141)],
      posting: {
        movements: [
          {
            register: { kind: "AccumulationRegister", name: "Stock" },
            source: { tabularSection: "goods" },
            movementType: "Expense",
            fields: { item: "row.item", lot: "row.lot", qty: "row.qty" },
          },
          {
            register: { kind: "AccumulationRegister", name: "Sales" },
            source: { tabularSection: "goods" },
            fields: { item: "row.item", lot: "row.lot", qty: "row.qty" },
          },
        ],
      },
    }),
    [STOCK_FILE]: register("Stock", "Balance"),
    "accumulation-registers/Sales/Sales.meta.json": register(
      "Sales",
      "Turnover"
    ),
  })
}

function informationRegisters(): Map<string, string> {
  const dimensions = () => [
    attribute("item", { ...ref("Catalog", "Item"), physicalName: "item_id" }),
    attribute("region", { type: "String", length: 20 }),
  ]
  return domain({
    "catalogs/Item/Item.meta.json": catalog("Item", { scope: "org" }),
    [SALE_FILE]: document("Sale", {
      scope: "org",
      registerMovements: [{ kind: "InformationRegister", name: "Rates" }],
      attributes: [
        attribute("item", {
          ...ref("Catalog", "Item"),
          physicalName: "item_id",
        }),
        attribute("rate", { type: "Numeric", precision: 9, scale: 4 }),
      ],
      posting: {
        movements: [
          {
            register: { kind: "InformationRegister", name: "Rates" },
            source: "document",
            fields: {
              item: "doc.item",
              region: "'north'",
              rate: "doc.rate",
              comment: "'posted'",
            },
          },
        ],
      },
    }),
    "information-registers/Prices/Prices.meta.json": {
      id: uuid(81),
      kind: "InformationRegister",
      name: "Prices",
      physicalName: "prices",
      scope: "org",
      periodicity: "Day",
      dimensions: dimensions(),
      resources: [
        attribute("price", { type: "Numeric", precision: 15, scale: 2 }),
      ],
    },
    "information-registers/Rates/Rates.meta.json": {
      id: uuid(82),
      kind: "InformationRegister",
      name: "Rates",
      physicalName: "rates",
      scope: "org",
      periodicity: "Month",
      writeMode: "RecorderSubordinate",
      recorderTypes: [{ kind: "Document", name: "Sale" }],
      dimensions: dimensions(),
      resources: [
        attribute("rate", { type: "Numeric", precision: 9, scale: 4 }),
      ],
      attributes: [attribute("comment", { type: "String", length: 50 })],
    },
  })
}

function constants(): Map<string, string> {
  const constant = (
    n: number,
    name: string,
    value: Record<string, unknown>
  ) => ({
    id: uuid(n),
    kind: "Constant",
    name,
    physicalName: toSnakeCase(name),
    ...value,
  })
  return domain({
    "catalogs/Item/Item.meta.json": catalog("Item", { scope: "org" }),
    "constants/MainItem/MainItem.meta.json": constant(91, "MainItem", {
      scope: "org",
      ...ref("Catalog", "Item"),
    }),
    "constants/VatRate/VatRate.meta.json": constant(92, "VatRate", {
      scope: "none",
      type: "Numeric",
      precision: 5,
      scale: 2,
      defaultValue: 20,
    }),
  })
}

function customTables(): Map<string, string> {
  const column = (
    n: number,
    name: string,
    physicalName: string,
    value: Record<string, unknown>
  ) => ({ id: uuid(n), name, physicalName, ...value })
  return domain({
    // Ціль FK оголошена пізніше за шляхом файлу: FK рендеряться після всіх таблиць.
    "custom-tables/Audit/Audit.meta.json": customTable("Audit", {
      scope: "none",
      columns: [
        // Колонки ключа й identity пишуть `notNull` явно: файл — дослівна фізика.
        column(101, "tenantId", "tenant_id", { type: "UUID", notNull: true }),
        column(102, "seq", "seq", {
          type: "BigInt",
          identity: "always",
          notNull: true,
        }),
        column(103, "userId", "user_id", { type: "UUID" }),
        column(104, "email", "email", { type: "Text" }),
        column(105, "amount", "amount", {
          type: "Numeric",
          precision: 12,
          scale: 2,
        }),
        column(106, "amountCents", "amount_cents", {
          type: "BigInt",
          generated: { expression: "(amount * 100)::bigint" },
        }),
        column(107, "code", "code", {
          type: "Text",
          collation: { name: "C" },
          notNull: true,
          default: "'none'",
        }),
        column(108, "ledgerId", "ledger_id", { type: "UUID" }),
      ],
      primaryKey: { name: "audit_pk", columns: ["tenantId", "seq"] },
      uniques: [
        {
          name: "audit_code_key",
          columns: ["tenantId", "code"],
          nullsNotDistinct: true,
          deferrable: "initiallyDeferred",
        },
      ],
      checks: [{ name: "audit_amount_check", expression: "amount >= 0" }],
      foreignKeys: [
        {
          name: "audit_user_fk",
          columns: ["userId"],
          references: {
            external: { schema: "auth", table: "users", columns: ["id"] },
          },
          onDelete: "setNull",
        },
        {
          name: "audit_ledger_fk",
          columns: ["ledgerId"],
          references: {
            object: { kind: "CustomTable", name: "Ledger" },
            columns: ["id"],
          },
          onDelete: "cascade",
          deferrable: "deferrable",
        },
      ],
      indexes: [
        {
          name: "audit_email_lower_idx",
          keys: [
            { expression: "lower(email)" },
            { column: "seq", order: "desc" },
          ],
          include: ["amount"],
          where: "email IS NOT NULL",
        },
      ],
      rowLevelSecurity: "enabled",
      comment: "Audit trail",
    }),
    "custom-tables/Ledger/Ledger.meta.json": customTable("Ledger", {
      scope: "none",
      columns: [
        column(111, "id", "id", { type: "UUID", notNull: true }),
        column(112, "name", "name", { type: "Text", comment: "Ledger name" }),
      ],
      primaryKey: { name: "ledger_pk", columns: ["id"] },
    }),
  })
}

function enumerations(): Map<string, string> {
  return domain({
    "enumerations/Color/Color.meta.json": {
      id: uuid(121),
      kind: "Enumeration",
      name: "Color",
      physicalName: "color",
      values: [
        { id: uuid(122), name: "Red", physicalName: "red" },
        { id: uuid(123), name: "Blue", physicalName: "blue" },
      ],
    },
    "pg-enums/Mood/Mood.meta.json": {
      id: uuid(124),
      kind: "PgEnum",
      name: "Mood",
      physicalName: "mood",
      values: ["happy", "sad"],
    },
    "catalogs/Item/Item.meta.json": catalog("Item", {
      scope: "org",
      attributes: [
        attribute("color", {
          ...ref("Enumeration", "Color"),
          defaultValue: "Red",
        }),
      ],
    }),
    "custom-tables/Diary/Diary.meta.json": customTable("Diary", {
      scope: "none",
      columns: [
        {
          id: uuid(125),
          name: "id",
          physicalName: "id",
          type: "UUID",
          notNull: true,
        },
        {
          id: uuid(126),
          name: "mood",
          physicalName: "mood",
          type: "PgEnum",
          enum: { kind: "PgEnum", name: "Mood" },
          notNull: true,
          default: "'happy'",
        },
      ],
      primaryKey: { columns: ["id"] },
    }),
  })
}

const MOVEMENTS_SQL = "documents/Sale/Sale.sql"

function movementQuery(): Map<string, string> {
  return domain({
    "catalogs/Item/Item.meta.json": catalog("Item", { scope: "org" }),
    [SALE_FILE]: document("Sale", {
      scope: "org",
      numberPeriodicity: "Month",
      registerMovements: [{ kind: "AccumulationRegister", name: "Stock" }],
      tabularSections: [
        {
          id: uuid(131),
          name: "goods",
          physicalName: "sale_goods",
          attributes: [
            attribute("item", {
              ...ref("Catalog", "Item"),
              physicalName: "item_id",
            }),
            attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
          ],
        },
      ],
    }),
    [STOCK_FILE]: {
      id: uuid(132),
      kind: "AccumulationRegister",
      name: "Stock",
      physicalName: "stock",
      scope: "org",
      recorderTypes: [{ kind: "Document", name: "Sale" }],
      dimensions: [
        attribute("item", {
          ...ref("Catalog", "Item"),
          physicalName: "item_id",
        }),
      ],
      resources: [
        attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
      ],
    },
    // Функції множини скоупу — справжні одиниці з тілом, що читає таблиці
    // домену й провайдера: `LANGUAGE sql` перевіряє його при створенні.
    [SCOPE_FUNCTIONS_FILE]: [
      "CREATE FUNCTION app.org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE",
      "  AS $$ SELECT id FROM app.organization $$;",
      "CREATE FUNCTION app.user_ids() RETURNS SETOF uuid LANGUAGE sql STABLE",
      "  AS $$ SELECT id FROM auth.users WHERE id = auth.uid() $$;",
    ].join("\n"),
    [MOVEMENTS_SQL]: [
      "-- @movements Stock",
      "SELECT d.date, 'Expense', g.item_id, g.qty",
      "FROM app.sale_goods g JOIN app.sale d ON d.id = g.parent_id",
      "WHERE d.id = p_document_id",
      "ORDER BY g.line_number",
      "-- @end",
      "",
    ].join("\n"),
  })
}

async function compiled(files: Map<string, string>): Promise<CompiledModel> {
  const result = await compile(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/** Розгортає модель у транзакції клієнта й повертає її схеми. */
async function deploy(
  client: pg.Client,
  model: CompiledModel
): Promise<string[]> {
  await client.query(renderDesiredState(model).sql)
  return [
    ...new Set([
      ...model.physical.tables.map((table) => table.schema),
      ...model.physical.enumTypes.map((type) => type.schema),
    ]),
  ]
}

const FIXTURES: [string, () => Map<string, string>][] = [
  [
    "scoped catalog with hierarchy, owner, code numbering and predefined items",
    scopedCatalog,
  ],
  [
    "document with two tabular sections, number_period and required check",
    saleDocument,
  ],
  [
    "balance and turnover accumulation registers with turnovers_month and totals",
    accumulationRegisters,
  ],
  [
    "independent and subordinate information registers with nullable dimensions",
    informationRegisters,
  ],
  ["scoped and global constants", constants],
  [
    "custom table with composite key, FK to auth.users, partial expression index, generated column, deferrable unique",
    customTables,
  ],
  ["enumeration reference with check and pg enum column", enumerations],
  ["movement query wrapper and a scope set function unit", movementQuery],
]

/** Код помилки Postgres (SQLSTATE) з винятку `pg`. */
async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

/** Організація — корінь скоупу `org`: на неї посилається кожен скоуплений рядок. */
async function insertOrganization(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO app.organization (id) VALUES (gen_random_uuid()) RETURNING id"
  )
  return rows[0]!.id
}

describe("deploy the desired state to Postgres", () => {
  for (const [name, fixture] of FIXTURES) {
    it(name, async () => {
      const model = await compiled(fixture())
      await withRollback(async (client) => {
        const schemas = await deploy(client, model)
        const catalog = await readCatalog(client, schemas)
        expectCatalogMatchesSnapshot(catalog, model.physical)
        // Функції одиниць і обгортки рухів створені там, де їх чекає модель.
        const functions = catalog.functions.map((f) => `${f.schema}.${f.name}`)
        for (const unit of model.sqlUnits) {
          if (unit.class === "function" || unit.class === "movementQuery") {
            expect(functions).toContain(`${unit.schema}.${unit.name}`)
          }
        }
      })
    })
  }

  it("the comparison notices a snapshot that differs from the catalog", async () => {
    const model = await compiled(customTables())
    await withRollback(async (client) => {
      const catalog = await readCatalog(client, await deploy(client, model))
      const audit = model.physical.tables.find((t) => t.name === "audit")!
      const tampered: ((table: PhysicalTable) => PhysicalTable)[] = [
        (t) => ({ ...t, columns: [...t.columns].reverse() }),
        (t) => ({
          ...t,
          foreignKeys: t.foreignKeys.map((fk) => ({
            ...fk,
            onDelete: "restrict",
          })),
        }),
        (t) => ({
          ...t,
          uniques: t.uniques.map((u) => ({
            ...u,
            nullsNotDistinct: !u.nullsNotDistinct,
          })),
        }),
        (t) => ({
          ...t,
          indexes: t.indexes.map((index) => ({ ...index, where: undefined })),
        }),
        (t) => ({ ...t, indexes: [] }),
        (t) => ({ ...t, rowLevelSecurity: "forced" }),
      ]
      for (const change of tampered) {
        const physical = {
          ...model.physical,
          tables: model.physical.tables.map((t) =>
            t === audit ? change(t) : t
          ),
        }
        expect(() => expectCatalogMatchesSnapshot(catalog, physical)).toThrow()
      }
    })
  })

  it("nulls not distinct rejects a second row with null dimension", async () => {
    const model = await compiled(accumulationRegisters())
    await withRollback(async (client) => {
      await deploy(client, model)
      const org = await insertOrganization(client)
      const insert = () =>
        client.query(
          `INSERT INTO app.stock_turnovers_month (org_id, item_id, lot, month)
           VALUES ($1, NULL, NULL, '2026-01-01')`,
          [org]
        )
      await insert()
      expect(await sqlState(insert())).toBe("23505")
    })
  })

  it("number_period is generated in the project time zone", async () => {
    const model = await compiled(saleDocument())
    await withRollback(async (client) => {
      await deploy(client, model)
      const org = await insertOrganization(client)
      // 23:30 UTC 31 січня — це вже 1 лютого в Києві: місяць нумерації — лютий.
      const { rows } = await client.query<{ number_period: string }>(
        `INSERT INTO app.sale (org_id, date)
         VALUES ($1, '2026-01-31 23:30:00+00')
         RETURNING number_period::text`,
        [org]
      )
      expect(rows).toEqual([{ number_period: "2026-02-01" }])
    })
  })

  it("movement wrapper returns rows", async () => {
    const model = await compiled(movementQuery())
    await withRollback(async (client) => {
      await deploy(client, model)
      // Текст `timestamptz` залежить від поясу сесії — фіксуємо його.
      await client.query("SET LOCAL TimeZone = 'UTC'")
      const org = await insertOrganization(client)
      const {
        rows: [ids],
      } = await client.query<{ item: string; sale: string }>(
        `WITH item AS (
           INSERT INTO app.item (id, org_id) VALUES (gen_random_uuid(), $1)
           RETURNING id
         ), sale AS (
           INSERT INTO app.sale (org_id, date)
           VALUES ($1, '2026-03-10 12:00:00+00') RETURNING id
         )
         SELECT item.id AS item, sale.id AS sale FROM item, sale`,
        [org]
      )
      await client.query(
        `INSERT INTO app.sale_goods (org_id, parent_id, line_number, item_id, qty)
         VALUES ($1, $2, 2, $3, 5), ($1, $2, 1, $3, 3)`,
        [org, ids!.sale, ids!.item]
      )
      const { rows } = await client.query(
        `SELECT period::text, movement_type, item_id, qty::text
           FROM app.sale_stock_movements($1)`,
        [ids!.sale]
      )
      expect(rows).toEqual([
        {
          period: "2026-03-10 12:00:00+00",
          movement_type: "Expense",
          item_id: ids!.item,
          qty: "3.000",
        },
        {
          period: "2026-03-10 12:00:00+00",
          movement_type: "Expense",
          item_id: ids!.item,
          qty: "5.000",
        },
      ])
    })
  })
})
