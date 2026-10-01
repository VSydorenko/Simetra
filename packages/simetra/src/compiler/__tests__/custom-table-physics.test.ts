import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import { kitchenSink } from "./fixtures/kitchen-sink"
import { customTable, metaFiles, project, uuid } from "./helpers"

const LOG = "custom-tables/Log/Log.meta.json"

const columns = [
  { id: uuid(1), name: "id", physicalName: "id", type: "UUID", notNull: true },
  { id: uuid(2), name: "price", physicalName: "price", type: "Numeric" },
  { id: uuid(3), name: "qty", physicalName: "qty", type: "Integer" },
  { id: uuid(4), name: "code", physicalName: "code", type: "Text" },
]

async function compileLog(overrides: Record<string, unknown>) {
  return compile(
    metaFiles({
      "project.meta.json": project(),
      [LOG]: customTable("Log", { columns, ...overrides }),
    })
  )
}

async function logTable(
  overrides: Record<string, unknown>
): Promise<PhysicalTable> {
  const result = await compileLog(overrides)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  const table = result.model!.physical.tables.find((t) => t.name === "log")
  expect(table).toBeDefined()
  return table!
}

describe("CustomTable physics round-trip", () => {
  it("generated column reaches the snapshot", async () => {
    const table = await logTable({
      columns: [
        ...columns,
        {
          id: uuid(5),
          name: "total",
          physicalName: "total",
          type: "Numeric",
          notNull: true,
          generated: { expression: "(price * (qty)::numeric)" },
        },
      ],
    })
    expect(table.columns.find((c) => c.name === "total")).toEqual({
      name: "total",
      type: "numeric",
      notNull: true,
      generated: { expression: "(price * (qty)::numeric)" },
      origin: { elementId: uuid(5) },
    })
  })

  it("generated with default is an error", async () => {
    const result = await compileLog({
      columns: [
        ...columns,
        {
          id: uuid(5),
          name: "total",
          physicalName: "total",
          type: "Numeric",
          default: "0",
          generated: { expression: "price" },
        },
        {
          id: uuid(6),
          name: "seq",
          physicalName: "seq",
          type: "BigInt",
          identity: "always",
          generated: { expression: "qty" },
        },
      ],
    })
    expect(
      result.diagnostics
        .filter((d) => d.code === "customTable.generated-conflict")
        .map((d) => ({ pointer: d.pointer, severity: d.severity }))
    ).toEqual([
      { pointer: "/columns/4/generated", severity: "error" },
      { pointer: "/columns/5/generated", severity: "error" },
    ])
  })

  it("desc nulls last opclass index key", async () => {
    const table = await logTable({
      indexes: [
        {
          name: "log_code_idx",
          method: "btree",
          keys: [
            {
              column: "code",
              order: "desc",
              nulls: "last",
              opclass: "text_pattern_ops",
              collation: "C",
            },
            { expression: "lower(code)", order: "asc", nulls: "first" },
            { column: "qty" },
          ],
        },
      ],
    })
    expect(table.indexes).toEqual([
      {
        name: "log_code_idx",
        unique: false,
        method: "btree",
        keys: [
          {
            column: "code",
            order: "desc",
            nulls: "last",
            opclass: "text_pattern_ops",
            collation: "C",
          },
          { expression: "lower(code)", order: "asc", nulls: "first" },
          { column: "qty" },
        ],
        include: [],
        nullsNotDistinct: false,
      },
    ])
  })

  it("deferrable unique and primary key", async () => {
    const table = await logTable({
      primaryKey: { columns: ["id"], deferrable: "initiallyDeferred" },
      uniques: [
        { name: "log_code_key", columns: ["code"], deferrable: "deferrable" },
        { name: "log_qty_key", columns: ["qty"] },
        { name: "log_price_key", columns: ["price"], deferrable: "no" },
      ],
    })
    expect(table.primaryKey).toEqual({
      name: "log_pkey",
      columns: ["id"],
      deferrable: "initiallyDeferred",
    })
    // «no» — значення за замовчуванням: у знімку його немає, як і в похідних
    // таблиць видів 1С, тож одна форма на один стан.
    expect(table.uniques).toEqual([
      {
        name: "log_code_key",
        columns: ["code"],
        nullsNotDistinct: false,
        deferrable: "deferrable",
      },
      { name: "log_price_key", columns: ["price"], nullsNotDistinct: false },
      { name: "log_qty_key", columns: ["qty"], nullsNotDistinct: false },
    ])
  })

  it("column collation", async () => {
    const table = await logTable({
      columns: [
        ...columns,
        {
          id: uuid(5),
          name: "title",
          physicalName: "title",
          type: "Text",
          collation: "und-x-icu",
        },
      ],
    })
    expect(table.columns.find((c) => c.name === "title")).toEqual({
      name: "title",
      type: "text",
      notNull: false,
      collation: "und-x-icu",
      origin: { elementId: uuid(5) },
    })
  })

  it("1C kinds snapshot unchanged", async () => {
    const result = await compile(kitchenSink())
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const physical = result.model!.physical
    // Знімок похідних таблиць видів 1С (усе, крім CustomTable `ledger`)
    // побайтно той самий, що до появи нових полів: хеш зафіксовано до зміни.
    const derived = {
      tables: physical.tables.filter((t) => t.name !== "ledger"),
      enumTypes: physical.enumTypes,
    }
    const digest = createHash("sha256")
      .update(JSON.stringify(derived))
      .digest("hex")
    expect(digest).toBe(
      "9cc3c2dec0366e9c4fa6c2d4fe60b500becf428804159bae22b82a84590d0d11"
    )
  })
})
