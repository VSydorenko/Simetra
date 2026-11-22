import { beforeAll, describe, expect, it } from "vitest"
import { compile, isRepairError, type Diagnostic } from "simetra/compiler"
import { readFiles, sqlStage } from "../pipeline"
import {
  HEAD_PINNED_SETTINGS,
  pinnedSettingsClause,
} from "../sql/head-settings"
import { headScope, judgeHandler } from "../sql/heads"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import {
  COMMENT_COUNTER_FILE,
  COMMENT_FILE,
  COUNT_COMMENT_FILE,
  COUNT_COMMENT_SQL_FILE,
  PROJECT_CATALOG_FILE,
  PROJECT_FILE,
  REGION_DIMENSION_ID,
  TASK_NOTE_FILE,
  compiledPolicyDomain,
  policyDomain,
  promotableTaskNote,
  teamScopeKind,
  type Layer,
} from "./fixtures/rights"
import {
  SCOPE_FUNCTIONS_FILE,
  acceptDebt,
  catalog,
  metaFiles,
  project,
  salesDocument,
  uuid,
} from "./helpers"

const SHARED = "sql/public/shared.sql"
const EMPTY_PATH = "SET search_path = ''"
/** Налаштування сесії, які корінь голови фіксує в оболонці (`sql.head-settings`). */
const PINNED = pinnedSettingsClause()
const SET_FUNCTION = "public.team_ids"
const HANDLER = "public.count_comment"
const PROJECT_MODULE = PROJECT_CATALOG_FILE.replace(".meta.json", ".sql")
const COMMENT_MODULE = COMMENT_FILE.replace(".meta.json", ".sql")
const SALE_SQL = "documents/Sale/Sale.sql"
/** Обгортка блоку рухів `Sale` → `Stock`: ім'я голови блоку. */
const SALE_WRAPPER = "public.sale_stock_movements"

const chain = (...names: string[]) => names.join(" → ")

/** Функція `LANGUAGE sql` з тілом `body`; типово — функція-запит. */
const sqlFunction = (
  name: string,
  body: string,
  options = `STABLE ${EMPTY_PATH}`,
  args = "",
  returns = "SETOF uuid"
) =>
  `CREATE FUNCTION ${name}(${args}) RETURNS ${returns} LANGUAGE sql ${options} AS $$ ${body} $$;\n`
/** Функція множини скоупу `team` — голова Правила 3. */
const setFunction = (body: string) =>
  sqlFunction(
    SET_FUNCTION,
    body,
    `STABLE SECURITY DEFINER ${EMPTY_PATH} ${PINNED}`
  )
/** Ланка на plpgsql у закритій оболонці. */
const plpgsqlFunction = (name: string, args = "", returns = "boolean") =>
  `CREATE FUNCTION ${name}(${args}) RETURNS ${returns} LANGUAGE plpgsql STABLE ${EMPTY_PATH} AS $$ BEGIN RETURN NULL; END $$;\n`
const selectWhere = (condition: string) =>
  setFunction(`SELECT t.id FROM public.task t WHERE ${condition}`)

/** Помилка без тексту: `sql.head-not-allowed` — конструкція, деталь і ланцюжок. */
type Finding = readonly unknown[]
const found = (
  construct: string,
  detail: string | undefined,
  ...names: string[]
) => ["sql.head-not-allowed", construct, detail, chain(...names)] as const

function errors(diagnostics: readonly Diagnostic[]): Finding[] {
  return diagnostics
    .filter((d) => d.severity === "error")
    .map((d) =>
      d.code === "sql.head-not-allowed" ||
      d.code === "sql.domain-check-not-allowed"
        ? [d.code, d.params?.construct, d.params?.detail, d.params?.chain]
        : [d.code]
    )
}

/** Домен політик з функцією множини `team_ids`, прийнятою `TaskNote` і SQL. */
async function headErrors(
  sql: Record<string, string>,
  layers: Layer[] = []
): Promise<Finding[]> {
  const result = await compiledPolicyDomain(sql, [
    teamScopeKind(),
    promotableTaskNote(),
    ...layers,
  ])
  return errors(result.diagnostics)
}

const RLS_ON: Layer = { [TASK_NOTE_FILE]: { rowLevelSecurity: "enabled" } }
const COUNTER_RLS_ON: Layer = {
  [COMMENT_COUNTER_FILE]: { rowLevelSecurity: "enabled" },
}
/** Борговий plpgsql, який кличе вираз політики. */
const DEBT_FN = plpgsqlFunction("public.debt_fn", "x uuid")
const READ_NOTES = setFunction("SELECT n.id FROM public.task_notes n")
const POLICY = "policy:public.task_notes.p"

describe("checkHeads: Rule 3 — query functions", () => {
  it.each<{
    name: string
    sql: string
    layers?: Layer[]
    expected: Finding[]
  }>([
    {
      name: "select-ok",
      sql: selectWhere("t.id = (select simetra.current_user_id())"),
      expected: [],
    },
    {
      name: "plpgsql-link",
      sql:
        setFunction("SELECT public.helper()") +
        plpgsqlFunction("public.helper", "", "SETOF uuid"),
      expected: [found("language", undefined, SET_FUNCTION, "public.helper")],
    },
    {
      name: "atomic-link",
      sql:
        setFunction("SELECT public.helper()") +
        `CREATE FUNCTION public.helper() RETURNS SETOF uuid LANGUAGE sql STABLE ${EMPTY_PATH} BEGIN ATOMIC SELECT NULL::uuid; END;\n`,
      expected: [found("sqlBody", undefined, SET_FUNCTION, "public.helper")],
    },
    {
      name: "link-search-path",
      sql:
        setFunction("SELECT public.helper()") +
        sqlFunction("public.helper", "SELECT NULL::uuid", "STABLE"),
      expected: [found("searchPath", undefined, SET_FUNCTION, "public.helper")],
    },
    {
      // Без волатильності ланка — борг: запис claims у ній лише
      // попередження, а голова однаково не кличе такої ланки.
      name: "link-setting",
      sql:
        setFunction("SELECT public.helper()") +
        sqlFunction(
          "public.helper",
          "SELECT NULL::uuid",
          `${EMPTY_PATH} SET request.jwt.claims = '{}'`
        ),
      expected: [
        found("setting", "request.jwt.claims", SET_FUNCTION, "public.helper"),
      ],
    },
    {
      name: "two-statements",
      sql: setFunction("SELECT NULL::uuid; SELECT NULL::uuid"),
      expected: [found("query", undefined, SET_FUNCTION)],
    },
    {
      name: "temp-table",
      sql: setFunction(
        "CREATE TEMP TABLE x ON COMMIT DROP AS SELECT NULL::uuid AS id; SELECT NULL::uuid"
      ),
      expected: [found("query", undefined, SET_FUNCTION)],
    },
    {
      name: "for-update",
      sql: setFunction("SELECT t.id FROM public.task t FOR UPDATE"),
      expected: [found("query", undefined, SET_FUNCTION)],
    },
    {
      name: "data-cte",
      sql: setFunction(
        "WITH d AS (DELETE FROM public.task_notes RETURNING id) SELECT d.id FROM d"
      ),
      expected: [found("query", undefined, SET_FUNCTION)],
    },
    {
      name: "builtin-allowed",
      sql: selectWhere(
        "lower(t.id::text) <> '' AND pg_catalog.now() IS NOT NULL"
      ),
      expected: [],
    },
    ...[
      "set_config('x.y', 'z', true)",
      "pg_sleep(0)",
      "pg_input_is_valid('x', 'public.d')",
    ].map((call) => ({
      name: `builtin-excluded ${call}`,
      sql: selectWhere(`${call} IS NOT NULL`),
      expected: [found("call", call.slice(0, call.indexOf("(")), SET_FUNCTION)],
    })),
    // Голова не називає відношення текстом: рядок, приведений до
    // `regclass`, — відношення, а вбудовані з іменем відношення в тексті —
    // поза переліком голови. `obj_description` читає каталог і поза
    // позитивним переліком голови (Р6 плану Д5).
    {
      name: "relation named by a regclass cast",
      sql: selectWhere(
        "pg_catalog.obj_description('auth.users'::regclass, 'pg_class') IS NULL"
      ),
      expected: [
        found("call", "pg_catalog.obj_description", SET_FUNCTION),
        found("relation", "auth.users", SET_FUNCTION),
      ],
    },
    ...[
      ["has_table_privilege('auth.users', 'select')", "has_table_privilege"],
      ["pg_catalog.to_regclass('x.y') IS NULL", "pg_catalog.to_regclass"],
    ].map(([condition, call]) => ({
      name: `text-named relation ${call}`,
      sql: selectWhere(condition!),
      expected: [found("call", call!, SET_FUNCTION)],
    })),
    {
      // Аргумент `regclass` називає відношення текстом, якого збирач
      // відношень не бачить.
      name: "builtin-excluded pg_relation_size of a relation named by text",
      sql: selectWhere("pg_catalog.pg_relation_size('public.t') > 0"),
      expected: [found("call", "pg_catalog.pg_relation_size", SET_FUNCTION)],
    },
    {
      // Аргумент `regclass` — ще й відношення, що його читає виклик.
      name: "builtin-excluded nextval('public.s')",
      sql: selectWhere("nextval('public.s') IS NOT NULL"),
      expected: [
        found("call", "nextval", SET_FUNCTION),
        found("relation", "public.s", SET_FUNCTION),
      ],
    },
    {
      // Ім'я послідовності без схеми відмовляє ранній блок (Правило 1, форма
      // `sequence`, спека прав §6.1 І20): до голови справа не доходить.
      name: "builtin-excluded nextval('s')",
      sql: selectWhere("nextval('s') IS NOT NULL"),
      expected: [["sql.kind-table-verbatim"]],
    },
    {
      // У тілі функції виклик, що виконує текст SQL, відмовляє ранній блок
      // скрізь, борг включно (`dynamicText`, спека прав §5.3): до голови справа не
      // доходить.
      name: "builtin-excluded query_to_xml in a function link",
      sql:
        setFunction("SELECT public.helper()") +
        sqlFunction(
          "public.helper",
          "SELECT NULL::uuid WHERE query_to_xml('select 1', true, true, '') IS NOT NULL",
          EMPTY_PATH
        ),
      expected: [["sql.function-body-statement"]],
    },
    {
      // Виклик подання, борг включно, судить ранній дозвільний перелік
      // виразів (спека прав §5.3): до голови справа не доходить.
      name: "builtin-excluded query_to_xml in a debt view link",
      sql:
        setFunction("SELECT v.id FROM public.helper v") +
        "CREATE VIEW public.helper AS SELECT NULL::uuid AS id WHERE pg_catalog.query_to_xml('select 1', true, true, '') IS NOT NULL;\n",
      expected: [["sql.expression-call-not-allowed"]],
    },
    {
      name: "provider auth.uid",
      sql: selectWhere("t.id = auth.uid()"),
      expected: [],
    },
    ...["extensions.gen_random_bytes(16)"].map((call) => ({
      name: `provider ${call}`,
      sql: selectWhere(`${call} IS NOT NULL`),
      expected: [found("call", call.slice(0, call.indexOf("(")), SET_FUNCTION)],
    })),
    {
      // Функція схеми провайдера поза позитивним переліком — виконання тексту
      // (спека прав §5.3): її судить перелік тіла раніше за голову.
      name: "provider auth.other",
      sql: selectWhere("auth.other() IS NOT NULL"),
      expected: [["sql.function-body-statement"]],
    },
    {
      name: "generated membership function",
      sql: selectWhere("public.org_member_my_member(t.id) IS NOT NULL"),
      expected: [],
    },
    {
      name: "aggregate",
      sql:
        setFunction(
          "SELECT t.id FROM public.task t GROUP BY t.id HAVING public.agg(1) > 0"
        ) + "CREATE AGGREGATE public.agg(int) (SFUNC = int4pl, STYPE = int);\n",
      expected: [found("call", "public.agg", SET_FUNCTION)],
    },
    ...["simetra.identities", "pg_catalog.pg_class", "auth.users"].map(
      (relation) => ({
        name: `relation ${relation}`,
        sql: setFunction(`SELECT r.id FROM ${relation} r`),
        expected: [found("relation", relation, SET_FUNCTION)],
      })
    ),
    {
      name: "relation unqualified",
      sql: setFunction("SELECT t.id FROM task t"),
      expected: [found("unqualified", "task", SET_FUNCTION)],
    },
    { name: "custom-table", sql: READ_NOTES, expected: [] },
    {
      name: "view",
      sql:
        setFunction("SELECT v.id FROM public.v v") +
        "CREATE VIEW public.v WITH (security_invoker = true) AS SELECT t.id FROM public.task t;\n",
      expected: [],
    },
    {
      // Подання зв'язує імена під час створення з `search_path` сесії.
      name: "bound-unqualified",
      sql:
        setFunction("SELECT v.id FROM public.v v") +
        "CREATE VIEW public.v WITH (security_invoker = true) AS SELECT t.id FROM public.task t WHERE lower(t.id::text) <> '';\n",
      expected: [found("unqualified", "lower", SET_FUNCTION, "public.v")],
    },
    {
      name: "view calling a function outside the allowlist",
      sql:
        setFunction("SELECT v.id FROM public.v v") +
        "CREATE VIEW public.v WITH (security_invoker = true) AS SELECT t.id FROM public.task t WHERE extensions.gen_random_bytes(16) IS NOT NULL;\n",
      expected: [
        found("call", "extensions.gen_random_bytes", SET_FUNCTION, "public.v"),
      ],
    },
    {
      // `n.evil` у поданні — виклик `evil(n)`.
      name: "attribute-call",
      sql:
        setFunction("SELECT v.id FROM public.v v") +
        "CREATE VIEW public.v WITH (security_invoker = true) AS SELECT n.id, n.evil FROM public.task_notes n;\n" +
        plpgsqlFunction("public.evil", "n public.task_notes", "uuid"),
      expected: [
        found("language", undefined, SET_FUNCTION, "public.v", "public.evil"),
      ],
    },
    {
      name: "policy-permissive",
      sql:
        READ_NOTES +
        DEBT_FN +
        "CREATE POLICY p ON public.task_notes FOR SELECT USING (public.debt_fn(id));\n",
      layers: [RLS_ON],
      expected: [
        found("language", undefined, SET_FUNCTION, POLICY, "public.debt_fn"),
      ],
    },
    {
      name: "policy-restrictive",
      sql:
        READ_NOTES +
        DEBT_FN +
        "CREATE POLICY p ON public.task_notes AS RESTRICTIVE FOR SELECT USING (public.debt_fn(id));\n",
      layers: [RLS_ON],
      expected: [
        found("language", undefined, SET_FUNCTION, POLICY, "public.debt_fn"),
      ],
    },
    {
      // RLS `off` — політик Postgres не обчислює.
      name: "policy on a table with RLS off",
      sql:
        READ_NOTES +
        DEBT_FN +
        "CREATE POLICY p ON public.task_notes FOR SELECT USING (public.debt_fn(id));\n",
      expected: [],
    },
    {
      name: "policy of the INSERT command",
      sql:
        READ_NOTES +
        DEBT_FN +
        "CREATE POLICY p ON public.task_notes FOR INSERT WITH CHECK (public.debt_fn(id));\n",
      layers: [RLS_ON],
      expected: [],
    },
    {
      name: "policy-recursive",
      sql:
        READ_NOTES +
        DEBT_FN +
        "CREATE POLICY p ON public.task_notes FOR SELECT USING (EXISTS (SELECT 1 FROM public.comment_counter o WHERE o.comment_id = id));\n" +
        "CREATE POLICY q ON public.comment_counter USING (public.debt_fn(comment_id));\n",
      layers: [RLS_ON, COUNTER_RLS_ON],
      expected: [
        found(
          "language",
          undefined,
          SET_FUNCTION,
          POLICY,
          "policy:public.comment_counter.q",
          "public.debt_fn"
        ),
      ],
    },
    {
      name: "operator",
      sql: selectWhere("1 OPERATOR(public.+) 1 = 2"),
      expected: [found("operator", "public.+", SET_FUNCTION)],
    },
    // Оператор називає не лише вираз: `ORDER BY … USING` і порівняння з
    // підзапитом кличуть його функцію так само.
    {
      name: "operator of ORDER BY USING",
      sql: setFunction(
        "SELECT t.id FROM public.task t ORDER BY t.id USING OPERATOR(public.<)"
      ),
      expected: [found("operator", "public.<", SET_FUNCTION)],
    },
    {
      name: "operator of a subquery comparison",
      sql: selectWhere("t.id OPERATOR(public.=) ANY (SELECT t.id)"),
      expected: [found("operator", "public.=", SET_FUNCTION)],
    },
    {
      name: "pg_catalog operator of a subquery comparison",
      sql: selectWhere("t.id OPERATOR(pg_catalog.=) ANY (SELECT t.id)"),
      expected: [],
    },
  ])("$name", async ({ sql, layers = [], expected }) => {
    expect(await headErrors({ [SCOPE_FUNCTIONS_FILE]: sql }, layers)).toEqual(
      expected
    )
  })

  it("cycle: the walk ends", async () => {
    const found = await headErrors({
      [SCOPE_FUNCTIONS_FILE]:
        setFunction("SELECT public.a()") +
        sqlFunction("public.a", "SELECT public.b()") +
        sqlFunction("public.b", "SELECT public.a()"),
    })
    expect(found.filter((f) => f[0] === "sql.head-not-allowed")).toEqual([])
  })
})

describe("checkHeads: other heads", () => {
  const dimension: Layer = {
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
  }
  const DIMENSION = "public.region_ids"

  it.each<{
    name: string
    sql: Record<string, string>
    layers?: Layer[]
    expected: Finding[]
  }>([
    {
      name: "dimension function: builtin-excluded",
      sql: {
        [SHARED]: sqlFunction(
          DIMENSION,
          "SELECT NULL::uuid WHERE pg_sleep(0) IS NOT NULL",
          `STABLE SECURITY DEFINER ${EMPTY_PATH} ${PINNED}`
        ),
      },
      layers: [dimension],
      expected: [found("call", "pg_sleep", DIMENSION)],
    },
    {
      name: "closed module function with a parameter",
      sql: {
        [PROJECT_MODULE]: sqlFunction(
          "public.project_tasks",
          "SELECT t.id FROM public.task t WHERE t.id = p",
          `STABLE ${EMPTY_PATH}`,
          "p uuid"
        ),
      },
      expected: [],
    },
    {
      name: "closed module function on plpgsql",
      sql: {
        [PROJECT_MODULE]: plpgsqlFunction("public.project_check", "p uuid"),
      },
      expected: [found("language", undefined, "public.project_check")],
    },
  ])("$name", async ({ sql, layers = [], expected }) => {
    expect(await headErrors(sql, layers)).toEqual(expected)
  })

  const blockErrors = async (query: string) => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        ...salesDocument({}, { posting: undefined }),
        [SALE_SQL]: `-- @movements Stock\n${query}\n-- @end\n`,
      })
    )
    return result.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => [
        d.code,
        d.file,
        d.params?.construct,
        d.params?.detail,
        d.params?.chain,
        d.params?.line,
      ])
  }

  it.each([
    {
      name: "builtin-excluded",
      query: "SELECT 1 WHERE pg_sleep(0) IS NOT NULL ORDER BY 1",
      expected: ["call", "pg_sleep"],
    },
    {
      name: "relation-platform",
      query: "SELECT 1 FROM simetra.identities i ORDER BY 1",
      expected: ["relation", "simetra.identities"],
    },
  ])("movement block: $name", async ({ query, expected }) => {
    expect(await blockErrors(query)).toEqual([
      ["sql.head-not-allowed", SALE_SQL, ...expected, SALE_WRAPPER, 1],
    ])
  })
})

// Р6/Р7 плану Д5 (І5): голова кличе лише вбудовані позитивного переліку
// й читає зі стану сесії лише точну назву claims. Те саме правило — для
// кожного виду голови й транзитивно. Часову зону функція голови фіксує в
// оболонці (`sql.head-settings`), а правило за іменами лишається лише для
// дослівного виразу політики.
describe("checkHeads: head builtin allowlist and session state", () => {
  const DIMENSION = "public.region_ids"
  const HELPER = "public.helper"
  const dimension: Layer = {
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
  }
  const heads: {
    head: string
    sql: (condition: string) => Record<string, string>
    layers: Layer[]
    chain: string[]
  }[] = [
    {
      head: "set function",
      sql: (condition) => ({ [SCOPE_FUNCTIONS_FILE]: selectWhere(condition) }),
      layers: [],
      chain: [SET_FUNCTION],
    },
    {
      head: "dimension values function",
      sql: (condition) => ({
        [SHARED]: sqlFunction(
          DIMENSION,
          `SELECT NULL::uuid WHERE ${condition}`,
          `STABLE SECURITY DEFINER ${EMPTY_PATH} ${PINNED}`
        ),
      }),
      layers: [dimension],
      chain: [DIMENSION],
    },
    {
      head: "transitive call",
      sql: (condition) => ({
        [SCOPE_FUNCTIONS_FILE]:
          setFunction(`SELECT ${HELPER}()`) +
          sqlFunction(HELPER, `SELECT NULL::uuid WHERE ${condition}`),
      }),
      layers: [],
      chain: [SET_FUNCTION, HELPER],
    },
    {
      // Вираз політики прочитаної таблиці суддя голів обходить через
      // `policiesOn`: правило розбору дерева діє й там.
      head: "policy of a read table",
      sql: (condition) => ({
        [SCOPE_FUNCTIONS_FILE]:
          READ_NOTES +
          `CREATE POLICY p ON public.task_notes FOR SELECT USING (${condition});\n`,
      }),
      layers: [RLS_ON],
      chain: [SET_FUNCTION, POLICY],
    },
  ]
  // Вбудовані кваліфіковані: у виразі політики некваліфіковане ім'я —
  // окрема знахідка `unqualified`.
  const refused: [string, string, string][] = [
    [
      "pg_catalog.pg_show_all_settings() IS NOT NULL",
      "call",
      "pg_catalog.pg_show_all_settings",
    ],
    [
      "pg_catalog.current_query() IS NOT NULL",
      "call",
      "pg_catalog.current_query",
    ],
    [
      "pg_catalog.inet_client_addr() IS NOT NULL",
      "call",
      "pg_catalog.inet_client_addr",
    ],
    [
      "pg_catalog.pg_try_advisory_xact_lock(1)",
      "call",
      "pg_catalog.pg_try_advisory_xact_lock",
    ],
    [
      "pg_catalog.to_regclass('x.secret') IS NULL",
      "call",
      "pg_catalog.to_regclass",
    ],
    [
      "pg_catalog.pg_get_viewdef('auth.v') IS NULL",
      "call",
      "pg_catalog.pg_get_viewdef",
    ],
    [
      "pg_catalog.has_table_privilege('x.secret', 'select')",
      "call",
      "pg_catalog.has_table_privilege",
    ],
    [
      "pg_catalog.current_setting('request.headers') IS NULL",
      "setting",
      "request.headers",
    ],
    [
      "pg_catalog.current_setting('request.jwt.claim.sub') IS NULL",
      "setting",
      "request.jwt.claim.sub",
    ],
    [
      "pg_catalog.current_setting('request.jwt.foo') IS NULL",
      "setting",
      "request.jwt.foo",
    ],
    ["pg_catalog.current_setting('app.x') IS NULL", "setting", "app.x"],
    ["pg_catalog.current_setting('role') IS NULL", "setting", "role"],
    [
      "pg_catalog.current_setting('REQUEST.JWT.CLAIMS') IS NULL",
      "setting",
      "REQUEST.JWT.CLAIMS",
    ],
    [
      "pg_catalog.current_setting(pg_catalog.lower('x')) IS NULL",
      "setting",
      "current_setting",
    ],
    [
      "pg_catalog.current_setting('request.jwt.claims'::text) IS NULL",
      "setting",
      "current_setting",
    ],
    [
      "pg_catalog.current_setting(setting_name => 'request.jwt.claims') IS NULL",
      "setting",
      "current_setting",
    ],
    [
      "pg_catalog.current_setting('request.jwt.claims', missing_ok => true) IS NULL",
      "setting",
      "request.jwt.claims",
    ],
    // Приведення до `reg*` не літералу називає об'єкт текстом під час
    // виконання: ні виклику, ні відношення голова не бачить.
    [
      "pg_catalog.lower('public.secret')::regclass IS NOT NULL",
      "call",
      "::regclass",
    ],
    ["'pg_catalog.lower'::regproc IS NOT NULL", "call", "::regproc"],
    [
      "pg_catalog.lower('pg_catalog.lower')::pg_catalog.regprocedure IS NOT NULL",
      "call",
      "::regprocedure",
    ],
    ["'x'::text::regtype IS NOT NULL", "call", "::regtype"],
  ]
  // Залежне від `TimeZone` чи `DateStyle`: функції голови виконуються в
  // зафіксованих налаштуваннях і це читають, а вираз політики — ні.
  const zoneDependent = [
    "current_date IS NOT NULL",
    "localtime IS NOT NULL",
    "localtimestamp IS NOT NULL",
    "pg_catalog.now()::date IS NOT NULL",
    "ts::date IS NOT NULL",
    "'today'::date IS NOT NULL",
    "'01-02-2026'::date IS NOT NULL",
    "pg_catalog.date(ts) IS NOT NULL",
    "pg_catalog.date_trunc('day', ts) IS NOT NULL",
    "(pg_catalog.now() AT LOCAL)::text <> ''",
    "pg_catalog.now()::timetz IS NOT NULL",
    "ts::time with time zone IS NOT NULL",
    "pg_catalog.timetz(ts) IS NOT NULL",
    "'2026-01-01 12:00'::timetz IS NOT NULL",
    "(pg_catalog.now() AT TIME ZONE 'UTC')::timetz IS NOT NULL",
    // `AT TIME ZONE` над значенням невідомого типу: над `timestamp` воно
    // повертає `timestamptz`, яке наступне перетворення читає в зоні сесії.
    "(ts AT TIME ZONE 'UTC')::date IS NOT NULL",
    "pg_catalog.date_trunc('day', ts AT TIME ZONE 'UTC') IS NOT NULL",
    // Перетворення в `timestamptz` того, що не має зони.
    "'2026-01-01 12:00'::timestamptz IS NOT NULL",
    "ts::timestamptz IS NOT NULL",
    "pg_catalog.timestamptz(ts) IS NOT NULL",
  ]
  const functionHeads = heads.filter((h) => !h.chain.includes(POLICY))
  const policyHead = heads.filter((h) => h.chain.includes(POLICY))
  const allowed = [
    "pg_catalog.current_setting('request.jwt.claims', true) IS NOT NULL",
    "(pg_catalog.now() AT TIME ZONE 'UTC')::date IS NOT NULL",
    "pg_catalog.now() IS NOT NULL",
    "current_timestamp IS NOT NULL",
    "ts >= pg_catalog.now()",
    "'2026-01-01'::date IS NOT NULL",
    "'2026-01-01 12:00:00+02'::timetz IS NOT NULL",
    "pg_catalog.date_trunc('day', ts, 'UTC') IS NOT NULL",
    "(current_timestamp AT TIME ZONE 'UTC')::date IS NOT NULL",
    "(pg_catalog.statement_timestamp() AT TIME ZONE 'UTC')::date IS NOT NULL",
    "('2026-01-01 12:00+02'::timestamptz AT TIME ZONE 'UTC')::date IS NOT NULL",
    "'2026-01-01 12:00:00+02'::timestamptz IS NOT NULL",
    "pg_catalog.now()::timestamptz IS NOT NULL",
  ]

  it.each(
    heads.flatMap((h) =>
      refused.map(([condition, construct, detail]) => ({
        ...h,
        condition,
        construct,
        detail,
      }))
    )
  )(
    "$head refuses $condition",
    async ({ sql, layers, chain: names, condition, construct, detail }) => {
      expect(await headErrors(sql(condition), layers)).toEqual([
        found(construct, detail, ...names),
      ])
    }
  )

  it.each(
    policyHead.flatMap((h) =>
      zoneDependent.map((condition) => ({ ...h, condition }))
    )
  )(
    "$head refuses $condition by the session time zone",
    async ({ sql, layers, chain: names, condition }) => {
      expect(await headErrors(sql(condition), layers)).toEqual([
        found("setting", "TimeZone", ...names),
      ])
    }
  )

  it.each(
    heads.flatMap((h) => allowed.map((condition) => ({ ...h, condition })))
  )("$head allows $condition", async ({ sql, layers, condition }) => {
    expect(await headErrors(sql(condition), layers)).toEqual([])
  })

  it.each(
    functionHeads.flatMap((h) =>
      zoneDependent.map((condition) => ({ ...h, condition }))
    )
  )(
    "$head runs in pinned settings, so it allows $condition",
    async ({ sql, layers, condition }) => {
      expect(await headErrors(sql(condition), layers)).toEqual([])
    }
  )

  // Вираз політики обчислюється в налаштуваннях клієнта, і так само все, що
  // він досягає: подання й функція без зафіксованих налаштувань. Функція, що
  // сама фіксує налаштування голови, виконується вже в них.
  const VIEW = "public.v"
  const zonedView = `CREATE VIEW ${VIEW} WITH (security_invoker = true) AS SELECT t.id FROM public.task t WHERE current_date IS NOT NULL;\n`
  const viaPolicy = (using: string) =>
    `CREATE POLICY p ON public.task_notes FOR SELECT USING (${using});\n`
  it.each<{ name: string; sql: string; expected: Finding[] }>([
    {
      name: "a view a policy reads",
      sql:
        READ_NOTES +
        zonedView +
        viaPolicy(`id IN (SELECT v.id FROM ${VIEW} v)`),
      expected: [found("setting", "TimeZone", SET_FUNCTION, POLICY, VIEW)],
    },
    {
      // Те саме подання голова читає й сама: там воно в її налаштуваннях,
      // тож знахідка — лише на шляху через політику, раз.
      name: "a view the head reads itself and a policy reads",
      sql:
        setFunction(
          `SELECT n.id FROM public.task_notes n UNION SELECT v.id FROM ${VIEW} v`
        ) +
        zonedView +
        viaPolicy(`id IN (SELECT v.id FROM ${VIEW} v)`),
      expected: [found("setting", "TimeZone", SET_FUNCTION, POLICY, VIEW)],
    },
    {
      name: "a view only the head reads",
      sql: setFunction(`SELECT v.id FROM ${VIEW} v`) + zonedView,
      expected: [],
    },
    {
      name: "a function a policy calls",
      sql:
        READ_NOTES +
        sqlFunction(
          HELPER,
          "SELECT NULL::uuid WHERE current_date IS NOT NULL"
        ) +
        viaPolicy(`id IN (SELECT ${HELPER}())`),
      expected: [found("setting", "TimeZone", SET_FUNCTION, POLICY, HELPER)],
    },
    {
      name: "a function a policy calls that pins the settings itself",
      sql:
        READ_NOTES +
        sqlFunction(
          HELPER,
          "SELECT NULL::uuid WHERE current_date IS NOT NULL",
          `STABLE ${EMPTY_PATH} ${PINNED}`
        ) +
        viaPolicy(`id IN (SELECT ${HELPER}())`),
      expected: [],
    },
  ])("policy context: $name", async ({ sql, expected }) => {
    expect(await headErrors({ [SCOPE_FUNCTIONS_FILE]: sql }, [RLS_ON])).toEqual(
      expected
    )
  })
})

// Корінь голови фіксує налаштування сесії у власній оболонці (§5.8): клієнт
// ставить `TimeZone` сам, тож без опцій перетворення в місцевий час і текст
// дат залежали б від нього. Ланка виконується вже в цих налаштуваннях.
describe("sql.head-settings: a root head pins the session settings", () => {
  const DIMENSION = "public.region_ids"
  const HELPER = "public.helper"
  const dimension: Layer = {
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
  }
  const shell = (settings: string) =>
    `STABLE SECURITY DEFINER ${EMPTY_PATH} ${settings}`
  const setFunctionWith = (settings: string, body = "SELECT NULL::uuid") => ({
    [SCOPE_FUNCTIONS_FILE]: sqlFunction(SET_FUNCTION, body, shell(settings)),
  })
  const settingsErrors = async (
    sql: Record<string, string>,
    layers: Layer[] = []
  ) => {
    const result = await compiledPolicyDomain(sql, [
      teamScopeKind(),
      promotableTaskNote(),
      ...layers,
    ])
    const errors = result.diagnostics.filter((d) => d.severity === "error")
    for (const d of errors) {
      if (d.code === "sql.head-settings") expect(isRepairError(d)).toBe(true)
    }
    return errors.map((d) =>
      d.code === "sql.head-settings"
        ? [
            d.code,
            `${d.params?.schema}.${d.params?.name}`,
            d.params?.setting,
            d.params?.problem,
            d.params?.actual,
          ]
        : [d.code, d.params?.construct, d.params?.detail, d.params?.chain]
    )
  }
  const settingsError = (
    fn: string,
    setting: string,
    problem: string,
    actual?: string
  ) => ["sql.head-settings", fn, setting, problem, actual]

  it.each<{
    name: string
    settings: string
    expected: readonly (readonly unknown[])[]
  }>([
    {
      // Значення в корені судить лише `sql.head-settings` (клас ремонту):
      // друга, не ремонтна знахідка `setting` не дала б режиму ремонту теки.
      name: "with another TimeZone",
      settings: PINNED.replace("'UTC'", "'Europe/Kyiv'"),
      expected: [
        settingsError(SET_FUNCTION, "TimeZone", "value", "Europe/Kyiv"),
      ],
    },
    {
      name: "with another DateStyle",
      settings: PINNED.replace("'ISO, MDY'", "'ISO, DMY'"),
      expected: [settingsError(SET_FUNCTION, "DateStyle", "value", "ISO, DMY")],
    },
    {
      name: "with another extra_float_digits",
      settings: PINNED.replace(
        "extra_float_digits = '1'",
        "extra_float_digits = 3"
      ),
      expected: [
        settingsError(SET_FUNCTION, "extra_float_digits", "value", "3"),
      ],
    },
    {
      name: "with TimeZone FROM CURRENT",
      settings: PINNED.replace(`"TimeZone" = 'UTC'`, `"TimeZone" FROM CURRENT`),
      expected: [settingsError(SET_FUNCTION, "TimeZone", "notFixed")],
    },
    {
      // `RESET ALL` прибирає задане до нього, як у `proconfig`.
      name: "with RESET ALL after the settings",
      settings: `${PINNED} RESET ALL ${EMPTY_PATH}`,
      expected: [settingsError(SET_FUNCTION, "TimeZone", "missing")],
    },
    {
      // Форма `pg_get_functiondef`, яку читає зворотна генерація: ім'я в
      // лапках лише з великими літерами, `TO`, число без лапок.
      name: "in the form of the catalog",
      settings: HEAD_PINNED_SETTINGS.map(({ name, value }) =>
        name === "extra_float_digits"
          ? `SET ${name} TO ${value}`
          : `SET ${name === name.toLowerCase() ? name : `"${name}"`} TO '${value}'`
      ).join(" "),
      expected: [],
    },
  ])("set function $name", async ({ settings, expected }) => {
    expect(await settingsErrors(setFunctionWith(settings))).toEqual(expected)
  })

  // Кожне налаштування набору судиться окремо: оболонка без будь-якого з них
  // — помилка з його ім'ям.
  it.each(HEAD_PINNED_SETTINGS.map((s) => s.name))(
    "set function without %s",
    async (name) => {
      const settings = HEAD_PINNED_SETTINGS.filter((s) => s.name !== name)
        .map((s) => `SET ${s.name} = '${s.value}'`)
        .join(" ")
      expect(await settingsErrors(setFunctionWith(settings))).toEqual([
        settingsError(SET_FUNCTION, name, "missing"),
      ])
    }
  )

  it("a dimension values function without the settings", async () => {
    expect(
      await settingsErrors(
        {
          [SHARED]: sqlFunction(
            DIMENSION,
            "SELECT NULL::uuid",
            `STABLE SECURITY DEFINER ${EMPTY_PATH}`
          ),
        },
        [dimension]
      )
    ).toEqual([settingsError(DIMENSION, "TimeZone", "missing")])
  })

  it("a separate ALTER FUNCTION of a setting", async () => {
    const sql = setFunctionWith(PINNED)
    sql[SCOPE_FUNCTIONS_FILE] +=
      "ALTER FUNCTION public.team_ids() SET TimeZone = 'UTC';\n"
    // Окремий `ALTER FUNCTION` на судиму функцію зупиняє ранній блок
    // (`sql.function-settings-shell`), тож суддя оболонки голови до неї не
    // доходить.
    expect(await settingsErrors(sql)).toEqual([
      ["sql.function-settings-shell", undefined, undefined, undefined],
    ])
  })

  it.each<{
    name: string
    settings: string
    expected: readonly (readonly unknown[])[]
  }>([
    {
      name: "sets TimeZone to another value",
      settings: "SET TimeZone = 'Europe/Kyiv'",
      expected: [found("setting", "timezone", SET_FUNCTION, HELPER)],
    },
    { name: "repeats the pinned value", settings: PINNED, expected: [] },
  ])("a function the head calls $name", async ({ settings, expected }) => {
    const sql = setFunctionWith(PINNED, `SELECT ${HELPER}()`)
    sql[SCOPE_FUNCTIONS_FILE] += sqlFunction(
      HELPER,
      "SELECT NULL::uuid",
      `STABLE ${EMPTY_PATH} ${settings}`
    )
    expect(await settingsErrors(sql)).toEqual(expected)
  })
})

describe("checkHeads: generated functions", () => {
  // Голова кличе лише згенеровані функції, що читають: оболонку проведення
  // й обгортку рухів — ні (спека прав §5.3); функцію пошуку предвизначеного — так.
  // Діагностика одна — суддя голів; `sql.platform-function-call` — лише для
  // вільного SQL.
  const handlerFiles = (call: string) =>
    metaFiles({
      "project.meta.json": project(),
      ...salesDocument(),
      "catalogs/Warehouse/Warehouse.meta.json": catalog("Warehouse", {
        id: uuid(7110),
        predefinedItems: [
          { id: uuid(7111), name: "Main", physicalName: "main" },
        ],
      }),
      "event-subscriptions/StampSale/StampSale.meta.json": {
        id: uuid(7101),
        kind: "EventSubscription",
        name: "StampSale",
        physicalName: "stamp_sale",
        sources: [{ kind: "Document", name: "Sale" }],
        event: "onWrite",
        handler: { schema: "public", name: "stamp_sale" },
      },
      "sql/public/stamp-sale.sql": `CREATE FUNCTION public.stamp_sale() RETURNS trigger LANGUAGE plpgsql VOLATILE ${EMPTY_PATH} AS $$ BEGIN PERFORM ${call}; RETURN NEW; END $$;`,
    })

  it.each([
    {
      call: "public.sale_post(NEW.id)",
      expected: [
        [
          "sql.head-not-allowed",
          "call",
          "public.sale_post",
          "public.stamp_sale",
        ],
      ],
    },
    {
      call: "public.sale_stock_movements(NEW.id)",
      expected: [
        [
          "sql.head-not-allowed",
          "call",
          "public.sale_stock_movements",
          "public.stamp_sale",
        ],
      ],
    },
    { call: "public.warehouse_predefined('main')", expected: [] },
  ])("$call", async ({ call, expected }) => {
    const result = await compile(await acceptDebt(handlerFiles(call)))
    expect(errors(result.diagnostics)).toEqual(expected)
  })
})

/** Обробник лічильника домену політик з тілом `body`. */
const handler = (body: string, { declare = "", options = EMPTY_PATH } = {}) =>
  `CREATE FUNCTION public.count_comment() RETURNS trigger LANGUAGE plpgsql VOLATILE ${options} AS $$ DECLARE v uuid; n int; a int[]; x int; r record; c refcursor; k CURSOR FOR SELECT 1; ${declare} BEGIN ${body} RETURN NEW; END $$;\n`
const FORBIDDEN = plpgsqlFunction("public.forbidden", "", "int")

let parse: SqlParser
let plpgsql: PlpgsqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
})

/**
 * Суддя обробника напряму: форми, які вже відмовляє оболонка чи ранній блок
 * (динамічний SQL, непрочитаний ініціалізатор у спільному файлі), через
 * `compile` до нього не доходять.
 */
function judged(sql: string) {
  const files = policyDomain()
  files.set(COUNT_COMMENT_SQL_FILE, sql)
  const stage1 = readFiles(files)
  const { stage2, stage3, sql: read } = sqlStage(stage1, parse)
  const scope = headScope(
    stage1.objects,
    stage2.references,
    stage1.project!,
    stage3!.physical,
    read.units,
    new Set(),
    parse,
    plpgsql
  )
  const unit = read.units.find(
    (u) => u.identity === "function:public.count_comment()"
  )!
  return judgeHandler(unit, scope).findings.map((f) => [f.construct, f.detail])
}

// І7 (спека декларацій функцій §5.2): задекларована функція з `check` завжди
// plpgsql (запобіжник — перший `PERFORM`), тож у ланцюзі голови її відмовляє
// межа мови, ще до довіри до викликів. Мутація: пропустити plpgsql-ланки голів.
describe("judgeHandler: a link that is a declared function with check", () => {
  it("a handler calling it is refused for the guard call", async () => {
    const result = await compiledPolicyDomain({
      [COUNT_COMMENT_SQL_FILE]: handler("PERFORM public.link(NEW.id);"),
      [SHARED]: `CREATE FUNCTION public.link(p_row uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER ${EMPTY_PATH} AS $$ BEGIN PERFORM simetra.rights_require('read', 'task', p_row); END $$;\n`,
      "sql/public/shared.functions.json": JSON.stringify({
        functions: [
          {
            id: uuid(7903),
            function: { name: "link" },
            callers: ["user"],
            check: {
              action: "read",
              object: { kind: "Document", name: "Task" },
              row: "p_row",
            },
          },
        ],
      }),
    })
    expect(errors(result.diagnostics)).toEqual([
      found("language", undefined, HANDLER, "public.link"),
    ])
  })
})

describe("judgeHandler: Rule 2 — a handler only checks", () => {
  const handlerErrors = (body: string, layers: Layer[] = [], extra = "") =>
    headErrors(
      { [COUNT_COMMENT_SQL_FILE]: handler(body), [SHARED]: extra },
      layers
    )
  const statement = (detail: string) => found("statement", detail, HANDLER)

  it.each<{
    name: string
    body: string
    expected: Finding[]
    extra?: string
  }>([
    {
      name: "checks-only",
      body: "IF NEW.title IS NULL THEN RAISE EXCEPTION 'x'; END IF; NEW.title := pg_catalog.btrim(NEW.title);",
      expected: [],
    },
    {
      name: "select-into",
      body: "SELECT t.id INTO v FROM public.task t WHERE t.id = NEW.task_id;",
      expected: [],
    },
    {
      name: "dml insert",
      body: "INSERT INTO public.task_notes (id) VALUES (NEW.id);",
      expected: [statement("InsertStmt")],
    },
    {
      name: "dml update",
      body: "UPDATE public.task_notes SET name = 'x' WHERE id = NEW.id;",
      expected: [statement("UpdateStmt")],
    },
    {
      name: "dml delete",
      body: "DELETE FROM public.task_notes WHERE id = NEW.id;",
      expected: [statement("DeleteStmt")],
    },
    {
      name: "dml insert returning into",
      body: "INSERT INTO public.task_notes (id) VALUES (NEW.id) RETURNING id INTO v;",
      expected: [statement("InsertStmt")],
    },
    {
      name: "call",
      body: "CALL public.p();",
      // Кваліфікований виклик невідомої процедури судить ще й суддя тіла, тож
      // процедуру моделі оголошено: ціль перевірки — лише вузол `call` голови.
      extra: "CREATE PROCEDURE public.p() LANGUAGE sql AS $$ SELECT 1 $$;",
      expected: [statement("call")],
    },
    { name: "commit", body: "COMMIT;", expected: [statement("commit")] },
    {
      name: "cursor",
      body: "OPEN c FOR SELECT 1; FETCH c INTO n; CLOSE c;",
      expected: [statement("open"), statement("fetch"), statement("close")],
    },
    {
      name: "forc",
      body: "FOR q IN k LOOP END LOOP;",
      expected: [statement("forc")],
    },
    {
      name: "getdiag",
      body: "GET DIAGNOSTICS n = ROW_COUNT;",
      expected: [statement("getdiag")],
    },
    {
      name: "set statement",
      body: "SET LOCAL x.y = 'z';",
      expected: [statement("VariableSetStmt")],
    },
    {
      name: "set_config",
      body: "PERFORM set_config('x.y', 'z', true);",
      expected: [found("call", "set_config", HANDLER)],
    },
    {
      name: "side-effects data CTE",
      body: "PERFORM (WITH d AS (DELETE FROM public.task_notes RETURNING 1) SELECT 1);",
      expected: [found("query", undefined, HANDLER)],
    },
    {
      name: "side-effects in a condition",
      body: "IF EXISTS (SELECT 1 FROM public.task FOR UPDATE) THEN NULL; END IF;",
      expected: [found("query", undefined, HANDLER)],
    },
    {
      name: "side-effects in an assignment",
      body: "v := t.id FROM public.task t WHERE t.id = NEW.task_id FOR UPDATE;",
      expected: [found("query", undefined, HANDLER)],
    },
  ])("$name", async ({ body, expected, extra }) => {
    expect(await handlerErrors(body, [], extra)).toEqual(expected)
  })

  it("search-path", async () => {
    expect(
      await headErrors({
        [COUNT_COMMENT_SQL_FILE]: handler("", { options: "" }),
      })
    ).toEqual([found("searchPath", undefined, HANDLER)])
  })

  it("in-closed-module: Rule 2 only, no language", async () => {
    expect(
      await headErrors({
        [COUNT_COMMENT_SQL_FILE]: "",
        [COMMENT_MODULE]: handler(
          "INSERT INTO public.task_notes (id) VALUES (NEW.id);"
        ),
      })
    ).toEqual([statement("InsertStmt")])
  })

  it.each([
    {
      name: "provider-source",
      event: "onWrite",
      body: "INSERT INTO public.task_notes (id) VALUES (NEW.id);",
      expected: [statement("InsertStmt")],
    },
    // спека прав §5.3: тригери платформи переносять рядок провайдера в «Користувачі».
    {
      name: "provider-assign",
      event: "beforeWrite",
      body: "NEW.raw_app_meta_data := '{}';",
      expected: [statement("assign")],
    },
    {
      name: "provider without assignment",
      event: "beforeWrite",
      body: "",
      expected: [],
    },
  ])("$name", async ({ event, body, expected }) => {
    const layer: Layer = {
      [COUNT_COMMENT_FILE]: {
        sources: [{ providerTable: "auth.users" }],
        event,
      },
    }
    expect(await handlerErrors(body, [layer])).toEqual(expected)
  })

  it.each([
    {
      name: "provider RETURN OLD",
      source: { providerTable: "auth.users" },
      body: "RETURN OLD;",
      expected: [["subscription.handler-assigns-mechanics"]],
    },
    {
      // Без механіки й носіїв рядок `CustomTable` обробник змінювати може.
      name: "custom table without mechanics",
      source: { kind: "CustomTable", name: "CommentCounter" },
      body: "NEW.comment_id := NULL; RETURN OLD;",
      expected: [],
    },
  ])("beforeWrite: $name", async ({ source, body, expected }) => {
    const layer: Layer = {
      [COUNT_COMMENT_FILE]: { sources: [source], event: "beforeWrite" },
    }
    expect(await handlerErrors(body, [layer])).toEqual(expected)
  })

  it.each([
    { body: "EXECUTE 'SELECT 1';", expected: [["statement", "dynexecute"]] },
    {
      body: "FOR r IN EXECUTE 'SELECT 1' LOOP END LOOP;",
      expected: [["statement", "dynfors"]],
    },
  ])("execute: $body", ({ body, expected }) => {
    expect(judged(handler(body))).toEqual(expected)
  })

  // Ініціалізатор, якому сканер не знайшов пари: `.` перед `record` він
  // читає як оголошення запису.
  const UNREAD = "b bool := r.record = 1;"

  it("unread", async () => {
    expect(judged(handler("", { declare: UNREAD }))).toEqual([
      ["unread", undefined],
    ])
    expect(
      await headErrors({
        [COUNT_COMMENT_SQL_FILE]: "",
        [COMMENT_MODULE]: handler("", { declare: UNREAD }),
      })
    ).toEqual([found("unread", undefined, HANDLER)])
  })

  // Кожен слот виразу дозволеного оператора.
  it.each<{ slot: string; body: string; declare?: string }>([
    { slot: "if", body: "IF public.forbidden() = 1 THEN NULL; END IF;" },
    {
      slot: "elsif",
      body: "IF false THEN NULL; ELSIF public.forbidden() = 1 THEN NULL; END IF;",
    },
    {
      slot: "while",
      body: "WHILE public.forbidden() = 0 LOOP EXIT; END LOOP;",
    },
    { slot: "exit", body: "LOOP EXIT WHEN public.forbidden() = 1; END LOOP;" },
    { slot: "assert condition", body: "ASSERT public.forbidden() = 1;" },
    { slot: "assert message", body: "ASSERT true, public.forbidden()::text;" },
    { slot: "raise parameter", body: "RAISE NOTICE '%', public.forbidden();" },
    {
      slot: "raise option",
      body: "RAISE NOTICE 'x' USING MESSAGE = public.forbidden()::text;",
    },
    {
      slot: "fori lower",
      body: "FOR i IN public.forbidden()..2 LOOP END LOOP;",
    },
    {
      slot: "fori upper",
      body: "FOR i IN 1..public.forbidden() LOOP END LOOP;",
    },
    {
      slot: "fori step",
      body: "FOR i IN 1..2 BY public.forbidden() LOOP END LOOP;",
    },
    {
      slot: "foreach_a",
      body: "FOREACH x IN ARRAY ARRAY[public.forbidden()] LOOP END LOOP;",
    },
    {
      slot: "case expression",
      body: "CASE public.forbidden() WHEN 1 THEN NULL; ELSE NULL; END CASE;",
    },
    {
      slot: "case when",
      body: "CASE WHEN public.forbidden() = 1 THEN NULL; ELSE NULL; END CASE;",
    },
    {
      slot: "return",
      body: "IF false THEN RETURN public.forbidden(); END IF;",
    },
    { slot: "assign value", body: "n := public.forbidden();" },
    { slot: "assign index", body: "a[public.forbidden()] := 1;" },
    { slot: "declare", body: "", declare: "d int := public.forbidden();" },
    {
      slot: "declare record",
      body: "",
      declare: "r2 record := ROW(public.forbidden());",
    },
    {
      slot: "declare quoted non-ASCII record",
      body: "",
      declare: `"Ж" record := (SELECT public.forbidden());`,
    },
    {
      slot: "declare unquoted non-ASCII record",
      body: "",
      declare: "Ж record := (SELECT public.forbidden());",
    },
    { slot: "perform", body: "PERFORM public.forbidden();" },
    { slot: "fors", body: "FOR r IN SELECT public.forbidden() LOOP END LOOP;" },
    { slot: "execsql into", body: "SELECT public.forbidden() INTO n;" },
  ])("handler-expression-slots: $slot", async ({ body, declare = "" }) => {
    expect(
      await headErrors({
        [COUNT_COMMENT_SQL_FILE]: handler(body, { declare }),
        [SHARED]: FORBIDDEN,
      })
    ).toEqual([found("language", undefined, HANDLER, "public.forbidden")])
  })
})

describe("checkDomainChecks: CHECK of a domain (спека прав §5.3)", () => {
  // Голова виконує CHECK домену, коли приводить до нього значення, тож CHECK
  // судиться як вираз Правила 3 у контексті зв'язування під час створення.
  const TASK_NOTE_MODULE = TASK_NOTE_FILE.replace(".meta.json", ".sql")
  const LOG_IT = plpgsqlFunction("public.log_it", "v text")
  const domain = (check: string) =>
    `CREATE DOMAIN public.d AS text CHECK (${check});\n`
  const onDomain = (
    construct: string,
    detail: string | undefined,
    ...names: string[]
  ) => ["sql.domain-check-not-allowed", construct, detail, chain(...names)]

  it.each<{ name: string; file: string; sql: string; expected: Finding[] }>([
    {
      name: "plain check",
      file: SHARED,
      sql: domain("VALUE <> ''"),
      expected: [],
    },
    {
      name: "plpgsql function",
      file: SHARED,
      sql: LOG_IT + domain("public.log_it(VALUE)"),
      expected: [onDomain("language", undefined, "public.d", "public.log_it")],
    },
    {
      name: "unqualified builtin",
      file: SHARED,
      sql: domain("lower(VALUE) = VALUE"),
      expected: [onDomain("unqualified", "lower", "public.d")],
    },
    {
      name: "in a debt module",
      file: TASK_NOTE_MODULE,
      sql: LOG_IT + domain("public.log_it(VALUE)"),
      expected: [onDomain("language", undefined, "public.d", "public.log_it")],
    },
  ])("$name", async ({ file, sql, expected }) => {
    expect(await headErrors({ [file]: sql })).toEqual(expected)
  })
})
