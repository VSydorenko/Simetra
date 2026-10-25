import { describe, expect, it } from "vitest"
import {
  COMMENT_COUNTER_FILE,
  PROJECT_CATALOG_FILE,
  PROJECT_FILE,
  REGION_DIMENSION_ID,
  compiledPolicyDomain,
  teamScopeKind,
  type Layer,
} from "./fixtures/rights"
import { diagnosticBrief, expectClean } from "./helpers"

const SHARED = "sql/public/shared.sql"
/** Спільний файл іншої схеми; тип `string` — ключ рядка таблиці кейсів. */
const OTHER_SCHEMA_SQL: string = "sql/app/s.sql"
const PROJECT_MODULE = PROJECT_CATALOG_FILE.replace(".meta.json", ".sql")
const COUNTER_MODULE = COMMENT_COUNTER_FILE.replace(".meta.json", ".sql")
/** Обробник лічильника домену політик. */
const HEAD = "public.count_comment"

const sqlFunction = (name: string, body: string) =>
  `CREATE FUNCTION ${name}() RETURNS int LANGUAGE sql STABLE AS $$ ${body} $$;\n`

/** Вимір `region` зі значеннями з функції `region_ids` і її ланкою. */
const dimensionFunction = (): Layer => ({
  [PROJECT_FILE]: {
    accessDimensions: [
      {
        id: REGION_DIMENSION_ID,
        name: "region",
        target: { kind: "Catalog", name: "Region" },
        values: { function: { name: "region_ids" } },
      },
    ],
  },
})
const DIMENSION_SQL =
  "CREATE FUNCTION public.region_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT public.region_link() $$;\n" +
  "CREATE FUNCTION public.region_link() RETURNS SETOF uuid LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT NULL::uuid $$;\n"
const PROJECT_FUNCTION =
  "CREATE FUNCTION public.project_label() RETURNS int LANGUAGE sql STABLE SECURITY INVOKER AS $$ SELECT 1 $$;\n"

describe("sql.function-settings-shell", () => {
  const codes = [
    "sql.function-settings-shell",
    "sql.statement-not-allowed",
    "sql.debt-grows",
  ]
  const shell = (file: string, fn: string, setting: string) => ({
    code: "sql.function-settings-shell",
    file,
    params: { function: fn, setting },
  })

  it.each([
    {
      name: "a closed module function made SECURITY DEFINER",
      sql: {
        [PROJECT_MODULE]: PROJECT_FUNCTION,
        [SHARED]: "ALTER FUNCTION public.project_label() SECURITY DEFINER;",
      },
      layers: [],
      expected: [shell(SHARED, "public.project_label", "security")],
    },
    {
      name: "a scope set function losing its search_path",
      sql: { [SHARED]: "ALTER FUNCTION public.team_ids() RESET search_path;" },
      layers: [teamScopeKind()],
      expected: [shell(SHARED, "public.team_ids", "search_path")],
    },
    {
      name: "a handler losing every option",
      sql: { [SHARED]: "ALTER FUNCTION public.count_comment() RESET ALL;" },
      layers: [],
      expected: [shell(SHARED, HEAD, "*")],
    },
    {
      name: "ALTER without arguments of a handler",
      sql: { [SHARED]: "ALTER FUNCTION public.count_comment RESET ALL;" },
      layers: [],
      expected: [shell(SHARED, HEAD, "*")],
    },
    {
      name: "a dimension values function made IMMUTABLE",
      sql: {
        [SHARED]:
          DIMENSION_SQL + "ALTER FUNCTION public.region_ids() IMMUTABLE;",
      },
      layers: [dimensionFunction()],
      expected: [shell(SHARED, "public.region_ids", "volatility")],
    },
    {
      name: "a link of a dimension chain losing its search_path",
      sql: {
        [SHARED]:
          DIMENSION_SQL +
          "ALTER FUNCTION public.region_link() RESET search_path;",
      },
      layers: [dimensionFunction()],
      expected: [shell(SHARED, "public.region_link", "search_path")],
    },
    {
      name: "ALTER inside a closed module",
      sql: {
        [PROJECT_MODULE]:
          PROJECT_FUNCTION +
          "ALTER FUNCTION public.project_label() SECURITY DEFINER;",
      },
      layers: [],
      expected: [
        shell(PROJECT_MODULE, "public.project_label", "security"),
        {
          code: "sql.statement-not-allowed",
          file: PROJECT_MODULE,
          params: {
            statement: "AlterFunctionStmt",
            line: 2,
            detail: "kindModule",
            class: "functionSettings",
          },
        },
      ],
    },
    {
      // Сигнатуру `ALTER` компілятор зводить не так, як Postgres (`%TYPE`
      // він не розгортає), тож ціль — за ім'ям.
      name: "an ALTER that spells the argument type differently",
      sql: {
        [PROJECT_MODULE]:
          "CREATE FUNCTION public.project_label(x public.project.id%TYPE) RETURNS int LANGUAGE sql STABLE SECURITY INVOKER AS $$ SELECT 1 $$;\n",
        [SHARED]: "ALTER FUNCTION public.project_label(uuid) SECURITY DEFINER;",
      },
      layers: [],
      expected: [shell(SHARED, "public.project_label", "security")],
    },
    {
      // Некваліфіковане ім'я рендер розв'язує за шляхом сесії, а не за
      // схемою файлу.
      name: "an unqualified ALTER in a file of another schema",
      sql: { [OTHER_SCHEMA_SQL]: "ALTER FUNCTION count_comment() RESET ALL;" },
      layers: [],
      expected: [shell(OTHER_SCHEMA_SQL, "app.count_comment", "*")],
    },
    {
      name: "claims set on a handler from a debt module",
      sql: {
        [COUNTER_MODULE]:
          "ALTER FUNCTION public.count_comment() SET request.jwt.claims = '{}';",
      },
      layers: [],
      expected: [shell(COUNTER_MODULE, HEAD, "request.jwt.claims")],
    },
  ])("rejects $name", async ({ sql, layers, expected }) => {
    const result = await compiledPolicyDomain(sql, layers)
    expect(diagnosticBrief(result.diagnostics, codes)).toEqual(expected)
  })

  // Ціль `ALTER` — за `схема.ім'я`: однойменна функція іншої схеми не
  // зачіпає судиму, а функція своєї схеми — зачіпає.
  it.each([
    {
      name: "a same-named function of another schema",
      alter: "ALTER FUNCTION other_schema.count_comment() SECURITY DEFINER;",
      expected: [],
    },
    {
      name: "the judged function in its own schema",
      alter: "ALTER FUNCTION public.count_comment() SECURITY DEFINER;",
      expected: [shell(SHARED, HEAD, "security")],
    },
  ])("targets $name", async ({ alter, expected }) => {
    const result = await compiledPolicyDomain({ [SHARED]: alter })
    expect(diagnosticBrief(result.diagnostics, codes)).toEqual(expected)
  })

  it("leaves ALTER FUNCTION of an ordinary shared function to the debt", async () => {
    expectClean(
      await compiledPolicyDomain({
        [SHARED]:
          sqlFunction("public.plain", "SELECT 1") +
          "ALTER FUNCTION public.plain() SECURITY DEFINER;",
      })
    )
  })
})
