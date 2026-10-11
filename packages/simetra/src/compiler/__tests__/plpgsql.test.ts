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

  it("records GET DIAGNOSTICS targets", () => {
    const f = parsed(
      fn(
        `DECLARE n int;\nBEGIN\n  GET DIAGNOSTICS n = ROW_COUNT, NEW.total = ROW_COUNT;\n  RETURN NEW;\nEND`
      )
    )
    expect(
      f.statements.filter((s) => s.type === "getdiag").map((s) => s.target)
    ).toEqual([{ variable: "n, new.total" }])
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

  it("exposes a declared cursor query as a declare statement", () => {
    const f = parsed(
      fn(
        `DECLARE c CURSOR FOR SELECT id FROM app.sale;\nBEGIN\n  RETURN NEW;\nEND`
      )
    )
    const declared = f.statements.filter((s) => s.type === "declare")
    expect(
      declared.map((s) => [
        s.lineno,
        s.depth,
        s.expressions.map((e) => [e.role, e.query]),
      ])
    ).toEqual([[2, 0, [["statement", "SELECT id FROM app.sale"]]]])
    // `declare` стоїть після обходу дерева, тож блок лишається першим.
    expect(f.statements[0]?.type).toBe("block")
  })

  it("does not list unnamed INTO rows as variables", () => {
    const f = parsed(
      fn(
        `DECLARE a int; b int;\nBEGIN\n  SELECT 1, 2 INTO a, b;\n  RETURN NEW;\nEND`
      )
    )
    expect(f.variables.map((v) => v.name)).not.toContain("(unnamed row)")
    expect(f.statements.find((s) => s.type === "execsql")?.target).toEqual({
      variable: "a, b",
    })
  })

  it("walks statements inside an EXCEPTION block", () => {
    // Обробник винятку — обгортка, а не оператор: його оператори мають лишитися
    // в обході, інакше запит у `EXCEPTION WHEN` ховався б від переписувача.
    const f = parsed(
      fn(
        [
          "DECLARE n int;",
          "BEGIN",
          "  n := 1;",
          "EXCEPTION WHEN unique_violation THEN",
          "  n := (SELECT 2 FROM app.t2);",
          "  RETURN NEW;",
          "END",
        ].join("\n")
      )
    )
    const handled = f.statements.find(
      (s) => s.expressions[0]?.query === "n := (SELECT 2 FROM app.t2)"
    )
    expect(handled?.type).toBe("assign")
    expect(handled?.lineno).toBe(6)
    expect(handled?.target).toEqual({ variable: "n" })
    expect(f.statements.map((s) => s.type)).toContain("return")
  })

  it("reads expressions of RAISE … USING options", () => {
    const f = parsed(
      fn(
        `BEGIN\n  RAISE EXCEPTION 'x %', 1 USING DETAIL = (SELECT count(*) FROM app.t2)::text, HINT = 'h';\nEND`
      )
    )
    const raise = f.statements.find((s) => s.type === "raise")
    expect(raise?.expressions.map((e) => [e.role, e.query])).toEqual([
      ["value", "1"],
      ["value", "(SELECT count(*) FROM app.t2)::text"],
      ["value", "'h'"],
    ])
  })

  it("records the target of integer and query FOR loops", () => {
    const f = parsed(
      fn(
        [
          "DECLARE n int := 3; r record;",
          "BEGIN",
          "  FOR i IN 1..n LOOP",
          "    PERFORM 1;",
          "  END LOOP;",
          "  FOR r IN SELECT id FROM app.t2 LOOP",
          "    PERFORM 1;",
          "  END LOOP;",
          "  RETURN NEW;",
          "END",
        ].join("\n")
      )
    )
    const integer = f.statements.find((s) => s.type === "fori")
    expect(integer?.target).toEqual({ variable: "i" })
    expect(integer?.expressions.map((e) => e.query)).toEqual(["1", "n"])
    const query = f.statements.find((s) => s.type === "fors")
    expect(query?.target).toEqual({ variable: "r" })
    expect(query?.expressions.map((e) => [e.role, e.query])).toEqual([
      ["statement", "SELECT id FROM app.t2"],
    ])
    // Тіла циклів глибші за сам цикл.
    expect(
      f.statements.filter((s) => s.type === "perform").map((s) => s.depth)
    ).toEqual([2, 2])
  })

  it("records the INTO target of a dynamic EXECUTE", () => {
    const f = parsed(
      fn(
        `DECLARE v int;\nBEGIN\n  EXECUTE 'select 1' INTO v;\n  RETURN NEW;\nEND`
      )
    )
    const dynamic = f.statements.find((s) => s.type === "dynexecute")
    expect(dynamic?.target).toEqual({ variable: "v" })
    expect(dynamic?.expressions.map((e) => [e.role, e.into])).toEqual([
      ["dynamic", true],
    ])
    expect(f.dynamicSqlLines).toEqual([4])
  })

  it("turns a SQL-standard body into ok:false without leaking WASM text, and keeps parsing", () => {
    // `BEGIN ATOMIC` валить WASM-виклик; мову перевіряє виклик, не цей парсер.
    const r = parse(
      "CREATE FUNCTION app.s() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;"
    )
    expect(r).toEqual({ ok: false, message: "PL/pgSQL body does not compile" })
    expect(parse(fn("BEGIN RETURN NEW; END")).ok).toBe(true)
  })

  it("keeps the Postgres text of a syntax error", () => {
    const r = parse(fn("BEGIN selec 1; END"))
    expect(!r.ok && r.message).toContain("syntax error")
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
