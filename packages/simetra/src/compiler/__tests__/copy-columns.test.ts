import { beforeAll, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { PhysicalColumn, PhysicalTable } from "simetra/model"
import { copyColumns } from "../copy-columns"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { document, metaFiles, project } from "./helpers"

let parse: SqlParser
let invoice: PhysicalTable
beforeAll(async () => {
  parse = await loadSqlParser()
  const result = await compile(
    metaFiles({
      "project.meta.json": project(),
      "documents/Invoice/Invoice.meta.json": document("Invoice", {
        numberPeriodicity: "Month",
      }),
    })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  invoice = result.model!.physical.tables.find((t) => t.name === "invoice")!
})

const copy = (name: string): PhysicalColumn => ({
  name,
  type: "uuid",
  notNull: false,
  origin: {
    copyOf: {
      table: { schema: "public", name: "task" },
      column: name,
      through: "task_id",
    },
  },
})
const generated = (name: string, expression: string): PhysicalColumn => ({
  name,
  type: "text",
  notNull: false,
  generated: { expression },
  origin: {},
})
const withColumns = (...columns: PhysicalColumn[]): PhysicalTable => ({
  ...invoice,
  columns: [...invoice.columns, ...columns],
})

describe("copyColumns", () => {
  it("a generated column from date (number_period) is not a copy", () => {
    // Без цього кейс нічого б не доводив: генерована колонка мусить бути.
    expect(
      invoice.columns.find((c) => c.name === "number_period")?.generated
    ).toBeDefined()
    expect([...copyColumns(invoice, parse)]).toEqual([])
  })

  it("a carrier copy is in the set", () => {
    expect([...copyColumns(withColumns(copy("assignee_id")), parse)]).toEqual([
      "assignee_id",
    ])
  })

  it("a generated column from a copy is in the set", () => {
    const table = withColumns(
      copy("assignee_id"),
      generated("assignee_text", "(assignee_id)::text")
    )
    expect([...copyColumns(table, parse)].sort()).toEqual([
      "assignee_id",
      "assignee_text",
    ])
  })

  // Похідна стоїть у таблиці раніше за свою генеровану основу: один прохід
  // у порядку колонок її б пропустив.
  it("a generated column through another generated one is in the set", () => {
    const table = withColumns(
      generated("assignee_upper", "upper(assignee_text)"),
      copy("assignee_id"),
      generated("assignee_text", "(assignee_id)::text")
    )
    expect([...copyColumns(table, parse)].sort()).toEqual([
      "assignee_id",
      "assignee_text",
      "assignee_upper",
    ])
  })

  it("a generated column that reads no copy stays out", () => {
    const table = withColumns(
      copy("assignee_id"),
      generated("number_text", "(number)::text")
    )
    expect([...copyColumns(table, parse)]).toEqual(["assignee_id"])
  })

  it("an unparsed generated expression counts as a copy", () => {
    const failing: SqlParser = () => ({ ok: false, message: "x", offset: 0 })
    expect([...copyColumns(invoice, failing)]).toEqual(["number_period"])
  })
})
