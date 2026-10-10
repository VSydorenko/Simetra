import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser } from "../sql/parse"
import { loadPlpgsqlParser } from "../sql/plpgsql"
import {
  rewriteFunction,
  type FunctionRewriteContext,
} from "../sql/rewrite/function"
import type { RenameMap, TableRename } from "../sql/rewrite/renames"

const COUNTERPARTIES: TableRename = {
  schema: "app",
  from: "counterparties",
  to: "counterparty",
  columns: new Map([
    ["name", "description"],
    ["inn", "tax_id"],
  ]),
  columnsAfter: new Set(["id", "description", "tax_id"]),
}

/** Непромотована таблиця, до якої тригер теж прив'язано: імена без змін. */
const INVOICE_UNCHANGED: TableRename = {
  schema: "app",
  from: "invoice",
  to: "invoice",
  columns: new Map(),
  columnsAfter: new Set(["id", "counterparty_id", "name"]),
}

const MAP: RenameMap = {
  tables: [COUNTERPARTIES],
  knownTables: new Map([
    ["app.counterparties", ["id", "name", "inn"]],
    ["app.invoice", ["id", "counterparty_id", "name"]],
  ]),
}

let ctx: FunctionRewriteContext

beforeAll(async () => {
  ctx = {
    parse: await loadSqlParser(),
    plpgsql: await loadPlpgsqlParser(),
    map: MAP,
    triggerTables: undefined,
    labels: [],
  }
})

const TRIGGER = `CREATE FUNCTION app.counterparty_touch() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v app.counterparties.inn%TYPE; -- inn тут лишається
  r app.counterparties%ROWTYPE;
BEGIN
  -- Привіт, inn
  NEW.inn := upper(NEW.inn);
  SELECT * INTO r FROM app.counterparties WHERE id = NEW.id;
  IF r.name IS NULL THEN RAISE EXCEPTION 'name % missing', NEW.name; END IF;
  PERFORM 1 FROM app.counterparties c WHERE c.inn = v;
  RETURN NEW;
END $fn$;`

/** Функція plpgsql з тілом `body`; `header` — сигнатура й опції до `AS`. */
const plpgsql = (
  body: string,
  header = "app.f(p_id uuid) RETURNS text LANGUAGE plpgsql STABLE"
) => `CREATE FUNCTION ${header} AS $fn$\n${body}\n$fn$`

const trigger = (body: string) =>
  plpgsql(body, "app.t() RETURNS trigger LANGUAGE plpgsql VOLATILE")

const codes = (r: ReturnType<typeof rewriteFunction>) =>
  r.problems.map((p) => p.code)

describe("rewriteFunction", () => {
  it("rewrites a trigger function bound to the promoted table", () => {
    const r = rewriteFunction(TRIGGER, {
      ...ctx,
      triggerTables: [COUNTERPARTIES],
    })
    expect(r.problems).toEqual([])
    expect(r.sql).toBe(
      TRIGGER.replace(
        "app.counterparties.inn%TYPE",
        "app.counterparty.tax_id%TYPE"
      )
        .replace("app.counterparties%ROWTYPE", "app.counterparty%ROWTYPE")
        .replace("NEW.inn := upper(NEW.inn)", "NEW.tax_id := upper(NEW.tax_id)")
        .replace(
          "FROM app.counterparties WHERE id",
          "FROM app.counterparty WHERE id"
        )
        .replace("r.name IS NULL", "r.description IS NULL")
        .replace("NEW.name; END IF", "NEW.description; END IF")
        .replace(
          "FROM app.counterparties c WHERE c.inn",
          "FROM app.counterparty c WHERE c.tax_id"
        )
    )
  })

  it("refuses NEW fields when bound to a non-promoted table too", () => {
    const r = rewriteFunction(TRIGGER, {
      ...ctx,
      triggerTables: [COUNTERPARTIES, INVOICE_UNCHANGED],
    })
    expect(codes(r)).toContain("rewrite.trigger-binding")
    expect(r.sql).toBe(TRIGGER)
  })

  it("keeps the record shape of SELECT INTO with AS <old>", () => {
    const sql = plpgsql(
      "DECLARE v text;\nBEGIN\n  SELECT c.name INTO v FROM app.counterparties c WHERE c.id = p_id;\n  RETURN v;\nEND"
    )
    const r = rewriteFunction(sql, ctx)
    expect(r.problems).toEqual([])
    expect(r.sql).toBe(
      sql.replace(
        "SELECT c.name INTO v FROM app.counterparties c",
        "SELECT c.description AS name INTO v FROM app.counterparty c"
      )
    )
  })

  it("does not report SELECT * INTO a ROWTYPE record of the same table", () => {
    const r = rewriteFunction(TRIGGER, {
      ...ctx,
      triggerTables: [COUNTERPARTIES],
    })
    expect(r.contractChanges).toEqual([])
  })

  it("places an ELSIF condition after the THEN body in text order", () => {
    const sql = trigger(
      "DECLARE x text;\nBEGIN\n  IF NEW.inn = '' THEN\n    x := NEW.inn;\n  ELSIF NEW.name = '' THEN\n    x := NEW.name;\n  END IF;\n  RETURN NEW;\nEND"
    )
    const r = rewriteFunction(sql, { ...ctx, triggerTables: [COUNTERPARTIES] })
    expect(r.problems).toEqual([])
    expect(r.sql).toBe(
      sql
        .replaceAll("NEW.inn", "NEW.tax_id")
        .replaceAll("NEW.name", "NEW.description")
    )
  })

  it("never misplaces expressions that share one line", () => {
    // `lineno` не впорядковує вирази одного рядка: умова ELSIF стоїть у
    // списку раніше за тіло THEN. Правка або на своєму місці, або відмова.
    const conditionsOnly = trigger(
      "DECLARE x int;\nBEGIN\n  IF NEW.inn = '' THEN x := 1; ELSIF NEW.name = '' THEN x := 2; END IF;\n  RETURN NEW;\nEND"
    )
    const ok = rewriteFunction(conditionsOnly, {
      ...ctx,
      triggerTables: [COUNTERPARTIES],
    })
    expect(ok.problems).toEqual([])
    expect(ok.sql).toBe(
      conditionsOnly
        .replace("NEW.inn = ''", "NEW.tax_id = ''")
        .replace("NEW.name = ''", "NEW.description = ''")
    )

    const bodies = trigger(
      "DECLARE x text;\nBEGIN\n  IF NEW.inn = '' THEN x := NEW.inn; ELSIF NEW.name = '' THEN x := NEW.name; END IF;\n  RETURN NEW;\nEND"
    )
    const refused = rewriteFunction(bodies, {
      ...ctx,
      triggerTables: [COUNTERPARTIES],
    })
    expect(codes(refused)).toEqual(["rewrite.verification-failed"])
    expect(refused.problems[0]!.line).toBe(4)
    expect(refused.sql).toBe(bodies)
  })

  it("reports absolute lines when the body starts mid-file", () => {
    const sql =
      "CREATE FUNCTION app.f()\nRETURNS void LANGUAGE plpgsql VOLATILE\nAS $fn$\nBEGIN\n  EXECUTE 'SELECT 1 FROM app.counterparties';\nEND $fn$"
    const r = rewriteFunction(sql, ctx)
    expect(r.problems.map((p) => [p.code, p.line])).toEqual([
      ["rewrite.dynamic-sql", 5],
    ])
  })

  it("rewrites a LANGUAGE sql string body and a BEGIN ATOMIC body", () => {
    const header =
      "CREATE FUNCTION app.g(p_id uuid) RETURNS text LANGUAGE sql STABLE"
    const query = "SELECT name FROM app.counterparties WHERE id = p_id"
    const rewritten =
      "SELECT description AS name FROM app.counterparty WHERE id = p_id"

    const string = `${header} AS $$ ${query} $$`
    const a = rewriteFunction(string, ctx)
    expect(a.problems).toEqual([])
    expect(a.sql).toBe(string.replace(query, rewritten))

    const atomic = `${header}\nBEGIN ATOMIC\n  ${query};\nEND`
    const b = rewriteFunction(atomic, ctx)
    expect(b.problems).toEqual([])
    expect(b.sql).toBe(atomic.replace(query, rewritten))

    const returns = `${header} RETURN (SELECT inn FROM app.counterparties WHERE id = p_id)`
    const c = rewriteFunction(returns, ctx)
    expect(c.problems).toEqual([])
    expect(c.sql).toBe(
      `${header} RETURN (SELECT tax_id AS inn FROM app.counterparty WHERE id = p_id)`
    )
  })

  it("refuses a single-quoted body", () => {
    const sql =
      "CREATE FUNCTION app.g() RETURNS bigint LANGUAGE sql STABLE AS 'SELECT count(*) FROM app.counterparties'"
    const r = rewriteFunction(sql, ctx)
    expect(codes(r)).toEqual(["rewrite.body-quoting"])
    expect(r.sql).toBe(sql)
  })

  it("refuses dynamic SQL in scope", () => {
    const sql = plpgsql(
      "BEGIN\n  RETURN (SELECT name FROM app.counterparties WHERE id = p_id);\n  EXECUTE format('DELETE FROM %I', 'counterparties');\nEND"
    )
    const r = rewriteFunction(sql, ctx)
    expect(r.problems.map((p) => [p.code, p.line])).toEqual([
      ["rewrite.dynamic-sql", 4],
    ])
    expect(r.sql).toBe(sql)
  })

  it("refuses an unresolved %TYPE", () => {
    const sql = plpgsql(
      "DECLARE v app.counterparties.missing%TYPE;\nBEGIN\n  RETURN v;\nEND"
    )
    const r = rewriteFunction(sql, ctx)
    expect(r.problems.map((p) => [p.code, p.line])).toEqual([
      ["rewrite.unresolved-type", 2],
    ])
  })

  it("rewrites next to a 2000-char literal", () => {
    const literal = "x".repeat(2000)
    const sql = plpgsql(
      `BEGIN\n  PERFORM 1 FROM app.counterparties WHERE inn <> '${literal}' AND name = 'Привіт';\n  RETURN p_id;\nEND`
    )
    const r = rewriteFunction(sql, ctx)
    expect(r.problems).toEqual([])
    expect(r.sql).toBe(
      sql.replace(
        `FROM app.counterparties WHERE inn <> '${literal}' AND name`,
        `FROM app.counterparty WHERE tax_id <> '${literal}' AND description`
      )
    )
  })

  it("reports a RETURNS SETOF promoted table as a contract change", () => {
    const sql =
      "CREATE FUNCTION app.list() RETURNS SETOF app.counterparties LANGUAGE sql STABLE AS $$ SELECT id, name, inn FROM app.counterparties $$"
    const r = rewriteFunction(sql, ctx)
    expect(r.problems).toEqual([])
    expect(r.contractChanges.map((c) => [c.reason, c.line])).toEqual([
      ["signature", 1],
    ])
    expect(r.sql).toBe(
      "CREATE FUNCTION app.list() RETURNS SETOF app.counterparty LANGUAGE sql STABLE AS $$ SELECT id, description AS name, tax_id AS inn FROM app.counterparty $$"
    )
  })

  it("returns the text unchanged when nothing references the map", () => {
    const sql = plpgsql(
      "BEGIN\n  -- counterparties колись були тут\n  RETURN (SELECT name FROM app.invoice WHERE id = p_id);\nEND"
    )
    const r = rewriteFunction(sql, ctx)
    expect(r).toEqual({ sql, problems: [], contractChanges: [] })
  })

  it("reports a star in RETURN QUERY", () => {
    const sql = plpgsql(
      "BEGIN\n  RETURN QUERY SELECT * FROM app.counterparties;\nEND",
      "app.all() RETURNS SETOF app.counterparties LANGUAGE plpgsql STABLE"
    )
    const r = rewriteFunction(sql, ctx)
    expect(r.problems).toEqual([])
    expect(r.contractChanges.map((c) => [c.reason, c.line])).toEqual([
      ["signature", 1],
      ["star", 3],
    ])
  })

  it("rewrites fields of a record filled by SELECT * of one promoted table", () => {
    const sql = plpgsql(
      "DECLARE q record; x text;\nBEGIN\n  FOR q IN SELECT * FROM app.counterparties LOOP\n    x := q.inn;\n  END LOOP;\n  RETURN x;\nEND"
    )
    const r = rewriteFunction(sql, ctx)
    expect(r.problems).toEqual([])
    expect(r.contractChanges).toEqual([])
    expect(r.sql).toBe(
      sql
        .replace("FROM app.counterparties LOOP", "FROM app.counterparty LOOP")
        .replace("x := q.inn", "x := q.tax_id")
    )
  })

  it("refuses a renamed field of a record of unknown shape", () => {
    const sql = plpgsql(
      "DECLARE q record;\nBEGIN\n  SELECT c.*, i.id AS invoice_id INTO q FROM app.counterparties c JOIN app.invoice i ON i.counterparty_id = c.id;\n  RETURN q.inn;\nEND"
    )
    const r = rewriteFunction(sql, ctx)
    expect(r.problems.map((p) => [p.code, p.line])).toEqual([
      ["rewrite.ambiguous-name", 5],
    ])
    expect(r.problems[0]!.detail).toContain('"q"')
    expect(r.sql).toBe(sql)
  })

  it("refuses when an expression is placed into a decoy comment", () => {
    // Розміщення знаходить текст виразу в коментарі раніше за сам вираз;
    // повторний розбір бачить вираз без правки — відмова, а не правка коментаря.
    const sql = trigger(
      "BEGIN\n  /* NEW.inn := upper(NEW.inn) */ NEW.inn := upper(NEW.inn);\n  RETURN NEW;\nEND"
    )
    const r = rewriteFunction(sql, { ...ctx, triggerTables: [COUNTERPARTIES] })
    expect(r.problems.map((p) => [p.code, p.line])).toEqual([
      ["rewrite.verification-failed", 3],
    ])
    expect(r.sql).toBe(sql)
  })

  it("rewrites a parameter of the promoted row type", () => {
    const sql =
      "CREATE FUNCTION app.label(c app.counterparties) RETURNS text LANGUAGE sql STABLE AS $$ SELECT c.name || c.inn $$"
    const r = rewriteFunction(sql, ctx)
    expect(r.problems).toEqual([])
    expect(r.contractChanges.map((c) => c.reason)).toEqual(["signature"])
    expect(r.sql).toBe(
      "CREATE FUNCTION app.label(c app.counterparty) RETURNS text LANGUAGE sql STABLE AS $$ SELECT c.description || c.tax_id $$"
    )
  })

  it("refuses unqualified names bound at creation despite SET search_path", () => {
    // Сигнатура й тіло стандарту SQL зв'язуються під час CREATE FUNCTION —
    // за search_path сесії, а не функції.
    const atomic =
      "CREATE FUNCTION app.g() RETURNS bigint LANGUAGE sql STABLE SET search_path = app BEGIN ATOMIC SELECT count(*) FROM counterparties; END"
    expect(codes(rewriteFunction(atomic, ctx))).toEqual([
      "rewrite.unqualified-table",
    ])
    const signature =
      "CREATE FUNCTION app.g() RETURNS SETOF counterparties LANGUAGE sql STABLE SET search_path = app AS $$ SELECT * FROM app.counterparties $$"
    expect(codes(rewriteFunction(signature, ctx))).toEqual([
      "rewrite.unqualified-table",
    ])
  })

  it("resolves unqualified tables by the function's search_path", () => {
    const sql = plpgsql(
      "BEGIN\n  PERFORM 1 FROM counterparties WHERE inn = '';\n  RETURN p_id;\nEND",
      "app.f(p_id uuid) RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = app"
    )
    const r = rewriteFunction(sql, ctx)
    expect(r.problems).toEqual([])
    expect(r.sql).toBe(
      sql.replace(
        "FROM counterparties WHERE inn",
        "FROM counterparty WHERE tax_id"
      )
    )
  })

  it("rewrites a CASE WHEN value", () => {
    const sql = trigger(
      "BEGIN\n  CASE 'a'\n    WHEN NEW.name THEN NEW.inn := '';\n    ELSE NULL;\n  END CASE;\n  RETURN NEW;\nEND"
    )
    const r = rewriteFunction(sql, { ...ctx, triggerTables: [COUNTERPARTIES] })
    expect(r.problems).toEqual([])
    expect(r.sql).toBe(
      sql
        .replace("WHEN NEW.name", "WHEN NEW.description")
        .replace("NEW.inn := ''", "NEW.tax_id := ''")
    )
  })

  it("refuses a renamed record field as an INTO target", () => {
    const sql = trigger(
      "BEGIN\n  SELECT upper(c.inn) INTO NEW.inn FROM app.counterparties c WHERE c.id = NEW.id;\n  RETURN NEW;\nEND"
    )
    const r = rewriteFunction(sql, { ...ctx, triggerTables: [COUNTERPARTIES] })
    expect(codes(r)).toEqual(["rewrite.unsupported"])
    expect(r.sql).toBe(sql)
  })

  // Повтори рецензента (раунд 1): кожне посилання або резолвиться точно,
  // або відмовляє — мовчки пропущене чи хибно переписане ім'я заборонене.
  describe("references the parse tree does not model", () => {
    const refused = (
      sql: string,
      code: string,
      detail: string,
      triggerTables?: TableRename[]
    ) => {
      const r = rewriteFunction(sql, { ...ctx, triggerTables })
      expect(r.sql).toBe(sql)
      expect(
        r.problems.filter((p) => p.code === code).map((p) => p.detail)
      ).toEqual(expect.arrayContaining([expect.stringContaining(detail)]))
    }

    it.each([
      [
        "an outer ROWTYPE and an inner ROWTYPE",
        "CREATE FUNCTION app.f() RETURNS text LANGUAGE plpgsql AS $fn$\nDECLARE r app.counterparties%ROWTYPE;\nBEGIN\n  SELECT * INTO r FROM app.counterparties LIMIT 1;\n  DECLARE r app.invoice%ROWTYPE;\n  BEGIN\n    SELECT * INTO r FROM app.invoice LIMIT 1;\n    RETURN r.name;\n  END;\nEND $fn$",
      ],
      [
        "two record variables",
        "CREATE FUNCTION app.f() RETURNS text LANGUAGE plpgsql AS $fn$\nDECLARE q record;\nBEGIN\n  FOR q IN SELECT * FROM app.counterparties LOOP END LOOP;\n  DECLARE q record;\n  BEGIN\n    SELECT i.name, i.id INTO q FROM app.invoice i;\n    RETURN q.name;\n  END;\nEND $fn$",
      ],
      [
        "a parameter and an inner ROWTYPE",
        "CREATE FUNCTION app.f(r app.counterparties) RETURNS text LANGUAGE plpgsql AS $fn$\nDECLARE r2 int;\nBEGIN\n  DECLARE r app.invoice%ROWTYPE;\n  BEGIN\n    RETURN r.name;\n  END;\nEND $fn$",
      ],
    ])("refuses a shadowed record name: %s", (_, sql) => {
      refused(sql, "rewrite.ambiguous-name", "shadowed")
    })

    it.each([
      [
        "a block label",
        "CREATE FUNCTION app.f() RETURNS text LANGUAGE plpgsql AS $fn$\n<<blk>>\nDECLARE r app.counterparties%ROWTYPE;\nBEGIN\n  SELECT * INTO r FROM app.counterparties c;\n  RETURN blk.r.inn;\nEND $fn$",
        '"blk.r.inn"',
      ],
      [
        "a block label on a record of unknown shape",
        "CREATE FUNCTION app.f() RETURNS text LANGUAGE plpgsql AS $fn$\n<<blk>>\nDECLARE q record;\nBEGIN\n  SELECT c.*, 1 AS z INTO q FROM app.counterparties c;\n  RETURN blk.q.inn;\nEND $fn$",
        '"blk.q.inn"',
      ],
      [
        "the function name",
        "CREATE FUNCTION app.f(c app.counterparties) RETURNS text LANGUAGE plpgsql AS $fn$\nBEGIN\n  RETURN f.c.inn;\nEND $fn$",
        '"f.c.inn"',
      ],
      [
        "an ALIAS of a parameter",
        "CREATE FUNCTION app.f(app.counterparties) RETURNS text LANGUAGE plpgsql AS $fn$\nDECLARE\n  c ALIAS FOR $1;\nBEGIN\n  RETURN c.inn;\nEND $fn$",
        '"c.inn"',
      ],
      [
        "a positional parameter",
        "CREATE FUNCTION app.f(app.counterparties) RETURNS text LANGUAGE plpgsql AS $fn$\nBEGIN\n  RETURN $1.inn;\nEND $fn$",
        "parenthesized row value",
      ],
      [
        "a positional parameter of LANGUAGE sql",
        "CREATE FUNCTION app.f(app.counterparties) RETURNS text LANGUAGE sql AS $fn$\n  SELECT $1.inn\n$fn$",
        "parenthesized row value",
      ],
    ])("refuses a changed field qualified by %s", (_, sql, detail) => {
      refused(sql, "rewrite.unsupported", detail)
    })

    it("refuses an ALIAS in a function whose signature names the promoted table", () => {
      const sql =
        "CREATE FUNCTION app.f(app.counterparties) RETURNS text LANGUAGE plpgsql AS $fn$\nDECLARE\n  c ALIAS FOR $1;\nBEGIN\n  RETURN c.inn;\nEND $fn$"
      refused(sql, "rewrite.unsupported", "ALIAS FOR")
      refused(sql, "rewrite.unsupported", '"c.inn"')
    })

    it("refuses an ALIAS of NEW, as a target and in an expression", () => {
      const sql =
        "CREATE FUNCTION app.t() RETURNS trigger LANGUAGE plpgsql AS $fn$\nDECLARE\n  n ALIAS FOR NEW;\nBEGIN\n  n.inn := upper(n.inn);\n  RETURN NEW;\nEND $fn$"
      refused(sql, "rewrite.unsupported", "ALIAS of new.inn", [COUNTERPARTIES])
      refused(sql, "rewrite.unsupported", '"n.inn"', [COUNTERPARTIES])
    })

    it("refuses an ALIAS whose name the promotion could capture", () => {
      // Без жодної правки: після промоції `tax_id` — колонка таблиці.
      const sql =
        "CREATE FUNCTION app.f(text) RETURNS bigint LANGUAGE plpgsql STABLE AS $fn$\nDECLARE\n  tax_id ALIAS FOR $1;\nBEGIN\n  RETURN (SELECT count(*) FROM app.counterparties c WHERE c.id::text = tax_id);\nEND $fn$"
      refused(sql, "rewrite.unsupported", "ALIAS FOR")
    })

    it.each([
      [
        "GET DIAGNOSTICS",
        "CREATE FUNCTION app.t() RETURNS trigger LANGUAGE plpgsql AS $fn$\nBEGIN\n  UPDATE app.invoice SET name = 'x';\n  GET DIAGNOSTICS NEW.inn = ROW_COUNT;\n  RETURN NEW;\nEND $fn$",
        "the target new.inn",
      ],
      [
        "FETCH INTO",
        "CREATE FUNCTION app.t() RETURNS trigger LANGUAGE plpgsql AS $fn$\nDECLARE c CURSOR FOR SELECT name FROM app.invoice;\nBEGIN\n  OPEN c;\n  FETCH c INTO NEW.name;\n  RETURN NEW;\nEND $fn$",
        "the target new.name",
      ],
    ])("refuses a renamed field as a %s target", (_, sql, detail) => {
      refused(sql, "rewrite.unsupported", detail, [COUNTERPARTIES])
    })

    it.each([
      "CREATE FUNCTION app.t() RETURNS trigger LANGUAGE plpgsql AS $fn$\nBEGIN\n  t.new.inn := upper(t.new.inn);\n  RETURN NEW;\nEND $fn$",
      "CREATE FUNCTION app.f() RETURNS text LANGUAGE plpgsql AS $fn$\nDECLARE r app.counterparties%ROWTYPE;\nBEGIN\n  GET DIAGNOSTICS r.inn = ROW_COUNT;\n  RETURN r.inn;\nEND $fn$",
    ])("refuses a body the PL/pgSQL parser rejects", (sql) => {
      refused(sql, "rewrite.unsupported", "does not compile", [COUNTERPARTIES])
    })

    it("rewrites FOREACH and FOR bounds", () => {
      const sql =
        "CREATE FUNCTION app.f() RETURNS text LANGUAGE plpgsql AS $fn$\nDECLARE r app.counterparties%ROWTYPE; i int;\nBEGIN\n  FOREACH i IN ARRAY ARRAY[1] LOOP END LOOP;\n  FOR i IN 1..r.inn::int LOOP END LOOP;\n  RETURN r.name;\nEND $fn$"
      const r = rewriteFunction(sql, ctx)
      expect(r.problems).toEqual([])
      expect(r.sql).toBe(
        sql
          .replace("app.counterparties%ROWTYPE", "app.counterparty%ROWTYPE")
          .replace("r.inn::int", "r.tax_id::int")
          .replace("RETURN r.name", "RETURN r.description")
      )
    })

    it("does not bind an array of the promoted row type as a record", () => {
      const sql =
        "CREATE FUNCTION app.f(a app.counterparties[]) RETURNS text LANGUAGE plpgsql STABLE AS $fn$\nBEGIN\n  RETURN a[1].inn;\nEND $fn$"
      const r = rewriteFunction(sql, ctx)
      expect(r.contractChanges.map((c) => c.reason)).toEqual(["signature"])
      refused(sql, "rewrite.unsupported", "parenthesized row value")
    })
  })

  describe("function-call sources in FROM", () => {
    it("refuses a field of unnest over an array of the promoted row type", () => {
      const sql =
        "CREATE FUNCTION app.f(a app.counterparties[]) RETURNS SETOF text LANGUAGE sql STABLE AS $$ SELECT x.inn FROM unnest(a) x $$"
      const r = rewriteFunction(sql, ctx)
      expect(r.sql).toBe(sql)
      expect(r.problems.map((p) => [p.code, p.column])).toEqual([
        ["rewrite.unsupported", 99],
      ])
      expect(r.problems[0]!.detail).toContain("unnest()")
    })

    it("refuses a field of a function returning the promoted rows", () => {
      const sql = plpgsql(
        "BEGIN\n  RETURN (SELECT s.name FROM app.list_counterparties() s LIMIT 1);\nEND"
      )
      const r = rewriteFunction(sql, ctx)
      expect(codes(r)).toEqual(["rewrite.unsupported"])
      expect(r.problems[0]!.detail).toContain("list_counterparties()")
      expect(r.sql).toBe(sql)
    })

    /** Функція над масивом рядків промотованої таблиці з тілом `LANGUAGE sql`. */
    const overArray = (body: string, options = "") =>
      `CREATE FUNCTION app.f(a app.counterparties[]) RETURNS SETOF text LANGUAGE sql STABLE ${options} AS $$ ${body} $$`

    it.each([
      ["a subquery star", "SELECT s.inn FROM (SELECT * FROM unnest(a)) s"],
      ["a CTE star", "WITH s AS (SELECT * FROM unnest(a)) SELECT s.inn FROM s"],
      ["a qualified star", "SELECT s.inn FROM (SELECT x.* FROM unnest(a) x) s"],
      [
        "two nested stars",
        "SELECT t.inn FROM (SELECT * FROM (SELECT * FROM unnest(a)) s) t",
      ],
      ["an unqualified name", "SELECT inn FROM (SELECT * FROM unnest(a)) s"],
    ])("refuses a function-call source wrapped in %s", (_, body) => {
      const sql = overArray(body)
      const r = rewriteFunction(sql, ctx)
      expect(codes(r)).toEqual(["rewrite.unsupported"])
      expect(r.problems[0]!.detail).toContain("unnest()")
      expect(r.sql).toBe(sql)
    })

    it("refuses a catalog set function over a non-constant argument", () => {
      // За `search_path = app` Postgres обирає перевантаження застосунку
      // `app.generate_series(app.counterparties[])`.
      const sql = overArray(
        "SELECT g.inn FROM generate_series(a) g",
        "SET search_path = app"
      )
      const r = rewriteFunction(sql, ctx)
      expect(codes(r)).toEqual(["rewrite.unsupported"])
      expect(r.problems[0]!.detail).toContain("generate_series()")
    })

    it("does not refuse unnest over a constant array", () => {
      const sql = overArray("SELECT u FROM unnest(ARRAY[1, 2]) u")
      const r = rewriteFunction(sql, ctx)
      expect(r.problems).toEqual([])
      expect(r.sql).toBe(
        sql.replace("app.counterparties[]", "app.counterparty[]")
      )
    })

    it("does not refuse a scalar set function", () => {
      const sql =
        "CREATE FUNCTION app.f() RETURNS SETOF int LANGUAGE sql STABLE AS $$ SELECT g FROM generate_series(1, 2) g $$"
      expect(rewriteFunction(sql, ctx)).toEqual({
        sql,
        problems: [],
        contractChanges: [],
      })
    })

    it("does not refuse a call with a column definition list", () => {
      const sql =
        "CREATE FUNCTION app.f() RETURNS SETOF text LANGUAGE sql STABLE AS $$ SELECT x.name FROM app.rows() AS x(id int, name text) $$"
      expect(rewriteFunction(sql, ctx)).toEqual({
        sql,
        problems: [],
        contractChanges: [],
      })
    })
  })
})
