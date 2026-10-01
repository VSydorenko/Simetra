import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
import {
  SALE_FILE,
  attribute,
  metaFiles,
  project,
  salesDocument,
} from "./helpers"

const SALE_SQL = "documents/Sale/Sale.sql"
const BLOCK = "-- @movements Stock\nSELECT 1\n-- @end\n"

/** `withConstructor: false` прибирає рухи конструктора: залишається лише блок. */
async function build(
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
  return await compile(metaFiles(entries))
}

function codes(result: CompileResult) {
  return result.diagnostics.map((d) => [d.code, d.file, d.pointer])
}

describe("stage 5: movement sources", () => {
  it("query block satisfies register", async () => {
    const result = await build({ withConstructor: false, sql: BLOCK })
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("missing source", async () => {
    expect(codes(await build({ withConstructor: false }))).toEqual([
      ["posting.source-missing", SALE_FILE, "/registerMovements/0"],
    ])
  })

  it("both sources", async () => {
    expect(codes(await build({ sql: BLOCK }))).toEqual([
      ["posting.source-ambiguous", SALE_FILE, "/registerMovements/0"],
    ])
  })

  it("two blocks for one register", async () => {
    expect(
      codes(await build({ withConstructor: false, sql: BLOCK + BLOCK }))
    ).toEqual([["posting.source-ambiguous", SALE_FILE, "/registerMovements/0"]])
  })

  it("block for undeclared register", async () => {
    const result = await build({
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

  it("block marker is indexed", async () => {
    const result = await build({
      withConstructor: false,
      sql: `-- comment\n${BLOCK}`,
    })
    const stock = result.model!.objects.find((o) => o.name === "Stock")!
    expect(result.model!.references).toContainEqual(
      expect.objectContaining({
        role: "posting.movementsBlock",
        from: expect.objectContaining({ file: SALE_SQL, pointer: "" }),
        to: { kind: "AccumulationRegister", id: stock.id },
        line: 2,
      })
    )
  })

  it("unknown register in a marker", async () => {
    const result = await build({
      withConstructor: false,
      sql: "-- @movements Nope\nSELECT 1\n-- @end",
    })
    expect(codes(result)).toContainEqual(["reference.unresolved", SALE_SQL, ""])
  })

  it("block in a catalog sql file", async () => {
    const result = await build({ extra: { "catalogs/Item/Item.sql": BLOCK } })
    expect(codes(result)).toEqual([
      ["file.movements-block", "catalogs/Item/Item.sql", ""],
    ])
  })

  it("block in a shared sql file", async () => {
    const result = await build({ extra: { "sql/public/shared.sql": BLOCK } })
    expect(codes(result)).toEqual([
      ["file.movements-block", "sql/public/shared.sql", ""],
    ])
  })

  it("malformed markers report the line", async () => {
    const result = await build({ sql: "SELECT 1\n-- @end" })
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        code: "file.movements-block",
        params: expect.objectContaining({ line: 2 }),
      })
    )
  })

  it("indented marker is a warning", async () => {
    const result = await build({
      withConstructor: false,
      sql: `${BLOCK}  -- @movements Stock\nSELECT 2\n\t-- @end\n`,
    })
    // Запит під маркером з відступом — уже не блок, а оператор файлу; SELECT
    // не є одиницею бажаного стану, тож помилкою його називає гейт SQL-одиниць.
    expect(
      result.diagnostics.map((d) => [d.code, d.severity, d.params?.line])
    ).toEqual([
      ["file.movements-marker-indented", "warning", 4],
      ["file.movements-marker-indented", "warning", 6],
      ["sql.statement-not-allowed", "error", 5],
    ])
  })

  it("CRLF line endings are accepted", async () => {
    const result = await build({
      withConstructor: false,
      sql: "-- @movements Stock\r\nSELECT 1\r\n-- @end\r\n",
    })
    expect(result.diagnostics).toEqual([])
  })

  it("empty block", async () => {
    const result = await build({
      withConstructor: false,
      sql: "-- @movements Stock\n  \n-- @end",
    })
    expect(codes(result)).toEqual([["file.movements-block", SALE_SQL, ""]])
    expect(result.diagnostics[0]!.params).toEqual(
      expect.objectContaining({ line: 1 })
    )
  })

  it("sidecar of a broken owner is skipped", async () => {
    const result = await build({
      extra: {
        "catalogs/Broken/Broken.meta.json": "{",
        "catalogs/Broken/Broken.sql": BLOCK,
      },
    })
    expect(codes(result)).toEqual([
      ["file.invalid-json", "catalogs/Broken/Broken.meta.json", ""],
    ])
  })
})

describe("movement block marker forms", () => {
  const informationStock = {
    "information-registers/Stock/Stock.meta.json": {
      id: "00000000-0000-4000-8000-000000009001",
      kind: "InformationRegister",
      name: "Stock",
      physicalName: "stock_info",
      resources: [{ ...attribute("threshold", { type: "Integer" }) }],
    },
  }
  const marked = async (marker: string, extra: Record<string, unknown> = {}) =>
    await build({
      withConstructor: false,
      sql: `-- @movements ${marker}\nSELECT 1\n-- @end`,
      extra,
    })

  it("qualified form resolves", async () => {
    const result = await marked("AccumulationRegister.Stock", informationStock)
    expect(result.diagnostics).toEqual([])
  })

  it("unqualified form is ambiguous between register kinds", async () => {
    const result = await marked("Stock", informationStock)
    expect(codes(result)).toEqual([["reference.ambiguous", SALE_SQL, ""]])
    expect(result.diagnostics[0]!.params).toEqual({
      name: "Stock",
      candidates: "AccumulationRegister.Stock, InformationRegister.Stock",
      line: 1,
    })
  })

  it("the document's declarations do not disambiguate", async () => {
    // Stock оголошено в registerMovements, але маркер від цього не міняє ціль.
    expect(codes(await marked("Stock", informationStock))[0]).toEqual([
      "reference.ambiguous",
      SALE_SQL,
      "",
    ])
  })

  it("qualified non-register kind", async () => {
    expect(codes(await marked("Catalog.Item"))).toEqual([
      ["posting.register-kind", SALE_SQL, ""],
    ])
  })

  it("marker of an independent register", async () => {
    const result = await marked("InformationRegister.Stock", informationStock)
    expect(codes(result)).toEqual([
      ["posting.register-independent", SALE_SQL, ""],
    ])
    expect(result.diagnostics[0]!.params).toEqual(
      expect.objectContaining({ name: "Stock", line: 1 })
    )
  })

  it("unknown qualified name", async () => {
    expect(codes(await marked("AccumulationRegister.Nope"))).toContainEqual([
      "reference.unresolved",
      SALE_SQL,
      "",
    ])
    expect(codes(await marked("Nonsense.Stock"))).toContainEqual([
      "reference.unresolved",
      SALE_SQL,
      "",
    ])
  })
})
