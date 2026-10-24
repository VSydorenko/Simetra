import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { COMMAND_SETTING, SESSION_CLAIMS_SETTING } from "simetra/model"
import {
  acceptDebt,
  customTable,
  metaFiles,
  project,
  salesDocument,
  withoutAccess,
  withoutMechanics,
} from "./helpers"

const SALE_SQL = "documents/Sale/Sale.sql"
const TABLE_SQL = "custom-tables/T/T.sql"

/**
 * Документ `Sale` (з регістром `Stock`) і прийнята таблиця `T` плюс `.sql`.
 * Предмет — класи одиниць модулів, а не ратчет (він — у `sql-debt.test.ts`),
 * тож увесь борг фікстури прийнято.
 */
async function diagnostics(files: Record<string, string>) {
  const result = await compile(
    await acceptDebt(
      metaFiles({
        "project.meta.json": project(),
        ...salesDocument(),
        "custom-tables/T/T.meta.json": customTable("T"),
        ...files,
      })
    )
  )
  return result.diagnostics
}

const shell = (options: string, body = "select 1") =>
  `CREATE FUNCTION public.sale_total() RETURNS int ${options} AS $$ ${body} $$;`

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
          "LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''",
          "BEGIN RETURN 1; END"
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

  describe("plpgsql body", () => {
    const plpgsql = (body: string) =>
      `CREATE FUNCTION public.sale_touch() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ ${body} $$;`
    const problems = async (files: Record<string, string>) =>
      (await diagnostics(files)).map((d) => [d.code, d.params?.problem])

    it("refuses dynamic SQL in a kind module", async () => {
      expect(
        await problems({
          [SALE_SQL]: plpgsql("BEGIN EXECUTE 'select 1'; RETURN NEW; END"),
        })
      ).toEqual([["sql.closed-shell", "dynamicSql"]])
    })

    it("names the file line of the first dynamic statement", async () => {
      // Рядок рахується від `$$` функції, а функція стоїть не з першого рядка файлу.
      const found = await diagnostics({
        [SALE_SQL]: [
          "-- коментар",
          "CREATE FUNCTION public.sale_touch()",
          "RETURNS trigger LANGUAGE plpgsql VOLATILE AS $body$",
          "BEGIN",
          "  PERFORM 1;",
          "  EXECUTE 'select 1';",
          "  EXECUTE 'select 2';",
          "  RETURN NEW;",
          "END",
          "$body$;",
        ].join("\n"),
      })
      expect(
        found.map((d) => [d.code, d.params?.problem, d.params?.line])
      ).toEqual([["sql.closed-shell", "dynamicSql", 6]])
    })

    it("falls back to the statement line for a quoted body with doubled quotes", async () => {
      // `''` у тексті оператора не збігається з розібраним тілом, тож зсув тіла
      // невідомий і лічба йде від рядка початку оператора (рядок 2), а не від
      // рядка з відкривною лапкою (3): звіт на один рядок раніший за істинний
      // (6), але завжди в межах функції.
      const found = await diagnostics({
        [SALE_SQL]: [
          "-- коментар",
          "CREATE FUNCTION public.sale_touch()",
          "RETURNS trigger LANGUAGE plpgsql VOLATILE AS '",
          "BEGIN",
          "  PERFORM ''x'';",
          "  EXECUTE ''select 1'';",
          "  RETURN NEW;",
          "END",
          "';",
        ].join("\n"),
      })
      expect(
        found.map((d) => [d.code, d.params?.problem, d.params?.line])
      ).toEqual([["sql.closed-shell", "dynamicSql", 5]])
    })

    it("refuses a plpgsql body that does not parse", async () => {
      expect(
        await problems({
          [SALE_SQL]: plpgsql("BEGIN SELEKT 1; RETURN NEW; END"),
        })
      ).toEqual([["sql.closed-shell", "body"]])
    })

    it("accepts static plpgsql", async () => {
      expect(
        await diagnostics({
          [SALE_SQL]: plpgsql("BEGIN PERFORM 1; RETURN NEW; END"),
        })
      ).toEqual([])
    })

    it("accepts a LANGUAGE sql BEGIN ATOMIC body", async () => {
      // Розбирач plpgsql на такому тілі падає: його не можна кликати для sql.
      expect(
        await diagnostics({
          [SALE_SQL]:
            "CREATE FUNCTION public.sale_total() RETURNS int LANGUAGE sql STABLE BEGIN ATOMIC SELECT 1; END;",
        })
      ).toEqual([])
    })

    it("keeps the order: shell problems come before the body", async () => {
      expect(
        await problems({
          [SALE_SQL]:
            "CREATE FUNCTION public.sale_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'select 1'; RETURN NEW; END $$;",
        })
      ).toEqual([["sql.closed-shell", "volatility"]])
    })
  })

  describe("application SQL leaves the command context alone", () => {
    // Імена налаштувань — лише через сталу: літерала поза T0 немає.
    const C = COMMAND_SETTING
    const MIXED = C.replace(/\b\w/g, (c) => c.toUpperCase())
    const plpgsqlBody = (statement: string) =>
      shell("LANGUAGE plpgsql VOLATILE", `BEGIN ${statement} RETURN 1; END`)
    const writes = async (sql: string) =>
      (await diagnostics({ [SALE_SQL]: sql }))
        .filter((d) => d.code === "sql.command-context-write")
        .map((d) => [d.code, d.file, d.params?.form])

    it.each([
      ["setConfig", plpgsqlBody(`PERFORM set_config('${C}', '{}', true);`)],
      [
        "setConfig",
        plpgsqlBody(`PERFORM pg_catalog.set_config('${MIXED}', '{}', true);`),
      ],
      ["nonLiteral", plpgsqlBody(`PERFORM set_config(v_name, '{}', true);`)],
      ["setStatement", plpgsqlBody(`SET LOCAL ${C} = '{}';`)],
      ["setStatement", plpgsqlBody(`RESET ${C};`)],
      ["setStatement", plpgsqlBody("RESET ALL;")],
      [
        "functionOption",
        shell(`LANGUAGE sql STABLE SET ${C} = '{}'`, "select 1"),
      ],
      [
        "setConfig",
        shell("LANGUAGE sql VOLATILE", `SELECT set_config('${C}', '{}', true)`),
      ],
      [
        "setConfig",
        `CREATE FUNCTION public.sale_total() RETURNS text LANGUAGE sql VOLATILE BEGIN ATOMIC SELECT set_config('${C}', '{}', true); END;`,
      ],
    ])("%s is refused", async (form, sql) => {
      expect(await writes(sql)).toEqual([
        ["sql.command-context-write", SALE_SQL, form],
      ])
    })

    // Claims запиту й роль захищені нарівні з контекстом (Р2b1-19b): claims
    // визначають користувача в політиках запису, а зміна ролі виходить з ролі
    // команд. Стара форма claims — `request.jwt.claim.<ключ>`.
    const CLAIMS = SESSION_CLAIMS_SETTING
    const LEGACY_CLAIM = `${CLAIMS.replace(/s$/, "")}.sub`
    it.each([
      [
        "claims via set_config",
        "setConfig",
        plpgsqlBody(`PERFORM set_config('${CLAIMS}', '{}', true);`),
      ],
      [
        "claims via SET LOCAL",
        "setStatement",
        plpgsqlBody(`SET LOCAL ${CLAIMS} = '{}';`),
      ],
      [
        "a legacy claim",
        "setConfig",
        plpgsqlBody(`PERFORM set_config('${LEGACY_CLAIM}', 'x', true);`),
      ],
      ["SET ROLE", "setStatement", plpgsqlBody("SET ROLE postgres;")],
      ["RESET ROLE", "setStatement", plpgsqlBody("RESET ROLE;")],
      [
        "SET SESSION AUTHORIZATION",
        "setStatement",
        plpgsqlBody("SET SESSION AUTHORIZATION postgres;"),
      ],
      [
        "RESET SESSION AUTHORIZATION",
        "setStatement",
        plpgsqlBody("RESET SESSION AUTHORIZATION;"),
      ],
      [
        "set_config on the role",
        "setConfig",
        plpgsqlBody("PERFORM set_config('role', 'postgres', true);"),
      ],
      [
        "set_config on the session authorization",
        "setConfig",
        plpgsqlBody(
          "PERFORM set_config('session_authorization', 'postgres', true);"
        ),
      ],
      [
        "a SET role function option",
        "functionOption",
        shell("LANGUAGE sql STABLE SET role = postgres", "select 1"),
      ],
    ])("%s is refused", async (_case, form, sql) => {
      expect(await writes(sql)).toEqual([
        ["sql.command-context-write", SALE_SQL, form],
      ])
    })

    it("reading the claims passes", async () => {
      expect(
        await writes(plpgsqlBody(`PERFORM current_setting('${CLAIMS}', true);`))
      ).toEqual([])
    })

    // Допоміжна функція спільного `sql/`-файлу (не обробник, не модуль виду):
    // її може викликати функція закритого модуля чи обробник (Р2b1-19a).
    const SHARED_SQL = "sql/public/helpers.sql"
    const sharedWrites = async (sql: string) =>
      (await diagnostics({ [SHARED_SQL]: sql }))
        .filter((d) => d.code === "sql.command-context-write")
        .map((d) => [d.code, d.file, d.params?.form])

    it.each([
      ["setConfig", plpgsqlBody(`PERFORM set_config('${C}', '{}', true);`)],
      [
        "settingsTable",
        plpgsqlBody("UPDATE pg_settings SET setting = '1' WHERE name = 'x';"),
      ],
      [
        "settingsTable",
        plpgsqlBody(
          "UPDATE pg_catalog.pg_settings SET setting = '1' WHERE name = 'x';"
        ),
      ],
      [
        "settingsTable",
        plpgsqlBody(`UPDATE "pg_catalog"."pg_settings" SET setting = '1';`),
      ],
      [
        "settingsTable",
        plpgsqlBody("INSERT INTO pg_settings (name) VALUES ('x');"),
      ],
      ["settingsTable", plpgsqlBody("DELETE FROM pg_catalog.pg_settings;")],
      [
        "settingsTable",
        shell("LANGUAGE sql VOLATILE", "UPDATE pg_settings SET setting = '1'"),
      ],
      ["setStatement", plpgsqlBody(`EXECUTE 'SET ${C} = ''{}''';`)],
      [
        "settingsTable",
        plpgsqlBody("EXECUTE 'UPDATE pg_settings SET setting = ''1''';"),
      ],
    ])("shared file function: %s is refused", async (form, sql) => {
      expect(await sharedWrites(sql)).toEqual([
        ["sql.command-context-write", SHARED_SQL, form],
      ])
    })

    it.each([
      plpgsqlBody("PERFORM setting FROM pg_settings WHERE name = 'x';"),
      shell(
        "LANGUAGE sql STABLE",
        "SELECT setting FROM pg_catalog.pg_settings"
      ),
      plpgsqlBody("PERFORM set_config('app.x', '1', true);"),
      // Нелітеральний `EXECUTE` — відоме обмеження до 2c, не помилка (Р2b1-19a).
      plpgsqlBody("EXECUTE v_sql;"),
      plpgsqlBody("EXECUTE format('delete from app.%I', v_table);"),
      plpgsqlBody("EXECUTE 'select 1';"),
    ])("shared file function: harmless SQL passes: %s", async (sql) => {
      expect(await sharedWrites(sql)).toEqual([])
    })

    it("a kind module function is refused for the new forms too", async () => {
      expect(await writes(plpgsqlBody("DELETE FROM pg_settings;"))).toEqual([
        ["sql.command-context-write", SALE_SQL, "settingsTable"],
      ])
    })

    it("a custom table module (debt) is outside the check", async () => {
      const found = await diagnostics({
        [TABLE_SQL]: plpgsqlBody(`PERFORM set_config('${C}', '{}', true);`),
      })
      expect(found.map((d) => d.code)).not.toContain(
        "sql.command-context-write"
      )
    })

    it.each([
      plpgsqlBody("PERFORM set_config('app.x', '1', true);"),
      plpgsqlBody("SET LOCAL statement_timeout = '1s';"),
      plpgsqlBody(`PERFORM current_setting('${C}', true);`),
    ])("an unrelated setting passes: %s", async (sql) => {
      expect(await writes(sql)).toEqual([])
    })
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
    // Гранти таблиць виду (генератор `access`) звіряє access-units.test.ts.
    expect(
      withoutMechanics(withoutAccess(result.model!.sqlUnits)).map(
        (u) => u.class
      )
    ).toEqual(["movementQuery", "function"])
  })
})
