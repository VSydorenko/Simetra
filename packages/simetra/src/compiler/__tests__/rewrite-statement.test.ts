import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import {
  applyEdits,
  type RenameMap,
  type RewriteScope,
  type TableRename,
} from "../sql/rewrite/renames"
import { rewriteStatementText } from "../sql/rewrite/statement"

let parse: SqlParser

beforeAll(async () => {
  parse = await loadSqlParser()
})

const COUNTERPARTIES: TableRename = {
  schema: "app",
  from: "counterparties",
  to: "counterparty",
  columns: new Map([
    ["name", "description"],
    ["inn", "tax_id"],
  ]),
}

const MAP: RenameMap = {
  tables: [COUNTERPARTIES],
  knownTables: new Map([
    ["app.counterparties", ["id", "name", "inn"]],
    ["app.invoice", ["id", "counterparty_id", "name"]],
  ]),
}

const rw = (sql: string, scope: Partial<RewriteScope> = {}) => {
  const r = rewriteStatementText(sql, parse, MAP, {
    variables: new Set(),
    records: new Map(),
    labels: [],
    ...scope,
  })
  return {
    sql: applyEdits(sql, r.edits),
    problems: r.problems.map((p) => p.code),
    changes: r.contractChanges.map((c) => c.reason),
  }
}

describe("rewriteStatementText", () => {
  it("renames qualified table and columns, keeping output names", () => {
    expect(
      rw("SELECT c.name, c.inn FROM app.counterparties c WHERE c.inn <> ''").sql
    ).toBe(
      "SELECT c.description AS name, c.tax_id AS inn FROM app.counterparty c WHERE c.tax_id <> ''"
    )
  })

  it("keeps an explicit alias", () => {
    expect(rw("SELECT name AS title FROM app.counterparties").sql).toBe(
      "SELECT description AS title FROM app.counterparty"
    )
  })

  it("resolves through nested and correlated scopes", () => {
    expect(
      rw(
        "SELECT i.id FROM app.invoice i WHERE EXISTS (SELECT 1 FROM app.counterparties c WHERE c.id = i.counterparty_id AND c.inn = i.name)"
      ).sql
    ).toBe(
      "SELECT i.id FROM app.invoice i WHERE EXISTS (SELECT 1 FROM app.counterparty c WHERE c.id = i.counterparty_id AND c.tax_id = i.name)"
    )
  })

  it("renames UPDATE SET and INSERT column lists", () => {
    expect(
      rw("UPDATE app.counterparties SET inn = upper(inn) WHERE name = 'x'").sql
    ).toBe(
      "UPDATE app.counterparty SET tax_id = upper(tax_id) WHERE description = 'x'"
    )
    expect(
      rw("INSERT INTO app.counterparties (name, inn) VALUES ('a', 'b')").sql
    ).toBe(
      "INSERT INTO app.counterparty (description, tax_id) VALUES ('a', 'b')"
    )
  })

  it("keeps output names in RETURNING", () => {
    expect(
      rw("UPDATE app.counterparties SET inn = '1' RETURNING id, inn").sql
    ).toBe(
      "UPDATE app.counterparty SET tax_id = '1' RETURNING id, tax_id AS inn"
    )
  })

  it("does not report a star read into a ROWTYPE record of the same table", () => {
    expect(
      rw("SELECT * FROM app.counterparties", { intoRowtypeOf: COUNTERPARTIES })
        .changes
    ).toEqual([])
  })

  it("leaves comments and literals untouched", () => {
    const sql =
      "SELECT /* inn */ inn FROM app.counterparties -- name\n WHERE name = 'inn'"
    expect(rw(sql).sql).toBe(
      "SELECT /* inn */ tax_id AS inn FROM app.counterparty -- name\n WHERE description = 'inn'"
    )
  })

  it("maps byte offsets after Cyrillic", () => {
    expect(rw("SELECT 'Привіт' AS g, inn FROM app.counterparties").sql).toBe(
      "SELECT 'Привіт' AS g, tax_id AS inn FROM app.counterparty"
    )
  })

  it("quotes a renamed quoted identifier", () => {
    expect(rw('SELECT c."inn" FROM app.counterparties c').sql).toBe(
      "SELECT c.tax_id AS inn FROM app.counterparty c"
    )
  })

  it("refuses an unqualified column present in two FROM tables", () => {
    expect(
      rw("SELECT name FROM app.counterparties, app.invoice").problems
    ).toEqual(["rewrite.ambiguous-name"])
  })

  it("refuses a column named like a variable", () => {
    expect(
      rw("SELECT inn FROM app.counterparties", { variables: new Set(["inn"]) })
        .problems
    ).toEqual(["rewrite.ambiguous-name"])
  })

  it("refuses an unqualified table without search_path", () => {
    expect(rw("SELECT 1 FROM counterparties").problems).toEqual([
      "rewrite.unqualified-table",
    ])
    expect(
      rw("SELECT inn FROM counterparties", { searchPath: ["app"] }).sql
    ).toBe("SELECT tax_id AS inn FROM counterparty")
  })

  it("refuses a renamed column in USING", () => {
    expect(
      rw("SELECT 1 FROM app.counterparties JOIN app.invoice USING (name)")
        .problems
    ).toEqual(["rewrite.unsupported"])
  })

  it("does not alias the synthetic top-level list of an expression", () => {
    expect(
      rw("SELECT NEW.inn", {
        topLevelOutput: "ignore",
        records: new Map([["new", { trigger: [COUNTERPARTIES] }]]),
      }).sql
    ).toBe("SELECT NEW.tax_id")
    expect(
      rw("SELECT EXISTS (SELECT c.inn FROM app.counterparties c)", {
        topLevelOutput: "ignore",
      }).sql
    ).toBe("SELECT EXISTS (SELECT c.tax_id AS inn FROM app.counterparty c)")
  })

  it("rewrites NEW fields only for a uniform trigger binding", () => {
    expect(
      rw("SELECT NEW.inn", {
        records: new Map([["new", { trigger: [COUNTERPARTIES] }]]),
      }).sql
    ).toBe("SELECT NEW.tax_id AS inn")
    expect(
      rw("SELECT NEW.inn", { records: new Map([["new", { trigger: [] }]]) })
        .problems
    ).toEqual(["rewrite.trigger-binding"])
  })

  it("reports whole rows and stars as contract changes", () => {
    expect(
      rw("SELECT row_to_json(NEW)", {
        records: new Map([["new", { trigger: [COUNTERPARTIES] }]]),
      }).changes
    ).toEqual(["wholeRow"])
    expect(rw("SELECT * FROM app.counterparties").changes).toEqual(["star"])
  })

  it("flags consumer label literals", () => {
    expect(
      rw("SELECT 1 WHERE 'cp' = 'cp'", { labels: ["cp"] }).problems
    ).toEqual(["rewrite.label-literal", "rewrite.label-literal"])
  })

  // Нижче — межі, яких бриф не перелічує, але які випливають з рішення 13.

  it("renames a table name used as a column qualifier", () => {
    expect(
      rw(
        "SELECT counterparties.inn, app.counterparties.id FROM app.counterparties"
      ).sql
    ).toBe(
      "SELECT counterparty.tax_id AS inn, app.counterparty.id FROM app.counterparty"
    )
  })

  it("keeps offsets relative to the whole text of several statements", () => {
    expect(
      rw(
        "SELECT 1; UPDATE app.counterparties SET name = 'x'; SELECT inn FROM app.counterparties"
      ).sql
    ).toBe(
      "SELECT 1; UPDATE app.counterparty SET description = 'x'; SELECT tax_id AS inn FROM app.counterparty"
    )
  })

  it("lets a CTE shadow a promoted table name", () => {
    expect(
      rw(
        "WITH counterparties AS (SELECT inn FROM app.counterparties) SELECT inn FROM counterparties"
      )
    ).toEqual({
      sql: "WITH counterparties AS (SELECT tax_id AS inn FROM app.counterparty) SELECT inn FROM counterparties",
      problems: [],
      changes: [],
    })
  })

  it("leaves an ORDER BY output name and renames a GROUP BY input column", () => {
    expect(
      rw("SELECT inn FROM app.counterparties GROUP BY inn ORDER BY inn").sql
    ).toBe(
      "SELECT tax_id AS inn FROM app.counterparty GROUP BY tax_id ORDER BY inn"
    )
  })

  it("renames ON CONFLICT SET and EXCLUDED, refusing an inference list", () => {
    expect(
      rw(
        "INSERT INTO app.counterparties (inn) VALUES ('1') ON CONFLICT ON CONSTRAINT k DO UPDATE SET inn = EXCLUDED.inn"
      ).sql
    ).toBe(
      "INSERT INTO app.counterparty (tax_id) VALUES ('1') ON CONFLICT ON CONSTRAINT k DO UPDATE SET tax_id = EXCLUDED.tax_id"
    )
    expect(
      rw(
        "INSERT INTO app.counterparties (inn) VALUES ('1') ON CONFLICT (inn) DO NOTHING"
      ).problems
    ).toEqual(["rewrite.unsupported"])
  })

  it("refuses a rename that would capture another source", () => {
    // Після перейменування name → description некваліфіковане description
    // зовнішньої таблиці потрапило б у внутрішню промотовану.
    const map: RenameMap = {
      tables: [COUNTERPARTIES],
      knownTables: new Map([
        ["app.counterparties", ["id", "name", "inn"]],
        ["app.notes", ["description"]],
      ]),
    }
    const r = rewriteStatementText(
      "SELECT 1 FROM app.notes WHERE EXISTS (SELECT 1 FROM app.counterparties WHERE description = 'x')",
      parse,
      map,
      { variables: new Set(), records: new Map(), labels: [] }
    )
    expect(r.problems.map((p) => p.code)).toEqual(["rewrite.ambiguous-name"])
  })

  it("refuses an output name hidden inside an expression", () => {
    expect(rw("SELECT inn::text FROM app.counterparties").problems).toEqual([
      "rewrite.unsupported",
    ])
    expect(
      rw("SELECT inn::text FROM app.counterparties", {
        topLevelOutput: "ignore",
      }).sql
    ).toBe("SELECT tax_id::text FROM app.counterparty")
  })

  it("refuses names it cannot place or prove", () => {
    // Поле `(row).f` у дереві без позиції.
    expect(
      rw("SELECT (NEW).inn", {
        records: new Map([["new", { trigger: [COUNTERPARTIES] }]]),
      }).problems
    ).toEqual(["rewrite.unsupported"])
    // `*` підзапиту віддає колонки промотованої таблиці під новими іменами.
    expect(
      rw("SELECT x.inn FROM (SELECT * FROM app.counterparties) x").problems
    ).toEqual(["rewrite.ambiguous-name"])
    // Нове ім'я колонки збіглося б зі змінною.
    expect(
      rw("SELECT inn FROM app.counterparties", {
        variables: new Set(["tax_id"]),
      }).problems
    ).toEqual(["rewrite.ambiguous-name"])
    expect(rw("CREATE INDEX ON app.counterparties (inn)").problems).toEqual([
      "rewrite.unsupported",
    ])
  })

  it("reports offsets in UTF-16 indexes of the text", () => {
    const sql = "SELECT 'Привіт' FROM counterparties"
    const r = rewriteStatementText(sql, parse, MAP, {
      variables: new Set(),
      records: new Map(),
      labels: [],
    })
    expect(r.problems.map((p) => p.offset)).toEqual([
      sql.indexOf("counterparties"),
    ])
  })
})

describe("applyEdits", () => {
  it("applies edits from the end, an insertion after a replacement", () => {
    expect(
      applyEdits("ab cd", [
        { start: 0, end: 2, text: "xyz" },
        { start: 2, end: 2, text: " AS ab" },
        { start: 3, end: 5, text: "q" },
      ])
    ).toBe("xyz AS ab q")
  })

  it("throws on overlapping edits", () => {
    expect(() =>
      applyEdits("abcdef", [
        { start: 0, end: 3, text: "x" },
        { start: 2, end: 4, text: "y" },
      ])
    ).toThrow()
  })
})
