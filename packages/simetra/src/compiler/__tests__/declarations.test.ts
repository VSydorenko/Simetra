import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { readFiles } from "../pipeline"
import type { SqlFunctionDeclaration } from "simetra/model"
import { checkDeclarations, declaredFunctions } from "../sql/declarations"
import type { VerbatimUnit } from "../sql/units"
import {
  COUNT_COMMENT_SQL_FILE,
  DIMENSION_SQL,
  compiledPolicyDomain,
  dimensionFunction,
  teamScopeKind,
} from "./fixtures/rights"
import { SCOPE_FUNCTIONS_FILE, metaFiles, project, uuid } from "./helpers"

const SQL = "sql/public/fns.sql"
const FUNCTIONS = "sql/public/fns.functions.json"
const OTHER_SQL = "sql/public/other.sql"
const OTHER_FUNCTIONS = "sql/public/other.functions.json"

const CODES = [
  "sql.declaration-target-missing",
  "sql.declaration-overload",
  "sql.declaration-duplicate",
  "sql.declaration-platform-form",
]

/** Функція в закритій оболонці: ні боргу, ні інших діагностик. */
const fn = (name: string, args = "") =>
  `CREATE FUNCTION ${name}(${args}) RETURNS int LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n`

let nextId = 7000
const declaration = (
  fn: { schema?: string; name: string },
  callers: SqlFunctionDeclaration["callers"] = ["user"]
): SqlFunctionDeclaration => ({ id: uuid(++nextId), function: fn, callers })

const functionsFile = (...entries: SqlFunctionDeclaration[]) =>
  JSON.stringify({ functions: entries })

async function declarationDiagnostics(files: Map<string, string>) {
  const { diagnostics } = await compile(files)
  return diagnostics
    .filter((d) => CODES.includes(d.code))
    .map((d) => [d.code, d.file, d.pointer, d.params])
}

const shared = (entries: Record<string, string>) =>
  declarationDiagnostics(
    metaFiles({ "project.meta.json": project(), ...entries })
  )

const keyParams = (schema: string, name: string) => ({
  schema,
  name,
  function: `${schema}.${name}`,
})

describe("declaration resolution", () => {
  it("a declaration of a function of the sibling .sql compiles clean", async () => {
    const files = metaFiles({
      "project.meta.json": project(),
      [SQL]: fn("public.f"),
      [FUNCTIONS]: functionsFile(declaration({ name: "f" })),
    })
    expect((await compile(files)).diagnostics).toEqual([])
  })

  it("a function missing from the sibling .sql is target-missing on the entry", async () => {
    expect(
      await shared({
        [SQL]: fn("public.f"),
        [OTHER_SQL]: fn("public.g"),
        // `g` є, але в іншому файлі: декларація описує лише сусідній `.sql`.
        [FUNCTIONS]: functionsFile(declaration({ name: "g" })),
      })
    ).toEqual([
      [
        "sql.declaration-target-missing",
        FUNCTIONS,
        "/functions/0",
        { ...keyParams("public", "g"), sqlFile: SQL },
      ],
    ])
  })

  it("an overloaded function is declaration-overload", async () => {
    expect(
      await shared({
        [SQL]: fn("public.f", "a int") + fn("public.f", "a text"),
        [FUNCTIONS]: functionsFile(declaration({ name: "f" })),
      })
    ).toEqual([
      [
        "sql.declaration-overload",
        FUNCTIONS,
        "/functions/0",
        { ...keyParams("public", "f"), count: 2 },
      ],
    ])
  })

  it("an overload in another file of the same pg_proc name is declaration-overload", async () => {
    expect(
      await shared({
        [SQL]: fn("public.f"),
        [OTHER_SQL]: fn("public.f", "a int"),
        [FUNCTIONS]: functionsFile(declaration({ name: "f" })),
      })
    ).toEqual([
      [
        "sql.declaration-overload",
        FUNCTIONS,
        "/functions/0",
        { ...keyParams("public", "f"), count: 2 },
      ],
    ])
  })

  it("two entries of one file are duplicates after defaultSchema", async () => {
    // Записано різне (`{ name }` і `{ schema, name }`), тож схема T0 їх
    // приймає; функція та сама.
    expect(
      await shared({
        [SQL]: fn("public.f"),
        [FUNCTIONS]: functionsFile(
          declaration({ name: "f" }),
          declaration({ schema: "public", name: "f" })
        ),
      })
    ).toEqual([
      [
        "sql.declaration-duplicate",
        FUNCTIONS,
        "/functions/1",
        { ...keyParams("public", "f"), first: `${FUNCTIONS}/functions/0` },
      ],
    ])
  })

  it("an entry of another file declaring the same function is a duplicate", async () => {
    expect(
      await shared({
        [SQL]: fn("public.f"),
        [OTHER_SQL]: fn("public.g"),
        [FUNCTIONS]: functionsFile(declaration({ name: "f" })),
        [OTHER_FUNCTIONS]: functionsFile(
          declaration({ schema: "public", name: "f" })
        ),
      })
    ).toEqual([
      [
        "sql.declaration-duplicate",
        OTHER_FUNCTIONS,
        "/functions/0",
        { ...keyParams("public", "f"), first: `${FUNCTIONS}/functions/0` },
      ],
      [
        "sql.declaration-target-missing",
        OTHER_FUNCTIONS,
        "/functions/0",
        { ...keyParams("public", "f"), sqlFile: OTHER_SQL },
      ],
    ])
  })

  it("an entry of a .sql that does not parse is not judged target-missing", async () => {
    const found = await shared({
      [SQL]: "CREATE FUNCTION broken(",
      [FUNCTIONS]: functionsFile(declaration({ name: "f" })),
    })
    expect(found).toEqual([])
  })
})

describe("declaration key: a (schema, name) pair", () => {
  // Ідентифікатори в лапках з крапкою: `"a.b".c` і `a."b.c"` зклеюються в
  // той самий рядок `a.b.c`, тож одиниці тут — пряма фікстура, а не `.sql`
  // (ідентичність одиниць їх теж зклеїла б).
  const units = [
    unit("a.b", "c", SQL),
    unit("a", "b.c", SQL),
  ] satisfies VerbatimUnit[]
  const stage1 = readFiles(
    metaFiles({ "project.meta.json": project(), [SQL]: "" })
  )

  it("each declaration resolves to its own function", () => {
    const declared = declaredFunctions(
      [
        {
          file: FUNCTIONS,
          sqlFile: SQL,
          functions: [
            declaration({ schema: "a", name: "b.c" }),
            declaration({ schema: "a.b", name: "c" }),
          ],
        },
      ],
      units,
      "public"
    )
    expect(
      declared.map((d) => [d.pointer, d.key, d.unit.schema, d.unit.name])
    ).toEqual([
      ["/functions/0", { schema: "a", name: "b.c" }, "a", "b.c"],
      ["/functions/1", { schema: "a.b", name: "c" }, "a.b", "c"],
    ])
  })

  it.each([
    {
      name: "in one file",
      files: [
        {
          file: FUNCTIONS,
          sqlFile: SQL,
          functions: [
            declaration({ schema: "a", name: "b.c" }),
            declaration({ schema: "a.b", name: "c" }),
          ],
        },
      ],
    },
    {
      name: "in two files",
      files: [
        {
          file: FUNCTIONS,
          sqlFile: SQL,
          functions: [declaration({ schema: "a", name: "b.c" })],
        },
        {
          file: OTHER_FUNCTIONS,
          sqlFile: SQL,
          functions: [declaration({ schema: "a.b", name: "c" })],
        },
      ],
    },
  ])("are no duplicates or overloads $name", ({ files }) => {
    expect(
      checkDeclarations(files, units, stage1.objects, stage1.project, new Set())
    ).toEqual([])
  })
})

describe("declaredFunctions", () => {
  // Нерезолвлена декларація не має давати функції ні виключення з боргу, ні
  // (далі) `EXECUTE`: декларація описує лише функцію сусіднього `.sql`.
  it("does not resolve a function of another .sql file", () => {
    expect(
      declaredFunctions(
        [
          {
            file: FUNCTIONS,
            sqlFile: SQL,
            functions: [declaration({ name: "g" })],
          },
        ],
        [unit("public", "g", OTHER_SQL)],
        "public"
      )
    ).toEqual([])
  })
})

function unit(schema: string, name: string, file: string): VerbatimUnit {
  return {
    class: "function",
    identity: `function:${schema}.${name}()`,
    schema,
    name,
    file,
    line: 1,
    sql: "",
    tree: {},
  }
}

describe("sql.declaration-platform-form", () => {
  const sidecar = (sql: string) => sql.replace(/\.sql$/, ".functions.json")
  const platformForm = async (
    sql: Record<string, string>,
    layers: Parameters<typeof compiledPolicyDomain>[1]
  ) =>
    (await compiledPolicyDomain(sql, layers)).diagnostics
      .filter((d) => CODES.includes(d.code))
      .map((d) => [d.code, d.file, d.pointer, d.params])

  it.each<{
    form: string
    name: string
    file: string
    sql: Record<string, string>
    layers: Parameters<typeof compiledPolicyDomain>[1]
  }>([
    {
      form: "setFunction",
      name: "team_ids",
      file: SCOPE_FUNCTIONS_FILE,
      sql: {
        [SCOPE_FUNCTIONS_FILE]:
          "CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT NULL::uuid $$;\n",
      },
      layers: [teamScopeKind()],
    },
    {
      form: "subscriptionHandler",
      name: "count_comment",
      file: COUNT_COMMENT_SQL_FILE,
      sql: {},
      layers: [],
    },
    {
      form: "dimension",
      name: "region_ids",
      file: "sql/public/region.sql",
      sql: { "sql/public/region.sql": DIMENSION_SQL },
      layers: [dimensionFunction()],
    },
  ])("a declaration of a $form", async ({ form, name, file, sql, layers }) => {
    expect(
      await platformForm(
        {
          ...sql,
          [sidecar(file)]: functionsFile(declaration({ name }, [])),
        },
        layers
      )
    ).toEqual([
      [
        "sql.declaration-platform-form",
        sidecar(file),
        "/functions/0",
        { ...keyParams("public", name), form },
      ],
    ])
  })
})
