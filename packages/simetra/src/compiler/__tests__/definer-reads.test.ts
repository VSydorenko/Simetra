import { describe, expect, it } from "vitest"
import { compile, type Diagnostic } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  type SqlFunctionCaller,
} from "simetra/model"
import {
  CHECKLIST_TABLE,
  COMMENT_COUNTER_FILE,
  PROJECT_CATALOG_FILE,
  PROJECT_FILE,
  REGION_DIMENSION_ID,
  policyDomain,
  teamScopeKind,
  type Layer,
} from "./fixtures/rights"
import { SCOPE_FUNCTIONS_FILE, acceptDebt, uuid } from "./helpers"

const RPC_FILE = "sql/public/rpc.sql"
const PROJECT_MODULE = PROJECT_CATALOG_FILE.replace(".meta.json", ".sql")
const RPC = "public.rpc"
const TASK = "public.task"
const API = PROVIDER_API_ROLES.supabase
/** Отримувачі, що мають привілей без жодного явного гранту чи відкликання. */
const EVERYONE = `PUBLIC, ${API.user}, ${API.anonymous}`
const COMMAND = PLATFORM_ROLES.command
/** Те саме для `EXECUTE`: роль команд має його через `PUBLIC` (Р14). */
const EVERY_CALLER = `${EVERYONE}, ${COMMAND}`
/** Типова RPC «читання повз RLS» — у закритій оболонці, тож не борг. */
const CLOSED = "SECURITY DEFINER SET search_path = ''"

const sqlFunction = (name: string, body: string, options = CLOSED) =>
  `CREATE FUNCTION ${name}() RETURNS bigint LANGUAGE sql STABLE ${options} AS $$ ${body} $$;\n`
const plpgsqlFunction = (body: string) =>
  `CREATE FUNCTION ${RPC}() RETURNS bigint LANGUAGE plpgsql STABLE ${CLOSED} AS $$ DECLARE v bigint; BEGIN ${body} RETURN v; END $$;\n`
const countTask = (options = CLOSED) =>
  sqlFunction(RPC, `SELECT count(*) FROM ${TASK}`, options)
/** Оператор гранту на кожного отримувача. */
const grants = (statement: string, recipients: readonly string[]) =>
  recipients.map((role) => `${statement} ${role};\n`).join("")
const revokeExecute = (...recipients: string[]) =>
  grants(`REVOKE EXECUTE ON FUNCTION ${RPC}() FROM`, recipients)
const ALL = ["PUBLIC", API.user, API.anonymous]

/** Подання над задачами з опціями `options`. */
const view = (name: string, options = "", from = TASK) =>
  `CREATE VIEW ${name}${options} AS SELECT id FROM ${from};\n`
const INVOKER = " WITH (security_invoker = true)"

/** Вимір `region`, значення якого дає функція `region_ids`. */
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

const warned = (
  object: string,
  params: Record<string, string | number> = {},
  file = RPC_FILE
) => ({
  code: "sql.definer-reads-rls",
  file,
  params: {
    object,
    form: "function",
    tables: TASK,
    roles: EVERYONE,
    line: 1,
    ...params,
  },
})

const refused = (
  fn: string,
  roles = EVERY_CALLER,
  file = RPC_FILE,
  line = 1
) => ({
  code: "sql.definer-caller-unchecked",
  file,
  params: {
    schema: fn.slice(0, fn.indexOf(".")),
    name: fn.slice(fn.indexOf(".") + 1),
    function: fn,
    roles,
    line,
  },
})

/** Обидва коди: помилка й попередження не дублюють одне одного. */
const CODES = ["sql.definer-caller-unchecked", "sql.definer-reads-rls"]

const brief = (diagnostics: readonly Diagnostic[], codes: readonly string[]) =>
  diagnostics
    .filter((d) => codes.includes(d.code))
    .map((d) => ({ code: d.code, file: d.file, params: d.params }))

/** Компіляція домену політик із прийнятим боргом: предмет — не ратчет. */
async function compiled(sql: Record<string, string>, layers: Layer[] = []) {
  const files = policyDomain(...layers)
  for (const [path, text] of Object.entries(sql)) files.set(path, text)
  return compile(await acceptDebt(files))
}

// Перевірку викликача називає декларація сигнатури (платформна спека §6.7),
// якої ще немає: definer-функція, яку може виконати роль API, — помилка в
// будь-якій одиниці SQL застосунку, борг включно, незалежно від того, що вона
// читає; попередження Р30 її не дублює.
describe("checkDefinerReads: SECURITY DEFINER functions", () => {
  it.each([
    {
      name: "a closed-shell function granted to the user role",
      sql: {
        [RPC_FILE]:
          countTask() +
          grants(`GRANT EXECUTE ON FUNCTION ${RPC}() TO`, [API.user]),
      },
      expected: [refused(RPC)],
    },
    {
      // Postgres дає EXECUTE PUBLIC, провайдер — ролям API.
      name: "a function without any grant",
      sql: { [RPC_FILE]: countTask() },
      expected: [refused(RPC)],
    },
    {
      name: "a debt function outside the closed shell",
      sql: { [RPC_FILE]: countTask("SECURITY DEFINER") },
      expected: [refused(RPC)],
    },
    {
      // Типові привілеї провайдера лишаються.
      name: "EXECUTE revoked from PUBLIC only",
      sql: { [RPC_FILE]: countTask() + revokeExecute("PUBLIC") },
      expected: [refused(RPC, `${API.user}, ${API.anonymous}`)],
    },
    {
      name: "EXECUTE revoked from PUBLIC and each API role",
      sql: { [RPC_FILE]: countTask() + revokeExecute(...ALL) },
      expected: [],
    },
    {
      // Роль API лишає EXECUTE через PUBLIC.
      name: "EXECUTE revoked from each API role but not from PUBLIC",
      sql: {
        [RPC_FILE]: countTask() + revokeExecute(API.user, API.anonymous),
      },
      expected: [refused(RPC)],
    },
    {
      name: "REVOKE ALL without arguments from every recipient at once",
      sql: {
        [RPC_FILE]:
          countTask() +
          `REVOKE ALL ON FUNCTION ${RPC} FROM ${ALL.join(", ")};\n`,
      },
      expected: [],
    },
    {
      name: "EXECUTE revoked from all and granted back to anon",
      sql: {
        [RPC_FILE]:
          countTask() +
          revokeExecute(...ALL) +
          grants(`GRANT EXECUTE ON FUNCTION ${RPC}() TO`, [API.anonymous]),
      },
      expected: [refused(RPC, API.anonymous)],
    },
    {
      // Грант PUBLIC повертає EXECUTE кожній ролі API (платформна спека §6.7).
      name: "EXECUTE revoked from all and granted back to PUBLIC",
      sql: {
        [RPC_FILE]:
          countTask() +
          revokeExecute(...ALL) +
          grants(`GRANT EXECUTE ON FUNCTION ${RPC}() TO`, ["PUBLIC"]),
      },
      expected: [refused(RPC)],
    },
    {
      // Відкликає лише право передавати привілей, не сам привілей.
      name: "REVOKE GRANT OPTION FOR",
      sql: {
        [RPC_FILE]:
          countTask() +
          grants(
            `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION ${RPC}() FROM`,
            ALL
          ),
      },
      expected: [refused(RPC)],
    },
    {
      name: "SECURITY DEFINER set by a separate ALTER FUNCTION",
      sql: {
        [RPC_FILE]:
          countTask("SECURITY INVOKER") +
          `ALTER FUNCTION ${RPC}() SECURITY DEFINER;\n`,
      },
      expected: [refused(RPC)],
    },
    {
      name: "a SECURITY INVOKER function",
      sql: { [RPC_FILE]: countTask("SECURITY INVOKER") },
      expected: [],
    },
    {
      name: "an adopted table with row-level security off",
      sql: {
        [RPC_FILE]: sqlFunction(
          RPC,
          "SELECT count(*) FROM public.comment_counter"
        ),
      },
      expected: [refused(RPC)],
    },
    {
      // Без власного search_path ім'я розв'язується за шляхом сесії.
      name: "an unqualified table name",
      sql: {
        [RPC_FILE]: sqlFunction(
          RPC,
          "SELECT count(*) FROM task",
          "SECURITY DEFINER"
        ),
      },
      expected: [refused(RPC)],
    },
    {
      // Помилка не залежить від того, що функція читає.
      name: "an unqualified table name under an empty search_path",
      sql: { [RPC_FILE]: sqlFunction(RPC, "SELECT count(*) FROM task") },
      expected: [refused(RPC)],
    },
    {
      name: "a plpgsql SELECT INTO from a tabular section",
      sql: {
        [RPC_FILE]: plpgsqlFunction(
          `SELECT count(*) INTO v FROM public.${CHECKLIST_TABLE};`
        ),
      },
      expected: [refused(RPC)],
    },
    {
      // Помічник виконується від власника зовнішньої функції.
      name: "a SECURITY INVOKER helper reading the table",
      sql: {
        [RPC_FILE]:
          sqlFunction(RPC, "SELECT public.helper()") +
          sqlFunction(
            "public.helper",
            `SELECT count(*) FROM ${TASK}`,
            "SECURITY INVOKER"
          ),
      },
      expected: [refused(RPC)],
    },
    {
      // Модуль виду не приймає дослівних грантів, а `EXECUTE` недекларованої
      // функції модуля платформа виводить з порожніми призначеннями (Р11):
      // ролі API її не виконують, тож перевірки викликача вона не потребує.
      name: "an undeclared function of a closed module",
      sql: { [PROJECT_MODULE]: countTask() },
      expected: [],
    },
  ])("$name", async ({ sql, expected }) => {
    const result = await compiled(sql)
    expect(brief(result.diagnostics, CODES)).toEqual(expected)
  })

  // Роль команд діє від імені користувача (Р14), але типових привілеїв не
  // має: `EXECUTE` вона дістає лише через `PUBLIC` чи явний грант.
  it("refuses an undeclared function granted to the command role", async () => {
    const result = await compiled({
      [RPC_FILE]:
        countTask() +
        revokeExecute(...ALL) +
        grants(`GRANT EXECUTE ON FUNCTION ${RPC}() TO`, [COMMAND]),
    })
    expect(brief(result.diagnostics, CODES)).toEqual([refused(RPC, COMMAND)])
  })

  // `CALL` з функції, яку кличе роль API, досягає definer-процедури; складову
  // агрегату Postgres виконує з правами власника агрегату, тож агрегат, даний
  // ролі API, виконує definer-складову від власника, хоч саму її відкликано.
  it("refuses a SECURITY DEFINER procedure an API role can execute", async () => {
    const result = await compiled({
      [RPC_FILE]: `CREATE PROCEDURE public.p() LANGUAGE plpgsql ${CLOSED} AS $$ BEGIN PERFORM 1; END $$;\n`,
    })
    expect(brief(result.diagnostics, CODES)).toEqual([refused("public.p")])
  })

  it("refuses an aggregate an API role can execute over a SECURITY DEFINER state function", async () => {
    const result = await compiled({
      [RPC_FILE]:
        `CREATE FUNCTION public.sf(a int, b int) RETURNS int LANGUAGE sql IMMUTABLE ${CLOSED} AS $$ SELECT a + b $$;\n` +
        `REVOKE EXECUTE ON FUNCTION public.sf(int, int) FROM ${ALL.join(", ")};\n` +
        "CREATE AGGREGATE public.agg2(int) (sfunc = public.sf, stype = int);\n",
    })
    expect(brief(result.diagnostics, CODES)).toEqual([
      refused("public.agg2", EVERY_CALLER, RPC_FILE, 3),
    ])
  })

  // Виняток функції множини — за ідентичністю (схема, ім'я, аргументи), а не
  // за ім'ям: перевантаження з аргументами й однойменна функція іншої схеми
  // — звичайні definer-функції.
  it.each([
    {
      name: "a definer overload of the set function",
      file: SCOPE_FUNCTIONS_FILE,
      sql: `CREATE FUNCTION public.team_ids(a uuid) RETURNS SETOF uuid LANGUAGE sql STABLE ${CLOSED} AS $$ SELECT a $$;\n`,
      fn: "public.team_ids",
    },
    {
      name: "a same-named definer function of another schema",
      file: "sql/app/rpc.sql",
      sql: `CREATE FUNCTION app.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE ${CLOSED} AS $$ SELECT NULL::uuid $$;\n`,
      fn: "app.team_ids",
    },
  ])("refuses $name", async ({ file, sql, fn }) => {
    const set = `CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE ${CLOSED} AS $$ SELECT id FROM ${TASK} $$;\n`
    const sources =
      file === SCOPE_FUNCTIONS_FILE
        ? { [SCOPE_FUNCTIONS_FILE]: set + sql }
        : { [SCOPE_FUNCTIONS_FILE]: set, [file]: sql }
    const result = await compiled(sources, [teamScopeKind()])
    const line = file === SCOPE_FUNCTIONS_FILE ? 2 : 1
    expect(brief(result.diagnostics, CODES)).toEqual([
      refused(fn, EVERY_CALLER, file, line),
    ])
  })

  // Функції, яких не кличуть як RPC: функції множини й виміру кличе політика
  // від імені запиту, тригерну функцію — лише тригер.
  it.each<{ name: string; sql: Record<string, string>; layers: Layer[] }>([
    {
      name: "a scope set function",
      sql: {
        [SCOPE_FUNCTIONS_FILE]: `CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE ${CLOSED} AS $$ SELECT id FROM ${TASK} $$;\n`,
      },
      layers: [teamScopeKind()],
    },
    {
      name: "a dimension values function",
      sql: {
        [RPC_FILE]: `CREATE FUNCTION public.region_ids() RETURNS SETOF uuid LANGUAGE sql STABLE ${CLOSED} AS $$ SELECT id FROM ${TASK} $$;\n`,
      },
      layers: [dimensionFunction()],
    },
    {
      name: "a trigger function",
      sql: {
        [RPC_FILE]: `CREATE FUNCTION public.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE ${CLOSED} AS $$ BEGIN PERFORM 1 FROM ${TASK}; RETURN NEW; END $$;\n`,
      },
      layers: [],
    },
  ])("skips $name", async ({ sql, layers }) => {
    const result = await compiled(sql, layers)
    expect(brief(result.diagnostics, CODES)).toEqual([])
  })

  it("names an adopted table once its row-level security is on", async () => {
    const result = await compiled(
      { [RPC_FILE]: view("public.v", "", "public.comment_counter") },
      [{ [COMMENT_COUNTER_FILE]: { rowLevelSecurity: "enabled" } }]
    )
    expect(brief(result.diagnostics, CODES)).toEqual([
      warned("public.v", { form: "view", tables: "public.comment_counter" }),
    ])
  })
})

describe("checkDefinerReads: views", () => {
  const V = "public.v"
  const viewWarned = (params: Record<string, string | number> = {}) =>
    warned(V, { form: "view", ...params })

  it.each([
    {
      name: "a view with security_invoker",
      sql: view(V, INVOKER),
      expected: [],
    },
    {
      name: "a view with security_invoker = on",
      sql: view(V, " WITH (security_invoker = on)"),
      expected: [],
    },
    {
      name: "a view without security_invoker",
      sql: view(V),
      expected: [viewWarned()],
    },
    {
      name: "a view with security_invoker = false",
      sql: view(V, " WITH (security_invoker = false)"),
      expected: [viewWarned()],
    },
    {
      name: "a view with SELECT revoked from PUBLIC and each API role",
      sql: view(V) + grants(`REVOKE SELECT ON ${V} FROM`, ALL),
      expected: [],
    },
    {
      name: "a view with SELECT revoked and granted back to the user role",
      sql:
        view(V) +
        grants(`REVOKE ALL ON TABLE ${V} FROM`, ALL) +
        grants(`GRANT SELECT (id) ON ${V} TO`, [API.user]),
      expected: [viewWarned({ roles: API.user })],
    },
    {
      // Відкликання на колонку не прибирає SELECT на подання цілком.
      name: "a view with SELECT revoked on a column only",
      sql: view(V) + grants(`REVOKE SELECT (id) ON ${V} FROM`, ALL),
      expected: [viewWarned()],
    },
    {
      // Внутрішнє подання читає від імені власника зовнішнього.
      name: "a view over an invoker view of an RLS table",
      sql: view("public.inner_v", INVOKER) + view(V, "", "public.inner_v"),
      expected: [viewWarned({ line: 2 })],
    },
    {
      // RLS не діє ні під час читання, ні від імені читача: рядки зберіг
      // власник під час REFRESH.
      name: "a materialized view",
      sql: `CREATE MATERIALIZED VIEW ${V} AS SELECT id FROM ${TASK};\n`,
      expected: [viewWarned({ form: "materializedView" })],
    },
    {
      // Postgres такої опції матеріалізованому поданню не приймає; компілятор
      // її не перевіряє, тож і не довіряє їй.
      name: "a materialized view with a security_invoker option",
      sql: `CREATE MATERIALIZED VIEW ${V}${INVOKER} AS SELECT id FROM ${TASK};\n`,
      expected: [viewWarned({ form: "materializedView" })],
    },
    {
      name: "a materialized view with SELECT revoked from every recipient",
      sql:
        `CREATE MATERIALIZED VIEW ${V} AS SELECT id FROM ${TASK};\n` +
        grants(`REVOKE SELECT ON ${V} FROM`, ALL),
      expected: [],
    },
  ])("$name", async ({ sql, expected }) => {
    const result = await compiled({ [RPC_FILE]: sql })
    expect(brief(result.diagnostics, ["sql.definer-reads-rls"])).toEqual(
      expected
    )
  })

  // Опцію подання задає лише CREATE VIEW: окремий ALTER VIEW у .sql не
  // приймається зовсім, тож RESET після CREATE … WITH не послабить її мовчки.
  it.each(["SET (security_invoker = true)", "RESET (security_invoker)"])(
    "rejects ALTER VIEW … %s",
    async (action) => {
      const result = await compiled({
        [RPC_FILE]: view(V, INVOKER) + `ALTER VIEW ${V} ${action};\n`,
      })
      expect(
        brief(result.diagnostics, [
          "sql.statement-not-allowed",
          "sql.definer-reads-rls",
        ])
      ).toEqual([
        {
          code: "sql.statement-not-allowed",
          file: RPC_FILE,
          params: {
            statement: "AlterTableStmt",
            line: 2,
            detail: "only REPLICA IDENTITY is allowed",
          },
        },
      ])
    }
  )
})

// Задекларована функція (спека декларацій функцій §5.1): її ACL виводить
// платформа з викликачів, тож `sql.definer-caller-unchecked` її не судить, а
// попередження Р30 бере ролі з викликачів, а не з дослівних грантів.
describe("checkDefinerReads: declared functions", () => {
  const RPC_FUNCTIONS = RPC_FILE.replace(/\.sql$/, ".functions.json")
  const declare = (callers: SqlFunctionCaller[], name = "rpc") =>
    JSON.stringify({
      functions: [{ id: uuid(7900), function: { name }, callers }],
    })

  it.each<{ callers: SqlFunctionCaller[]; roles: string }>([
    { callers: ["user"], roles: API.user },
    { callers: ["command"], roles: COMMAND },
    { callers: ["user", "service"], roles: `${API.user}, ${API.service}` },
  ])(
    "warns a definer function with callers $callers with the roles of its callers",
    async ({ callers, roles }) => {
      const result = await compiled({
        // Дослівний грант іншій ролі не змінює ролей попередження.
        [RPC_FILE]:
          countTask() +
          grants(`GRANT EXECUTE ON FUNCTION ${RPC}() TO`, [API.anonymous]),
        [RPC_FUNCTIONS]: declare(callers),
      })
      expect(brief(result.diagnostics, CODES)).toEqual([warned(RPC, { roles })])
    }
  )

  it("does not warn a definer function with only the service caller", async () => {
    const result = await compiled({
      [RPC_FILE]: countTask(),
      [RPC_FUNCTIONS]: declare(["service"]),
    })
    expect(result.diagnostics).toEqual([])
  })

  it("compiles an invoker function with every caller, anonymous included", async () => {
    const result = await compiled({
      [RPC_FILE]: countTask("SECURITY INVOKER"),
      [RPC_FUNCTIONS]: declare(["user", "anonymous", "service", "command"]),
    })
    expect(result.diagnostics).toEqual([])
  })

  // Складову агрегату Postgres виконує від власника агрегату, тож декларація
  // складової його `EXECUTE` не обмежує (#275).
  it("refuses an aggregate over a declared definer state function", async () => {
    const result = await compiled({
      [RPC_FILE]:
        `CREATE FUNCTION public.sf(a int, b int) RETURNS int LANGUAGE sql IMMUTABLE ${CLOSED} AS $$ SELECT a + b $$;\n` +
        "CREATE AGGREGATE public.agg2(int) (sfunc = public.sf, stype = int);\n",
      [RPC_FUNCTIONS]: declare(["service"], "sf"),
    })
    expect(brief(result.diagnostics, CODES)).toEqual([
      refused("public.agg2", EVERY_CALLER, RPC_FILE, 2),
    ])
  })
})
