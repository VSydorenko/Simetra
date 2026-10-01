import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
import {
  STOCK_FILE,
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
    ).toEqual([
      "function:public.g(pg_catalog.int4)",
      "procedure:public.p(text[])",
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
