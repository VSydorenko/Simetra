import { describe, expect, it } from "vitest"
import { compile, type Diagnostic } from "simetra/compiler"
import {
  COMMAND_SETTING,
  PLATFORM_SETTING_PREFIX,
  SESSION_CLAIMS_SETTING,
} from "simetra/model"
import {
  acceptDebt,
  customTable,
  metaFiles,
  organization,
  project,
  SCOPE_FUNCTIONS_FILE,
  salesDocument,
  scopedProject,
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
    [
      "SET search_path = '' reset by a later RESET ALL",
      "searchPath",
      "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' RESET ALL",
    ],
    [
      "SET search_path = '' overridden by a later SET in another case",
      "searchPath",
      `LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET "SEARCH_PATH" = public`,
    ],
  ])("closed shell: %s", async (_name, problem, options) => {
    const found = await diagnostics({ [SALE_SQL]: shell(options) })
    expect(found.map((d) => [d.code, d.file, d.params?.problem])).toEqual([
      ["sql.closed-shell", SALE_SQL, problem],
    ])
  })

  // Оболонку судить ранній блок, а тіло — суддя голів: функція модуля виду
  // — функція-запит (Р2c1-18).
  it("a function in the closed shell is judged as a query function", async () => {
    const heads = async (files: Record<string, string>) =>
      (await diagnostics(files)).map((d) => [d.code, d.params?.construct])
    expect(
      await heads({
        [SALE_SQL]: shell(
          "LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''",
          "BEGIN RETURN 1; END"
        ),
      })
    ).toEqual([["sql.head-not-allowed", "language"]])
    // Тіло стандарту SQL (`RETURN …`) — теж `LANGUAGE sql`.
    expect(
      await heads({
        [SALE_SQL]:
          "CREATE FUNCTION public.sale_total() RETURNS int STABLE RETURN 1;",
      })
    ).toEqual([
      ["sql.head-not-allowed", "sqlBody"],
      ["sql.head-not-allowed", "searchPath"],
    ])
    expect(
      await diagnostics({
        [SALE_SQL]: shell("LANGUAGE sql STABLE SET search_path = ''"),
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

    // Тригерна функція, яку жодна підписка не називає обробником, — теж
    // функція-запит (Р2c1-18): оболонку вона проходить, тіло — ні.
    it("passes static plpgsql to the head judge", async () => {
      expect(
        (
          await diagnostics({
            [SALE_SQL]: plpgsql("BEGIN PERFORM 1; RETURN NEW; END"),
          })
        ).map((d) => [d.code, d.params?.construct])
      ).toEqual([
        ["sql.head-not-allowed", "language"],
        ["sql.head-not-allowed", "searchPath"],
      ])
    })

    it("passes a LANGUAGE sql BEGIN ATOMIC body to the head judge", async () => {
      // Розбирач plpgsql на такому тілі падає: його не можна кликати для sql.
      expect(
        (
          await diagnostics({
            [SALE_SQL]:
              "CREATE FUNCTION public.sale_total() RETURNS int LANGUAGE sql STABLE BEGIN ATOMIC SELECT 1; END;",
          })
        ).map((d) => [d.code, d.params?.construct])
      ).toEqual([
        ["sql.head-not-allowed", "sqlBody"],
        ["sql.head-not-allowed", "searchPath"],
      ])
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
        .filter(
          (d) =>
            d.code === "sql.command-context-write" ||
            d.code === "sql.debt-session-write"
        )
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

    // Кожна одиниця спільного файлу, а не лише функції (Р2b1-22). Борг
    // фікстури прийнято (`acceptDebt`): `ALTER FUNCTION` у спільному файлі —
    // борг, і без прийняття його й так відхилив би ратчет. Борг пише
    // `simetra.*` з помилкою, решту захищених — з попередженням (Р2c1-14);
    // функція в закритій оболонці боргом не є, тож її запис — помилка.
    const REFUSED = "sql.command-context-write"
    const WARNED = "sql.debt-session-write"
    const HELPER = `CREATE FUNCTION public.helper() RETURNS int LANGUAGE sql STABLE AS $$ select 1 $$;`
    const DB_QUALIFIED = `postgres.pg_catalog.set_config('${C}', '{}', true)`
    it.each([
      [
        "ALTER FUNCTION … SET the command context",
        REFUSED,
        "functionOption",
        `${HELPER} ALTER FUNCTION public.helper() SET ${C} = '{}';`,
      ],
      [
        "ALTER FUNCTION … SET the claims",
        WARNED,
        "functionOption",
        `${HELPER} ALTER FUNCTION public.helper() SET ${CLAIMS} = '{}';`,
      ],
      [
        "an aggregate over set_config",
        WARNED,
        "nonLiteral",
        `CREATE AGGREGATE public.agg(text, boolean) (SFUNC = pg_catalog.set_config, STYPE = text, INITCOND = '${C}');`,
      ],
      [
        "a view calling set_config",
        REFUSED,
        "setConfig",
        `CREATE VIEW public.v AS SELECT set_config('${C}', '{}', true) AS x;`,
      ],
      [
        "a view over pg_settings",
        REFUSED,
        "settingsTable",
        "CREATE VIEW public.v AS SELECT name, setting FROM pg_catalog.pg_settings;",
      ],
      [
        "a domain CHECK calling set_config",
        REFUSED,
        "setConfig",
        `CREATE DOMAIN public.d AS text CHECK (set_config('${C}', VALUE, true) IS NOT NULL);`,
      ],
      [
        "RESET ALL as a body statement",
        REFUSED,
        "setStatement",
        plpgsqlBody("RESET ALL;"),
      ],
      [
        "a parameter default calling set_config",
        REFUSED,
        "setConfig",
        `CREATE FUNCTION public.helper(x text DEFAULT set_config('${C}', '{}', true)) RETURNS int LANGUAGE sql STABLE AS $$ select 1 $$;`,
      ],
      [
        "a database-qualified set_config in plpgsql",
        REFUSED,
        "setConfig",
        plpgsqlBody(`PERFORM ${DB_QUALIFIED};`),
      ],
      [
        "a database-qualified set_config in LANGUAGE sql",
        REFUSED,
        "setConfig",
        shell("LANGUAGE sql VOLATILE", `SELECT ${DB_QUALIFIED}`),
      ],
      [
        "a database-qualified set_config in a literal EXECUTE",
        REFUSED,
        "setConfig",
        plpgsqlBody(`EXECUTE 'SELECT ${DB_QUALIFIED.replaceAll("'", "''")}';`),
      ],
    ])("shared file unit: %s", async (_case, code, form, sql) => {
      expect(await sharedWrites(sql)).toEqual([[code, SHARED_SQL, form]])
    })

    it.each([
      plpgsqlBody("PERFORM setting FROM pg_settings WHERE name = 'x';"),
      "CREATE VIEW public.v AS SELECT current_setting('app.x', true) AS x;",
      "CREATE DOMAIN public.d AS text CHECK (VALUE <> '');",
      `${HELPER} ALTER FUNCTION public.helper() SET search_path = '';`,
      // `RESET ALL` опції прибирає лише власні налаштування функції (Р2b1-25).
      `${HELPER} ALTER FUNCTION public.helper() RESET ALL;`,
      // `set_config` іншої схеми — не вбудований, навіть за трьох частин.
      plpgsqlBody(`PERFORM postgres.app.set_config('${C}', '{}', true);`),
      shell(
        "LANGUAGE sql STABLE",
        "SELECT setting FROM pg_catalog.pg_settings"
      ),
      plpgsqlBody("PERFORM set_config('app.x', '1', true);"),
      // Нелітеральний `EXECUTE` — не запис сесії: його відмовляє дозвільний
      // перелік тіла (`sql.function-body-statement`, Р2c1-37).
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

    // Борговий SQL (Р2c1-6, Р2c1-14): платформний префікс і форми, що
    // зачіпають його неминуче, — помилка; решта захищених — попередження,
    // доки одиниця — борг (`debtPredicate`), однаково в модулі прийнятої
    // таблиці й у спільному `sql/`-файлі. Боргова форма фікстури — функція без
    // явної волатильності (так її віддає introspect для `VOLATILE`): у
    // закритій оболонці вона боргом не була б.
    const PLATFORM = `${PLATFORM_SETTING_PREFIX}rights_maintenance`
    const ERROR = "sql.command-context-write"
    const WARNING = "sql.debt-session-write"
    const debtBody = (statement: string) =>
      shell("LANGUAGE plpgsql", `BEGIN ${statement} RETURN 1; END`)
    const sessionWrites = (found: readonly Diagnostic[]) =>
      found
        .filter((d) => d.code === ERROR || d.code === WARNING)
        .map((d) => [d.code, d.params?.form, d.params?.setting])
    describe.each([
      ["debt module", TABLE_SQL],
      ["shared file", SHARED_SQL],
    ])("%s", (_where, file) => {
      it.each([
        [
          "set_config on the command context",
          debtBody(`PERFORM set_config('${C}', '{}', true);`),
          [ERROR, "setConfig", C],
        ],
        [
          "SET of a platform setting",
          debtBody(`SET ${PLATFORM} = 'on';`),
          [ERROR, "setStatement", PLATFORM],
        ],
        [
          "a SET function option on the command context",
          shell(`LANGUAGE sql SET ${C} = '{}'`, "select 1"),
          [ERROR, "functionOption", C],
        ],
        [
          "SET ROLE",
          debtBody("SET ROLE postgres;"),
          [WARNING, "setStatement", "role"],
        ],
        [
          "set_config with a non-literal name",
          debtBody("PERFORM set_config(v_name, 'x', true);"),
          [WARNING, "nonLiteral", undefined],
        ],
        [
          "set_config on the claims",
          debtBody(`PERFORM set_config('${CLAIMS}', '{}', true);`),
          [WARNING, "setConfig", CLAIMS],
        ],
        [
          // Перший запис — попередження, але судяться всі записи одиниці.
          "SET ROLE before set_config on the command context",
          debtBody(
            `SET ROLE postgres; PERFORM set_config('${C}', '{}', true);`
          ),
          [ERROR, "setConfig", C],
        ],
        [
          // Записи одного оператора судяться всі, а не лише перший.
          "two writes in one statement, the claims first",
          debtBody(
            `PERFORM set_config('${CLAIMS}', '{}', true), set_config('${C}', '{}', true);`
          ),
          [ERROR, "setConfig", C],
        ],
        [
          // Опція SET не ховає тіла: запис платформи в ньому — помилка.
          "a SET option on the claims with the command context in the body",
          shell(
            `LANGUAGE plpgsql SET ${CLAIMS} = '{}'`,
            `BEGIN PERFORM set_config('${C}', '{}', true); RETURN 1; END`
          ),
          [ERROR, "setConfig", C],
        ],
        [
          // Postgres імен налаштувань за регістром не розрізняє.
          "an upper-case platform prefix",
          debtBody(`PERFORM set_config('${C.toUpperCase()}', '{}', true);`),
          [ERROR, "setConfig", C.toUpperCase()],
        ],
        [
          "RESET ALL as a body statement",
          debtBody("RESET ALL;"),
          [ERROR, "setStatement", "*"],
        ],
        [
          "a write to pg_settings",
          debtBody("UPDATE pg_settings SET setting = 'x' WHERE name = 'role';"),
          [ERROR, "settingsTable", undefined],
        ],
      ])("debt: %s", async (_case, sql, expected) => {
        const found = await diagnostics({ [file]: sql })
        expect(sessionWrites(found)).toEqual([expected])
        // Помилка боргу несе маркер боргової одиниці: повідомлення й
        // підказка конверсії боргові, а не текст закритого коду.
        expect(
          found.filter((d) => d.code === ERROR).map((d) => d.params?.unit)
        ).toEqual(expected[0] === ERROR ? ["debt"] : [])
        // Попередження не зупиняє компіляцію: прийом бази з ним проходить.
        if (expected[0] === WARNING) {
          expect(found.filter((d) => d.severity === "error")).toEqual([])
        }
      })

      // Функція в закритій оболонці боргом не є ніде (`debtPredicate`), тож
      // зміна ролі в ній — помилка закритого коду, а не попередження боргу.
      it.each([
        "LANGUAGE plpgsql VOLATILE",
        "LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''",
      ])("closed shell %s: SET ROLE is an error", async (options) => {
        const found = await diagnostics({
          [file]: shell(options, "BEGIN SET ROLE postgres; RETURN 1; END"),
        })
        expect(sessionWrites(found)).toEqual([
          [ERROR, "setStatement", undefined],
        ])
        expect(found.find((d) => d.code === ERROR)?.params?.unit).toBe(
          undefined
        )
      })
    })

    // Функція, що виконує текст SQL, змінює сесію невідомою формою (Р2c1-32).
    // У тілі функції це нелітеральний `EXECUTE`: помилка переліку тіла
    // скрізь, борг включно, без другої діагностики запису сесії (Р2c1-50).
    // Боргова форма — без явної волатильності, закрита — `STABLE`. Одиниця
    // без тіла (подання) лишається записом сесії: у боргу — попередження.
    const closedShell = (body: string) => shell("LANGUAGE sql STABLE", body)
    const debtShell = (body: string) => shell("LANGUAGE sql", body)
    const bodyStatements = (found: readonly Diagnostic[]) =>
      found
        .filter((d) => d.code === "sql.function-body-statement")
        .map((d) => d.params?.statement)
    it.each([
      ["pg_catalog.query_to_xml('SELECT 1', false, false, '')"],
      ["ts_stat('SELECT 1')"],
      ["extensions.dblink_exec('c', 'SELECT 1')"],
      // Некваліфікований виклик розв'язує шлях сесії: судиться голе ім'я.
      ["dblink_exec('c', 'SELECT 1')"],
      ["cron.schedule('j', '* * * * *', 'SELECT 1')"],
    ])("a call of %s executes SQL text", async (call) => {
      for (const wrap of [closedShell, debtShell]) {
        const found = await diagnostics({
          [SHARED_SQL]: wrap(`SELECT ${call}`),
        })
        expect(sessionWrites(found)).toEqual([])
        expect(bodyStatements(found)).toEqual(["dynamicText"])
      }
      expect(
        sessionWrites(
          await diagnostics({
            [SHARED_SQL]: `CREATE VIEW public.v AS SELECT ${call} AS x;`,
          })
        )
      ).toEqual([[WARNING, "dynamicText", undefined]])
    })

    it("an ordinary builtin call writes nothing", async () => {
      expect(
        sessionWrites(
          await diagnostics({
            [SHARED_SQL]: closedShell("SELECT pg_catalog.lower('x')"),
          })
        )
      ).toEqual([])
    })

    // `replica` вимикає тригери платформи, у сесії пулу — і для чужих команд
    // (Р2c1-40): налаштування платформи, тож і в боргу помилка.
    it("SET session_replication_role in debt is an error", async () => {
      expect(
        sessionWrites(
          await diagnostics({
            [TABLE_SQL]: debtBody("SET session_replication_role = replica;"),
          })
        )
      ).toEqual([[ERROR, "setStatement", "session_replication_role"]])
    })

    it("a debt function called by closed code is a head error, its own write a warning", async () => {
      // Функція модуля виду кличе лише функції-запити (Р2c1-18): боргова
      // ланка на plpgsql — помилка голови; попередження боргу лишається на
      // самій одиниці.
      const found = await diagnostics({
        [SALE_SQL]: shell(
          "LANGUAGE sql STABLE SET search_path = ''",
          "SELECT 1 WHERE public.t_role() IS NULL"
        ),
        [TABLE_SQL]:
          "CREATE FUNCTION public.t_role() RETURNS void LANGUAGE plpgsql AS $$ BEGIN SET ROLE postgres; END $$;",
      })
      expect(
        found.map((d) => [
          d.code,
          d.file,
          d.params?.construct ?? d.params?.form,
          d.params?.chain,
        ])
      ).toEqual([
        [WARNING, TABLE_SQL, "setStatement", undefined],
        ...["language", "searchPath"].map((construct) => [
          "sql.head-not-allowed",
          SALE_SQL,
          construct,
          "public.sale_total → public.t_role",
        ]),
      ])
    })

    it("a scope set function is judged in a custom table module too", async () => {
      // Функція множини скоупу боргом не буває (спека промоції §9.4), хоч би
      // де лежав файл: у модулі прийнятої таблиці її теж судять.
      const setFunction = (body: string) =>
        `CREATE FUNCTION public.user_ids() RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$ BEGIN ${body} RETURN; END $$;`
      const forms = async (body: string) =>
        (
          await compile(
            await acceptDebt(
              metaFiles({
                "project.meta.json": scopedProject(),
                "catalogs/Organization/Organization.meta.json": organization(),
                [SCOPE_FUNCTIONS_FILE]: `CREATE FUNCTION public.org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT NULL::uuid $$;`,
                "custom-tables/T/T.meta.json": customTable("T"),
                [TABLE_SQL]: setFunction(body),
              })
            )
          )
        ).diagnostics
          .filter(
            (d) =>
              d.code === "sql.command-context-write" ||
              d.code === "sql.debt-session-write"
          )
          .map((d) => [d.code, d.file, d.params?.form])
      expect(
        await forms(`PERFORM pg_catalog.set_config('${C}', '{}', true);`)
      ).toEqual([["sql.command-context-write", TABLE_SQL, "setConfig"]])
      // Зміна ролі — помилка, а не попередження боргу: функція множини
      // виконується посеред команди й боргом не буває.
      expect(await forms("SET ROLE postgres;")).toEqual([
        ["sql.command-context-write", TABLE_SQL, "setStatement"],
      ])
      expect(
        await forms("PERFORM pg_catalog.set_config('app.x', '1', true);")
      ).toEqual([])
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
          shell("LANGUAGE sql STABLE SET search_path = ''") +
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

describe("extensions of application SQL (Р2c1-35)", () => {
  // Розширення поза схемами провайдера ставить свої функції в схему
  // застосунку: попередження боргу, бо поза боргом такої одиниці не буває.
  it.each([
    { sql: "CREATE EXTENSION pgcrypto SCHEMA extensions;", expected: [] },
    {
      sql: "CREATE EXTENSION pgcrypto;",
      expected: [
        ["sql.debt-extension-schema", "warning", { extension: "pgcrypto" }],
      ],
    },
    {
      sql: "CREATE EXTENSION pgcrypto SCHEMA public;",
      expected: [
        [
          "sql.debt-extension-schema",
          "warning",
          { extension: "pgcrypto", schema: "public" },
        ],
      ],
    },
  ])("$sql", async ({ sql, expected }) => {
    const found = await diagnostics({ "sql/public/extensions.sql": sql })
    expect(found.map((d) => [d.code, d.severity, d.params])).toEqual(expected)
  })
})
