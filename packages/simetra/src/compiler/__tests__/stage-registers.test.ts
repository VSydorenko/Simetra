import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { PhysicalSnapshot, PhysicalTable } from "simetra/model"
import {
  attribute,
  catalog,
  document,
  metaFiles,
  organization,
  project,
  scopedProject,
  uuid,
} from "./helpers"

const PROJECT = "project.meta.json"
const ORG = "catalogs/Organization/Organization.meta.json"
const SALE = "documents/Sale/Sale.meta.json"
const STOCK = "accumulation-registers/Stock/Stock.meta.json"
const RATES = "information-registers/Rates/Rates.meta.json"
const STOCK_ID = uuid(1)

function ref(kind: string, name: string) {
  return { type: "Ref", ref: { kind, name } }
}

function scopedFiles(entries: Record<string, unknown>) {
  return metaFiles({
    [PROJECT]: scopedProject(),
    [ORG]: organization(),
    ...entries,
  })
}

function physicalOf(files: Map<string, string>): PhysicalSnapshot {
  const result = compile(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!.physical
}

function tableOf(physical: PhysicalSnapshot, name: string): PhysicalTable {
  const table = physical.tables.find((t) => t.name === name)
  expect(table, name).toBeDefined()
  return table!
}

function indexesOf(table: PhysicalTable) {
  return table.indexes.map((index) => ({
    name: index.name,
    keys: index.keys.map((key) => ("column" in key ? key.column : "")),
  }))
}

function column(table: PhysicalTable, name: string) {
  const found = table.columns.find((c) => c.name === name)
  expect(found, name).toBeDefined()
  return found!
}

function diagnosticsOf(files: Map<string, string>) {
  return compile(files).diagnostics.map((d) => [d.code, d.file, d.pointer])
}

/** Скоуплені довідники `Warehouse`, `Item` і документ `Sale` виду `org`. */
function stockFiles(register: Record<string, unknown> = {}) {
  return scopedFiles({
    "catalogs/Warehouse/Warehouse.meta.json": catalog("Warehouse", {
      scope: "org",
    }),
    "catalogs/Item/Item.meta.json": catalog("Item", { scope: "org" }),
    [SALE]: document("Sale", { scope: "org" }),
    [STOCK]: {
      id: STOCK_ID,
      kind: "AccumulationRegister",
      name: "Stock",
      physicalName: "stock",
      scope: "org",
      recorderTypes: [{ kind: "Document", name: "Sale" }],
      dimensions: [
        attribute("warehouse", {
          physicalName: "warehouse_id",
          required: true,
          ...ref("Catalog", "Warehouse"),
        }),
        attribute("item", {
          physicalName: "item_id",
          ...ref("Catalog", "Item"),
        }),
      ],
      resources: [
        attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
      ],
      ...register,
    },
  })
}

/** Скоуплений довідник `Currency` і регістр відомостей `Rates` за валютою. */
function ratesFiles(register: Record<string, unknown> = {}) {
  return scopedFiles({
    "catalogs/Currency/Currency.meta.json": catalog("Currency", {
      scope: "org",
    }),
    [SALE]: document("Sale", { scope: "org" }),
    [RATES]: {
      id: uuid(2),
      kind: "InformationRegister",
      name: "Rates",
      physicalName: "rates",
      scope: "org",
      periodicity: "Day",
      dimensions: [
        attribute("currency", {
          physicalName: "currency_id",
          ...ref("Catalog", "Currency"),
        }),
      ],
      resources: [
        attribute("rate", { type: "Numeric", precision: 15, scale: 4 }),
      ],
      ...register,
    },
  })
}

describe("stage 3: register keys", () => {
  it("accumulation movements key", () => {
    const stock = tableOf(physicalOf(stockFiles()), "stock")
    expect(stock.primaryKey).toEqual({
      name: "stock_pkey",
      columns: ["recorder_type", "recorder_id", "line_number"],
    })
    expect(stock.uniques).toEqual([])
    // FK `(org_id)` на корінь і `(org_id, warehouse_id)` покриває префікс
    // індексу рухів за ключем; індексу лише на `period` немає.
    expect(indexesOf(stock)).toEqual([
      { name: "stock_org_id_item_id_idx", keys: ["org_id", "item_id"] },
      { name: "stock_org_id_period_idx", keys: ["org_id", "period"] },
      {
        name: "stock_org_id_warehouse_id_item_id_period_idx",
        keys: ["org_id", "warehouse_id", "item_id", "period"],
      },
    ])
    expect(column(stock, "warehouse_id").notNull).toBe(true)
    // Необов'язковий вимір може бути NULL: ключ запису зіставляє порожні.
    expect(column(stock, "item_id").notNull).toBe(false)
  })

  it("balance register has totals", () => {
    const physical = physicalOf(stockFiles())
    const totals = tableOf(physical, "stock_totals")
    expect(totals.origin).toEqual({ objectId: STOCK_ID, part: "totals" })
    expect(totals.columns.map((c) => `${c.name} ${c.type}`)).toEqual([
      "org_id uuid",
      "warehouse_id uuid",
      "item_id uuid",
      "qty numeric(15,3)",
    ])
    expect(totals.columns.every((c) => c.notNull)).toBe(true)
    expect(column(totals, "qty").default).toBe("0")
    expect(totals.primaryKey).toEqual({
      name: "stock_totals_pkey",
      columns: ["org_id", "warehouse_id", "item_id"],
    })
    expect(totals.uniques).toEqual([])
    expect(totals.checks).toEqual([])
    expect(
      totals.foreignKeys.map((fk) => [
        fk.name,
        fk.columns,
        fk.references.table,
        fk.references.columns,
      ])
    ).toEqual([
      ["stock_totals_org_id_fkey", ["org_id"], "organization", ["id"]],
      [
        "stock_totals_org_id_item_id_fkey",
        ["org_id", "item_id"],
        "item",
        ["org_id", "id"],
      ],
      [
        "stock_totals_org_id_warehouse_id_fkey",
        ["org_id", "warehouse_id"],
        "warehouse",
        ["org_id", "id"],
      ],
    ])
    expect(indexesOf(totals)).toEqual([
      { name: "stock_totals_org_id_item_id_idx", keys: ["org_id", "item_id"] },
    ])

    const turnover = physicalOf(stockFiles({ registerType: "Turnover" }))
    expect(turnover.tables.map((t) => t.name)).not.toContain("stock_totals")
  })

  it("accumulation movement resources are NOT NULL without a default", () => {
    const stock = tableOf(physicalOf(stockFiles()), "stock")
    expect(column(stock, "qty").notNull).toBe(true)
    expect(column(stock, "qty").default).toBeUndefined()
    const totals = tableOf(physicalOf(stockFiles()), "stock_totals")
    expect(column(totals, "qty")).toMatchObject({ notNull: true, default: "0" })
    // Ресурс регістра відомостей — значення: без `required` він може бути порожнім.
    const rates = tableOf(physicalOf(ratesFiles()), "rates")
    expect(column(rates, "rate").notNull).toBe(false)
  })

  it("degenerate totals key is a singleton", () => {
    const physical = physicalOf(
      metaFiles({
        [PROJECT]: project(),
        [STOCK]: {
          id: STOCK_ID,
          kind: "AccumulationRegister",
          name: "Stock",
          physicalName: "stock",
          resources: [attribute("qty", { type: "Integer" })],
        },
      })
    )
    const totals = tableOf(physical, "stock_totals")
    expect(totals.primaryKey).toEqual({
      name: "stock_totals_pkey",
      columns: ["singleton"],
    })
    expect(totals.columns).toEqual([
      {
        name: "singleton",
        type: "boolean",
        notNull: true,
        default: "true",
        origin: { standard: "singleton" },
      },
      {
        name: "qty",
        type: "integer",
        notNull: true,
        default: "0",
        origin: expect.objectContaining({ elementId: expect.any(String) }),
      },
    ])
    expect(totals.checks).toEqual([
      { name: "stock_totals_singleton_check", expression: "singleton" },
    ])
  })

  it("dimensions are nullable unless required", () => {
    const stock = tableOf(physicalOf(stockFiles()), "stock")
    expect(column(stock, "warehouse_id").notNull).toBe(true)
    expect(column(stock, "item_id").notNull).toBe(false)
    const targets = stock.foreignKeys.map((fk) => fk.columns)
    expect(targets).toContainEqual(["org_id", "warehouse_id"])
    expect(targets).toContainEqual(["org_id", "item_id"])
  })

  it("independent information register key", () => {
    const rates = tableOf(physicalOf(ratesFiles()), "rates")
    expect(rates.primaryKey).toBeUndefined()
    expect(column(rates, "period").notNull).toBe(true)
    expect(rates.uniques).toContainEqual({
      name: "rates_org_id_currency_id_period_key",
      columns: ["org_id", "currency_id", "period"],
      nullsNotDistinct: true,
    })
    // Ключ запису служить і зрізу за ключем; оборотів у регістра відомостей
    // немає, тож і індексів рухів немає (FK-індекси покриває префікс PK).
    expect(indexesOf(rates)).toEqual([])
    expect(physicalOf(ratesFiles()).tables.map((t) => t.name)).not.toContain(
      "rates_totals"
    )

    const flat = tableOf(
      physicalOf(ratesFiles({ periodicity: "NonPeriodic" })),
      "rates"
    )
    expect(flat.columns.map((c) => c.name)).not.toContain("period")
    expect(flat.primaryKey).toBeUndefined()
    expect(flat.uniques.map((u) => u.columns)).toContainEqual([
      "org_id",
      "currency_id",
    ])
    expect(indexesOf(flat)).toEqual([])
  })

  it("subordinate information register", () => {
    const rates = tableOf(
      physicalOf(
        ratesFiles({
          writeMode: "RecorderSubordinate",
          recorderTypes: [{ kind: "Document", name: "Sale" }],
        })
      ),
      "rates"
    )
    expect(rates.primaryKey).toEqual({
      name: "rates_pkey",
      columns: ["recorder_type", "recorder_id", "line_number"],
    })
    expect(rates.uniques).toEqual([
      {
        name: "rates_org_id_currency_id_period_key",
        columns: ["org_id", "currency_id", "period"],
        nullsNotDistinct: true,
      },
    ])
    expect(indexesOf(rates)).toEqual([])
  })

  it("subordinate register without dimensions, period or scope", () => {
    const physical = physicalOf(
      metaFiles({
        [PROJECT]: project(),
        [SALE]: document("Sale"),
        "information-registers/Settings/Settings.meta.json": {
          id: uuid(5),
          kind: "InformationRegister",
          name: "Settings",
          physicalName: "settings",
          writeMode: "RecorderSubordinate",
          recorderTypes: [{ kind: "Document", name: "Sale" }],
          resources: [attribute("limit", { type: "Integer" })],
        },
      })
    )
    const settings = tableOf(physical, "settings")
    // Як у 1С: одна множина записів на весь регістр — одинак як ключ запису
    // поруч із PK реєстратора.
    expect(settings.primaryKey).toEqual({
      name: "settings_pkey",
      columns: ["recorder_type", "recorder_id", "line_number"],
    })
    expect(settings.uniques).toEqual([
      {
        name: "settings_singleton_key",
        columns: ["singleton"],
        nullsNotDistinct: false,
      },
    ])
    expect(column(settings, "singleton")).toMatchObject({
      type: "boolean",
      notNull: true,
      default: "true",
    })
    expect(settings.checks.map((c) => c.expression)).toContain("singleton")
    expect(settings.indexes).toEqual([])
  })

  it("independent non-periodic register without dimensions or scope", () => {
    const physical = physicalOf(
      metaFiles({
        [PROJECT]: project(),
        "information-registers/Settings/Settings.meta.json": {
          id: uuid(3),
          kind: "InformationRegister",
          name: "Settings",
          physicalName: "settings",
          resources: [attribute("limit", { type: "Integer" })],
        },
      })
    )
    const settings = tableOf(physical, "settings")
    expect(settings.primaryKey).toEqual({
      name: "settings_pkey",
      columns: ["singleton"],
    })
    expect(settings.columns.map((c) => c.name)).toEqual(["singleton", "limit"])
    expect(settings.checks.map((c) => c.expression)).toEqual(["singleton"])
    expect(settings.indexes).toEqual([])
  })

  it("scoped register without dimensions is keyed by the scope column", () => {
    const physical = physicalOf(
      scopedFiles({
        "information-registers/Settings/Settings.meta.json": {
          id: uuid(4),
          kind: "InformationRegister",
          name: "Settings",
          physicalName: "settings",
          scope: "org",
          resources: [attribute("limit", { type: "Integer" })],
        },
      })
    )
    const settings = tableOf(physical, "settings")
    expect(settings.columns.map((c) => c.name)).toEqual(["org_id", "limit"])
    expect(settings.primaryKey?.columns).toEqual(["org_id"])
    expect(settings.checks).toEqual([])
  })

  it("totals table name collision", () => {
    const files = metaFiles({
      [PROJECT]: project(),
      "catalogs/StockTotals/StockTotals.meta.json": catalog("StockTotals", {
        physicalName: "stock_totals",
      }),
      [STOCK]: {
        id: STOCK_ID,
        kind: "AccumulationRegister",
        name: "Stock",
        physicalName: "stock",
        resources: [attribute("qty", { type: "Integer" })],
      },
    })
    expect(
      diagnosticsOf(files).filter(
        ([code]) => code === "physical.table-duplicate"
      )
    ).toHaveLength(1)
  })
})

describe("balance control", () => {
  it("balanceControl only for balance registers", () => {
    expect(
      diagnosticsOf(
        stockFiles({
          registerType: "Turnover",
          balanceControl: { resources: ["qty"] },
        })
      )
    ).toEqual([["register.balance-control-type", STOCK, "/balanceControl"]])
  })

  it("balanceControl names unknown resource", () => {
    expect(
      diagnosticsOf(stockFiles({ balanceControl: { resources: ["amount"] } }))
    ).toEqual([
      [
        "register.balance-control-resource",
        STOCK,
        "/balanceControl/resources/0",
      ],
    ])
  })

  it("balanceControl over a known resource is in the reference index", () => {
    const qty = attribute("qty", { type: "Integer" })
    const result = compile(
      stockFiles({ resources: [qty], balanceControl: { resources: ["qty"] } })
    )
    expect(result.diagnostics).toEqual([])
    // Каскад перейменування ресурсу знаходить налаштування за індексом.
    expect(
      result.model!.references.filter(
        (r) => r.role === "register.balanceControl"
      )
    ).toEqual([
      {
        from: {
          file: STOCK,
          pointer: "/balanceControl/resources/0",
          objectId: STOCK_ID,
        },
        to: { kind: "Element", id: qty.id },
        role: "register.balanceControl",
      },
    ])
  })
})
