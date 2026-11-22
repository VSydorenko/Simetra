import { describe, expect, it } from "vitest"
import {
  COMMENT_COUNTER_FILE,
  COUNT_COMMENT_SQL_FILE,
  DIMENSION_SQL,
  PROJECT_CATALOG_FILE,
  compiledPolicyDomain,
  dimensionFunction,
  teamScopeKind,
  type Layer,
} from "./fixtures/rights"
import {
  SCOPE_FUNCTIONS_FILE,
  diagnosticBrief,
  expectClean,
  uuid,
} from "./helpers"

const SHARED = "sql/public/shared.sql"
/** Спільний файл іншої схеми; тип `string` — ключ рядка таблиці кейсів. */
const OTHER_SCHEMA_SQL: string = "sql/app/s.sql"
const PROJECT_MODULE = PROJECT_CATALOG_FILE.replace(".meta.json", ".sql")
const COUNTER_MODULE = COMMENT_COUNTER_FILE.replace(".meta.json", ".sql")
/** Обробник лічильника домену політик. */
const HEAD = "public.count_comment"

const sqlFunction = (name: string, body: string) =>
  `CREATE FUNCTION ${name}() RETURNS int LANGUAGE sql STABLE AS $$ ${body} $$;\n`

/** Функція множини `team_ids`, що кличе ланку `public.helper`. */
const TEAM_IDS =
  "CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET TimeZone = 'UTC' SET DateStyle = 'ISO, MDY' SET IntervalStyle = 'postgres' SET extra_float_digits = '1' SET lc_monetary = 'C' SET lc_numeric = 'C' SET lc_time = 'C' SET bytea_output = 'hex' SET xmlbinary = 'base64' SET xmloption = 'content' SET timezone_abbreviations = 'Default' SET default_text_search_config = 'pg_catalog.simple' AS $$ SELECT public.helper() $$;\n"
const HELPER =
  "CREATE FUNCTION public.helper() RETURNS SETOF uuid LANGUAGE sql STABLE SET search_path = '' SET TimeZone = 'UTC' SET DateStyle = 'ISO, MDY' SET IntervalStyle = 'postgres' SET extra_float_digits = '1' SET lc_monetary = 'C' SET lc_numeric = 'C' SET lc_time = 'C' SET bytea_output = 'hex' SET xmlbinary = 'base64' SET xmloption = 'content' SET timezone_abbreviations = 'Default' SET default_text_search_config = 'pg_catalog.simple' AS $$ SELECT NULL::uuid $$;\n"
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

  it.each<{
    name: string
    sql: Record<string, string>
    layers: Layer[]
    expected: unknown[]
  }>([
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
    // Ланки голів (`headLinks`, спека прав §5.3) — судимі функції: окремий `ALTER`
    // підмінив би claims чи шлях ланки повз судження голови.
    {
      name: "a link of a scope set function given request claims",
      sql: {
        [SCOPE_FUNCTIONS_FILE]: TEAM_IDS,
        [SHARED]:
          HELPER +
          "ALTER FUNCTION public.helper() SET request.jwt.claims = '{}';",
      },
      layers: [teamScopeKind()],
      expected: [shell(SHARED, "public.helper", "request.jwt.claims")],
    },
    {
      name: "a link of a scope set function losing its search_path",
      sql: {
        [SCOPE_FUNCTIONS_FILE]: TEAM_IDS,
        [SHARED]: HELPER + "ALTER FUNCTION public.helper() RESET search_path;",
      },
      layers: [teamScopeKind()],
      expected: [shell(SHARED, "public.helper", "search_path")],
    },
    {
      name: "a link called from a plpgsql expression of a handler",
      sql: {
        [COUNT_COMMENT_SQL_FILE]:
          "CREATE FUNCTION public.count_comment() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN PERFORM public.helper(); RETURN NEW; END $$;",
        [SHARED]: HELPER + "ALTER FUNCTION public.helper() RESET search_path;",
      },
      layers: [],
      expected: [shell(SHARED, "public.helper", "search_path")],
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
      // Функція тієї схеми — функція моделі, тож ціль `ALTER` не відхиляється.
      alter:
        sqlFunction("other_schema.count_comment", "SELECT 1") +
        "ALTER FUNCTION other_schema.count_comment() SECURITY DEFINER;",
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
          "ALTER FUNCTION public.plain() SECURITY DEFINER;\n" +
          // Без цього definer-функцію виконувала б роль API, і її відмовила б
          // перевірка викликача (платформна спека §6.7).
          "REVOKE EXECUTE ON FUNCTION public.plain() FROM PUBLIC, authenticated, anon;",
      })
    )
  })
})

describe("sql.function-settings-shell on a declared function", () => {
  // Задекларовану функцію судить закрита оболонка в будь-якому файлі (спека
  // декларацій функцій §5.1), тож окремий `ALTER` послабив би її повз неї.
  it("rejects ALTER FUNCTION of a declared shared function", async () => {
    const result = await compiledPolicyDomain({
      [SHARED]:
        sqlFunction("public.plain", "SELECT 1") +
        "ALTER FUNCTION public.plain() SECURITY DEFINER;\n",
      [SHARED.replace(/\.sql$/, ".functions.json")]: JSON.stringify({
        functions: [
          { id: uuid(7301), function: { name: "plain" }, callers: [] },
        ],
      }),
    })
    expect(
      diagnosticBrief(result.diagnostics, ["sql.function-settings-shell"])
    ).toEqual([
      {
        code: "sql.function-settings-shell",
        file: SHARED,
        params: { function: "public.plain", setting: "security" },
      },
    ])
  })
})

describe("sql.function-settings-shell on a function the application did not create (Р10)", () => {
  // Форму згенерованої функції, функції платформи й функції провайдера тримає
  // платформа чи провайдер: `ALTER FUNCTION` на таку ціль — помилка в будь-якому
  // файлі, борг включно (спека прав §6.1).
  const notModel = (function_: string, setting: string) => ({
    code: "sql.function-settings-shell",
    file: SHARED,
    params: { function: function_, setting, target: "notModel" },
  })

  it.each([
    {
      name: "a function nobody declares",
      alter: "ALTER FUNCTION public.not_created() SECURITY DEFINER;",
      expected: [notModel("public.not_created", "security")],
    },
    {
      name: "a function of the provider",
      alter: "ALTER FUNCTION extensions.gen_random_bytes(int) RESET ALL;",
      expected: [notModel("extensions.gen_random_bytes", "*")],
    },
    {
      name: "an unqualified name nobody declares",
      alter: "ALTER FUNCTION not_created() SET search_path = '';",
      expected: [notModel("public.not_created", "search_path")],
    },
  ])("rejects ALTER FUNCTION of $name", async ({ alter, expected }) => {
    const result = await compiledPolicyDomain({ [SHARED]: alter })
    expect(
      diagnosticBrief(result.diagnostics, ["sql.function-settings-shell"])
    ).toEqual(expected)
  })

  // Функцію платформи відмовляє резервування схеми `simetra`, ще до цього
  // правила: друга діагностика була б шумом.
  it("leaves ALTER FUNCTION of a platform function to the reserved schema", async () => {
    const result = await compiledPolicyDomain({
      [SHARED]: "ALTER FUNCTION simetra.provision_user() SECURITY DEFINER;",
    })
    expect(
      diagnosticBrief(result.diagnostics, [
        "sql.function-settings-shell",
        "schema.reserved",
      ]).map((d) => d.code)
    ).toEqual(["schema.reserved"])
  })

  it("rejects ALTER FUNCTION of a generated function", async () => {
    const base = await compiledPolicyDomain({})
    const generated = base.model!.sqlUnits.find(
      (u) => u.class === "function" && u.file === undefined
    )
    expect(generated).toBeDefined()
    const name = `${generated!.schema}.${generated!.name}`
    const result = await compiledPolicyDomain({
      [SHARED]: `ALTER FUNCTION ${name}() SECURITY DEFINER;`,
    })
    expect(
      diagnosticBrief(result.diagnostics, ["sql.function-settings-shell"])
    ).toEqual([notModel(name, "security")])
  })

  it("leaves ALTER FUNCTION of a model function alone", async () => {
    expectClean(
      await compiledPolicyDomain({
        [SHARED]:
          sqlFunction("public.plain", "SELECT 1") +
          "ALTER FUNCTION public.plain() SECURITY INVOKER;\n",
      })
    )
  })
})

describe("sql.function-settings-shell: the target is judged by schema and signature (fix round 1 of #275)", () => {
  const notModel = (function_: string, setting: string) => ({
    code: "sql.function-settings-shell",
    file: SHARED,
    params: { function: function_, setting, target: "notModel" },
  })
  const fn = (name: string, args: string) =>
    `CREATE FUNCTION ${name}(${args}) RETURNS int LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n`

  it.each([
    {
      // H1а: функція провайдера з іншою сигнатурою, ніж «приманка» моделі.
      name: "a provider-schema decoy with another signature",
      sql:
        fn("extensions.dblink_exec", "n int") +
        "ALTER FUNCTION extensions.dblink_exec(text, text) SET search_path = public;",
      expected: [notModel("extensions.dblink_exec", "search_path")],
    },
    {
      name: "a provider-schema decoy with the same signature",
      sql:
        fn("extensions.dblink_exec", "n int") +
        "ALTER FUNCTION extensions.dblink_exec(int) SET search_path = public;",
      expected: [notModel("extensions.dblink_exec", "search_path")],
    },
    {
      // H1б: перевантаження, якого модель не створювала.
      name: "an overload the model did not create",
      sql:
        fn("public.f", "n int") +
        "ALTER FUNCTION public.f(text) SET search_path = '';",
      expected: [notModel("public.f", "search_path")],
    },
    {
      name: "an overload with another arity",
      sql:
        fn("public.f", "n int") +
        "ALTER FUNCTION public.f(int, int) SET search_path = '';",
      expected: [notModel("public.f", "search_path")],
    },
    {
      name: "a same-named function of another application schema",
      sql:
        fn("public.f", "n int") +
        "ALTER FUNCTION app.f(int) SET search_path = '';",
      expected: [notModel("app.f", "search_path")],
    },
    {
      // H2: некваліфіковане ім'я в DDL розв'язується за шляхом сесії.
      name: "an unqualified name of a model function",
      sql:
        fn("public.helper2", "") +
        "ALTER FUNCTION helper2() SET search_path = '';",
      expected: [notModel("public.helper2", "search_path")],
    },
  ])("rejects ALTER FUNCTION of $name", async ({ sql, expected }) => {
    const result = await compiledPolicyDomain({ [SHARED]: sql })
    expect(
      diagnosticBrief(result.diagnostics, ["sql.function-settings-shell"])
    ).toEqual(expected)
  })

  // Один нормалізатор підписів (`units.ts`): ці збіги Postgres цілить у ту
  // саму функцію моделі.
  it.each([
    { args: "n int[]", alter: "public.f(_int4)" },
    { args: "n int[][]", alter: "public.f(int[])" },
    { args: "n varchar(5)", alter: "public.f(character varying)" },
    { args: "n int, OUT o int", alter: "public.f(int4)" },
    { args: "n int, INOUT m text", alter: "public.f(int, text)" },
    { args: "VARIADIC n int[]", alter: "public.f(int[])" },
    { args: "n int DEFAULT 1", alter: "public.f(integer)" },
    { args: '"c" "char"', alter: 'public.f("char")' },
  ])(
    "leaves ALTER FUNCTION $alter on f($args) alone",
    async ({ args, alter }) => {
      expectClean(
        await compiledPolicyDomain({
          [SHARED]:
            fn("public.f", args) +
            `ALTER FUNCTION ${alter} SET search_path = '';`,
        })
      )
    }
  )

  it('rejects "char" altered as char', async () => {
    const result = await compiledPolicyDomain({
      [SHARED]:
        fn("public.f", '"c" "char"') +
        "ALTER FUNCTION public.f(char) SET search_path = '';",
    })
    expect(
      diagnosticBrief(result.diagnostics, ["sql.function-settings-shell"])
    ).toHaveLength(1)
  })

  it("leaves a model domain spelled with and without its schema alone", async () => {
    const domain = "CREATE DOMAIN public.codes AS text;\n"
    for (const [args, alter] of [
      ["n codes", "public.f(public.codes)"],
      ["n public.codes", "public.f(codes)"],
    ]) {
      expectClean(
        await compiledPolicyDomain({
          [SHARED]:
            domain +
            fn("public.f", args!) +
            `ALTER FUNCTION ${alter} SET search_path = '';`,
        })
      )
    }
  })

  it.each([
    "ALTER FUNCTION public.f(int) SET search_path = '';",
    "ALTER FUNCTION public.f(integer) SET search_path = '';",
    "ALTER FUNCTION public.f(n int) SET search_path = '';",
  ])("leaves %s on the model function alone", async (alter) => {
    expectClean(
      await compiledPolicyDomain({
        [SHARED]: fn("public.f", "n int") + alter,
      })
    )
  })
})
