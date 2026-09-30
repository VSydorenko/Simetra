import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  SALE_FILE,
  STOCK_FILE,
  metaFiles,
  project,
  salesDocument,
} from "./helpers"

const SALE_SQL = "documents/Sale/Sale.sql"
const BLOCK = "-- @movements Stock\nSELECT 1\n-- @end\n"

/** `withConstructor: false` прибирає рухи конструктора: залишається лише блок. */
function build(
  options: {
    withConstructor?: boolean
    sql?: string
    sale?: Record<string, unknown>
    extra?: Record<string, unknown>
  } = {}
) {
  const { withConstructor = true, sql, sale = {}, extra = {} } = options
  const entries: Record<string, unknown> = {
    "project.meta.json": project(),
    ...salesDocument(
      {},
      { ...(withConstructor ? {} : { posting: undefined }), ...sale }
    ),
    ...extra,
  }
  if (sql !== undefined) entries[SALE_SQL] = sql
  return compile(metaFiles(entries))
}

function codes(result: ReturnType<typeof compile>) {
  return result.diagnostics.map((d) => [d.code, d.file, d.pointer])
}

describe("stage 5: movement sources", () => {
  it("query block satisfies register", () => {
    const result = build({ withConstructor: false, sql: BLOCK })
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("missing source", () => {
    expect(codes(build({ withConstructor: false }))).toEqual([
      ["posting.source-missing", SALE_FILE, "/registerMovements/0"],
    ])
  })

  it("both sources", () => {
    expect(codes(build({ sql: BLOCK }))).toEqual([
      ["posting.source-ambiguous", SALE_FILE, "/registerMovements/0"],
    ])
  })

  it("two blocks for one register", () => {
    expect(
      codes(build({ withConstructor: false, sql: BLOCK + BLOCK }))
    ).toEqual([["posting.source-ambiguous", SALE_FILE, "/registerMovements/0"]])
  })

  it("block for undeclared register", () => {
    const result = build({
      withConstructor: false,
      sql: BLOCK,
      sale: { registerMovements: [] },
    })
    expect(codes(result)).toEqual([
      ["posting.register-undeclared", SALE_SQL, ""],
    ])
    expect(result.diagnostics[0]!.params).toEqual(
      expect.objectContaining({ name: "Stock", line: 1 })
    )
  })

  it("block marker is indexed", () => {
    const stock = salesDocument()[STOCK_FILE] as { id: string }
    const result = build({
      withConstructor: false,
      sql: `-- comment\n${BLOCK}`,
    })
    expect(result.model!.references).toContainEqual(
      expect.objectContaining({
        role: "posting.movementsBlock",
        from: expect.objectContaining({ file: SALE_SQL, pointer: "" }),
        to: { kind: "AccumulationRegister", id: expect.any(String) },
        line: 2,
      })
    )
    expect(stock.id).toEqual(expect.any(String))
  })

  it("unknown register in a marker", () => {
    const result = build({
      withConstructor: false,
      sql: "-- @movements Nope\nSELECT 1\n-- @end",
    })
    expect(codes(result)).toContainEqual(["reference.unresolved", SALE_SQL, ""])
  })

  it("block in a catalog sql file", () => {
    const result = build({ extra: { "catalogs/Item/Item.sql": BLOCK } })
    expect(codes(result)).toEqual([
      ["file.movements-block", "catalogs/Item/Item.sql", ""],
    ])
  })

  it("block in a shared sql file", () => {
    const result = build({ extra: { "sql/public/shared.sql": BLOCK } })
    expect(codes(result)).toEqual([
      ["file.movements-block", "sql/public/shared.sql", ""],
    ])
  })

  it("block containing the wrapper delimiter", () => {
    const result = build({
      withConstructor: false,
      sql: "-- @movements Stock\nSELECT $simetra$\n-- @end",
    })
    expect(codes(result)).toEqual([["file.movements-block", SALE_SQL, ""]])
  })

  it("malformed markers report the line", () => {
    const result = build({ sql: "SELECT 1\n-- @end" })
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        code: "file.movements-block",
        params: expect.objectContaining({ line: 2 }),
      })
    )
  })
})
