import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { customTable, metaFiles, project, salesDocument } from "./helpers"

const SALE_SQL = "documents/Sale/Sale.sql"
const TABLE_SQL = "custom-tables/T/T.sql"

/** Документ `Sale` (з регістром `Stock`) і прийнята таблиця `T` плюс `.sql`. */
async function diagnostics(files: Record<string, string>) {
  const result = await compile(
    metaFiles({
      "project.meta.json": project(),
      ...salesDocument(),
      "custom-tables/T/T.meta.json": customTable("T"),
      ...files,
    })
  )
  return result.diagnostics
}

const shell = (options: string) =>
  `CREATE FUNCTION public.sale_total() RETURNS int ${options} AS $$ select 1 $$;`

describe("kind module: closed forms only", () => {
  it.each([
    [
      "CREATE TRIGGER t BEFORE INSERT ON public.sale FOR EACH ROW EXECUTE FUNCTION public.f();",
      "trigger",
    ],
    ["CREATE POLICY p ON public.sale USING (true);", "policy"],
    ["COMMENT ON TABLE public.sale IS 'x';", "comment"],
    ["CREATE VIEW public.v AS SELECT 1;", "view"],
  ])("kind module rejects %s", async (sql, cls) => {
    const found = await diagnostics({ [SALE_SQL]: sql })
    expect(found.map((d) => [d.code, d.file, d.params?.line])).toEqual([
      ["sql.statement-not-allowed", SALE_SQL, 1],
    ])
    expect(found[0]!.params).toMatchObject({ detail: "kindModule", class: cls })
  })

  it("custom table module keeps verbatim classes (debt)", async () => {
    const found = await diagnostics({
      [TABLE_SQL]:
        "CREATE FUNCTION public.f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\n" +
        "CREATE TRIGGER t BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.f();",
    })
    expect(found).toEqual([])
  })

  it.each([
    ["LANGUAGE c", "language", "LANGUAGE c VOLATILE"],
    ["no volatility", "volatility", "LANGUAGE sql"],
    [
      "SECURITY DEFINER without SET search_path = ''",
      "searchPath",
      "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public",
    ],
  ])("closed shell: %s", async (_name, problem, options) => {
    const found = await diagnostics({ [SALE_SQL]: shell(options) })
    expect(found.map((d) => [d.code, d.file, d.params?.problem])).toEqual([
      ["sql.closed-shell", SALE_SQL, problem],
    ])
  })

  it("a function in the closed shell passes", async () => {
    expect(
      await diagnostics({
        [SALE_SQL]: shell(
          "LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''"
        ),
      })
    ).toEqual([])
    // Тіло стандарту SQL (`RETURN …`) — теж `LANGUAGE sql`.
    expect(
      await diagnostics({
        [SALE_SQL]:
          "CREATE FUNCTION public.sale_total() RETURNS int STABLE RETURN 1;",
      })
    ).toEqual([])
  })

  it("overload in a kind module is an error, in a custom table module is not", async () => {
    const pair = (table: string) =>
      `CREATE FUNCTION public.${table}_f(a int) RETURNS int LANGUAGE sql STABLE AS $$ select a $$;\n` +
      `CREATE FUNCTION public.${table}_f(a text) RETURNS int LANGUAGE sql STABLE AS $$ select 1 $$;`
    const found = await diagnostics({ [SALE_SQL]: pair("sale") })
    expect(found.map((d) => [d.code, d.file, d.params?.line])).toEqual([
      ["sql.function-overload", SALE_SQL, 1],
      ["sql.function-overload", SALE_SQL, 2],
    ])
    expect(await diagnostics({ [TABLE_SQL]: pair("t") })).toEqual([])
  })

  it("a shared file overloading a kind module function is an overload of the module", async () => {
    const found = await diagnostics({
      [SALE_SQL]:
        "CREATE FUNCTION public.g(a int) RETURNS int LANGUAGE sql STABLE AS $$ select a $$;",
      "sql/public/g.sql":
        "CREATE FUNCTION public.g(a text) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
    })
    expect(found.map((d) => [d.code, d.file])).toEqual([
      ["sql.function-overload", SALE_SQL],
    ])
  })

  it("procedure in a kind module is not allowed", async () => {
    const found = await diagnostics({
      [SALE_SQL]: "CREATE PROCEDURE public.p() LANGUAGE sql AS $$ select 1 $$;",
    })
    expect(found.map((d) => [d.code, d.params?.class])).toEqual([
      ["sql.statement-not-allowed", "procedure"],
    ])
  })

  it("movement query blocks of a document module stay valid", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        ...salesDocument({}, { posting: undefined }),
        [SALE_SQL]:
          shell("LANGUAGE sql STABLE") +
          "\n-- @movements Stock\nSELECT now(), 'Expense', null::uuid, 1 ORDER BY 1\n-- @end\n",
      })
    )
    expect(result.diagnostics).toEqual([])
    expect(result.model!.sqlUnits.map((u) => u.class)).toEqual([
      "movementQuery",
      "function",
    ])
  })
})
