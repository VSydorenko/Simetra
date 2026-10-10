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
  // Промоція додає колонку виду `deletion_mark` і знімає `legacy`.
  columnsAfter: new Set(["id", "description", "tax_id", "deletion_mark"]),
}

const MAP: RenameMap = {
  tables: [COUNTERPARTIES],
  knownTables: new Map([
    ["app.counterparties", ["id", "name", "inn", "legacy"]],
    ["app.invoice", ["id", "counterparty_id", "name"]],
    ["app.notes", ["id", "description", "deletion_mark", "legacy"]],
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

/** Проблеми з деталями — для відмов, де важить причина. */
const details = (sql: string, scope: Partial<RewriteScope> = {}) =>
  rewriteStatementText(sql, parse, MAP, {
    variables: new Set(),
    records: new Map(),
    labels: [],
    ...scope,
  }).problems.map((p) => `${p.code} ${p.detail}`)

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

  describe("captures (decision 14)", () => {
    const CAPTURE = ["rewrite.ambiguous-name capture"]

    it("refuses an added kind column that captures an outer name", () => {
      expect(
        details(
          "SELECT 1 FROM app.notes n WHERE EXISTS (SELECT 1 FROM app.counterparties c WHERE deletion_mark)"
        )
      ).toEqual(CAPTURE)
    })

    it("refuses a rename target that did not exist before", () => {
      expect(
        details(
          "SELECT 1 FROM app.notes WHERE EXISTS (SELECT 1 FROM app.counterparties WHERE description = 'x')"
        )
      ).toEqual(CAPTURE)
    })

    it("refuses a removed column whose name falls through to an outer source", () => {
      expect(
        details(
          "SELECT 1 FROM app.notes WHERE EXISTS (SELECT 1 FROM app.counterparties c WHERE legacy)"
        )
      ).toEqual(CAPTURE)
    })

    it("refuses a PL/pgSQL variable that becomes an added column", () => {
      expect(
        details(
          "SELECT 1 FROM app.invoice i WHERE EXISTS (SELECT 1 FROM app.counterparties c WHERE c.id = i.id AND deletion_mark)",
          { variables: new Set(["deletion_mark"]) }
        )
      ).toEqual(CAPTURE)
    })

    it("refuses a reference to a removed column", () => {
      expect(rw("SELECT legacy FROM app.counterparties").problems).toEqual([
        "rewrite.unsupported",
      ])
      expect(rw("SELECT c.legacy FROM app.counterparties c").problems).toEqual([
        "rewrite.unsupported",
      ])
      expect(
        rw("SELECT NEW.legacy", {
          records: new Map([["new", { trigger: [COUNTERPARTIES] }]]),
        }).problems
      ).toEqual(["rewrite.unsupported"])
    })

    it("refuses a join alias column that a rename makes ambiguous", () => {
      expect(
        details(
          "SELECT j.description FROM (app.notes n JOIN app.counterparties c ON true) j"
        )
      ).toEqual(CAPTURE)
    })

    it("refuses a renamed table name that another FROM name or variable already takes", () => {
      for (const sql of [
        // Кваліфікатор перейменованої таблиці потрапив би у внутрішній аліас.
        "SELECT 1 FROM app.counterparties WHERE EXISTS (SELECT 1 FROM app.invoice counterparty WHERE counterparties.id = counterparty.counterparty_id)",
        // Аліас зовнішнього рівня затінила б внутрішня перейменована таблиця.
        "SELECT 1 FROM app.invoice counterparty WHERE EXISTS (SELECT 1 FROM app.counterparties WHERE counterparty.id = 1)",
        "SELECT 1 FROM app.invoice counterparty WHERE EXISTS (SELECT counterparty FROM app.counterparties)",
        "SELECT 1 FROM app.invoice counterparty, app.counterparties",
      ]) {
        expect(details(sql), sql).toEqual(CAPTURE)
      }
      expect(
        details("SELECT counterparty.id FROM app.counterparties", {
          records: new Map([["counterparty", { table: COUNTERPARTIES }]]),
        })
      ).toEqual(CAPTURE)
    })

    it("renames the qualifier of a star of an unaliased promoted table", () => {
      expect(rw("SELECT counterparties.* FROM app.counterparties").sql).toBe(
        "SELECT counterparty.* FROM app.counterparty"
      )
      expect(
        rw("SELECT row_to_json(counterparties.*) FROM app.counterparties").sql
      ).toBe("SELECT row_to_json(counterparty.*) FROM app.counterparty")
      expect(
        rw("SELECT app.counterparties.* FROM app.counterparties").sql
      ).toBe("SELECT app.counterparty.* FROM app.counterparty")
    })
  })

  describe("search_path (decision 14)", () => {
    it("refuses when a schema outside the model precedes the promoted table", () => {
      expect(
        details("SELECT 1 FROM counterparties", {
          searchPath: ["extensions", "app"],
        })
      ).toEqual(["rewrite.ambiguous-name search-path"])
    })

    it("rewrites when the model schema comes first", () => {
      expect(
        rw("SELECT 1 FROM counterparties", {
          searchPath: ["app", "extensions"],
        }).sql
      ).toBe("SELECT 1 FROM counterparty")
    })
  })

  it("renames a cast to a promoted row type and reports the row shape", () => {
    expect(rw("SELECT '(1)'::app.counterparties")).toEqual({
      sql: "SELECT '(1)'::app.counterparty",
      problems: [],
      changes: ["wholeRow"],
    })
    expect(rw("SELECT NULL::db.app.counterparties").problems).toEqual([
      "rewrite.unsupported",
    ])
  })

  it("explains a positional INSERT by added and removed columns", () => {
    const r = rewriteStatementText(
      "INSERT INTO app.counterparties VALUES (1)",
      parse,
      MAP,
      { variables: new Set(), records: new Map(), labels: [] }
    )
    expect(r.contractChanges.map((c) => c.reason)).toEqual(["star"])
    expect(r.contractChanges[0]?.detail).toMatch(/adds or removes columns/)
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

  it("refuses a changed field behind a qualifier that is no source or record", () => {
    // Мітка блоку, ім'я функції чи ALIAS PL/pgSQL: запис за ними невідомий.
    expect(details("SELECT blk.r.inn")).toEqual([
      'rewrite.unsupported "blk.r.inn": "blk" is neither a source in FROM nor a known record (a block label, the function name or an ALIAS), and "inn" is a column that the promotion changes',
    ])
    expect(rw("SELECT n.inn").problems).toEqual(["rewrite.unsupported"])
    // Незмінене поле нічого не ламає; скаляр-змінна — поза промоцією.
    expect(rw("SELECT n.id").problems).toEqual([])
    expect(rw("SELECT v.inn", { variables: new Set(["v"]) }).problems).toEqual(
      []
    )
  })

  it("refuses changed names that may come from a function-call source", () => {
    // Оператор не згадує таблицю, а функція може віддавати її рядки.
    expect(rw("SELECT x.inn FROM unnest($1) x").problems).toEqual([
      "rewrite.unsupported",
    ])
    expect(rw("SELECT name FROM app.list_counterparties()").problems).toEqual([
      "rewrite.unsupported",
    ])
    // Список псевдонімів перейменовує лише перші колонки складеного рядка.
    expect(rw("SELECT x.inn FROM app.rows() AS x(a, b)").problems).toEqual([
      "rewrite.unsupported",
    ])
    expect(rw("SELECT x.id FROM unnest($1) x").problems).toEqual([])
  })

  it("knows the shape of scalar set functions and column definition lists", () => {
    expect(
      rw("SELECT g, inn FROM generate_series(1, 2) g, app.counterparties")
    ).toEqual({
      sql: "SELECT g, tax_id AS inn FROM generate_series(1, 2) g, app.counterparty",
      problems: [],
      changes: [],
    })
    expect(
      rw("SELECT x.inn FROM app.rows() AS x(id int, inn text)").problems
    ).toEqual([])
    expect(
      rw("SELECT inn FROM app.counterparties c, unnest(ARRAY[1]) u")
    ).toEqual({
      sql: "SELECT tax_id AS inn FROM app.counterparty c, unnest(ARRAY[1]) u",
      problems: [],
      changes: [],
    })
  })

  it("carries an unproven row shape through stars of derived sources", () => {
    for (const sql of [
      "SELECT s.inn FROM (SELECT * FROM unnest($1)) s",
      "WITH s AS (SELECT * FROM unnest($1)) SELECT s.inn FROM s",
      "SELECT s.inn FROM (SELECT x.* FROM unnest($1) x) s",
      "SELECT t.inn FROM (SELECT * FROM (SELECT * FROM unnest($1)) s) t",
      // Перевантаження застосунку обирається за типом неконстантного аргументу.
      "SELECT g.inn FROM generate_series($1) g",
    ]) {
      expect(rw(sql).problems, sql).toEqual(["rewrite.unsupported"])
    }
    // Явний список колонок підзапиту доводить форму.
    expect(
      rw("SELECT s.inn FROM (SELECT x.id AS inn FROM unnest($1) x) s").problems
    ).toEqual([])
  })
})
