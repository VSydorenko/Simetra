import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  SALE_FILE,
  STOCK_FILE,
  attribute,
  catalog,
  metaFiles,
  project,
  salesDocument,
} from "./helpers"

function contracts(entries: Record<string, unknown>) {
  const result = compile(metaFiles(entries))
  expect(result.diagnostics).toEqual([])
  return result.model!.contracts
}

function withStock(patch: Record<string, unknown>): Record<string, unknown> {
  const entries = salesDocument()
  Object.assign(entries[STOCK_FILE] as Record<string, unknown>, patch)
  return { "project.meta.json": project(), ...entries }
}

const at = { name: "p_at", type: "timestamp with time zone" }
const from = { name: "p_from", type: "timestamp with time zone" }
const to = { name: "p_to", type: "timestamp with time zone" }

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
        parameters: [at],
        columns: [
          { name: "item_id", type: "uuid" },
          { name: "qty", type: "numeric(15,3)" },
        ],
      },
      {
        kind: "balanceAndTurnovers",
        function: { schema: "public", name: "stock_balance_and_turnovers" },
        parameters: [from, to],
        columns: [
          { name: "item_id", type: "uuid" },
          { name: "qty_opening", type: "numeric(15,3)" },
          { name: "qty_receipt", type: "numeric(15,3)" },
          { name: "qty_expense", type: "numeric(15,3)" },
          { name: "qty_closing", type: "numeric(15,3)" },
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
    expect(turnover.registers[0]).not.toHaveProperty("totalsMaintenance")
    expect(turnover.registers[0]!.virtualTables).toEqual([
      {
        kind: "turnovers",
        function: { schema: "public", name: "stock_turnovers" },
        parameters: [from, to],
        columns: [
          { name: "item_id", type: "uuid" },
          { name: "qty", type: "numeric(15,3)" },
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
})
