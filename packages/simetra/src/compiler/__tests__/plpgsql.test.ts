import { beforeAll, describe, expect, it } from "vitest"
import {
  loadPlpgsqlParser,
  type PlpgsqlFunction,
  type PlpgsqlParser,
} from "../sql/plpgsql"

let parse: PlpgsqlParser

beforeAll(async () => {
  parse = await loadPlpgsqlParser()
})

// Рядок 1 тіла — рядок відкривального `$$`, тож перший рядок `body` — другий.
const fn = (body: string, extra = "") =>
  `CREATE FUNCTION app.t() RETURNS trigger LANGUAGE plpgsql ${extra} AS $$\n${body}\n$$;`

function parsed(sql: string): PlpgsqlFunction {
  const r = parse(sql)
  if (!r.ok || r.fn === undefined) throw new Error("expected a parsed function")
  return r.fn
}

describe("loadPlpgsqlParser", () => {
  it("lists direct expressions in text order with their lines", () => {
    const r = parse(
      fn(
        `BEGIN\n  NEW.total := NEW.qty * NEW.price;\n  IF NEW.status = 'draft' THEN\n    PERFORM pg_notify('x', 'y');\n  END IF;\n  RETURN NEW;\nEND`
      )
    )
    // `RETURN NEW` компілюється у `retvarno` без виразу, тож його вирази тут не перевіряються.
    expect(
      r.ok &&
        r.fn?.statements
          .slice(0, 4)
          .map((s) => [
            s.type,
            s.lineno,
            s.expressions.map((e) => [e.role, e.query]),
          ])
    ).toEqual([
      ["block", 2, []],
      ["assign", 3, [["assign", "NEW.total := NEW.qty * NEW.price"]]],
      ["if", 4, [["condition", "NEW.status = 'draft'"]]],
      ["perform", 5, [["statement", "SELECT pg_notify('x', 'y')"]]],
    ])
  })

  it("marks SELECT INTO and PERFORM forms", () => {
    const f = parsed(
      fn(
        `DECLARE v int;\nBEGIN\n  SELECT 1 INTO v;\n  PERFORM 2;\n  SELECT 3;\n  RETURN NEW;\nEND`
      )
    )
    const exprs = f.statements.flatMap((s) => s.expressions)
    expect(
      exprs.map((e) => [e.query.trim().replace(/\s+/g, " "), e.into, e.perform])
    ).toEqual([
      ["SELECT 1", true, undefined],
      ["SELECT 2", undefined, true],
      ["SELECT 3", undefined, undefined],
      ["NEW", undefined, undefined],
    ])
  })

  it("walks nested statements depth first and takes ELSIF/CASE lines from their wrappers", () => {
    const f = parsed(
      fn(
        [
          "DECLARE n int := 1;",
          "BEGIN",
          "  IF n = 1 THEN",
          "    n := 2;",
          "  ELSIF n = 2 THEN",
          "    n := 3;",
          "  ELSE",
          "    n := 4;",
          "  END IF;",
          "  CASE n",
          "    WHEN 1 THEN n := 5;",
          "    WHEN 2 THEN",
          "      n := 6;",
          "  END CASE;",
          "  RETURN NEW;",
          "END",
        ].join("\n")
      )
    )
    const rows = f.statements.map((s) => [s.type, s.depth, s.lineno])
    expect(rows.slice(0, 5)).toEqual([
      ["block", 0, 3],
      ["if", 1, 4],
      ["assign", 2, 5],
      ["assign", 2, 7],
      ["assign", 2, 9],
    ])
    const ifStatement = f.statements.find((s) => s.type === "if")
    // Умова `ELSIF` — вираз оператора `if` з рядком обгортки `PLpgSQL_if_elsif`.
    expect(
      ifStatement?.expressions.map((e) => [e.role, e.query, e.lineno])
    ).toEqual([
      ["condition", "n = 1", 4],
      ["condition", "n = 2", 6],
    ])
    const caseStatement = f.statements.find((s) => s.type === "case")
    expect(caseStatement?.expressions.map((e) => e.lineno)).toEqual([
      11, 12, 13,
    ])
  })

  it("records assignment targets", () => {
    const f = parsed(
      fn(
        `DECLARE n int;\nBEGIN\n  n := 1;\n  NEW.total := 2;\n  RETURN NEW;\nEND`
      )
    )
    expect(
      f.statements.filter((s) => s.type === "assign").map((s) => s.target)
    ).toEqual([{ variable: "n" }, { variable: "new.total" }])
  })

  it.each([
    ["EXECUTE format('select 1 from %I', 'sale');", "RETURNS trigger"],
    ["RETURN QUERY EXECUTE 'select 1';", "RETURNS SETOF int"],
    ["FOR r IN EXECUTE 'select 1' LOOP END LOOP;", "RETURNS trigger"],
    ["OPEN c FOR EXECUTE 'select 1';", "RETURNS trigger"],
  ])("finds dynamic SQL: %s", (stmt, returns) => {
    const sql = `CREATE FUNCTION app.t() ${returns} LANGUAGE plpgsql AS $$\nDECLARE r record; c refcursor; BEGIN\n  ${stmt}\nEND\n$$;`
    const f = parsed(sql)
    expect(f.dynamicSqlLines).toEqual([3])
    expect(
      f.statements
        .flatMap((s) => s.expressions)
        .filter((e) => e.role === "dynamic")
    ).toHaveLength(1)
  })

  it("reports declared types as text", () => {
    const f = parsed(
      fn(
        `DECLARE v app.sale.amount%TYPE; n int := 5;\nBEGIN\n  RETURN NEW;\nEND`
      )
    )
    const byName = new Map(f.variables.map((v) => [v.name, v]))
    expect(byName.get("v")).toMatchObject({
      kind: "var",
      lineno: 2,
      typeText: "app.sale.amount%TYPE",
    })
    expect(byName.get("n")?.typeText).toBe("int")
    expect(byName.get("new")).toMatchObject({ kind: "rec" })
    expect(byName.get("old")).toMatchObject({ kind: "rec" })
  })

  it("exposes DECLARE default expressions that read tables", () => {
    const f = parsed(
      fn(
        `DECLARE n int := (SELECT count(*) FROM app.sale);\nBEGIN\n  RETURN NEW;\nEND`
      )
    )
    const declared = f.statements.filter((s) => s.type === "declare")
    expect(
      declared.map((s) => [s.lineno, s.expressions.map((e) => e.query)])
    ).toEqual([[2, ["(SELECT count(*) FROM app.sale)"]]])
  })

  it("returns fn undefined for LANGUAGE sql", () => {
    const r = parse(
      "CREATE FUNCTION app.s() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;"
    )
    expect(r).toEqual({ ok: true, fn: undefined })
  })

  it("turns a syntax error into ok:false", () => {
    const r = parse(fn("BEGIN selec 1; END"))
    expect(r.ok).toBe(false)
  })

  it("turns a semantic error into ok:false", () => {
    // RETURN QUERY у не-SETOF функції: обгортка кидає SyntaxError із JSON.parse
    expect(parse(fn("BEGIN RETURN QUERY SELECT 1; END")).ok).toBe(false)
  })

  it("parses a body with a 2000-char literal", () => {
    expect(
      parse(fn(`BEGIN PERFORM '${"x".repeat(2000)}'; RETURN NEW; END`)).ok
    ).toBe(true)
  })

  it("caches results by text", () => {
    const sql = fn("BEGIN RETURN NEW; END")
    expect(parse(sql)).toBe(parse(sql))
  })
})
