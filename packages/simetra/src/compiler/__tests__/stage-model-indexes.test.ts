import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { PhysicalSnapshot, PhysicalTable } from "simetra/model"
import {
  attribute,
  catalog,
  document,
  metaFiles,
  organization,
  scopedProject,
  uuid,
} from "./helpers"

const PROJECT = "project.meta.json"
const ORG = "catalogs/Organization/Organization.meta.json"
const CP = "catalogs/Counterparty/Counterparty.meta.json"
const CURRENCY = "catalogs/Currency/Currency.meta.json"
const INVOICE = "documents/Invoice/Invoice.meta.json"
const STOCK = "accumulation-registers/Stock/Stock.meta.json"

function ref(kind: string, name: string, extra: Record<string, unknown> = {}) {
  return { type: "Ref", ref: { kind, name }, ...extra }
}

async function physicalOf(
  entries: Record<string, unknown>
): Promise<PhysicalSnapshot> {
  const result = await compile(
    metaFiles({
      [PROJECT]: scopedProject(),
      [ORG]: organization(),
      ...entries,
    })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!.physical
}

function tableOf(physical: PhysicalSnapshot, name: string): PhysicalTable {
  const table = physical.tables.find((t) => t.name === name)
  expect(table, name).toBeDefined()
  return table!
}

/** Ключі індексів таблиці без часткових (`predefined_name`): `b DESC` для спадного, вираз як є; унікальні з `unique`. */
function shapesOf(table: PhysicalTable): string[] {
  return table.indexes
    .filter((index) => index.where === undefined)
    .map((index) => {
      const keys = index.keys
        .map((key) => {
          const text = "column" in key ? key.column : key.expression
          return key.order === "desc" ? `${text} DESC` : text
        })
        .join(", ")
      return index.unique ? `unique (${keys})` : `(${keys})`
    })
    .sort()
}

const indexedInt = (name: string) =>
  attribute(name, { type: "Integer", indexed: true })

const sectionOf = (extra: Record<string, unknown> = {}) => ({
  id: uuid(910),
  name: "lines",
  physicalName: "invoice_lines",
  attributes: [attribute("qty", { type: "Integer" })],
  ...extra,
})

describe("stage 3: list-order search indexes end with the row key", () => {
  it.each<{
    name: string
    entries: Record<string, unknown>
    table: string
    expected: string[]
  }>([
    {
      name: "indexed attribute of a scoped catalog",
      entries: {
        [CP]: catalog("Counterparty", {
          scope: "org",
          attributes: [indexedInt("a")],
        }),
      },
      table: "counterparty",
      expected: ["(org_id, a, id)"],
    },
    {
      name: "indexed attribute of an unscoped catalog",
      entries: {
        [CURRENCY]: catalog("Currency", {
          scope: "none",
          attributes: [indexedInt("a")],
        }),
      },
      table: "currency",
      expected: ["(a, id)"],
    },
    {
      name: "indexed attribute of the scope root",
      entries: { [ORG]: organization({ attributes: [indexedInt("a")] }) },
      table: "organization",
      expected: ["(a, id)"],
    },
    {
      name: "indexed Ref in a scoped table: one FK index, key last",
      entries: {
        [CP]: catalog("Counterparty", { scope: "org" }),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          scope: "org",
          attributes: [
            attribute("r", {
              physicalName: "r_id",
              indexed: true,
              ...ref("Catalog", "Counterparty"),
            }),
          ],
        }),
      },
      table: "contract",
      expected: ["(org_id, r_id, id)"],
    },
    {
      name: "Ref without indexed keeps the plain FK index",
      entries: {
        [CP]: catalog("Counterparty", { scope: "org" }),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          scope: "org",
          attributes: [
            attribute("r", {
              physicalName: "r_id",
              ...ref("Catalog", "Counterparty"),
            }),
          ],
        }),
      },
      table: "contract",
      expected: ["(org_id, r_id)"],
    },
    {
      name: "standard parent_id of a hierarchy is unchanged",
      entries: {
        [CP]: catalog("Counterparty", {
          scope: "org",
          hierarchyType: "ItemsOnly",
        }),
      },
      table: "counterparty",
      expected: ["(org_id, parent_id)"],
    },
    {
      name: "parent_id of a tabular section is unchanged",
      entries: {
        [INVOICE]: document("Invoice", {
          scope: "org",
          tabularSections: [sectionOf()],
        }),
      },
      table: "invoice_lines",
      expected: ["(org_id, parent_id)"],
    },
    {
      name: "unique indexed attribute in a scope: the UNIQUE constraint alone",
      entries: {
        [CP]: catalog("Counterparty", {
          scope: "org",
          attributes: [
            attribute("a", { type: "Integer", unique: true, indexed: true }),
          ],
        }),
      },
      table: "counterparty",
      expected: [],
    },
    {
      name: "ignoreCase unique plus indexed: unique expression index and the key index",
      entries: {
        [CP]: catalog("Counterparty", {
          scope: "org",
          attributes: [
            attribute("a", {
              type: "String",
              length: 20,
              unique: "ignoreCase",
              indexed: true,
            }),
          ],
        }),
      },
      table: "counterparty",
      expected: ["(org_id, a, id)", "unique (org_id, lower(a))"],
    },
    {
      name: "composite index with a desc column",
      entries: {
        [CP]: catalog("Counterparty", {
          scope: "org",
          attributes: [
            attribute("a", { type: "Integer" }),
            attribute("b", { type: "Integer" }),
          ],
          indexes: [{ attributes: ["a", { name: "b", order: "desc" }] }],
        }),
      },
      table: "counterparty",
      expected: ["(org_id, a, b DESC, id)"],
    },
    {
      name: "composite index over a polymorphic Ref: the pair, then the key",
      entries: {
        "catalogs/A/A.meta.json": catalog("A", { scope: "none" }),
        "catalogs/B/B.meta.json": catalog("B", { scope: "none" }),
        [CURRENCY]: catalog("Currency", {
          scope: "none",
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
      },
      table: "currency",
      expected: ["(subject_type, subject_id, id)"],
    },
    {
      name: "composite index of a tabular section ends with the section key",
      entries: {
        [INVOICE]: document("Invoice", {
          scope: "org",
          tabularSections: [
            sectionOf({
              indexes: [
                { attributes: ["qty", { name: "lineNumber", order: "desc" }] },
              ],
            }),
          ],
        }),
      },
      table: "invoice_lines",
      expected: ["(org_id, parent_id)", "(org_id, qty, line_number DESC, id)"],
    },
    {
      name: "standard code with the numbering UNIQUE: the UNIQUE alone",
      entries: { [CP]: catalog("Counterparty", { scope: "org" }) },
      table: "counterparty",
      expected: [],
    },
    {
      name: "two candidates with the same columns: one index",
      entries: {
        [CP]: catalog("Counterparty", {
          scope: "org",
          attributes: [indexedInt("a")],
          indexes: [{ attributes: ["a"] }],
        }),
      },
      table: "counterparty",
      expected: ["(org_id, a, id)"],
    },
  ])("$name", async ({ entries, table, expected }) => {
    const physical = await physicalOf(entries)
    expect(shapesOf(tableOf(physical, table))).toEqual(expected)
  })

  // Рух має складений PK, підсумки — UNIQUE NULLS NOT DISTINCT без PK: ключа
  // рядка там немає, тож індексований вимір нового широкого індексу не дає.
  describe("register tables get no row key", () => {
    const stockEntries = () => ({
      "catalogs/Item/Item.meta.json": catalog("Item", { scope: "org" }),
      "catalogs/Warehouse/Warehouse.meta.json": catalog("Warehouse", {
        scope: "org",
      }),
      "documents/Sale/Sale.meta.json": document("Sale", { scope: "org" }),
      [STOCK]: {
        id: uuid(1),
        kind: "AccumulationRegister",
        name: "Stock",
        physicalName: "stock",
        kindLabel: "stock",
        scope: "org",
        recorderTypes: [{ kind: "Document", name: "Sale" }],
        dimensions: [
          attribute("warehouse", {
            physicalName: "warehouse_id",
            ...ref("Catalog", "Warehouse"),
          }),
          attribute("item", {
            physicalName: "item_id",
            indexed: true,
            ...ref("Catalog", "Item"),
          }),
        ],
        resources: [
          attribute("qty", { type: "Numeric", precision: 15, scale: 3 }),
        ],
      },
    })

    it.each([
      {
        name: "movements: indexed dimension, unchanged movement indexes",
        table: "stock",
        expected: [
          "(org_id, item_id)",
          "(org_id, period)",
          "(org_id, warehouse_id, item_id, period, recorder_type, recorder_id)",
        ],
      },
      {
        name: "totals with an indexed dimension",
        table: "stock_totals",
        expected: ["(org_id, item_id)"],
      },
    ])("$name", async ({ table, expected }) => {
      const physical = await physicalOf(stockEntries())
      expect(shapesOf(tableOf(physical, table))).toEqual(expected)
    })
  })
})
