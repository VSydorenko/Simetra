import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  SALE_FILE,
  STOCK_FILE,
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  organization,
  project,
  salesDocument,
  scopedProject,
  uuid,
} from "./helpers"

function contracts(entries: Record<string, unknown>) {
  const result = compile(metaFiles(entries))
  expect(result.diagnostics).toEqual([])
  return result.model!.contracts
}

function scopedProject2(): Record<string, unknown> {
  return {
    "project.meta.json": scopedProject(),
    "catalogs/Organization/Organization.meta.json": organization(),
  }
}

function withStock(patch: Record<string, unknown>): Record<string, unknown> {
  const entries = salesDocument()
  Object.assign(entries[STOCK_FILE] as Record<string, unknown>, patch)
  return { "project.meta.json": project(), ...entries }
}

/** Оборотний регістр: документ не вказує вид руху. */
function turnoverStock(): Record<string, unknown> {
  const entries = withStock({ registerType: "Turnover" })
  const sale = entries[SALE_FILE] as {
    posting: { movements: Record<string, unknown>[] }
  }
  delete sale.posting.movements[0]!.movementType
  return entries
}

const at = { name: "p_at", type: "timestamp with time zone" }
const from = { name: "p_from", type: "timestamp with time zone" }
const to = { name: "p_to", type: "timestamp with time zone" }

describe("numbering contract", () => {
  it("document numbering contract", () => {
    const { numbering } = contracts({
      ...scopedProject2(),
      "documents/Invoice/Invoice.meta.json": document("Invoice", {
        id: "00000000-0000-4000-8000-000000000d01",
        scope: "org",
      }),
    })
    expect(numbering).toContainEqual({
      objectId: "00000000-0000-4000-8000-000000000d01",
      column: "number",
      periodColumn: "number_period",
      type: "String",
      length: 11,
      autonumber: true,
      periodicity: "Year",
      scoped: true,
      assignedAt: "firstWrite",
    })
  })

  it("catalog code numbering contract", () => {
    const { numbering } = contracts({
      "project.meta.json": project(),
      "catalogs/A/A.meta.json": catalog("A", {
        id: "00000000-0000-4000-8000-000000000a01",
      }),
      "catalogs/B/B.meta.json": catalog("B", {
        id: "00000000-0000-4000-8000-000000000b02",
        codeLength: 0,
      }),
    })
    expect(numbering).toEqual([
      {
        objectId: "00000000-0000-4000-8000-000000000a01",
        column: "code",
        type: "String",
        length: 9,
        autonumber: true,
        periodicity: "None",
        scoped: false,
        assignedAt: "firstWrite",
      },
    ])
  })
})

describe("predefined contract", () => {
  it("predefined contract lists items with ids", () => {
    const { predefined } = contracts({
      "project.meta.json": project(),
      "catalogs/B/B.meta.json": catalog("B", {
        id: "00000000-0000-4000-8000-000000000b02",
        predefinedItems: [
          { id: "00000000-0000-4000-8000-0000000000e2", name: "second" },
          { id: "00000000-0000-4000-8000-0000000000e1", name: "first" },
        ],
      }),
      "catalogs/A/A.meta.json": catalog("A", {
        id: "00000000-0000-4000-8000-000000000a01",
        predefinedItems: [
          { id: "00000000-0000-4000-8000-0000000000e3", name: "only" },
        ],
      }),
      "catalogs/C/C.meta.json": catalog("C"),
    })
    expect(predefined).toEqual([
      {
        objectId: "00000000-0000-4000-8000-000000000a01",
        items: [{ id: "00000000-0000-4000-8000-0000000000e3", name: "only" }],
      },
      {
        objectId: "00000000-0000-4000-8000-000000000b02",
        items: [
          { id: "00000000-0000-4000-8000-0000000000e2", name: "second" },
          { id: "00000000-0000-4000-8000-0000000000e1", name: "first" },
        ],
      },
    ])
  })
})

describe("posting and register contracts", () => {
  it("posting contract of a document", () => {
    const { posting } = contracts(
      withStock({ balanceControl: { resources: ["qty"] } })
    )
    expect(posting).toHaveLength(1)
    const [sale] = posting
    expect(sale).toMatchObject({
      post: { schema: "public", name: "sale_post" },
      unpost: { schema: "public", name: "sale_unpost" },
      movements: [
        {
          source: "constructor",
          function: { schema: "public", name: "sale_stock_movements" },
        },
      ],
      balanceControl: [{ resources: ["qty"] }],
    })
    expect(sale!.movements[0]!.registerId).toBe(
      sale!.balanceControl[0]!.registerId
    )
  })

  it("posting contract names save", () => {
    const { posting } = contracts(withStock({}))
    expect(posting[0]!.save).toEqual({ schema: "public", name: "sale_save" })
  })

  it("required on post lists header and rows", () => {
    const entries = withStock({})
    const sale = entries[SALE_FILE] as {
      attributes?: unknown[]
      tabularSections: { attributes: Record<string, unknown>[]; id: string }[]
    }
    const customer = attribute("customer", {
      physicalName: "customer_id",
      type: "Ref",
      ref: { kind: "Catalog", name: "Item" },
      required: true,
    })
    sale.attributes = [customer]
    sale.tabularSections[0]!.attributes[1]!.required = true
    const result = compile(metaFiles(entries))
    expect(result.diagnostics).toEqual([])
    const [posting] = result.model!.contracts.posting
    const table = result.model!.physical.tables.find((t) => t.name === "sale")!
    const check = table.checks.find((c) => c.name.endsWith("_required"))!
    expect(posting!.requiredOnPost.header).toEqual([
      { attributeId: customer.id, columns: ["customer_id"], check: check.name },
    ])
    const goods = sale.tabularSections[0]!
    expect(posting!.requiredOnPost.sections).toEqual([
      {
        sectionId: goods.id,
        table: { schema: "public", name: "goods" },
        columns: [{ attributeId: goods.attributes[1]!.id, columns: ["qty"] }],
      },
    ])
  })

  it("required check name comes from the name assignment", () => {
    const entries = withStock({})
    const sale = entries[SALE_FILE] as { attributes?: unknown[] }
    const customer = attribute("customer", {
      physicalName: "customer_id",
      type: "Ref",
      ref: { kind: "Catalog", name: "Item" },
      required: true,
    })
    sale.attributes = [customer]
    // Явне ім'я в схемі займає стандартне `sale_customer_id_required`, тож
    // призначення дає суфікс; контракт мусить повернути саме призначене ім'я.
    entries["custom-tables/Taken/Taken.meta.json"] = customTable("Taken", {
      checks: [{ name: "sale_customer_id_required", expression: "true" }],
    })
    const result = compile(metaFiles(entries))
    expect(result.diagnostics).toEqual([])
    const [posting] = result.model!.contracts.posting
    expect(posting!.requiredOnPost.header).toEqual([
      {
        attributeId: customer.id,
        columns: ["customer_id"],
        check: "sale_customer_id_required1",
      },
    ])
    const table = result.model!.physical.tables.find((t) => t.name === "sale")!
    expect(table.checks.map((c) => c.name)).toContain(
      "sale_customer_id_required1"
    )
  })

  it("immutability covers header and sections", () => {
    const { posting } = contracts(withStock({}))
    expect(posting[0]!.immutability).toEqual({
      trigger: "sale_immutable",
      tables: [
        { schema: "public", name: "sale" },
        { schema: "public", name: "goods" },
      ],
    })
  })

  it("save name collision", () => {
    const entries = withStock({})
    entries["catalogs/Clash/Clash.meta.json"] = catalog("Clash", {
      physicalName: "sale_save",
    })
    const found = compile(metaFiles(entries)).diagnostics.filter(
      (d) => d.code === "physical.function-duplicate"
    )
    expect(found).toHaveLength(1)
  })

  it("balance register contract", () => {
    const { registers } = contracts(withStock({}))
    expect(registers).toHaveLength(1)
    const [stock] = registers
    expect(stock).toMatchObject({
      movements: { schema: "public", name: "stock" },
      totals: { schema: "public", name: "stock_totals" },
      totalsMaintenance: {
        recalculate: { schema: "public", name: "stock_totals_recalculate" },
        verify: { schema: "public", name: "stock_totals_verify" },
      },
    })
    expect(stock!.balanceControl).toBeUndefined()
    expect(stock!.virtualTables).toEqual([
      {
        kind: "balance",
        function: { schema: "public", name: "stock_balance" },
        parameters: [
          at,
          { name: "p_recorder_type", type: "text" },
          { name: "p_recorder_id", type: "uuid" },
        ],
        columns: [
          { name: "item_id", type: "uuid" },
          {
            name: "qty",
            type: "numeric(15,3)",
            source: { resourceId: expect.any(String), measure: "closing" },
          },
        ],
      },
      {
        kind: "balanceAndTurnovers",
        function: { schema: "public", name: "stock_balance_and_turnovers" },
        parameters: [from, to],
        columns: [
          { name: "item_id", type: "uuid" },
          {
            name: "qty_opening",
            type: "numeric(15,3)",
            source: { resourceId: expect.any(String), measure: "opening" },
          },
          {
            name: "qty_receipt",
            type: "numeric(15,3)",
            source: { resourceId: expect.any(String), measure: "receipt" },
          },
          {
            name: "qty_expense",
            type: "numeric(15,3)",
            source: { resourceId: expect.any(String), measure: "expense" },
          },
          {
            name: "qty_closing",
            type: "numeric(15,3)",
            source: { resourceId: expect.any(String), measure: "closing" },
          },
        ],
      },
    ])
  })

  it("balance control lists physical resource names", () => {
    const { registers } = contracts(
      withStock({ balanceControl: { resources: ["qty"] } })
    )
    expect(registers[0]!.balanceControl).toEqual({ resources: ["qty"] })
  })

  it("turnover and information registers", () => {
    const entries = withStock({ registerType: "Turnover" })
    const sale = entries[SALE_FILE] as {
      posting: { movements: Record<string, unknown>[] }
    }
    delete sale.posting.movements[0]!.movementType
    const turnover = contracts(entries)
    expect(turnover.registers[0]).not.toHaveProperty("totals")
    expect(turnover.registers[0]).toHaveProperty("totalsMaintenance")
    expect(turnover.registers[0]!.virtualTables).toEqual([
      {
        kind: "turnovers",
        function: { schema: "public", name: "stock_turnovers" },
        parameters: [from, to],
        columns: [
          { name: "item_id", type: "uuid" },
          {
            name: "qty",
            type: "numeric(15,3)",
            source: { resourceId: expect.any(String), measure: "net" },
          },
        ],
      },
    ])

    const info = (periodicity: string) =>
      contracts({
        "project.meta.json": project(),
        "information-registers/Price/Price.meta.json": {
          id: "00000000-0000-4000-8000-000000000999",
          kind: "InformationRegister",
          name: "Price",
          physicalName: "price",
          periodicity,
          dimensions: [attribute("code", { type: "String", length: 10 })],
          resources: [
            attribute("value", { type: "Numeric", precision: 15, scale: 2 }),
          ],
        },
      }).registers[0]!
    const periodic = info("Month")
    expect(periodic.virtualTables.map((t) => t.kind)).toEqual([
      "sliceLast",
      "sliceFirst",
    ])
    expect(periodic.virtualTables[0]).toMatchObject({
      function: { schema: "public", name: "price_slice_last" },
      parameters: [at],
      columns: [
        { name: "period", type: "timestamp with time zone" },
        { name: "code", type: "character varying(10)" },
        { name: "value", type: "numeric(15,2)" },
      ],
    })
    expect(info("NonPeriodic").virtualTables).toEqual([])
  })

  it("balance virtual table has recorder bound", () => {
    const { registers } = contracts(withStock({}))
    const balance = registers[0]!.virtualTables.find(
      (t) => t.kind === "balance"
    )
    expect(balance!.parameters).toEqual([
      at,
      { name: "p_recorder_type", type: "text" },
      { name: "p_recorder_id", type: "uuid" },
    ])
  })

  it("monthly turnovers contract", () => {
    const expression =
      "date_trunc('month', (period AT TIME ZONE 'Europe/Kyiv'))::date"
    const balance = contracts({
      ...withStock({}),
      "project.meta.json": project({ timezone: "Europe/Kyiv" }),
    }).registers[0]!
    expect(balance.turnoversMonth).toEqual({
      table: { schema: "public", name: "stock_turnovers_month" },
      monthExpression: expression,
      split: true,
      resources: [
        {
          resourceId: expect.any(String),
          receipt: "qty_receipt",
          expense: "qty_expense",
        },
      ],
    })
    const turnover = contracts({
      ...turnoverStock(),
      "project.meta.json": project({ timezone: "Europe/Kyiv" }),
    }).registers[0]!
    expect(turnover.turnoversMonth).toMatchObject({
      monthExpression: expression,
      split: false,
    })
  })

  it("resources map to their columns by id, not by name suffix", () => {
    // Різні id й порядок `amount`, `qty` у файлі: відповідність береться з
    // origin колонок, а не з імен (спека П2 §8.3).
    const resourcesOf = (amountId: string, qtyId: string) => [
      attribute("amount", {
        id: amountId,
        type: "Numeric",
        precision: 15,
        scale: 2,
      }),
      attribute("qty", {
        id: qtyId,
        type: "Numeric",
        precision: 15,
        scale: 3,
      }),
    ]
    const [amountId, qtyId, salesAmountId, salesQtyId] = [
      901, 902, 903, 904,
    ].map(uuid) as [string, string, string, string]
    const register = (id: string, name: string, extra: object) => ({
      [`accumulation-registers/${name}/${name}.meta.json`]: {
        id,
        kind: "AccumulationRegister",
        name,
        physicalName: name.toLowerCase(),
        ...extra,
      },
    })
    const { registers } = contracts({
      "project.meta.json": project(),
      ...register(uuid(1), "Stock", {
        resources: resourcesOf(amountId, qtyId),
      }),
      ...register(uuid(2), "Sales", {
        registerType: "Turnover",
        resources: resourcesOf(salesAmountId, salesQtyId),
      }),
    })
    const stock = registers.find((r) => r.movements.name === "stock")!
    const sales = registers.find((r) => r.movements.name === "sales")!

    expect(stock.turnoversMonth!.resources).toEqual([
      {
        resourceId: amountId,
        receipt: "amount_receipt",
        expense: "amount_expense",
      },
      { resourceId: qtyId, receipt: "qty_receipt", expense: "qty_expense" },
    ])
    expect(sales.turnoversMonth!.resources).toEqual([
      { resourceId: salesAmountId, column: "amount" },
      { resourceId: salesQtyId, column: "qty" },
    ])

    const columns = (
      contract: (typeof registers)[number],
      kind: string
    ): { name: string; source?: unknown }[] =>
      contract.virtualTables.find((t) => t.kind === kind)!.columns
    const sourced = (contract: (typeof registers)[number], kind: string) =>
      columns(contract, kind).map(({ name, source }) => [name, source ?? null])

    expect(sourced(stock, "balance")).toEqual([
      ["amount", { resourceId: amountId, measure: "closing" }],
      ["qty", { resourceId: qtyId, measure: "closing" }],
    ])
    expect(sourced(stock, "balanceAndTurnovers")).toEqual(
      [
        ["amount", amountId],
        ["qty", qtyId],
      ].flatMap(([name, resourceId]) =>
        ["opening", "receipt", "expense", "closing"].map((measure) => [
          `${name}_${measure}`,
          { resourceId, measure },
        ])
      )
    )
    expect(sourced(sales, "turnovers")).toEqual([
      ["amount", { resourceId: salesAmountId, measure: "net" }],
      ["qty", { resourceId: salesQtyId, measure: "net" }],
    ])
    // Служебні колонки (виміри, носій скоупу) джерела не мають.
    expect(columns(stock, "balance").every((c) => c.source !== undefined)).toBe(
      true
    )
  })

  it("turnover register maintains derived tables", () => {
    const register = contracts(turnoverStock()).registers[0]!
    expect(register).not.toHaveProperty("totals")
    expect(register.turnoversMonth).toMatchObject({ split: false })
    expect(register.totalsMaintenance).toEqual({
      recalculate: { schema: "public", name: "stock_totals_recalculate" },
      verify: { schema: "public", name: "stock_totals_verify" },
    })
  })

  it("maintenance function name collision", () => {
    const entries = turnoverStock()
    entries["catalogs/Clash/Clash.meta.json"] = catalog("Clash", {
      physicalName: "stock_totals_verify",
    })
    const found = compile(metaFiles(entries)).diagnostics.filter(
      (d) => d.code === "physical.function-duplicate"
    )
    expect(found).toHaveLength(1)
  })

  it("function name collision", () => {
    const entries = withStock({})
    Object.assign(entries, {
      "catalogs/Clash/Clash.meta.json": catalog("Clash", {
        physicalName: "stock_balance",
      }),
    })
    const result = compile(metaFiles(entries))
    expect(result.ok).toBe(false)
    expect(result.model).toBeUndefined()
    expect(
      result.diagnostics.filter((d) => d.code === "physical.function-duplicate")
    ).toHaveLength(1)
  })

  // Імена колізій стадії 4 і імена контракту мусять бути одними й тими
  // самими: розбіжність пропустила б колізію, яку П3 зустріне на CREATE.
  it("every contract function is checked for collisions, unpost included", () => {
    const built = contracts(withStock({}))
    const [posting] = built.posting
    const [register] = built.registers
    const names = [
      posting!.post.name,
      posting!.unpost.name,
      ...register!.virtualTables.map((t) => t.function.name),
      register!.totalsMaintenance!.recalculate.name,
      register!.totalsMaintenance!.verify.name,
    ]
    expect(names).toContain("sale_unpost")
    for (const name of names) {
      const entries = withStock({})
      entries["catalogs/Clash/Clash.meta.json"] = catalog("Clash", {
        physicalName: name,
      })
      const found = compile(metaFiles(entries)).diagnostics.filter(
        (d) => d.code === "physical.function-duplicate"
      )
      expect(found.map((d) => d.params?.name)).toEqual([name])
    }
  })

  it("scope carrier is the first column of every virtual table", () => {
    // Регістр залишків дає balance і balanceAndTurnovers, оборотний —
    // turnovers, періодичний регістр відомостей — зрізи.
    const build = (scoped: boolean) => {
      const entries = withStock({ dimensions: [] })
      const sale = entries[SALE_FILE] as {
        posting: { movements: { fields: Record<string, string> }[] }
      }
      sale.posting.movements[0]!.fields = { qty: "row.qty" }
      const scope = scoped ? { scope: "org" } : {}
      entries["accumulation-registers/Sales/Sales.meta.json"] = {
        id: "00000000-0000-4000-8000-000000000981",
        kind: "AccumulationRegister",
        name: "Sales",
        physicalName: "sales",
        registerType: "Turnover",
        resources: [
          attribute("amount", { type: "Numeric", precision: 15, scale: 2 }),
        ],
        ...scope,
      }
      entries["information-registers/Rates/Rates.meta.json"] = {
        id: "00000000-0000-4000-8000-000000000982",
        kind: "InformationRegister",
        name: "Rates",
        physicalName: "rates",
        periodicity: "Day",
        writeMode: "RecorderSubordinate",
        resources: [
          attribute("rate", { type: "Numeric", precision: 15, scale: 4 }),
        ],
        ...scope,
      }
      if (scoped) {
        Object.assign(entries[SALE_FILE] as object, scope)
        Object.assign(entries[STOCK_FILE] as object, scope)
        entries["project.meta.json"] = scopedProject()
        entries["catalogs/Organization/Organization.meta.json"] = organization()
        entries["catalogs/Item/Item.meta.json"] = catalog("Item", scope)
      }
      return contracts(entries).registers.flatMap((r) => r.virtualTables)
    }
    const carrier = { name: "org_id", type: "uuid" }
    const scoped = build(true)
    expect(
      Object.fromEntries(scoped.map((t) => [t.kind, t.columns[0]]))
    ).toEqual({
      balance: carrier,
      balanceAndTurnovers: carrier,
      turnovers: carrier,
      sliceLast: carrier,
      sliceFirst: carrier,
    })
    // Носій — колонка, а не параметр: RLS ріже рядки сам.
    for (const table of scoped) {
      expect(table.parameters.map((p) => p.name)).not.toContain("org_id")
      expect(table.columns.filter((c) => c.name === "org_id").length).toBe(1)
    }
    const plain = build(false)
    expect(plain.map((t) => t.kind).sort()).toEqual(
      scoped.map((t) => t.kind).sort()
    )
    expect(plain.flatMap((t) => t.columns.map((c) => c.name))).not.toContain(
      "org_id"
    )
  })

  it("polymorphic dimension gives both pair columns", () => {
    const entries = withStock({})
    entries["catalogs/Service/Service.meta.json"] = catalog("Service")
    const stock = entries[STOCK_FILE] as { dimensions: unknown[] }
    stock.dimensions.push(
      attribute("origin", {
        physicalName: "origin",
        type: "Ref",
        allowedTypes: [
          { kind: "Catalog", name: "Item" },
          { kind: "Catalog", name: "Service" },
        ],
      })
    )
    const sale = entries[SALE_FILE] as {
      tabularSections: { attributes: unknown[] }[]
      posting: { movements: { fields: Record<string, string> }[] }
    }
    sale.tabularSections[0]!.attributes.push(
      attribute("origin", {
        physicalName: "origin",
        type: "Ref",
        allowedTypes: [
          { kind: "Catalog", name: "Item" },
          { kind: "Catalog", name: "Service" },
        ],
      })
    )
    sale.posting.movements[0]!.fields.origin = "row.origin"
    const result = compile(metaFiles(entries))
    expect(result.diagnostics).toEqual([])
    const [balance] = result.model!.contracts.registers[0]!.virtualTables
    expect(balance!.columns.map((c) => c.name)).toEqual([
      "item_id",
      "origin_type",
      "origin_id",
      "qty",
    ])
    // Обидві колонки пари мають елемент виміру своїм origin.
    const table = result.model!.physical.tables.find((t) => t.name === "stock")!
    const dimension = (stock.dimensions[1] as { id: string }).id
    expect(
      table.columns
        .filter((c) => c.origin.elementId === dimension)
        .map((c) => c.name)
    ).toEqual(["origin_type", "origin_id"])
  })

  it("wrapper name collides with a table", () => {
    const entries = withStock({})
    entries["catalogs/Clash/Clash.meta.json"] = catalog("Clash", {
      physicalName: "sale_stock_movements",
    })
    const found = compile(metaFiles(entries)).diagnostics.filter(
      (d) => d.code === "physical.function-duplicate"
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      file: SALE_FILE,
      pointer: "/registerMovements/0",
    })
  })

  it("wrapper name collides with another wrapper", () => {
    // Довгі імена документів скорочуються до однакового початку, тож дві
    // обгортки в один регістр мають однакове ім'я.
    const entries = withStock({})
    const prefix = "D" + "d".repeat(57)
    const sale = entries[SALE_FILE] as Record<string, unknown>
    const other = (name: string, n: number) => ({
      ...sale,
      id: `00000000-0000-4000-8000-00000000097${n}`,
      name,
      physicalName: name.toLowerCase(),
      tabularSections: [],
      posting: {
        movements: [
          {
            register: { kind: "AccumulationRegister", name: "Stock" },
            source: "document",
            movementType: "Expense",
            fields: { item: "doc.ref", qty: "1" },
          },
        ],
      },
    })
    delete entries[SALE_FILE]
    Object.assign(entries[STOCK_FILE] as object, {
      recorderTypes: [
        { kind: "Document", name: `${prefix}Aa` },
        { kind: "Document", name: `${prefix}Bb` },
      ],
    })
    entries[`documents/${prefix}Aa/${prefix}Aa.meta.json`] = other(
      `${prefix}Aa`,
      1
    )
    entries[`documents/${prefix}Bb/${prefix}Bb.meta.json`] = other(
      `${prefix}Bb`,
      2
    )
    const found = compile(metaFiles(entries)).diagnostics.filter(
      (d) => d.code === "physical.function-duplicate"
    )
    expect(found.some((d) => d.message.includes("movement query"))).toBe(true)
    expect(found.some((d) => d.message.includes("function of"))).toBe(true)
  })

  it("contract function collides with contract function", () => {
    // Мітка `_turnovers` скорочує ім'я регістра до 53 байтів, тож два довгі
    // регістри з однаковим початком дають однакові функції за різних таблиць.
    const register = (name: string, n: number) => ({
      id: `00000000-0000-4000-8000-00000000099${n}`,
      kind: "AccumulationRegister",
      name,
      physicalName: name.toLowerCase(),
      registerType: "Turnover",
      resources: [
        attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
      ],
    })
    const prefix = "R" + "r".repeat(57)
    const found = compile(
      metaFiles({
        "project.meta.json": project(),
        [`accumulation-registers/${prefix}Aa/${prefix}Aa.meta.json`]: register(
          `${prefix}Aa`,
          1
        ),
        [`accumulation-registers/${prefix}Bb/${prefix}Bb.meta.json`]: register(
          `${prefix}Bb`,
          2
        ),
      })
    ).diagnostics.filter((d) => d.code === "physical.function-duplicate")
    // Оборотний регістр веде похідні таблиці, тож з функцією віртуальної
    // таблиці збігаються й обидві функції перерахунку та звірки.
    expect(found).toHaveLength(3)
    expect(found.every((d) => d.message.includes("function of"))).toBe(true)
  })
})
