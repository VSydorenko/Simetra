import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { makeObjectName, type PhysicalTable } from "simetra/model"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  project,
  uuid,
} from "./helpers"

function compileWith(entries: Record<string, unknown>) {
  const result = compile(
    metaFiles({ "project.meta.json": project(), ...entries })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!.physical
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
  it("catalog table", () => {
    const physical = compileWith({
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
    expect(contract.indexes).toEqual([
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

  it("attribute flags: required, default, unique, indexed", () => {
    const physical = compileWith({
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
    expect(item.indexes.map((i) => i.name)).toEqual(["item_rank_idx"])
  })

  it("document tabular section", () => {
    const physical = compileWith({
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

  it("enumeration reference is text with check", () => {
    const physical = compileWith({
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
    expect(order.indexes).toEqual([])
    expect(physical.tables.map((t) => t.name)).toEqual(["order"])
  })

  it("array of references is uuid[] without fk", () => {
    const physical = compileWith({
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
    expect(rate.indexes).toEqual([])
  })

  it("polymorphic reference", () => {
    const physical = compileWith({
      "catalogs/Contract/Contract.meta.json": catalog("Contract"),
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
        expression: "subject_type IN ('contract', 'counterparty')",
      },
    ])
    expect(note.foreignKeys).toEqual([])
  })

  it("standard polymorphic pairs: catalog owners and register recorder", () => {
    const physical = compileWith({
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
    expect(many.indexes).toEqual([
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
    expect(stock.indexes.map((i) => i.name)).toEqual(["stock_period_idx"])
  })

  it("constant is a singleton table with a typed value", () => {
    const physical = compileWith({
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

  it("custom table with external fk and pg enum column", () => {
    const physical = compileWith({
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
    expect(profile.columns[3]!.identity).toBe("always")
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

  it("reference to a custom table uses its uuid primary key", () => {
    const physical = compileWith({
      "custom-tables/Account/Account.meta.json": customTable("Account", {
        columns: [
          {
            id: uuid(60),
            name: "key",
            physicalName: "account_key",
            type: "UUID",
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

  it("custom table fk to a catalog maps logical columns to physical", () => {
    const physical = compileWith({
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

  it("explicit constraint names win", () => {
    const physical = compileWith({
      "custom-tables/Log/Log.meta.json": customTable("Log", {
        columns: [
          { id: uuid(80), name: "id", physicalName: "id", type: "UUID" },
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

  it("long names use postgres truncation", () => {
    const longName = "x".repeat(60)
    const physical = compileWith({
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

  it("multi-column names stop growing at NAMEDATALEN like postgres", () => {
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
    const physical = compileWith({
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

  it("deterministic regardless of map order", () => {
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
    const forward = compile(metaFiles(Object.fromEntries(entries)))
    const backward = compile(
      metaFiles(Object.fromEntries([...entries].reverse()))
    )
    expect(forward.ok).toBe(true)
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward))
  })
})
