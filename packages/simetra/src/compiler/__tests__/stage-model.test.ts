import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { makeObjectName, type PhysicalTable } from "simetra/model"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  organization,
  project,
  scopedProject,
  uuid,
} from "./helpers"

async function compileWith(entries: Record<string, unknown>) {
  const result = await compile(
    metaFiles({ "project.meta.json": project(), ...entries })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!.physical
}

/** Індекси без часткового унікального індексу `predefined_name` (окремий тест). */
function searchIndexes(table: PhysicalTable) {
  return table.indexes.filter((index) => index.where === undefined)
}

function tableOf(
  physical: { tables: PhysicalTable[] },
  name: string,
  schema = "public"
): PhysicalTable {
  const table = physical.tables.find(
    (t) => t.schema === schema && t.name === name
  )
  expect(table, `${schema}.${name}`).toBeDefined()
  return table!
}

const currencyRef = { type: "Ref", ref: { kind: "Catalog", name: "Currency" } }

function enumeration(name: string, labels: string[]) {
  return {
    id: uuid(600 + name.length),
    kind: "Enumeration",
    name,
    physicalName: name.toLowerCase(),
    values: labels.map((label, index) => ({
      id: uuid(610 + index),
      name: label[0]!.toUpperCase() + label.slice(1),
      physicalName: label,
    })),
  }
}

describe("stage 3: physical snapshot", () => {
  it("predefined name partial unique index", async () => {
    const plain = tableOf(
      await compileWith({
        "catalogs/Warehouse/Warehouse.meta.json": catalog("Warehouse"),
      }),
      "warehouse"
    )
    const index = plain.indexes.find((i) => i.unique)
    expect(index).toEqual({
      name: "warehouse_predefined_name_idx",
      unique: true,
      method: "btree",
      keys: [{ column: "predefined_name" }],
      include: [],
      where: "predefined_name IS NOT NULL",
      nullsNotDistinct: false,
    })

    const scoped = tableOf(
      await compileWith({
        "project.meta.json": scopedProject(),
        "catalogs/Organization/Organization.meta.json": organization(),
        "catalogs/Warehouse/Warehouse.meta.json": catalog("Warehouse", {
          scope: "org",
        }),
      }),
      "warehouse"
    )
    const scopedIndex = scoped.indexes.find((i) => i.where !== undefined)
    expect(scopedIndex?.keys).toEqual([
      { column: "org_id" },
      { column: "predefined_name" },
    ])
    expect(scopedIndex?.unique).toBe(true)
  })

  it("user attribute named version", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          attributes: [attribute("version", { id: uuid(2) })],
        }),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-reserved",
        pointer: "/attributes/0/name",
      }),
    ])
  })

  it("catalog table", async () => {
    const physical = await compileWith({
      "catalogs/Contract/Contract.meta.json": catalog("Contract", {
        id: uuid(1),
        attributes: [
          attribute("currency", {
            id: uuid(2),
            physicalName: "currency_id",
            ...currencyRef,
          }),
        ],
      }),
      "catalogs/Currency/Currency.meta.json": catalog("Currency"),
    })
    const contract = tableOf(physical, "contract")

    expect(contract.origin).toEqual({ objectId: uuid(1) })
    expect(
      contract.columns.map(({ name, type, notNull, default: value }) => ({
        name,
        type,
        notNull,
        default: value,
      }))
    ).toEqual([
      { name: "id", type: "uuid", notNull: true, default: undefined },
      {
        name: "code",
        type: "character varying(9)",
        notNull: false,
        default: undefined,
      },
      {
        name: "description",
        type: "character varying(150)",
        notNull: false,
        default: undefined,
      },
      {
        name: "deletion_mark",
        type: "boolean",
        notNull: true,
        default: "false",
      },
      {
        name: "predefined_name",
        type: "text",
        notNull: false,
        default: undefined,
      },
      { name: "version", type: "bigint", notNull: true, default: "1" },
      {
        name: "created_at",
        type: "timestamp with time zone",
        notNull: true,
        default: "now()",
      },
      {
        name: "updated_at",
        type: "timestamp with time zone",
        notNull: true,
        default: "now()",
      },
      { name: "currency_id", type: "uuid", notNull: false, default: undefined },
    ])
    expect(contract.columns[0]!.origin).toEqual({ standard: "ref" })
    expect(contract.columns.at(-1)!.origin).toEqual({ elementId: uuid(2) })
    expect(contract.primaryKey).toEqual({
      name: "contract_pkey",
      columns: ["id"],
    })
    expect(contract.foreignKeys).toEqual([
      {
        name: "contract_currency_id_fkey",
        columns: ["currency_id"],
        references: { schema: "public", table: "currency", columns: ["id"] },
        onDelete: "noAction",
        onUpdate: "noAction",
        deferrable: "no",
      },
    ])
    expect(contract.uniques).toEqual([
      { name: "contract_code_key", columns: ["code"], nullsNotDistinct: false },
    ])
    expect(searchIndexes(contract)).toEqual([
      {
        name: "contract_currency_id_idx",
        unique: false,
        method: "btree",
        keys: [{ column: "currency_id" }],
        include: [],
        nullsNotDistinct: false,
      },
    ])
  })

  it("attribute flags: required, default, unique, indexed", async () => {
    const physical = await compileWith({
      "catalogs/Item/Item.meta.json": catalog("Item", {
        codeLength: 0,
        attributes: [
          attribute("note", {
            type: "String",
            length: 20,
            required: true,
            defaultValue: "it's",
          }),
          attribute("rank", {
            type: "Integer",
            defaultValue: 3,
            indexed: true,
          }),
          attribute("sku", { type: "Text", unique: true, indexed: true }),
          attribute("flag", { defaultValue: true }),
        ],
      }),
    })
    const item = tableOf(physical, "item")
    const column = (name: string) => item.columns.find((c) => c.name === name)!
    expect(column("note")).toMatchObject({
      type: "character varying(20)",
      notNull: true,
      default: "'it''s'",
    })
    expect(column("rank").default).toBe("3")
    expect(column("flag").default).toBe("true")
    expect(item.uniques.map((u) => u.name)).toEqual(["item_sku_key"])
    expect(searchIndexes(item).map((i) => i.name)).toEqual(["item_rank_idx"])
  })

  it("required document attribute is checked on posting", async () => {
    const physical = await compileWith({
      "catalogs/Customer/Customer.meta.json": catalog("Customer"),
      "documents/Sale/Sale.meta.json": document("Sale", {
        attributes: [
          attribute("customer", {
            physicalName: "customer_id",
            type: "Ref",
            ref: { kind: "Catalog", name: "Customer" },
            required: true,
          }),
        ],
      }),
    })
    const sale = tableOf(physical, "sale")
    expect(sale.columns.find((c) => c.name === "customer_id")).toMatchObject({
      notNull: false,
    })
    expect(sale.checks).toContainEqual({
      name: "sale_customer_id_required",
      expression: "NOT posted OR customer_id IS NOT NULL",
    })
  })

  it("required polymorphic header attribute", async () => {
    const physical = await compileWith({
      "catalogs/Contract/Contract.meta.json": catalog("Contract"),
      "catalogs/Counterparty/Counterparty.meta.json": catalog("Counterparty"),
      "documents/Sale/Sale.meta.json": document("Sale", {
        attributes: [
          attribute("subject", {
            type: "Ref",
            required: true,
            allowedTypes: [
              { kind: "Catalog", name: "Contract" },
              { kind: "Catalog", name: "Counterparty" },
            ],
          }),
        ],
      }),
    })
    const sale = tableOf(physical, "sale")
    expect(sale.columns.filter((c) => c.name.startsWith("subject_"))).toEqual([
      expect.objectContaining({ name: "subject_type", notNull: false }),
      expect.objectContaining({ name: "subject_id", notNull: false }),
    ])
    expect(sale.checks).toContainEqual({
      name: "sale_subject_type_required",
      expression:
        "NOT posted OR (subject_type IS NOT NULL AND subject_id IS NOT NULL)",
    })
  })

  it("required tabular row attribute", async () => {
    const physical = await compileWith({
      "documents/Sale/Sale.meta.json": document("Sale", {
        tabularSections: [
          {
            id: uuid(11),
            name: "goods",
            physicalName: "sale_goods",
            attributes: [attribute("qty", { type: "Integer", required: true })],
          },
        ],
      }),
    })
    const goods = tableOf(physical, "sale_goods")
    expect(goods.columns.find((c) => c.name === "qty")).toMatchObject({
      notNull: false,
    })
    expect(goods.checks.filter((c) => c.name.includes("required"))).toEqual([])
    expect(goods.checks).toEqual([])
  })

  it("required string of a catalog is NOT NULL plus a nonempty check", async () => {
    const physical = await compileWith({
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [
          attribute("note", { type: "String", length: 20, required: true }),
          attribute("qty", { type: "Integer", required: true }),
          attribute("tags", {
            type: "String",
            length: 5,
            array: true,
            required: true,
          }),
          attribute("memo", { type: "Text" }),
        ],
      }),
    })
    const item = tableOf(physical, "item")
    expect(item.columns.find((c) => c.name === "note")?.notNull).toBe(true)
    expect(item.checks).toContainEqual({
      name: "item_note_nonempty",
      expression: "note !~ '^\\s*$'",
    })
    expect(
      item.checks.filter((c) => c.name.endsWith("_nonempty"))
    ).toHaveLength(1)
  })

  it("numeric bounds form one CHECK", async () => {
    const physical = await compileWith({
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [
          attribute("qty", {
            type: "Numeric",
            precision: 10,
            scale: 2,
            nonNegative: true,
            maxValue: "1000",
          }),
          attribute("rank", { type: "Integer", positive: true, minValue: 5 }),
          attribute("delta", { type: "Integer", minValue: -3, maxValue: 3 }),
          attribute("plain", { type: "Integer" }),
        ],
      }),
    })
    const item = tableOf(physical, "item")
    expect(item.checks).toContainEqual({
      name: "item_qty_bounds",
      expression: "qty >= 0 AND qty <= 1000",
    })
    expect(item.checks).toContainEqual({
      name: "item_rank_bounds",
      expression: "rank > 0 AND rank >= 5",
    })
    expect(item.checks).toContainEqual({
      name: "item_delta_bounds",
      expression: "delta >= -3 AND delta <= 3",
    })
    expect(item.checks.filter((c) => c.name.startsWith("item_plain"))).toEqual(
      []
    )
  })

  it("pattern and minLength form one CHECK", async () => {
    const physical = await compileWith({
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [
          attribute("sku", {
            type: "String",
            length: 20,
            pattern: "^[A-Z]+$",
            minLength: 2,
          }),
          attribute("memo", { type: "Text", pattern: "it's" }),
        ],
      }),
    })
    const item = tableOf(physical, "item")
    expect(item.checks).toContainEqual({
      name: "item_sku_format",
      expression: "sku ~ '^[A-Z]+$' AND char_length(sku) >= 2",
    })
    expect(item.checks).toContainEqual({
      name: "item_memo_format",
      expression: "memo ~ 'it''s'",
    })
  })

  it("required text of a register dimension is nonempty too", async () => {
    const physical = await compileWith({
      "information-registers/Rate/Rate.meta.json": {
        id: uuid(30),
        kind: "InformationRegister",
        name: "Rate",
        physicalName: "rate",
        periodicity: "Day",
        dimensions: [attribute("zone", { type: "Text", required: true })],
        resources: [attribute("value", { type: "Integer" })],
      },
    })
    expect(tableOf(physical, "rate").checks).toContainEqual({
      name: "rate_zone_nonempty",
      expression: "zone !~ '^\\s*$'",
    })
  })

  it("required string of a document header is nonempty only when posted", async () => {
    const physical = await compileWith({
      "documents/Sale/Sale.meta.json": document("Sale", {
        attributes: [
          attribute("note", { type: "String", length: 20, required: true }),
        ],
        tabularSections: [
          {
            id: uuid(11),
            name: "goods",
            physicalName: "sale_goods",
            attributes: [
              attribute("memo", { type: "String", length: 20, required: true }),
            ],
          },
        ],
      }),
    })
    const sale = tableOf(physical, "sale")
    expect(sale.checks).toContainEqual({
      name: "sale_note_required",
      expression: "NOT posted OR (note IS NOT NULL AND note !~ '^\\s*$')",
    })
    expect(sale.checks.some((c) => c.name.endsWith("_nonempty"))).toBe(false)
    expect(tableOf(physical, "sale_goods").checks).toEqual([])
  })

  it("required catalog attribute stays not null", async () => {
    const physical = await compileWith({
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [attribute("note", { type: "Integer", required: true })],
      }),
      "information-registers/Rate/Rate.meta.json": {
        id: uuid(30),
        kind: "InformationRegister",
        name: "Rate",
        physicalName: "rate",
        periodicity: "Day",
        resources: [attribute("value", { type: "Integer", required: true })],
      },
    })
    for (const [table, column] of [
      ["item", "note"],
      ["rate", "value"],
    ] as const) {
      const found = tableOf(physical, table)
      expect(found.columns.find((c) => c.name === column)).toMatchObject({
        notNull: true,
      })
      expect(found.checks.filter((c) => c.name.includes("required"))).toEqual(
        []
      )
    }
  })

  it("document tabular section", async () => {
    const physical = await compileWith({
      "documents/Invoice/Invoice.meta.json": document("Invoice", {
        id: uuid(10),
        tabularSections: [
          {
            id: uuid(11),
            name: "lines",
            physicalName: "invoice_lines",
            attributes: [attribute("qty", { type: "Integer" })],
          },
        ],
      }),
    })
    const invoice = tableOf(physical, "invoice")
    expect(invoice.columns[0]).toMatchObject({
      name: "id",
      default: "gen_random_uuid()",
    })
    const lines = tableOf(physical, "invoice_lines")
    expect(lines.origin).toEqual({
      objectId: uuid(10),
      tabularSectionId: uuid(11),
    })
    expect(lines.columns.map((c) => c.name)).toEqual([
      "id",
      "parent_id",
      "line_number",
      "qty",
    ])
    expect(lines.columns[0]).toMatchObject({ default: "gen_random_uuid()" })
    expect(lines.columns[2]).toMatchObject({
      type: "integer",
      notNull: true,
    })
    expect(lines.foreignKeys).toEqual([
      expect.objectContaining({
        name: "invoice_lines_parent_id_fkey",
        columns: ["parent_id"],
        references: { schema: "public", table: "invoice", columns: ["id"] },
        onDelete: "cascade",
      }),
    ])
    expect(lines.indexes.map((i) => i.name)).toEqual([
      "invoice_lines_parent_id_idx",
    ])
  })

  it("enumeration reference is text with check", async () => {
    const physical = await compileWith({
      "enumerations/Status/Status.meta.json": enumeration("Status", [
        "draft",
        "posted",
      ]),
      "catalogs/Order/Order.meta.json": catalog("Order", {
        attributes: [
          attribute("status", {
            type: "Ref",
            ref: { kind: "Enumeration", name: "Status" },
          }),
          attribute("history", {
            type: "Ref",
            ref: { kind: "Enumeration", name: "Status" },
            array: true,
          }),
        ],
      }),
    })
    const order = tableOf(physical, "order")
    expect(order.columns.find((c) => c.name === "status")!.type).toBe("text")
    expect(order.columns.find((c) => c.name === "history")!.type).toBe("text[]")
    expect(order.checks).toEqual([
      {
        name: "order_history_check",
        expression: "history <@ ARRAY['draft', 'posted']",
      },
      {
        name: "order_status_check",
        expression: "status IN ('draft', 'posted')",
      },
    ])
    expect(order.foreignKeys).toEqual([])
    expect(searchIndexes(order)).toEqual([])
    expect(physical.tables.map((t) => t.name)).toEqual(["order"])
  })

  it("array of references is uuid[] without fk", async () => {
    const physical = await compileWith({
      "catalogs/Currency/Currency.meta.json": catalog("Currency"),
      "catalogs/Rate/Rate.meta.json": catalog("Rate", {
        attributes: [attribute("currencies", { ...currencyRef, array: true })],
      }),
    })
    const rate = tableOf(physical, "rate")
    expect(rate.columns.at(-1)).toMatchObject({
      name: "currencies",
      type: "uuid[]",
    })
    expect(rate.foreignKeys).toEqual([])
    expect(searchIndexes(rate)).toEqual([])
  })

  it("polymorphic reference", async () => {
    const physical = await compileWith({
      "catalogs/Contract/Contract.meta.json": catalog("Contract", {
        kindLabel: "agreement",
      }),
      "catalogs/Counterparty/Counterparty.meta.json": catalog("Counterparty"),
      "catalogs/Note/Note.meta.json": catalog("Note", {
        attributes: [
          attribute("subject", {
            id: uuid(20),
            type: "Ref",
            required: true,
            allowedTypes: [
              { kind: "Catalog", name: "Contract" },
              { kind: "Catalog", name: "Counterparty" },
            ],
          }),
        ],
      }),
    })
    const note = tableOf(physical, "note")
    expect(note.columns.slice(-2)).toEqual([
      {
        name: "subject_type",
        type: "text",
        collation: { name: "C" },
        notNull: true,
        origin: { elementId: uuid(20) },
      },
      {
        name: "subject_id",
        type: "uuid",
        notNull: true,
        origin: { elementId: uuid(20) },
      },
    ])
    expect(note.checks).toEqual([
      {
        name: "note_subject_type_check",
        expression: "subject_type IN ('agreement', 'counterparty')",
      },
    ])
    expect(note.foreignKeys).toEqual([])
  })

  it("polymorphic target without a label", async () => {
    // Перерахування в allowedTypes: мітки в нього немає, стадія 3 не падає, а
    // значення просто відсутнє в CHECK; помилку дає стадія 4.
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/A/A.meta.json": catalog("A"),
        "enumerations/Status/Status.meta.json": enumeration("Status", ["open"]),
        "catalogs/Note/Note.meta.json": catalog("Note", {
          attributes: [
            attribute("subject", {
              type: "Ref",
              allowedTypes: [
                { kind: "Catalog", name: "A" },
                { kind: "Enumeration", name: "Status" },
              ],
            }),
          ],
        }),
      })
    )
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "reference.polymorphic-target-kind"
    )
  })

  it("standard polymorphic pairs: catalog owners and register recorder", async () => {
    const physical = await compileWith({
      "catalogs/A/A.meta.json": catalog("A"),
      "catalogs/B/B.meta.json": catalog("B"),
      "catalogs/Single/Single.meta.json": catalog("Single", {
        owners: [{ kind: "Catalog", name: "A" }],
      }),
      "catalogs/Many/Many.meta.json": catalog("Many", {
        owners: [
          { kind: "Catalog", name: "A" },
          { kind: "Catalog", name: "B" },
        ],
      }),
      "documents/Sale/Sale.meta.json": document("Sale"),
      "accumulation-registers/Stock/Stock.meta.json": {
        id: uuid(30),
        kind: "AccumulationRegister",
        name: "Stock",
        physicalName: "stock",
        recorderTypes: [{ kind: "Document", name: "Sale" }],
        resources: [
          attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
        ],
      },
    })
    const single = tableOf(physical, "single")
    expect(single.columns.map((c) => c.name)).toContain("owner_id")
    expect(single.foreignKeys).toEqual([
      expect.objectContaining({
        name: "single_owner_id_fkey",
        references: { schema: "public", table: "a", columns: ["id"] },
      }),
    ])

    const many = tableOf(physical, "many")
    expect(many.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["owner_type", "owner_id"])
    )
    expect(many.columns.find((c) => c.name === "owner_type")!.origin).toEqual({
      standard: "owner",
    })
    expect(many.checks).toEqual([
      { name: "many_owner_type_check", expression: "owner_type IN ('a', 'b')" },
    ])
    expect(many.foreignKeys).toEqual([])
    expect(searchIndexes(many)).toEqual([
      expect.objectContaining({
        name: "many_owner_type_owner_id_idx",
        keys: [{ column: "owner_type" }, { column: "owner_id" }],
      }),
    ])

    const stock = tableOf(physical, "stock")
    expect(stock.primaryKey).toEqual({
      name: "stock_pkey",
      columns: ["recorder_type", "recorder_id", "line_number"],
    })
    expect(stock.columns.map((c) => `${c.name} ${c.type}`)).toEqual([
      "period timestamp with time zone",
      "recorder_type text",
      "recorder_id uuid",
      "line_number integer",
      "active boolean",
      "movement_type text",
      "qty numeric(15,3)",
    ])
    expect(stock.checks.map((c) => c.name)).toEqual([
      "stock_movement_type_check",
      "stock_recorder_type_check",
    ])
    expect(stock.checks[1]!.expression).toBe("recorder_type IN ('sale')")
    expect(
      stock.columns.find((c) => c.name === "recorder_type")!.collation
    ).toEqual({
      name: "C",
    })
    expect(stock.indexes.map((i) => i.name)).toEqual([
      "stock_period_recorder_type_recorder_id_idx",
    ])
  })

  it("constant is a singleton table with a typed value", async () => {
    const physical = await compileWith({
      "catalogs/Currency/Currency.meta.json": catalog("Currency"),
      "constants/MainCurrency/MainCurrency.meta.json": {
        id: uuid(40),
        kind: "Constant",
        name: "MainCurrency",
        physicalName: "main_currency",
        ...currencyRef,
      },
    })
    const constant = tableOf(physical, "main_currency")
    expect(constant.columns).toEqual([
      {
        name: "singleton",
        type: "boolean",
        notNull: true,
        default: "true",
        origin: { standard: "singleton" },
      },
      {
        name: "value",
        type: "uuid",
        notNull: false,
        origin: { standard: "value" },
      },
    ])
    expect(constant.primaryKey?.name).toBe("main_currency_pkey")
    expect(constant.checks).toEqual([
      { name: "main_currency_singleton_check", expression: "singleton" },
    ])
    expect(constant.foreignKeys.map((f) => f.name)).toEqual([
      "main_currency_value_fkey",
    ])
  })

  it("constant defaultValue becomes the DEFAULT of the value column", async () => {
    const constantOf = (n: number, name: string, extra: object) => ({
      [`constants/${name}/${name}.meta.json`]: {
        id: uuid(n),
        kind: "Constant",
        name,
        physicalName: name.toLowerCase(),
        ...extra,
      },
    })
    const physical = await compileWith({
      ...constantOf(60, "Greeting", {
        type: "String",
        length: 20,
        defaultValue: "it's",
      }),
      ...constantOf(61, "Limit", { type: "Integer", defaultValue: 3 }),
      ...constantOf(62, "Enabled", { type: "Boolean", defaultValue: true }),
      ...constantOf(63, "Plain", { type: "Integer" }),
    })
    const valueOf = (table: string) =>
      tableOf(physical, table).columns.find((c) => c.name === "value")!
    expect(valueOf("greeting").default).toBe("'it''s'")
    expect(valueOf("limit").default).toBe("3")
    expect(valueOf("enabled").default).toBe("true")
    expect(valueOf("plain")).not.toHaveProperty("default")
  })

  it("fill and empty default forms become DEFAULT expressions", async () => {
    const physical = await compileWith({
      "project.meta.json": project({ timezone: "Europe/Kyiv" }),
      "catalogs/Item/Item.meta.json": catalog("Item", {
        codeLength: 0,
        attributes: [
          attribute("seenAt", {
            type: "DateTime",
            defaultValue: { fill: "now" },
          }),
          attribute("seenOn", {
            type: "Date",
            defaultValue: { fill: "today" },
          }),
          attribute("token", {
            type: "UUID",
            defaultValue: { fill: "newUuid" },
          }),
          attribute("tags", {
            type: "String",
            length: 5,
            array: true,
            defaultValue: { empty: true },
          }),
          attribute("doc", { type: "Json", defaultValue: { empty: "object" } }),
          attribute("list", { type: "Json", defaultValue: { empty: "array" } }),
        ],
      }),
      "constants/Day/Day.meta.json": {
        id: uuid(70),
        kind: "Constant",
        name: "Day",
        physicalName: "day",
        type: "Date",
        defaultValue: { fill: "today" },
      },
    })
    const item = tableOf(physical, "item")
    const column = (name: string) => item.columns.find((c) => c.name === name)!
    expect(column("seen_at").default).toBe("now()")
    expect(column("seen_on").default).toBe(
      "(now() AT TIME ZONE 'Europe/Kyiv')::date"
    )
    expect(column("token").default).toBe("gen_random_uuid()")
    expect(column("tags").default).toBe("'{}'")
    expect(column("doc").default).toBe("'{}'::jsonb")
    expect(column("list").default).toBe("'[]'::jsonb")
    expect(
      tableOf(physical, "day").columns.find((c) => c.name === "value")!.default
    ).toBe("(now() AT TIME ZONE 'Europe/Kyiv')::date")
  })

  it("enumeration default becomes its label in DEFAULT for attributes and constants", async () => {
    const status = { kind: "Enumeration", name: "Status" }
    const physical = await compileWith({
      "enumerations/Status/Status.meta.json": {
        id: uuid(64),
        kind: "Enumeration",
        name: "Status",
        physicalName: "status",
        values: [
          { id: uuid(65), name: "Open", physicalName: "open_label" },
          { id: uuid(66), name: "Closed", physicalName: "it's_closed" },
        ],
      },
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [
          attribute("status", {
            type: "Ref",
            ref: status,
            defaultValue: "Closed",
          }),
        ],
      }),
      "constants/Initial/Initial.meta.json": {
        id: uuid(67),
        kind: "Constant",
        name: "Initial",
        physicalName: "initial",
        type: "Ref",
        ref: status,
        defaultValue: "Open",
      },
    })
    const columnOf = (table: string, name: string) =>
      tableOf(physical, table).columns.find((c) => c.name === name)!
    expect(columnOf("item", "status").default).toBe("'it''s_closed'")
    expect(columnOf("initial", "value").default).toBe("'open_label'")
  })

  it("custom table with external fk and pg enum column", async () => {
    const physical = await compileWith({
      "pg-enums/OrderStatus/OrderStatus.meta.json": {
        id: uuid(50),
        kind: "PgEnum",
        name: "OrderStatus",
        physicalName: "order_status",
        values: ["new", "paid", "shipped"],
      },
      "custom-tables/Profile/Profile.meta.json": customTable("Profile", {
        schema: "app",
        comment: "User profile",
        columns: [
          {
            id: uuid(51),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          {
            id: uuid(52),
            name: "userId",
            physicalName: "user_id",
            type: "UUID",
            notNull: true,
            comment: "Owner",
          },
          {
            id: uuid(53),
            name: "status",
            physicalName: "status",
            type: "PgEnum",
            enum: { kind: "PgEnum", name: "OrderStatus" },
          },
          {
            id: uuid(54),
            name: "counter",
            physicalName: "counter",
            type: "BigInt",
            identity: "always",
            notNull: true,
          },
          {
            id: uuid(55),
            name: "payload",
            physicalName: "payload",
            type: "Raw",
            pgType: "tsvector",
          },
        ],
        primaryKey: { columns: ["id"] },
        uniques: [{ columns: ["userId", "status"], nullsNotDistinct: true }],
        checks: [
          { name: "profile_counter_positive", expression: "counter > 0" },
        ],
        foreignKeys: [
          {
            name: "profile_user_fk",
            columns: ["userId"],
            references: {
              external: { schema: "auth", table: "users", columns: ["id"] },
            },
            onDelete: "cascade",
          },
        ],
        indexes: [
          { keys: [{ column: "status" }], where: "status IS NOT NULL" },
          {
            name: "profile_status_lower_idx",
            keys: [{ expression: "lower(status::text)" }],
            include: ["counter"],
          },
        ],
      }),
    })
    expect(physical.enumTypes).toEqual([
      {
        schema: "public",
        name: "order_status",
        values: ["new", "paid", "shipped"],
        origin: { objectId: uuid(50) },
      },
    ])
    const profile = tableOf(physical, "profile", "app")
    expect(profile.comment).toBe("User profile")
    expect(profile.columns.map((c) => c.type)).toEqual([
      "uuid",
      "uuid",
      "public.order_status",
      "bigint",
      "tsvector",
    ])
    expect(profile.columns[1]!.comment).toBe("Owner")
    expect(profile.columns[3]!.identity).toEqual({
      generation: "always",
      sequence: "profile_counter_seq",
    })
    expect(profile.primaryKey).toEqual({
      name: "profile_pkey",
      columns: ["id"],
    })
    expect(profile.uniques).toEqual([
      {
        name: "profile_user_id_status_key",
        columns: ["user_id", "status"],
        nullsNotDistinct: true,
      },
    ])
    expect(profile.checks).toEqual([
      { name: "profile_counter_positive", expression: "counter > 0" },
    ])
    expect(profile.foreignKeys).toEqual([
      {
        name: "profile_user_fk",
        columns: ["user_id"],
        references: { schema: "auth", table: "users", columns: ["id"] },
        onDelete: "cascade",
        onUpdate: "noAction",
        deferrable: "no",
      },
    ])
    expect(profile.indexes).toEqual([
      expect.objectContaining({
        name: "profile_status_idx",
        keys: [{ column: "status" }],
        where: "status IS NOT NULL",
      }),
      expect.objectContaining({
        name: "profile_status_lower_idx",
        keys: [{ expression: "lower(status::text)" }],
        include: ["counter"],
      }),
    ])
  })

  it("reference to a custom table uses its uuid primary key", async () => {
    const physical = await compileWith({
      "custom-tables/Account/Account.meta.json": customTable("Account", {
        columns: [
          {
            id: uuid(60),
            name: "key",
            physicalName: "account_key",
            type: "UUID",
            notNull: true,
          },
        ],
        primaryKey: { columns: ["key"] },
      }),
      "catalogs/Client/Client.meta.json": catalog("Client", {
        attributes: [
          attribute("account", {
            physicalName: "account_id",
            type: "Ref",
            ref: { kind: "CustomTable", name: "Account" },
          }),
        ],
      }),
    })
    expect(tableOf(physical, "client").foreignKeys).toEqual([
      expect.objectContaining({
        references: {
          schema: "public",
          table: "account",
          columns: ["account_key"],
        },
      }),
    ])
  })

  it("custom table fk to a catalog maps logical columns to physical", async () => {
    const physical = await compileWith({
      "catalogs/Currency/Currency.meta.json": catalog("Currency"),
      "custom-tables/Rate/Rate.meta.json": customTable("Rate", {
        columns: [
          {
            id: uuid(70),
            name: "currency",
            physicalName: "currency",
            type: "UUID",
          },
        ],
        foreignKeys: [
          {
            columns: ["currency"],
            references: {
              object: { kind: "Catalog", name: "Currency" },
              columns: ["ref"],
            },
          },
        ],
      }),
    })
    expect(tableOf(physical, "rate").foreignKeys).toEqual([
      expect.objectContaining({
        name: "rate_currency_fkey",
        references: { schema: "public", table: "currency", columns: ["id"] },
      }),
    ])
  })

  it("explicit constraint names win", async () => {
    const physical = await compileWith({
      "custom-tables/Log/Log.meta.json": customTable("Log", {
        columns: [
          {
            id: uuid(80),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          { id: uuid(81), name: "code", physicalName: "code", type: "Text" },
        ],
        primaryKey: { name: "log_pk", columns: ["id"] },
        uniques: [{ name: "log_code_unique", columns: ["code"] }],
        checks: [{ name: "log_code_len", expression: "length(code) > 0" }],
        indexes: [
          // Явне ім'я займає автоматичне ім'я наступного індексу.
          { name: "log_code_idx", keys: [{ column: "id" }] },
          { keys: [{ column: "code" }] },
        ],
      }),
    })
    const log = tableOf(physical, "log")
    expect(log.primaryKey?.name).toBe("log_pk")
    expect(log.uniques.map((u) => u.name)).toEqual(["log_code_unique"])
    expect(log.checks.map((c) => c.name)).toEqual(["log_code_len"])
    expect(log.indexes.map((i) => i.name)).toEqual([
      "log_code_idx",
      "log_code_idx1",
    ])
  })

  it("long names use postgres truncation", async () => {
    const longName = "x".repeat(60)
    const physical = await compileWith({
      "catalogs/Customer/Customer.meta.json": catalog("Customer"),
      "catalogs/Long/Long.meta.json": catalog("Long", {
        physicalName: longName,
        codeLength: 0,
        attributes: [
          attribute("customer", {
            physicalName: "customer_id",
            type: "Ref",
            ref: { kind: "Catalog", name: "Customer" },
          }),
        ],
      }),
    })
    const table = tableOf(physical, longName)
    expect(table.foreignKeys[0]!.name).toBe(
      makeObjectName(longName, "customer_id", "fkey")
    )
    expect(table.foreignKeys[0]!.name).toBe(
      `${"x".repeat(46)}_customer_id_fkey`
    )
    expect(table.primaryKey?.name).toBe(`${"x".repeat(58)}_pkey`)
  })

  it("multi-column names stop growing at NAMEDATALEN like postgres", async () => {
    // Значення звірено з Postgres 17: доповнення з імен колонок перестає
    // рости, щойно досягає 64 байтів, решту обрізає makeObjectName.
    const first = "first_very_long_column_name_number_one_abcdefghij"
    const second = "second_very_long_column_name_number_two_abcdefghij"
    const column = (n: number, physicalName: string) => ({
      id: uuid(n),
      name: physicalName.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
      physicalName,
      type: "UUID",
    })
    const wide = "a".repeat(62)
    const physical = await compileWith({
      "custom-tables/T2/T2.meta.json": customTable("T2", {
        columns: [
          column(90, first),
          column(91, second),
          column(92, "third_col"),
        ],
        uniques: [
          {
            columns: [first, second, "third_col"].map((c) =>
              c.replace(/_(\w)/g, (_, x: string) => x.toUpperCase())
            ),
          },
        ],
        foreignKeys: [
          {
            columns: [first, second].map((c) =>
              c.replace(/_(\w)/g, (_, x: string) => x.toUpperCase())
            ),
            references: {
              external: { schema: "zt", table: "parent", columns: ["a", "b"] },
            },
          },
        ],
      }),
      "custom-tables/T3/T3.meta.json": customTable("T3", {
        columns: [
          column(93, wide),
          column(94, "bb"),
          column(95, "cc"),
          column(96, "dd"),
        ],
        indexes: [
          { keys: [{ column: wide }, { column: "bb" }, { column: "cc" }] },
          { keys: [{ column: "bb" }], include: ["cc", "dd"] },
          { keys: [{ column: "dd" }, { column: "dd" }] },
        ],
      }),
    })
    expect(tableOf(physical, "t2").uniques[0]!.name).toBe(
      "t2_first_very_long_column_name_number_one_abcdefghij_second_key"
    )
    expect(tableOf(physical, "t2").foreignKeys[0]!.name).toBe(
      "t2_first_very_long_column_name_number_one_abcdefghij_secon_fkey"
    )
    expect(
      tableOf(physical, "t3")
        .indexes.map((i) => i.name)
        .sort()
    ).toEqual(
      [`t3_${"a".repeat(56)}_idx`, "t3_bb_cc_dd_idx", "t3_dd_dd1_idx"].sort()
    )
  })

  it("deterministic regardless of map order", async () => {
    const entries: [string, unknown][] = [
      ["project.meta.json", project()],
      [
        "catalogs/Contract/Contract.meta.json",
        catalog("Contract", {
          id: uuid(1),
          attributes: [
            attribute("currency", {
              id: uuid(2),
              physicalName: "currency_id",
              ...currencyRef,
            }),
          ],
        }),
      ],
      [
        "catalogs/Currency/Currency.meta.json",
        catalog("Currency", { id: uuid(3) }),
      ],
      [
        "enumerations/Status/Status.meta.json",
        enumeration("Status", ["draft", "posted"]),
      ],
    ]
    const forward = await compile(metaFiles(Object.fromEntries(entries)))
    const backward = await compile(
      metaFiles(Object.fromEntries([...entries].reverse()))
    )
    expect(forward.ok).toBe(true)
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward))
  })

  it("document number period is generated", async () => {
    const table = tableOf(
      await compileWith({
        "documents/Invoice/Invoice.meta.json": document("Invoice"),
      }),
      "invoice"
    )
    const names = table.columns.map((c) => c.name)
    expect(names[names.indexOf("date") + 1]).toBe("number_period")
    const column = table.columns.find((c) => c.name === "number_period")
    expect(column).toEqual({
      name: "number_period",
      type: "date",
      notNull: true,
      generated: {
        expression: "date_trunc('year', (date AT TIME ZONE 'UTC'))::date",
      },
      origin: { standard: "numberPeriod" },
    })
    expect(column).not.toHaveProperty("default")
    expect(table.uniques).toEqual([
      {
        name: "invoice_number_period_number_key",
        columns: ["number_period", "number"],
        nullsNotDistinct: false,
      },
    ])
    expect(
      searchIndexes(table).filter((i) =>
        i.keys.some((k) => "column" in k && k.column === "number")
      )
    ).toEqual([])
  })

  it("quarter periodicity", async () => {
    const entries = {
      "documents/Invoice/Invoice.meta.json": document("Invoice", {
        numberPeriodicity: "Quarter",
      }),
    }
    const column = async (zone?: string) =>
      tableOf(
        await compileWith({
          ...entries,
          ...(zone === undefined
            ? {}
            : { "project.meta.json": project({ timezone: zone }) }),
        }),
        "invoice"
      ).columns.find((c) => c.name === "number_period")?.generated?.expression
    expect(await column()).toBe(
      "date_trunc('quarter', (date AT TIME ZONE 'UTC'))::date"
    )
    expect(await column("Europe/Kyiv")).toBe(
      "date_trunc('quarter', (date AT TIME ZONE 'Europe/Kyiv'))::date"
    )
  })

  it("document without number periodicity", async () => {
    const table = tableOf(
      await compileWith({
        "documents/Invoice/Invoice.meta.json": document("Invoice", {
          numberPeriodicity: "None",
        }),
      }),
      "invoice"
    )
    expect(table.columns.map((c) => c.name)).not.toContain("number_period")
    expect(table.uniques.map((u) => u.columns)).toEqual([["number"]])
  })

  it("catalog code uniqueness unchanged", async () => {
    const unique = tableOf(
      await compileWith({
        "catalogs/Item/Item.meta.json": catalog("Item", { codeUnique: true }),
      }),
      "item"
    )
    expect(unique.uniques.map((u) => u.columns)).toEqual([["code"]])
    expect(searchIndexes(unique)).toEqual([])
    const loose = tableOf(
      await compileWith({
        "catalogs/Item/Item.meta.json": catalog("Item", { codeUnique: false }),
      }),
      "item"
    )
    expect(loose.uniques).toEqual([])
    expect(searchIndexes(loose).map((i) => i.keys)).toEqual([
      [{ column: "code" }],
    ])
  })

  it("user attribute named number_period", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project({
          naming: { attributeCase: "snake_case" },
        }),
        "documents/Invoice/Invoice.meta.json": document("Invoice", {
          attributes: [attribute("number_period", { type: "Integer" })],
        }),
      })
    )
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "identity.name-reserved"
    )
    expect(result.diagnostics.map((d) => d.code)).not.toContain(
      "physical.duplicate-column"
    )
  })

  describe("unique ignoreCase and uniqueWithin", () => {
    const code = (extra: Record<string, unknown> = {}) =>
      attribute("code2", { type: "String", length: 20, unique: true, ...extra })

    it("ignoreCase unique is a unique index on lower(column) after the scope carrier", async () => {
      const physical = await compileWith({
        "project.meta.json": scopedProject(),
        "catalogs/Organization/Organization.meta.json": organization(),
        "catalogs/Item/Item.meta.json": catalog("Item", {
          scope: "org",
          attributes: [code({ unique: "ignoreCase" })],
        }),
      })
      const item = tableOf(physical, "item")
      expect(item.uniques.map((u) => u.columns)).not.toContainEqual([
        "org_id",
        "code2",
      ])
      expect(item.indexes).toContainEqual({
        name: "item_org_id_lower_idx",
        unique: true,
        method: "btree",
        keys: [{ column: "org_id" }, { expression: "lower(code2)" }],
        include: [],
        nullsNotDistinct: false,
      })
    })

    it("uniqueWithin owner keys by the owner column, a polymorphic owner by the pair", async () => {
      const physical = await compileWith({
        "catalogs/A/A.meta.json": catalog("A"),
        "catalogs/B/B.meta.json": catalog("B"),
        "catalogs/Single/Single.meta.json": catalog("Single", {
          owners: [{ kind: "Catalog", name: "A" }],
          attributes: [code({ uniqueWithin: "owner" })],
        }),
        "catalogs/Many/Many.meta.json": catalog("Many", {
          owners: [
            { kind: "Catalog", name: "A" },
            { kind: "Catalog", name: "B" },
          ],
          attributes: [code({ uniqueWithin: "owner" })],
        }),
      })
      expect(
        tableOf(physical, "single").uniques.map((u) => u.columns)
      ).toContainEqual(["owner_id", "code2"])
      expect(
        tableOf(physical, "many").uniques.map((u) => u.columns)
      ).toContainEqual(["owner_type", "owner_id", "code2"])
    })

    it("uniqueWithin parent is a NULLS NOT DISTINCT unique index partial on the column", async () => {
      const physical = await compileWith({
        "catalogs/Node/Node.meta.json": catalog("Node", {
          hierarchyType: "ItemsOnly",
          attributes: [code({ uniqueWithin: "parent" })],
        }),
      })
      expect(tableOf(physical, "node").indexes).toContainEqual(
        expect.objectContaining({
          unique: true,
          keys: [{ column: "parent_id" }, { column: "code2" }],
          where: "code2 IS NOT NULL",
          nullsNotDistinct: true,
        })
      )
    })

    it("scope carrier leads the key before the owner column", async () => {
      const physical = await compileWith({
        "project.meta.json": scopedProject(),
        "catalogs/Organization/Organization.meta.json": organization(),
        "catalogs/A/A.meta.json": catalog("A", { scope: "org" }),
        "catalogs/Child/Child.meta.json": catalog("Child", {
          scope: "org",
          owners: [{ kind: "Catalog", name: "A" }],
          attributes: [code({ uniqueWithin: "owner" })],
        }),
      })
      expect(
        tableOf(physical, "child").uniques.map((u) => u.columns)
      ).toContainEqual(["org_id", "owner_id", "code2"])
    })

    it("ignoreCase combined with uniqueWithin parent is a NULLS NOT DISTINCT expression index", async () => {
      const physical = await compileWith({
        "catalogs/Node/Node.meta.json": catalog("Node", {
          hierarchyType: "ItemsOnly",
          attributes: [code({ unique: "ignoreCase", uniqueWithin: "parent" })],
        }),
      })
      expect(tableOf(physical, "node").indexes).toContainEqual(
        expect.objectContaining({
          unique: true,
          keys: [{ column: "parent_id" }, { expression: "lower(code2)" }],
          where: "code2 IS NOT NULL",
          nullsNotDistinct: true,
        })
      )
    })
  })
})

describe("stage 3: composite indexes", () => {
  const counterparty = (extra: Record<string, unknown> = {}) =>
    attribute("counterparty", {
      physicalName: "counterparty_id",
      type: "Ref",
      ref: { kind: "Catalog", name: "Counterparty" },
      ...extra,
    })
  const scopedSale = (overrides: Record<string, unknown>) => ({
    "project.meta.json": scopedProject(),
    "catalogs/Organization/Organization.meta.json": organization(),
    "catalogs/Counterparty/Counterparty.meta.json": catalog("Counterparty", {
      scope: "org",
    }),
    "documents/Sale/Sale.meta.json": document("Sale", {
      scope: "org",
      ...overrides,
    }),
  })

  it("composite index puts the scope carrier first and keeps desc order", async () => {
    const physical = await compileWith(
      scopedSale({
        attributes: [counterparty()],
        indexes: [
          { attributes: ["counterparty", { name: "date", order: "desc" }] },
        ],
      })
    )
    expect(tableOf(physical, "sale").indexes).toContainEqual(
      expect.objectContaining({
        unique: false,
        keys: [
          { column: "org_id" },
          { column: "counterparty_id" },
          { column: "date", order: "desc" },
        ],
      })
    )
  })

  it("tabular section index uses the section's own attributes", async () => {
    const physical = await compileWith(
      scopedSale({
        tabularSections: [
          {
            id: uuid(11),
            name: "goods",
            physicalName: "sale_goods",
            attributes: [attribute("qty", { type: "Integer" })],
            indexes: [
              { attributes: ["qty", { name: "lineNumber", order: "desc" }] },
            ],
          },
        ],
      })
    )
    expect(tableOf(physical, "sale_goods").indexes).toContainEqual(
      expect.objectContaining({
        unique: false,
        keys: [
          { column: "org_id" },
          { column: "qty" },
          { column: "line_number", order: "desc" },
        ],
      })
    )
  })

  it("a polymorphic attribute gives both pair columns", async () => {
    const physical = await compileWith({
      "catalogs/A/A.meta.json": catalog("A"),
      "catalogs/B/B.meta.json": catalog("B"),
      "documents/Sale/Sale.meta.json": document("Sale", {
        attributes: [
          attribute("subject", {
            type: "Ref",
            allowedTypes: [
              { kind: "Catalog", name: "A" },
              { kind: "Catalog", name: "B" },
            ],
          }),
        ],
        indexes: [{ attributes: ["subject"] }],
      }),
    })
    const keys = tableOf(physical, "sale").indexes.map((i) =>
      i.keys.map((k) => ("column" in k ? k.column : k.expression))
    )
    expect(keys).toContainEqual(["subject_type", "subject_id"])
  })

  it("an index covered by a longer one is dropped, a different order is not covered", async () => {
    const physical = await compileWith({
      "documents/Sale/Sale.meta.json": document("Sale", {
        attributes: [attribute("qty", { type: "Integer" })],
        indexes: [
          { attributes: ["qty"] },
          { attributes: ["qty", "date"] },
          { attributes: ["qty", { name: "date", order: "desc" }] },
        ],
      }),
    })
    const keys = tableOf(physical, "sale")
      .indexes.filter(
        (i) => !i.unique && "column" in i.keys[0]! && i.keys[0].column === "qty"
      )
      .map((i) => JSON.stringify(i.keys))
    expect(keys).toEqual([
      JSON.stringify([{ column: "qty" }, { column: "date" }]),
      JSON.stringify([{ column: "qty" }, { column: "date", order: "desc" }]),
    ])
  })

  it("an expression or partial unique index never covers a composite index", async () => {
    const physical = await compileWith({
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [
          attribute("sku", {
            type: "String",
            length: 20,
            unique: "ignoreCase",
          }),
        ],
        indexes: [{ attributes: ["sku"] }, { attributes: ["predefinedName"] }],
      }),
    })
    const indexes = tableOf(physical, "item").indexes
    expect(indexes.filter((i) => i.unique)).toHaveLength(2)
    expect(indexes).toContainEqual(
      expect.objectContaining({ unique: false, keys: [{ column: "sku" }] })
    )
    expect(indexes).toContainEqual(
      expect.objectContaining({
        unique: false,
        keys: [{ column: "predefined_name" }],
      })
    )
  })
})
