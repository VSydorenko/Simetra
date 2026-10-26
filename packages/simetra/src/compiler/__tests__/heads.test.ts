import { beforeAll, describe, expect, it } from "vitest"
import { compile, type Diagnostic } from "simetra/compiler"
import { readFiles, sqlStage } from "../pipeline"
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
  sqlFunction(SET_FUNCTION, body, `STABLE SECURITY DEFINER ${EMPTY_PATH}`)
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
    {
      // Аргумент `regclass` — ще й відношення, що його читає виклик.
      name: "builtin-excluded nextval('s')",
      sql: selectWhere("nextval('s') IS NOT NULL"),
      expected: [
        found("call", "nextval", SET_FUNCTION),
        found("unqualified", "s", SET_FUNCTION),
      ],
    },
    {
      // У тілі функції виклик, що виконує текст SQL, відмовляє ранній блок
      // скрізь, борг включно (`dynamicText`, Р2c1-50): до голови справа не
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
      // Борг без тіла — подання — лишається ланкою: виклик судить голова.
      name: "builtin-excluded query_to_xml in a debt view link",
      sql:
        setFunction("SELECT v.id FROM public.helper v") +
        "CREATE VIEW public.helper AS SELECT NULL::uuid AS id WHERE pg_catalog.query_to_xml('select 1', true, true, '') IS NOT NULL;\n",
      expected: [
        found("call", "pg_catalog.query_to_xml", SET_FUNCTION, "public.helper"),
      ],
    },
    {
      name: "provider auth.uid",
      sql: selectWhere("t.id = auth.uid()"),
      expected: [],
    },
    ...["extensions.gen_random_bytes(16)", "auth.other()"].map((call) => ({
      name: `provider ${call}`,
      sql: selectWhere(`${call} IS NOT NULL`),
      expected: [found("call", call.slice(0, call.indexOf("(")), SET_FUNCTION)],
    })),
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
        "CREATE VIEW public.v AS SELECT t.id FROM public.task t;\n",
      expected: [],
    },
    {
      // Подання зв'язує імена під час створення з `search_path` сесії.
      name: "bound-unqualified",
      sql:
        setFunction("SELECT v.id FROM public.v v") +
        "CREATE VIEW public.v AS SELECT t.id FROM public.task t WHERE lower(t.id::text) <> '';\n",
      expected: [found("unqualified", "lower", SET_FUNCTION, "public.v")],
    },
    {
      name: "view calling a function outside the allowlist",
      sql:
        setFunction("SELECT v.id FROM public.v v") +
        "CREATE VIEW public.v AS SELECT t.id FROM public.task t WHERE extensions.gen_random_bytes(16) IS NOT NULL;\n",
      expected: [
        found("call", "extensions.gen_random_bytes", SET_FUNCTION, "public.v"),
      ],
    },
    {
      // `n.evil` у поданні — виклик `evil(n)`.
      name: "attribute-call",
      sql:
        setFunction("SELECT v.id FROM public.v v") +
        "CREATE VIEW public.v AS SELECT n.id, n.evil FROM public.task_notes n;\n" +
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
          `STABLE SECURITY DEFINER ${EMPTY_PATH}`
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

describe("checkHeads: generated functions", () => {
  // Голова кличе лише згенеровані функції, що читають: оболонку проведення
  // й обгортку рухів — ні (Р2c1-18 (б)); функцію пошуку предвизначеного — так.
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

describe("judgeHandler: Rule 2 — a handler only checks", () => {
  const handlerErrors = (body: string, layers: Layer[] = [], extra = "") =>
    headErrors(
      { [COUNT_COMMENT_SQL_FILE]: handler(body), [SHARED]: extra },
      layers
    )
  const statement = (detail: string) => found("statement", detail, HANDLER)

  it.each<{ name: string; body: string; expected: Finding[] }>([
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
    { name: "call", body: "CALL public.p();", expected: [statement("call")] },
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
  ])("$name", async ({ body, expected }) => {
    expect(await handlerErrors(body)).toEqual(expected)
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
    // Р2c1-39: тригери платформи переносять рядок провайдера в «Користувачі».
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

  // Review Focus 1 і 5: кожен слот виразу дозволеного оператора.
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

describe("checkDomainChecks: CHECK of a domain (Р2c1-33)", () => {
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

describe("checkHeads: model functions shadowed by a debt extension (Р2c1-35)", () => {
  // Функція розширення в схемі застосунку перевантажила б функцію-запит з
  // тим самим ім'ям, а функцій розширень серед одиниць немає.
  const QUERY = sqlFunction("public.f", "SELECT NULL::uuid")
  it.each<{ extension: string; expected: Finding[] }>([
    { extension: "SCHEMA extensions", expected: [] },
    {
      extension: "SCHEMA public",
      expected: [found("call", "public.f", SET_FUNCTION)],
    },
    { extension: "", expected: [found("call", "public.f", SET_FUNCTION)] },
  ])("extension $extension", async ({ extension, expected }) => {
    expect(
      await headErrors({
        [SCOPE_FUNCTIONS_FILE]: setFunction("SELECT public.f()") + QUERY,
        "sql/public/extensions.sql": `CREATE EXTENSION pgcrypto ${extension};\n`,
      })
    ).toEqual(expected)
  })
})
