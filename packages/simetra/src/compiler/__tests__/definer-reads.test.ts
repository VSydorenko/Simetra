import { describe, expect, it } from "vitest"
import { compile, type Diagnostic } from "simetra/compiler"
import { PROVIDER_API_ROLES } from "simetra/model"
import {
  CHECKLIST_TABLE,
  COMMENT_COUNTER_FILE,
  PROJECT_CATALOG_FILE,
  PROJECT_FILE,
  REGION_DIMENSION_ID,
  counterColumn,
  policyDomain,
  teamScopeKind,
  type Layer,
} from "./fixtures/rights"
import { dynamicFunction } from "./fixtures/sql-shape"
import { SCOPE_FUNCTIONS_FILE, acceptDebt } from "./helpers"

const RPC_FILE = "sql/public/rpc.sql"
const PROJECT_MODULE = PROJECT_CATALOG_FILE.replace(".meta.json", ".sql")
const RPC = "public.rpc"
const TASK = "public.task"
const API = PROVIDER_API_ROLES.supabase
/** Отримувачі, що мають привілей без жодного явного гранту чи відкликання. */
const EVERYONE = `PUBLIC, ${API.user}, ${API.anonymous}`
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

describe("checkDefinerReads: functions", () => {
  it.each([
    {
      name: "a closed-shell function granted to the user role",
      sql: {
        [RPC_FILE]:
          countTask() +
          grants(`GRANT EXECUTE ON FUNCTION ${RPC}() TO`, [API.user]),
      },
      expected: [warned(RPC)],
    },
    {
      // Postgres дає EXECUTE PUBLIC, провайдер — ролям API.
      name: "a function without any grant",
      sql: { [RPC_FILE]: countTask() },
      expected: [warned(RPC)],
    },
    {
      name: "a debt function outside the closed shell",
      sql: { [RPC_FILE]: countTask("SECURITY DEFINER") },
      expected: [warned(RPC)],
    },
    {
      // Типові привілеї провайдера лишаються.
      name: "EXECUTE revoked from PUBLIC only",
      sql: { [RPC_FILE]: countTask() + revokeExecute("PUBLIC") },
      expected: [warned(RPC, { roles: `${API.user}, ${API.anonymous}` })],
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
      expected: [warned(RPC)],
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
      expected: [warned(RPC, { roles: API.anonymous })],
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
      expected: [warned(RPC)],
    },
    {
      name: "SECURITY DEFINER set by a separate ALTER FUNCTION",
      sql: {
        [RPC_FILE]:
          countTask("SECURITY INVOKER") +
          `ALTER FUNCTION ${RPC}() SECURITY DEFINER;\n`,
      },
      expected: [warned(RPC)],
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
      expected: [],
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
      expected: [warned(RPC)],
    },
    {
      // З порожнім search_path ім'я називає лише pg_catalog чи pg_temp.
      name: "an unqualified table name under an empty search_path",
      sql: { [RPC_FILE]: sqlFunction(RPC, "SELECT count(*) FROM task") },
      expected: [],
    },
    {
      name: "a plpgsql SELECT INTO from a tabular section",
      sql: {
        [RPC_FILE]: plpgsqlFunction(
          `SELECT count(*) INTO v FROM public.${CHECKLIST_TABLE};`
        ),
      },
      expected: [warned(RPC, { tables: `public.${CHECKLIST_TABLE}` })],
    },
    {
      name: "a plpgsql EXECUTE of a built string",
      sql: {
        [RPC_FILE]: plpgsqlFunction("EXECUTE format('SELECT %s', 1) INTO v;"),
      },
      expected: [warned(RPC, { tables: "", reason: "unknown" })],
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
      expected: [warned(RPC)],
    },
    {
      name: "a reached function with dynamic SQL",
      sql: {
        [RPC_FILE]:
          sqlFunction(RPC, "SELECT public.dyn()") +
          dynamicFunction("public.dyn"),
      },
      expected: [warned(RPC, { tables: "", reason: "unknown" })],
    },
    {
      // Закрита оболонка не забороняє читати таблицю під RLS, а EXECUTE без
      // явного REVOKE має PUBLIC.
      name: "a function of a closed module",
      sql: { [PROJECT_MODULE]: countTask() },
      expected: [warned(RPC, {}, PROJECT_MODULE)],
    },
  ])("$name", async ({ sql, expected }) => {
    const result = await compiled(sql)
    expect(brief(result.diagnostics, ["sql.definer-reads-rls"])).toEqual(
      expected
    )
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
    expect(brief(result.diagnostics, ["sql.definer-reads-rls"])).toEqual([])
  })

  it("names an adopted table once its row-level security is on", async () => {
    const result = await compiled(
      {
        [RPC_FILE]: sqlFunction(
          RPC,
          "SELECT count(*) FROM public.comment_counter"
        ),
      },
      [{ [COMMENT_COUNTER_FILE]: { rowLevelSecurity: "enabled" } }]
    )
    expect(brief(result.diagnostics, ["sql.definer-reads-rls"])).toEqual([
      warned(RPC, { tables: "public.comment_counter" }),
    ])
  })

  // Вираз таблиці, якого розбір не читає, Postgres однаково обчислить
  // посеред запису від імені власника функції.
  it("marks a write into a table with an unparsable default as unknown", async () => {
    const result = await compiled(
      {
        [RPC_FILE]: sqlFunction(
          RPC,
          "INSERT INTO public.comment_counter (comment_id) VALUES (NULL) RETURNING 1"
        ),
      },
      [counterColumn({ default: "public.dyn(" })]
    )
    expect(brief(result.diagnostics, ["sql.definer-reads-rls"])).toEqual([
      warned(RPC, { tables: "", reason: "unknown" }),
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
