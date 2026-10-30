import { describe, expect, it } from "vitest"
import { compile, type Diagnostic } from "simetra/compiler"
import { SQL_DEBT_FILE } from "simetra/model"
import { policyDomain, promotableTaskNote } from "./fixtures/rights"
import {
  acceptDebt,
  catalog,
  metaFiles,
  project,
  salesDocument,
  uuid,
} from "./helpers"

const EXTRA = "sql/public/extra.sql"
const TASK_NOTE_MODULE = "custom-tables/TaskNote/TaskNote.sql"
/** Спільний файл і модуль боргу прийнятої таблиці: правило однакове скрізь. */
const PLACES = [EXTRA, TASK_NOTE_MODULE]
const MATVIEW = "CREATE MATERIALIZED VIEW public.mv AS SELECT 1 AS x;\n"
/** Тимчасова таблиця тіла, що зникає з транзакцією. */
const TEMP = "CREATE TEMP TABLE t (a int) ON COMMIT DROP"

/** Домен політик з прийнятою `TaskNote` і SQL-файлами; `debt` — перелік боргу. */
function files(sql: Record<string, string>, debt?: string[]) {
  const result = policyDomain(promotableTaskNote())
  for (const [path, text] of Object.entries(sql)) result.set(path, text)
  if (debt !== undefined)
    result.set(SQL_DEBT_FILE, JSON.stringify({ units: debt }))
  return result
}

const brief = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.map((d) => ({ code: d.code, file: d.file, params: d.params }))

/** Функція plpgsql без волатильності — поза закритою оболонкою, тобто борг. */
const plpgsql = (body: string, shell = "") =>
  `CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql ${shell} AS $$ DECLARE r record; v text := ''; BEGIN ${body}; END $$`
const literalExecute = (stmt: string) =>
  plpgsql(`EXECUTE '${stmt.replaceAll("'", "''")}'`)
const doBlock = (stmt: string) => plpgsql(`DO $d$ BEGIN ${stmt}; END $d$`)
const atomic = (stmt: string) =>
  `CREATE FUNCTION public.f() RETURNS void LANGUAGE sql BEGIN ATOMIC ${stmt}; END`

const bodyStatement = (file: string, statement: string) => ({
  code: "sql.function-body-statement",
  file,
  params: { function: "public.f", statement, line: 1 },
})

/**
 * Оператори поза дозвільним переліком тіла (спека прав §6.1) і вузол, який називає
 * діагностика. Кожен — те, що денайліст за ціллю пропускав: зміна бази,
 * ролі чи системи, створення об'єктів під час виконання, `TRUNCATE`.
 */
const FORBIDDEN: readonly [string, string][] = [
  ["ALTER DATABASE postgres SET simetra.actor = 'x'", "AlterDatabaseSetStmt"],
  [
    "ALTER ROLE authenticator SET request.jwt.claims = '{}'",
    "AlterRoleSetStmt",
  ],
  ["ALTER SYSTEM SET work_mem = '1MB'", "AlterSystemStmt"],
  ["CREATE VIEW public.alias AS SELECT * FROM public.task", "ViewStmt"],
  ["TRUNCATE public.task_notes CASCADE", "TruncateStmt"],
  [
    "CREATE OR REPLACE FUNCTION public.g() RETURNS int LANGUAGE sql AS $g$ SELECT 1 $g$",
    "CreateFunctionStmt",
  ],
  ["ALTER FUNCTION public.g() SECURITY DEFINER", "AlterFunctionStmt"],
  ["ALTER TABLE public.task_notes ENABLE ROW LEVEL SECURITY", "AlterTableStmt"],
  [
    "CREATE POLICY p ON public.task_notes FOR SELECT USING (true)",
    "CreatePolicyStmt",
  ],
  ["ALTER DOMAIN public.d ADD CHECK (VALUE > 0)", "AlterDomainStmt"],
  [
    "CREATE EVENT TRIGGER e ON ddl_command_end EXECUTE FUNCTION public.g()",
    "CreateEventTrigStmt",
  ],
  ["ALTER EXTENSION e ADD TABLE public.task", "AlterExtensionContentsStmt"],
  ["CREATE TABLE public.x (a int)", "CreateStmt"],
  // Тимчасова таблиця, що переживає транзакцію, затіняла б у сесії пулу
  // відношення й типи некваліфікованими іменами.
  ["CREATE TEMP TABLE t (a int)", "CreateStmt"],
  [
    "CREATE TEMP TABLE t ON COMMIT PRESERVE ROWS AS SELECT 1",
    "CreateTableAsStmt",
  ],
  // Тимчасова дочірня таблиця підмішала б свої рядки в читання батька.
  [
    "CREATE TEMP TABLE t () INHERITS (public.task_notes) ON COMMIT DROP",
    "CreateStmt",
  ],
  ["DROP TABLE public.task_notes", "DropStmt"],
  ["GRANT SELECT ON public.task_notes TO anon", "GrantStmt"],
  ["COPY public.task_notes TO STDOUT", "CopyStmt"],
  ["REFRESH MATERIALIZED VIEW other.mv", "RefreshMatViewStmt"],
  // Ім'я без схеми Postgres розв'яже за шляхом сесії, а не за моделлю.
  ["REFRESH MATERIALIZED VIEW mv", "RefreshMatViewStmt"],
  // Підготовлений оператор сесії виконує текст, якого тіло не несе.
  ["PREPARE q AS SELECT 1", "PrepareStmt"],
  // Тимчасова таблиця тіла — лише `pg_temp.<ім'я>`: шлях пошуку сесії може
  // ставити `pg_temp` після схеми застосунку, і голе ім'я влучить у неї.
  [`${TEMP}; INSERT INTO t VALUES (2)`, "InsertStmt"],
  [`${TEMP}; UPDATE t SET a = 1`, "UpdateStmt"],
  [`${TEMP}; INSERT INTO pg_temp.t SELECT a FROM t`, "InsertStmt"],
  [
    `${TEMP}; CREATE TEMP TABLE u ON COMMIT DROP AS SELECT a FROM t`,
    "CreateTableAsStmt",
  ],
  [`${TEMP}; DROP TABLE t`, "DropStmt"],
]

/** Оператори, які тіло може виконувати (спека прав §6.1). */
const ALLOWED: readonly [string, string][] = [
  ["SELECT", "PERFORM 1 FROM public.task"],
  [
    "INSERT into a CustomTable",
    "INSERT INTO public.task_notes (id) VALUES (NULL)",
  ],
  ["UPDATE of a CustomTable", "UPDATE public.task_notes SET name = name"],
  ["DELETE from a CustomTable", "DELETE FROM public.task_notes WHERE false"],
  [
    "MERGE into a CustomTable",
    "MERGE INTO public.task_notes n USING (SELECT 1 AS x) s ON false WHEN NOT MATCHED THEN DO NOTHING",
  ],
  ["LOCK", "LOCK TABLE public.task_notes"],
  ["SET LOCAL", "SET LOCAL statement_timeout = '1s'"],
  ["CALL", "CALL public.p()"],
  ["NOTIFY", "NOTIFY c"],
  ["REFRESH of a model view", "REFRESH MATERIALIZED VIEW public.mv"],
  [
    "a temporary table of the body",
    "CREATE TEMP TABLE t ON COMMIT DROP AS SELECT 1; INSERT INTO pg_temp.t VALUES (2); PERFORM 1 FROM pg_temp.t; DROP TABLE pg_temp.t",
  ],
  [
    "a temporary table with columns",
    "CREATE TEMP TABLE t (a int) ON COMMIT DROP; DROP TABLE pg_temp.t",
  ],
  ["a literal EXECUTE", "EXECUTE 'SELECT 1'"],
  ["a DO block", "DO $d$ BEGIN PERFORM 1; END $d$"],
  // Виклик функції платформи, що лише читає (спека прав §5.3).
  ["the current user", "PERFORM (select simetra.current_user_id())"],
]

describe("sql.function-body-statement: the body is an allowlist (спека прав §6.1)", () => {
  it.each(
    PLACES.flatMap((file) =>
      FORBIDDEN.map(([sql, node]) => ({ file, sql, node }))
    )
  )("$sql in $file → $node", async ({ file, sql, node }) => {
    const result = await compile(
      await acceptDebt(files({ [file]: plpgsql(sql) }))
    )
    expect(brief(result.diagnostics)).toEqual([bodyStatement(file, node)])
  })

  // Тіло, яке функція виконує, — не лише її оператори: текст літерального
  // `EXECUTE`, блок `DO` і тіло стандарту SQL судяться тим самим переліком.
  it.each(
    [
      { form: "a literal EXECUTE", wrap: literalExecute },
      { form: "a DO block", wrap: doBlock },
      { form: "BEGIN ATOMIC", wrap: atomic },
    ].flatMap(({ form, wrap }) =>
      FORBIDDEN.map(([sql, node]) => ({ form, wrap, sql, node }))
    )
  )("$sql in $form → $node", async ({ wrap, sql, node }) => {
    const result = await compile(
      await acceptDebt(files({ [EXTRA]: wrap(sql) }))
    )
    expect(brief(result.diagnostics)).toEqual([bodyStatement(EXTRA, node)])
  })

  it.each(
    PLACES.flatMap((file) =>
      ALLOWED.map(([name, body]) => ({ file, name, body }))
    )
  )("$name in $file → no error", async ({ file, body }) => {
    const result = await compile(
      await acceptDebt(files({ [file]: MATVIEW + plpgsql(body) }))
    )
    expect(brief(result.diagnostics)).toEqual([])
  })

  // Текст, який статично не прочитати, переліку не проходить: один
  // `EXECUTE format(…)` відкрив би все, що перелік закрив.
  it.each(
    PLACES.flatMap((file) =>
      [
        {
          name: "EXECUTE format(…)",
          sql: plpgsql("EXECUTE format('SELECT %s', 1)"),
          statement: "nonLiteralExecute",
        },
        {
          name: "FOR … IN EXECUTE",
          sql: plpgsql("FOR r IN EXECUTE v LOOP NULL; END LOOP"),
          statement: "nonLiteralExecute",
        },
        {
          name: "a non-literal EXECUTE in a DO block",
          sql: doBlock("EXECUTE format('SELECT %s', 1)"),
          statement: "nonLiteralExecute",
        },
        {
          name: "another language",
          sql: "CREATE FUNCTION public.f() RETURNS void LANGUAGE plpython3u AS $$ pass $$",
          statement: "language",
        },
        {
          name: "a DO block of another language",
          sql: plpgsql("DO LANGUAGE plpython3u $d$ pass $d$"),
          statement: "language",
        },
        {
          // Ініціалізатор, якому порт не знайшов пари (`unreadLines`).
          name: "an unread record initializer",
          sql: "CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$ DECLARE r record; a bool := r.record = 1; BEGIN NULL; END $$",
          statement: "unread",
        },
        {
          // Вираз plpgsql читається як `SELECT`.
          name: "an unqualified temporary table read by PERFORM",
          sql: plpgsql(`${TEMP}; PERFORM 1 FROM t`),
          statement: "SelectStmt",
        },
        {
          name: "a prepared statement in a literal EXECUTE",
          sql: literalExecute("EXECUTE q"),
          statement: "ExecuteStmt",
        },
        {
          name: "an unreadable literal EXECUTE",
          sql: plpgsql("EXECUTE 'SELEC 1'"),
          statement: "unread",
        },
      ].map((row) => ({ ...row, file }))
    )
  )("$name in $file → $statement", async ({ file, sql, statement }) => {
    const result = await compile(await acceptDebt(files({ [file]: sql })))
    expect(brief(result.diagnostics)).toEqual([bodyStatement(file, statement)])
  })

  // `SET ROLE` і `SET SESSION AUTHORIZATION` — `VariableSetStmt` переліку:
  // захищені налаштування й далі судить `commandContextWrite`.
  it.each([
    ["SET ROLE postgres", "role"],
    ["SET SESSION AUTHORIZATION postgres", "session_authorization"],
  ])("%s is judged by the command context", async (sql, setting) => {
    const closed = await compile(
      await acceptDebt(files({ [EXTRA]: plpgsql(sql, "VOLATILE") }))
    )
    expect(closed.diagnostics.map((d) => d.code)).toEqual([
      "sql.command-context-write",
    ])
    const debt = await compile(
      await acceptDebt(files({ [EXTRA]: plpgsql(sql) }))
    )
    expect(debt.diagnostics.map((d) => [d.code, d.params?.setting])).toEqual([
      ["sql.debt-session-write", setting],
    ])
  })
})

// Виклик функції, що виконує текст SQL, — той самий нелітеральний `EXECUTE`
// (спека прав §6.1): перелік тіла й Правило 1 обійшов би текст, тож це помилка
// скрізь, борг включно, і функція з ним боргом не є.
describe("sql.function-body-statement: a call that executes SQL text (спека прав §5.3)", () => {
  const QUERY_TO_XML = "pg_catalog.query_to_xml('SELECT 1', false, false, '')"
  it.each(
    PLACES.flatMap((file) =>
      [
        { name: "query_to_xml", sql: plpgsql(`PERFORM ${QUERY_TO_XML}`) },
        { name: "ts_stat", sql: plpgsql("PERFORM ts_stat('SELECT 1')") },
        {
          name: "dblink_exec of the provider",
          sql: plpgsql("PERFORM extensions.dblink_exec('c', 'SELECT 1')"),
        },
        {
          name: "cron.schedule of the provider",
          sql: plpgsql("PERFORM cron.schedule('j', '* * * * *', 'SELECT 1')"),
        },
        {
          name: "a call in an assignment",
          sql: plpgsql(`v := ${QUERY_TO_XML}`),
        },
        {
          name: "a call in a DO block",
          sql: doBlock(`PERFORM ${QUERY_TO_XML}`),
        },
        {
          name: "a call in BEGIN ATOMIC",
          sql: atomic(`SELECT ${QUERY_TO_XML}`),
        },
        {
          // Значення параметра за замовчуванням обчислює виклик функції.
          name: "a call in a parameter default",
          sql: `CREATE FUNCTION public.f(a xml DEFAULT ${QUERY_TO_XML}) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$`,
        },
      ].map((row) => ({ ...row, file }))
    )
  )("$name in $file → dynamicText", async ({ file, sql }) => {
    const result = await compile(await acceptDebt(files({ [file]: sql })))
    expect(brief(result.diagnostics)).toEqual([
      bodyStatement(file, "dynamicText"),
    ])
  })

  it.each(PLACES)("an ordinary builtin call in %s → no error", async (file) => {
    const result = await compile(
      await acceptDebt(
        files({ [file]: plpgsql("PERFORM pg_catalog.lower('x')") })
      )
    )
    expect(brief(result.diagnostics)).toEqual([])
  })
})

describe("a body outside the allowlist is never debt", () => {
  const alterDatabase = plpgsql(
    "ALTER DATABASE postgres SET simetra.actor = 'x'"
  )

  it("an unlisted function gives only its own error", async () => {
    const result = await compile(files({ [EXTRA]: alterDatabase }))
    expect(brief(result.diagnostics)).toEqual([
      bodyStatement(EXTRA, "AlterDatabaseSetStmt"),
    ])
  })

  it("a listed function is an error and a stale entry", async () => {
    const result = await compile(
      files({ [EXTRA]: alterDatabase }, ["function:public.f()"])
    )
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "sql.debt-stale",
      "sql.function-body-statement",
    ])
  })

  it("a listed function writing the provider's identity table is a kind-table error", async () => {
    // Тригери платформи переносять запис у `auth.users` в «Користувачі» й
    // ідентичності (спека прав §6.1): для Правила 1 це таблиця виду.
    const result = await compile(
      files(
        { [EXTRA]: plpgsql("UPDATE auth.users SET email = NULL WHERE false") },
        ["function:public.f()"]
      )
    )
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "sql.debt-stale",
      "sql.kind-table-verbatim",
    ])
  })
})

describe("sql.platform-function-call: only the reading platform functions (спека прав §5.3)", () => {
  it.each(
    PLACES.flatMap((file) => [
      {
        name: "provisioning in a body",
        file,
        sql: plpgsql("PERFORM simetra.provision_user(NULL, NULL, NULL, NULL)"),
        unit: "function:public.f()",
        fn: "simetra.provision_user",
      },
      {
        name: "provisioning in an assignment",
        file,
        sql: plpgsql("v := simetra.provision_user(NULL, NULL, NULL, NULL)"),
        unit: "function:public.f()",
        fn: "simetra.provision_user",
      },
      {
        name: "provisioning in an sql body",
        file,
        sql: "CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ SELECT simetra.provision_user(NULL, NULL, NULL, NULL) $$",
        unit: "function:public.f()",
        fn: "simetra.provision_user",
      },
      {
        name: "another platform function in a view",
        file,
        sql: "CREATE VIEW public.v AS SELECT simetra.other_function() AS x",
        unit: "view:public.v",
        fn: "simetra.other_function",
      },
    ])
  )("$name in $file → error", async ({ file, sql, unit, fn }) => {
    const result = await compile(await acceptDebt(files({ [file]: sql })))
    expect(brief(result.diagnostics)).toEqual([
      {
        code: "sql.platform-function-call",
        file,
        params: { unit, function: fn, line: 1 },
      },
    ])
  })
})

describe("RETURN expr is judged as the SELECT of the same body", () => {
  // Тіло стандарту SQL `RETURN expr` — лише вираз: виклики, відношення й
  // вкладені оператори судяться тими самими правилами, що й `SELECT expr`.
  const select = (expr: string) =>
    `CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT ${expr} $$`
  const returns = (expr: string) =>
    `CREATE FUNCTION public.f() RETURNS int LANGUAGE sql RETURN ${expr}`

  it.each([
    {
      name: "a platform function call",
      expr: "(SELECT simetra.provision_user(NULL, NULL, NULL, NULL))",
      codes: ["sql.platform-function-call"],
    },
    {
      name: "a data-modifying CTE into a kind table",
      expr: "(WITH d AS (DELETE FROM public.task RETURNING 1) SELECT 1)",
      codes: ["sql.kind-table-verbatim"],
    },
    {
      name: "a platform setting write",
      expr: "length(pg_catalog.set_config('simetra.actor', 'x', false))",
      codes: ["sql.command-context-write"],
    },
    { name: "a constant", expr: "1", codes: [] },
  ])("$name → $codes", async ({ expr, codes }) => {
    const judged = async (sql: string) =>
      brief(
        (await compile(await acceptDebt(files({ [EXTRA]: sql })))).diagnostics
      )
    const asSelect = await judged(select(expr))
    expect(asSelect.map((d) => d.code)).toEqual(codes)
    expect(await judged(returns(expr))).toEqual(asSelect)
  })
})

describe("sql.platform-function-call: generated functions that write (спека прав §5.3)", () => {
  // Документ з проведенням дає оболонку проведення, довідник із
  // предвизначеними — функцію пошуку, що лише читає.
  const generated = (call: string) =>
    metaFiles({
      "project.meta.json": project(),
      ...salesDocument(),
      "catalogs/Warehouse/Warehouse.meta.json": catalog("Warehouse", {
        id: uuid(7120),
        predefinedItems: [
          { id: uuid(7121), name: "Main", physicalName: "main" },
        ],
      }),
      [EXTRA]: `CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ SELECT ${call} $$`,
    })

  it.each([
    {
      call: "public.sale_post(NULL)",
      expected: [
        {
          code: "sql.platform-function-call",
          file: EXTRA,
          params: {
            unit: "function:public.f()",
            function: "public.sale_post",
            line: 1,
          },
        },
      ],
    },
    { call: "public.warehouse_predefined('main')", expected: [] },
  ])("$call", async ({ call, expected }) => {
    const result = await compile(await acceptDebt(generated(call)))
    expect(
      brief(result.diagnostics.filter((d) => d.severity === "error"))
    ).toEqual(expected)
  })
})

/** Функція plpgsql у закритій оболонці (боргом не є) з тілом `body`. */
const closedFn = (body: string, name = "public.f", shell = "VOLATILE") =>
  `CREATE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql ${shell} AS $$ DECLARE n int; BEGIN ${body}; END $$`
/** Функція `LANGUAGE sql` без волатильності — поза оболонкою, тобто борг. */
const sqlFn = (body: string) =>
  `CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ ${body} $$`
const TASK_MODULE = "documents/Task/Task.sql"
const OTHER_SCHEMA = "sql/app/extra.sql"

describe("sql.function-body-statement: forms the target denylist judged before (спека прав §6.1)", () => {
  // Колишні рядки `sql.kind-table-verbatim` з формою `functionBody` поза DML:
  // перелік операторів відмовляє їм незалежно від цілі, тож і на
  // `CustomTable` — теж.
  it.each([
    {
      name: "CREATE POLICY in a plpgsql body",
      sql: closedFn(
        "CREATE POLICY p ON public.task FOR SELECT TO authenticated USING (true)"
      ),
      statement: "CreatePolicyStmt",
    },
    {
      name: "ALTER TABLE … DISABLE ROW LEVEL SECURITY in an sql body",
      sql: sqlFn("ALTER TABLE public.task DISABLE ROW LEVEL SECURITY"),
      statement: "AlterTableStmt",
    },
    {
      name: "TRUNCATE of a tabular section table",
      sql: closedFn("TRUNCATE public.task_checklist"),
      statement: "TruncateStmt",
    },
    {
      name: "GRANT",
      sql: closedFn("GRANT INSERT ON public.task TO authenticated"),
      statement: "GrantStmt",
    },
    {
      name: "in a kind module",
      file: TASK_MODULE,
      sql: closedFn(
        "ALTER TABLE public.task DISABLE TRIGGER ALL",
        "public.task_reopen"
      ),
      fn: "public.task_reopen",
      statement: "AlterTableStmt",
    },
    {
      name: "in the debt module of an adopted table",
      file: TASK_NOTE_MODULE,
      sql: sqlFn("DROP POLICY task_read ON public.task_hours"),
      statement: "DropStmt",
    },
    {
      name: "VOLATILE SECURITY DEFINER SET search_path = '' creating a policy",
      sql: closedFn(
        "CREATE POLICY p ON public.task FOR SELECT TO authenticated USING (true)",
        "public.f",
        "VOLATILE SECURITY DEFINER SET search_path = ''"
      ),
      statement: "CreatePolicyStmt",
    },
    {
      name: "procedure",
      sql: "CREATE PROCEDURE public.f() LANGUAGE sql AS $$ CREATE INDEX ON public.task (id) $$",
      statement: "IndexStmt",
    },
    {
      name: "COMMENT ON TABLE",
      sql: closedFn("COMMENT ON TABLE public.org_roles IS 'x'"),
      statement: "CommentStmt",
    },
    {
      name: "SECURITY LABEL ON TABLE",
      sql: closedFn("SECURITY LABEL FOR anon ON TABLE public.task IS 'x'"),
      statement: "SecLabelStmt",
    },
    {
      name: "unqualified table in a function of another schema",
      file: OTHER_SCHEMA,
      sql: closedFn("CREATE POLICY p ON task FOR SELECT USING (true)", "app.f"),
      fn: "app.f",
      statement: "CreatePolicyStmt",
    },
    {
      name: "a child table of a kind table",
      sql: closedFn("CREATE TABLE public.task_extra () INHERITS (public.task)"),
      statement: "CreateStmt",
    },
    {
      name: "GRANT … ON ALL TABLES IN SCHEMA",
      sql: closedFn(
        "GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO authenticated"
      ),
      statement: "GrantStmt",
    },
    {
      name: "DROP SCHEMA",
      sql: closedFn("DROP SCHEMA public CASCADE"),
      statement: "DropStmt",
    },
    {
      name: "ALTER SCHEMA … RENAME",
      sql: closedFn("ALTER SCHEMA public RENAME TO old_public"),
      statement: "RenameStmt",
    },
    {
      name: "ALTER SCHEMA … OWNER",
      sql: closedFn("ALTER SCHEMA public OWNER TO authenticated"),
      statement: "AlterOwnerStmt",
    },
    {
      name: "a DO block in a body",
      sql: closedFn("DO $d$ BEGIN TRUNCATE public.task; END $d$"),
      statement: "TruncateStmt",
    },
    {
      name: "a function defined in a body",
      sql: closedFn(
        "CREATE FUNCTION pg_temp.g() RETURNS void LANGUAGE sql AS $g$ TRUNCATE public.task $g$; PERFORM pg_temp.g()"
      ),
      statement: "CreateFunctionStmt",
    },
    {
      name: "a policy on a CustomTable",
      sql: closedFn(
        "CREATE POLICY p ON public.task_notes FOR SELECT TO authenticated USING (true)"
      ),
      statement: "CreatePolicyStmt",
    },
    {
      name: "TRUNCATE of a CustomTable",
      sql: closedFn("TRUNCATE public.task_notes"),
      statement: "TruncateStmt",
    },
    {
      name: "a policy on a CustomTable reading a kind table",
      sql: closedFn(
        "CREATE POLICY p ON public.task_notes FOR SELECT USING (EXISTS (SELECT 1 FROM public.task))"
      ),
      statement: "CreatePolicyStmt",
    },
    {
      name: "a temporary table copied from a kind table",
      sql: closedFn("CREATE TEMP TABLE snapshot AS SELECT * FROM public.task"),
      statement: "CreateTableAsStmt",
    },
  ])(
    "$name → $statement",
    async ({ file = EXTRA, sql, fn = "public.f", statement }) => {
      const result = await compile(files({ [file]: sql }))
      expect(brief(result.diagnostics)).toEqual([
        {
          code: "sql.function-body-statement",
          file,
          params: { function: fn, statement, line: 1 },
        },
      ])
    }
  )

  it("a temporary table copied from a kind table and dropped at commit → no error", async () => {
    const result = await compile(
      files({
        [EXTRA]: closedFn(
          "CREATE TEMP TABLE snapshot ON COMMIT DROP AS SELECT * FROM public.task"
        ),
      })
    )
    expect(brief(result.diagnostics)).toEqual([])
  })
})
