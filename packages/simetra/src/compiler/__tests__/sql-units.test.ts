import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
import {
  STOCK_FILE,
  customTable,
  document,
  metaFiles,
  project,
  salesDocument,
} from "./helpers"

const MISC = "sql/public/misc.sql"

/** Компілює проєкт з одним спільним `.sql` (плюс додаткові файли). */
async function compileSql(
  sql: string,
  extra: Record<string, unknown> = {}
): Promise<CompileResult> {
  const result = await compile(
    metaFiles({ "project.meta.json": project(), [MISC]: sql, ...extra })
  )
  return result
}

async function identities(sql: string): Promise<string[]> {
  const result = await compileSql(sql)
  expect(result.diagnostics).toEqual([])
  return result.model!.sqlUnits.map((unit) => unit.identity)
}

describe("sql units", () => {
  it("grant on all objects in a schema is not a unit", async () => {
    const result = await compileSql(
      "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;\n" +
        "REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM anon;"
    )
    expect(
      result.diagnostics.map((d) => [
        d.code,
        d.params?.statement,
        d.params?.line,
      ])
    ).toEqual([
      ["sql.statement-not-allowed", "GrantStmt", 1],
      ["sql.statement-not-allowed", "GrantStmt", 2],
    ])
    expect(result.diagnostics[0]!.params).toMatchObject({
      detail: "allInSchema",
    })
  })

  it("function identity includes argument types", async () => {
    const result = await compileSql(
      "CREATE FUNCTION public.f(a uuid, b text) RETURNS int LANGUAGE sql AS $$ select 1 $$;"
    )
    expect(result.diagnostics).toEqual([])
    const [unit] = result.model!.sqlUnits
    expect(unit).toMatchObject({
      class: "function",
      identity: "function:public.f(uuid,text)",
      schema: "public",
      name: "f",
      file: MISC,
      module: "TestApp",
    })
    expect(unit!.sql).toBe(
      "CREATE FUNCTION public.f(a uuid, b text) RETURNS int LANGUAGE sql AS $$ select 1 $$"
    )
  })

  it("unqualified names take the schema of the folder; OUT parameters are not part of the identity", async () => {
    expect(
      await identities(
        "CREATE FUNCTION g(x int, OUT y text) LANGUAGE sql AS $$ select '' $$;\n" +
          "CREATE PROCEDURE p(a text[]) LANGUAGE sql AS $$ select 1 $$;"
      )
    ).toEqual(["function:public.g(int4)", "procedure:public.p(text[])"])
  })

  it("f(int) and f(int4) are one function", async () => {
    const result = await compileSql(
      "CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $$ select 1 $$;\n" +
        "CREATE FUNCTION f(b int4) RETURNS int LANGUAGE sql AS $$ select 2 $$;"
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.unit-duplicate",
        params: expect.objectContaining({
          identity: "function:public.f(int4)",
          line: 2,
        }),
      }),
    ])
  })

  it("f(uuid) and f(pg_catalog.uuid) are one function", async () => {
    const result = await compileSql(
      "CREATE FUNCTION f(a uuid) RETURNS int LANGUAGE sql AS $$ select 1 $$;\n" +
        "CREATE FUNCTION f(a pg_catalog.uuid) RETURNS int LANGUAGE sql AS $$ select 2 $$;"
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.unit-duplicate",
        params: expect.objectContaining({
          identity: "function:public.f(uuid)",
        }),
      }),
    ])
  })

  // Кожна пара — два написання одного типу `pg_proc`; третій стовпець —
  // канонічна форма в ідентичності.
  it.each([
    ["int4", "integer", "int4"],
    ["int", "pg_catalog.int4", "int4"],
    ["smallint", "int2", "int2"],
    ["bigint", "int8", "int8"],
    ["boolean", "bool", "bool"],
    ["real", "float4", "float4"],
    ["float(10)", "float4", "float4"],
    ["float", "float8", "float8"],
    ["double precision", "float8", "float8"],
    ["decimal", "numeric", "numeric"],
    ["dec", "numeric", "numeric"],
    ["timestamp with time zone", "timestamptz", "timestamptz"],
    ["timestamp without time zone", "pg_catalog.timestamp", "timestamp"],
    ["time with time zone", "timetz", "timetz"],
    ["time without time zone", "pg_catalog.time", "time"],
    ["character varying", "varchar", "varchar"],
    ["char varying", "pg_catalog.varchar", "varchar"],
    ["national character varying", "varchar", "varchar"],
    ["character", "bpchar", "bpchar"],
    ["char", "bpchar", "bpchar"],
    ["nchar", "bpchar", "bpchar"],
    ["bit varying", "varbit", "varbit"],
    ["bit", '"bit"', "bit"],
    ["json", '"json"', "json"],
    ["interval", '"interval"', "interval"],
    // Модифікатор типу не входить у тип функції.
    ["varchar(10)", "character varying", "varchar"],
    ["numeric(10,2)", "numeric", "numeric"],
    ["char(5)", "bpchar", "bpchar"],
    ["timestamp(3) with time zone", "timestamptz", "timestamptz"],
    ["time(2)", "time", "time"],
    ["bit(3)", '"bit"', "bit"],
    ["interval day to second", '"interval"', "interval"],
    // Масив — один тип незалежно від написання й кількості вимірів.
    ["int[]", "_int4", "int4[]"],
    ["integer[]", "int4[]", "int4[]"],
    ["integer array", "pg_catalog._int4", "int4[]"],
    ["int[][]", "int4[3]", "int4[]"],
    ["varchar(10)[]", "_varchar", "varchar[]"],
    ["_int4[]", "int[]", "int4[]"],
  ])("f(%s) and f(%s) are one function", async (first, second, canonical) => {
    const result = await compileSql(
      `CREATE FUNCTION f(a ${first}) RETURNS int LANGUAGE sql AS $$ select 1 $$;\n` +
        `CREATE FUNCTION f(a ${second}) RETURNS int LANGUAGE sql AS $$ select 2 $$;`
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.unit-duplicate",
        params: expect.objectContaining({
          identity: `function:public.f(${canonical})`,
        }),
      }),
    ])
  })

  it("distinct types stay distinct: quoted char, user types and their schemas", async () => {
    expect(
      await identities(
        [
          'CREATE FUNCTION f(a "char") RETURNS int LANGUAGE sql AS $$ select 1 $$;',
          "CREATE FUNCTION f(a char) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
          "CREATE FUNCTION f(a item) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
          "CREATE FUNCTION f(a other.item) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
        ].join("\n")
      )
    ).toEqual([
      "function:public.f(bpchar)",
      "function:public.f(char)",
      "function:public.f(item)",
      "function:public.f(other.item)",
    ])
  })

  it("_x is an array only for catalog types; a user type named _x is a name", async () => {
    expect(
      await identities(
        [
          "CREATE FUNCTION f(a public._item) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
          "CREATE FUNCTION f(a public.item[]) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
          "CREATE FUNCTION f(a _item) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
        ].join("\n")
      )
    ).toEqual([
      "function:public.f(_item)",
      "function:public.f(public._item)",
      "function:public.f(public.item[])",
    ])
  })

  it("%type argument keeps its column reference", async () => {
    expect(
      await identities(
        "CREATE FUNCTION f(a t.c%type) RETURNS int LANGUAGE sql AS $$ select 1 $$;"
      )
    ).toEqual(["function:public.f(t.c%type)"])
  })

  it("unqualified domain type takes the schema of the domain: f(item) and f(public.item) are one function", async () => {
    const result = await compileSql(
      [
        "CREATE DOMAIN item AS text;",
        "CREATE FUNCTION f(a item) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
        "CREATE FUNCTION f(a public.item) RETURNS int LANGUAGE sql AS $$ select 2 $$;",
      ].join("\n")
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.unit-duplicate",
        params: expect.objectContaining({
          identity: "function:public.f(public.item)",
          line: 3,
        }),
      }),
    ])
  })

  it("unqualified type known in one schema takes that schema, not the file's", async () => {
    const result = await compileSql("", {
      "sql/a/f.sql":
        "CREATE FUNCTION f(a item) RETURNS int LANGUAGE sql AS $$ select 1 $$;\n" +
        "GRANT EXECUTE ON FUNCTION f(item) TO anon;",
      "sql/b/item.sql": "CREATE DOMAIN item AS text;",
    })
    expect(result.diagnostics).toEqual([])
    expect(result.model!.sqlUnits.map((u) => u.identity)).toEqual(
      expect.arrayContaining([
        "function:a.f(b.item)",
        "grant:grant:function:a.f(b.item):anon:execute",
      ])
    )
  })

  it("unqualified type known in several schemas takes the schema of the unit", async () => {
    const result = await compileSql("", {
      "sql/a/f.sql":
        "CREATE DOMAIN item AS text;\n" +
        "CREATE FUNCTION f(a item) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
      "sql/b/item.sql": "CREATE DOMAIN item AS text;",
    })
    expect(result.diagnostics).toEqual([])
    expect(result.model!.sqlUnits.map((u) => u.identity)).toContain(
      "function:a.f(a.item)"
    )
  })

  it("unqualified type unknown to the model stays as written", async () => {
    expect(
      await identities(
        "CREATE FUNCTION f(a citext, b vector) RETURNS int LANGUAGE sql AS $$ select 1 $$;"
      )
    ).toEqual(["function:public.f(citext,vector)"])
  })

  it("unqualified enum type of the model takes its schema", async () => {
    const result = await compileSql(
      "CREATE FUNCTION f(a mood) RETURNS int LANGUAGE sql AS $$ select 1 $$;\n" +
        "CREATE FUNCTION f(a x.mood) RETURNS int LANGUAGE sql AS $$ select 2 $$;",
      {
        "pg-enums/Mood/Mood.meta.json": {
          id: "00000000-0000-4000-8000-000000000077",
          kind: "PgEnum",
          name: "Mood",
          physicalName: "mood",
          schema: "x",
          values: ["happy"],
        },
      }
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.unit-duplicate",
        params: expect.objectContaining({
          identity: "function:public.f(x.mood)",
        }),
      }),
    ])
  })

  it("built-in type targets are canonical like signature arguments", async () => {
    // Вбудований тип — завжди `pg_catalog`, тож `int`, `int4` і
    // `pg_catalog.int4` — одна ціль; файлова схема йому не належить.
    for (const sql of [
      "COMMENT ON TYPE int IS 'x';",
      "COMMENT ON TYPE int4 IS 'x';",
      "COMMENT ON TYPE pg_catalog.int4 IS 'x';",
    ]) {
      expect(await identities(sql), sql).toEqual(["comment:type:int4"])
    }
    expect(await identities("GRANT USAGE ON TYPE int4 TO anon;")).toEqual([
      "grant:grant:type:int4:anon:usage",
    ])
  })

  it("user type targets follow the signature rule: model-known are qualified", async () => {
    expect(
      await identities(
        "CREATE DOMAIN d AS text;\n" +
          "COMMENT ON TYPE d IS 'x';\n" +
          "COMMENT ON DOMAIN other.d IS 'x';\n" +
          "COMMENT ON TYPE ext_t IS 'x';"
      )
    ).toEqual([
      "comment:domain:other.d",
      "comment:type:ext_t",
      "comment:type:public.d",
      "domain:public.d",
    ])
  })

  it("comment on a cast keeps the boundary between its two types and canonicalizes them", async () => {
    expect(
      await identities(
        "COMMENT ON CAST (a.b AS c) IS 'x';\n" +
          "COMMENT ON CAST (a AS b.c) IS 'x';\n" +
          "COMMENT ON CAST (int AS text) IS 'x';"
      )
    ).toEqual([
      "comment:cast:(a).(b.c)",
      "comment:cast:(a.b).(c)",
      "comment:cast:(int4).(text)",
    ])
  })

  it("comment on a domain constraint resolves the domain like a type target", async () => {
    // Домен в іншій схемі файлу — відомий моделі, тож береться його схема, а
    // не схема файлу з коментарем.
    const result = await compileSql("", {
      "sql/a/x.sql":
        "CREATE DOMAIN d AS text CONSTRAINT c CHECK (VALUE <> '');",
      "sql/b/y.sql": "COMMENT ON CONSTRAINT c ON DOMAIN d IS 'x';",
    })
    expect(result.diagnostics).toEqual([])
    expect(result.model!.sqlUnits.map((u) => u.identity)).toContain(
      "comment:domconstraint:a.d.c"
    )
  })

  it("a table row type argument has one identity however it is written", async () => {
    const tables = {
      "custom-tables/Codes/Codes.meta.json": customTable("Codes"),
    }
    const fn = (arg: string) =>
      `CREATE FUNCTION f(r ${arg}) RETURNS int LANGUAGE sql AS $$ select 1 $$;`
    const result = await compileSql(
      `${fn("codes")}\n${fn("public.codes")}`,
      tables
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.unit-duplicate",
        params: expect.objectContaining({
          identity: "function:public.f(public.codes)",
        }),
      }),
    ])
  })

  it("a same-named table in two schemas resolves to the schema of the unit", async () => {
    const result = await compileSql(
      "CREATE FUNCTION f(r codes) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
      {
        "custom-tables/Codes/Codes.meta.json": customTable("Codes"),
        "custom-tables/Other/Other.meta.json": customTable("Other", {
          physicalName: "codes",
          schema: "other",
        }),
      }
    )
    expect(result.diagnostics).toEqual([])
    expect(result.model!.sqlUnits.map((u) => u.identity)).toEqual([
      "function:public.f(public.codes)",
    ])
  })

  it("aggregate, function settings, grant and comment name a signature canonically", async () => {
    expect(
      await identities(
        [
          "CREATE AGGREGATE agg(integer) (SFUNC = int4pl, STYPE = int);",
          "ALTER FUNCTION f(integer, varchar(5)) SET search_path = '';",
          "GRANT EXECUTE ON FUNCTION f(int, character varying) TO anon;",
          "COMMENT ON FUNCTION f(pg_catalog.int4, pg_catalog.varchar) IS 'x';",
        ].join("\n")
      )
    ).toEqual([
      "aggregate:public.agg(int4)",
      "comment:function:public.f(int4,varchar)",
      "functionSettings:public.f(int4,varchar)",
      "grant:grant:function:public.f(int4,varchar):anon:execute",
    ])
  })

  it("trigger and policy identity include table", async () => {
    expect(
      await identities(
        "CREATE TRIGGER trg_x AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.h();\n" +
          "CREATE POLICY p ON storage.objects FOR SELECT USING (true);"
      )
    ).toEqual(["policy:storage.objects.p", "trigger:public.orders.trg_x"])
  })

  it("grants with different privileges are different units", async () => {
    expect(
      await identities(
        "GRANT SELECT ON public.t TO authenticated;\n" +
          "GRANT INSERT ON public.t TO authenticated;"
      )
    ).toEqual([
      "grant:grant:table:public.t:authenticated:insert",
      "grant:grant:table:public.t:authenticated:select",
    ])
  })

  it("two ALTER PUBLICATION ADD TABLE for different tables are different units", async () => {
    expect(
      await identities(
        "ALTER PUBLICATION supabase_realtime ADD TABLE t1;\n" +
          "ALTER PUBLICATION supabase_realtime ADD TABLE t2;"
      )
    ).toEqual([
      "publication:supabase_realtime:add:public.t1",
      "publication:supabase_realtime:add:public.t2",
    ])
  })

  it("user function colliding with a movement wrapper gives one diagnostic", async () => {
    const result = await compileSql(
      "CREATE FUNCTION public.sale_stock_movements(p uuid) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
      salesDocument()
    )
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.unit-duplicate",
        file: MISC,
        params: expect.objectContaining({
          identity: "function:public.sale_stock_movements(uuid)",
          line: 1,
        }),
      }),
    ])
  })

  it("user function on pg_catalog.uuid collides with a movement wrapper", async () => {
    const result = await compileSql(
      "CREATE FUNCTION public.sale_stock_movements(p pg_catalog.uuid) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
      salesDocument()
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.unit-duplicate",
        params: expect.objectContaining({
          identity: "function:public.sale_stock_movements(uuid)",
        }),
      }),
    ])
  })

  it("accepted-schema dump compiles", async () => {
    const result = await compileSql(
      [
        "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
        "CREATE SEQUENCE s;",
        "ALTER SEQUENCE s OWNED BY t.c;",
        "CREATE DOMAIN d AS text;",
        "ALTER PUBLICATION supabase_realtime ADD TABLE t;",
        "CREATE TRIGGER on_auth_user AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();",
        "CREATE POLICY p ON storage.objects FOR SELECT USING (bucket_id = 'avatars');",
      ].join("\n")
    )
    expect(result.diagnostics).toEqual([])
    expect(result.model!.sqlUnits.map((u) => u.identity)).toEqual([
      "domain:public.d",
      "extension:pgcrypto",
      "policy:storage.objects.p",
      "publication:supabase_realtime:add:public.t",
      "sequence:public.s",
      "sequenceOwnedBy:public.s",
      "trigger:auth.users.on_auth_user",
    ])
  })

  it("table, index, enum and drop are not allowed", async () => {
    const result = await compileSql(
      [
        "CREATE TABLE t (id uuid);",
        "CREATE INDEX i ON t (id);",
        "CREATE TYPE e AS ENUM ('a');",
        "DROP TABLE t;",
        "INSERT INTO t VALUES (gen_random_uuid());",
      ].join("\n")
    )
    expect(result.ok).toBe(false)
    expect(
      result.diagnostics.map((d) => [
        d.code,
        d.params?.statement,
        d.params?.line,
      ])
    ).toEqual([
      ["sql.statement-not-allowed", "CreateStmt", 1],
      ["sql.statement-not-allowed", "IndexStmt", 2],
      ["sql.statement-not-allowed", "CreateEnumStmt", 3],
      ["sql.statement-not-allowed", "DropStmt", 4],
      ["sql.statement-not-allowed", "InsertStmt", 5],
    ])
  })

  it("enable rls statement is not allowed", async () => {
    const result = await compileSql(
      "ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;"
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.statement-not-allowed",
        params: expect.objectContaining({
          statement: "AlterTableStmt",
          feature: "rowLevelSecurity",
        }),
        hint: expect.stringContaining("rowLevelSecurity"),
      }),
    ])
    expect(result.diagnostics[0]!.message).not.toContain("AT_")
    expect(result.diagnostics[0]!.message).not.toMatch(/got\s*$/)
  })

  it("same-named grants on domains in two schemas are two units", async () => {
    const sql = "CREATE DOMAIN d AS text;\nGRANT USAGE ON DOMAIN d TO anon;"
    const result = await compileSql("", {
      "sql/a/x.sql": sql,
      "sql/b/x.sql": sql,
    })
    expect(result.diagnostics).toEqual([])
    expect(result.model!.sqlUnits.map((u) => u.identity)).toEqual(
      expect.arrayContaining([
        "grant:grant:domain:a.d:anon:usage",
        "grant:grant:domain:b.d:anon:usage",
      ])
    )
  })

  it("comments on same-named domain constraints in two schemas are two units", async () => {
    const sql =
      "CREATE DOMAIN d AS text CONSTRAINT c CHECK (VALUE <> '');\n" +
      "COMMENT ON CONSTRAINT c ON DOMAIN d IS 'x';"
    const result = await compileSql("", {
      "sql/a/x.sql": sql,
      "sql/b/x.sql": sql,
    })
    expect(result.diagnostics).toEqual([])
    expect(result.model!.sqlUnits.map((u) => u.identity)).toEqual(
      expect.arrayContaining([
        "comment:domconstraint:a.d.c",
        "comment:domconstraint:b.d.c",
      ])
    )
  })

  it("create publication is not allowed and points to ALTER PUBLICATION", async () => {
    const result = await compileSql("CREATE PUBLICATION pub FOR TABLE t;")
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.statement-not-allowed",
        params: expect.objectContaining({
          statement: "CreatePublicationStmt",
          feature: "publication",
        }),
        hint: expect.stringContaining("ALTER PUBLICATION"),
      }),
    ])
  })

  it("duplicate unit", async () => {
    const result = await compileSql(
      "CREATE VIEW v AS SELECT 1;\n\n-- ще раз\nCREATE OR REPLACE VIEW public.v AS SELECT 2;"
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.unit-duplicate",
        file: MISC,
        params: expect.objectContaining({ identity: "view:public.v", line: 4 }),
      }),
    ])
  })

  it("parse error has line and column", async () => {
    // Перед помилкою на тому самому рядку — кирилиця (2 байти) і 😀 (4 байти,
    // 2 одиниці UTF-16, 1 кодова точка): `;` — 33-тя колонка в UTF-16, а не
    // 32 (кодові точки) і не 36 (байти).
    const result = await compileSql(
      "CREATE VIEW v AS SELECT 'ї';\n-- коментар 😀\nCREATE VIEW w AS SELECT 'ї😀' + ;"
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.parse",
        file: MISC,
        pointer: "",
        params: expect.objectContaining({ line: 3, column: 33 }),
      }),
    ])
  })

  it("statement start after multi-byte text keeps its text and line", async () => {
    // `stmt_location` — байти UTF-8: без перекладу в індекс UTF-16 текст і
    // рядок другого оператора зсунулися б.
    const text =
      "CREATE VIEW a AS SELECT 'ї😀';\n-- ї 😀\n/* 😀 */ CREATE VIEW b AS SELECT 'ї😀 ї';"
    const valid = await compileSql(text)
    expect(valid.diagnostics).toEqual([])
    expect(valid.model!.sqlUnits.map((u) => u.sql)).toEqual([
      "CREATE VIEW a AS SELECT 'ї😀'",
      "CREATE VIEW b AS SELECT 'ї😀 ї'",
    ])
    const duplicate = await compileSql(
      `${text}\n/* ї😀 */ CREATE OR REPLACE VIEW b AS SELECT 3;`
    )
    expect(duplicate.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.unit-duplicate",
        params: expect.objectContaining({ identity: "view:public.b", line: 4 }),
      }),
    ])
  })

  it("tree has no locations", async () => {
    const result = await compileSql(
      "CREATE VIEW v AS SELECT a.x + 1 FROM public.t a WHERE a.y = 'z';"
    )
    const [unit] = result.model!.sqlUnits
    const text = JSON.stringify(unit!.tree)
    expect(text).toContain("ViewStmt")
    expect(text).not.toContain('"location"')
    expect(text).not.toContain("stmt_location")
    expect(text).not.toContain("stmt_len")
  })

  it("formatting does not change the tree", async () => {
    const a = await compileSql("CREATE VIEW v AS SELECT 1;")
    const b = await compileSql("\n\n  create   view v as\n  select 1 ;")
    expect(a.model!.sqlUnits[0]!.tree).toEqual(b.model!.sqlUnits[0]!.tree)
  })

  it("object sql belongs to its object and leaves movement blocks out", async () => {
    const entries = salesDocument({}, { posting: undefined })
    const sale = entries["documents/Sale/Sale.meta.json"] as { id: string }
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        ...entries,
        "documents/Sale/Sale.sql":
          "CREATE FUNCTION sale_total(p uuid) RETURNS numeric LANGUAGE sql AS $$ select 0 $$;\n" +
          "-- @movements Stock\nSELECT now(), 'Expense', null::uuid, 1 ORDER BY 1\n-- @end\n",
      })
    )
    expect(result.diagnostics).toEqual([])
    const units = result.model!.sqlUnits
    expect(units.map((u) => [u.class, u.identity])).toEqual([
      ["movementQuery", "function:public.sale_stock_movements(uuid)"],
      ["function", "function:public.sale_total(uuid)"],
    ])
    expect(units[1]).toMatchObject({
      file: "documents/Sale/Sale.sql",
      ownerObjectId: sale.id,
    })
  })

  it("contract function colliding with a user function is physical.function-duplicate", async () => {
    const result = await compileSql(
      "CREATE FUNCTION public.sale_post(p uuid) RETURNS void LANGUAGE sql AS $$ select $$;",
      salesDocument()
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "physical.function-duplicate",
        file: "documents/Sale/Sale.meta.json",
        params: expect.objectContaining({ name: "sale_post" }),
      }),
    ])
  })

  it("movement query wrappers are units", async () => {
    const entries = salesDocument()
    const sale = entries["documents/Sale/Sale.meta.json"] as { id: string }
    const stock = entries[STOCK_FILE] as { id: string }
    const result = await compile(
      metaFiles({ "project.meta.json": project(), ...entries })
    )
    expect(result.diagnostics).toEqual([])
    const [unit] = result.model!.sqlUnits
    expect(unit).toMatchObject({
      class: "movementQuery",
      identity: "function:public.sale_stock_movements(uuid)",
      schema: "public",
      name: "sale_stock_movements",
      ownerObjectId: sale.id,
      documentId: sale.id,
      registerId: stock.id,
      source: "constructor",
      module: "TestApp",
    })
    expect(unit!.file).toBeUndefined()
    expect(JSON.stringify(unit!.tree)).toContain("CreateFunctionStmt")
  })

  it("compile is async", () => {
    const pending = compile(
      metaFiles({
        "project.meta.json": project(),
        "documents/D/D.meta.json": document("D"),
      })
    )
    expect(pending).toBeInstanceOf(Promise)
    return pending
  })
})
