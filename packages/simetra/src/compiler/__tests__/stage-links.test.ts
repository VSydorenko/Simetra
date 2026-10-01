import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
import {
  SALE_FILE,
  SCOPE_FUNCTIONS_FILE,
  attribute,
  metaFiles,
  organization,
  project,
  salesDocument,
  scopedProject,
} from "./helpers"

const SALE_SQL = "documents/Sale/Sale.sql"
const BLOCK = "-- @movements Stock\nSELECT 1 ORDER BY 1\n-- @end\n"

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
      sql: "-- @movements Stock\r\nSELECT 1 ORDER BY 1\r\n-- @end\r\n",
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
      sql: `-- @movements ${marker}\nSELECT 1 ORDER BY 1\n-- @end`,
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

describe("stage 5: movement query blocks", () => {
  const block = (query: string) => `-- @movements Stock\n${query}\n-- @end\n`
  const run = async (query: string) =>
    await build({ withConstructor: false, sql: block(query) })

  it("a non-select block is an error with the marker line", async () => {
    const result = await run("DELETE FROM stock")
    expect(codes(result)).toEqual([["posting.query-not-select", SALE_SQL, ""]])
    expect(result.diagnostics[0]!.severity).toBe("error")
    expect(result.diagnostics[0]!.params).toEqual({ line: 1 })
  })

  it("several statements are not one select", async () => {
    expect(codes(await run("SELECT 1; SELECT 2"))).toEqual([
      ["posting.query-not-select", SALE_SQL, ""],
    ])
  })

  it("data-modifying CTE and FOR UPDATE in movement block are rejected", async () => {
    // Верхній оператор — SELECT, але CTE з DML змінив би дані під час
    // читання рухів, а FOR UPDATE/FOR SHARE брав би блокування рядків.
    for (const query of [
      "WITH d AS (DELETE FROM stock RETURNING 1 AS x) SELECT x FROM d ORDER BY 1",
      "WITH i AS (INSERT INTO stock DEFAULT VALUES RETURNING 1 AS x) SELECT x FROM i ORDER BY 1",
      "WITH u AS (UPDATE stock SET qty = 0 RETURNING 1 AS x) SELECT x FROM u ORDER BY 1",
      "SELECT 1 AS x FROM stock ORDER BY 1 FOR UPDATE",
      "SELECT x FROM (SELECT 1 AS x FROM stock FOR SHARE) s ORDER BY 1",
    ]) {
      const result = await run(query)
      expect(codes(result), query).toEqual([
        ["posting.query-not-select", SALE_SQL, ""],
      ])
      expect(result.diagnostics[0]!.params, query).toEqual({
        line: 1,
        detail: expect.any(String),
      })
    }
  })

  it("WITH and UNION ALL are selects", async () => {
    const result = await run(
      "WITH a AS (SELECT 1 AS x) SELECT x FROM a UNION ALL SELECT 2 ORDER BY 1"
    )
    expect(result.diagnostics).toEqual([])
  })

  it("an unparsable block keeps the parse detail and position", async () => {
    const result = await run("SELECT 1\nFROM FROM")
    expect(codes(result)).toEqual([["posting.query-not-select", SALE_SQL, ""]])
    expect(result.diagnostics[0]!.params).toEqual({
      line: 1,
      detail: expect.stringContaining("line 3 of the file"),
    })
  })

  it("an empty block is a diagnostic, not a throw", async () => {
    const result = await build({
      withConstructor: false,
      sql: "-- @movements Stock\n-- @end\n",
    })
    expect(codes(result)).toContainEqual(["file.movements-block", SALE_SQL, ""])
  })

  it.each([
    ["empty", ""],
    ["whitespace", " \n\t\n"],
  ])("%s sql file compiles without diagnostics", async (_name, text) => {
    const result = await build({
      extra: { "sql/public/blank.sql": text },
    })
    expect(result.diagnostics).toEqual([])
  })

  it("an empty object sql file compiles", async () => {
    const result = await build({ sql: "" })
    expect(codes(result)).not.toContainEqual(["sql.parse", SALE_SQL, ""])
  })

  it("a select without ORDER BY is a warning", async () => {
    const result = await run("SELECT 1")
    expect(
      result.diagnostics.map((d) => [d.code, d.severity, d.file, d.pointer])
    ).toEqual([["posting.query-order-missing", "warning", SALE_SQL, ""]])
    expect(result.diagnostics[0]!.params).toEqual({ line: 1 })
    expect(result.ok).toBe(true)
  })
})

describe("stage 5: scope set functions", () => {
  const FUNCTIONS = SCOPE_FUNCTIONS_FILE
  const create = (
    name: string,
    tail = "RETURNS SETOF uuid LANGUAGE sql STABLE"
  ) => `CREATE FUNCTION public.${name}${tail} AS $$ SELECT NULL::uuid $$;\n`
  const good = (name: string) => create(`${name}()`)
  const buildScoped = async (sql?: string) =>
    await compile(
      metaFiles({
        "project.meta.json": scopedProject(),
        "catalogs/Organization/Organization.meta.json": organization(),
        [FUNCTIONS]: sql ?? create("unrelated()"),
      })
    )

  it("missing set functions", async () => {
    const result = await buildScoped()
    expect(codes(result)).toEqual([
      [
        "scope.set-function-missing",
        "project.meta.json",
        "/scopeKinds/0/setFunction",
      ],
      [
        "scope.set-function-missing",
        "project.meta.json",
        "/scopeKinds/1/setFunction",
      ],
    ])
    expect(result.diagnostics[0]!.severity).toBe("error")
  })

  it("set function with the right signature passes", async () => {
    const result = await buildScoped(good("org_ids") + good("user_ids"))
    expect(result.diagnostics).toEqual([])
  })

  it.each([
    [
      "RETURNS TABLE",
      "org_ids() RETURNS TABLE (id uuid) LANGUAGE sql STABLE",
      "table",
    ],
    [
      "OUT parameter",
      "org_ids(OUT id uuid) RETURNS SETOF uuid LANGUAGE sql STABLE",
      "OUT",
    ],
  ])("signature problem names the cause: %s", async (_name, def, word) => {
    const result = await buildScoped(
      `CREATE FUNCTION public.${def} AS $$ SELECT NULL::uuid $$;\n` +
        good("user_ids")
    )
    expect(result.diagnostics[0]!.code).toBe("scope.set-function-signature")
    expect(String(result.diagnostics[0]!.params?.problem)).toContain(word)
  })

  it.each([
    ["arguments", create("org_ids(a uuid)")],
    ["not setof", create("org_ids()", "RETURNS uuid LANGUAGE sql STABLE")],
    ["not uuid", create("org_ids()", "RETURNS SETOF text LANGUAGE sql STABLE")],
    ["volatile", create("org_ids()", "RETURNS SETOF uuid LANGUAGE sql")],
    [
      "immutable",
      create("org_ids()", "RETURNS SETOF uuid LANGUAGE sql IMMUTABLE"),
    ],
  ])("wrong signature: %s", async (_name, bad) => {
    const result = await buildScoped(bad + good("user_ids"))
    expect(codes(result)).toEqual([
      [
        "scope.set-function-signature",
        "project.meta.json",
        "/scopeKinds/0/setFunction",
      ],
    ])
    expect(result.diagnostics[0]!.severity).toBe("error")
    expect(typeof result.diagnostics[0]!.params?.problem).toBe("string")
  })
})

describe("stage 5: modules and actions", () => {
  it("modules and actions in the model", async () => {
    const result = await build({ sql: undefined })
    const model = result.model!
    expect(model.modules).toEqual([{ name: "TestApp" }])
    expect(model.objects.every((o) => o.module === "TestApp")).toBe(true)
    const sale = model.objects.find((o) => o.name === "Sale")!
    const stock = model.objects.find((o) => o.name === "Stock")!
    expect(model.actions.find((a) => a.objectId === stock.id)).toEqual({
      objectId: stock.id,
      actions: ["read"],
    })
    expect(
      model.actions.find((a) => a.objectId === sale.id)!.actions
    ).toContain("post")
    const ids = model.actions.map((a) => a.objectId)
    expect(ids).toEqual([...ids].sort())
  })

  it("orphan module file", async () => {
    const result = await build({
      extra: { "documents/Ghost/Ghost.module.ts": "export {}" },
    })
    expect(codes(result)).toEqual([
      ["file.orphan", "documents/Ghost/Ghost.module.ts", ""],
    ])
  })
})
