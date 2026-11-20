import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { policyDomain, promotableTaskNote } from "./fixtures/rights"
import { acceptDebt } from "./helpers"

/*
 * Дозвільний перелік викликів одиниць-виразів (спека прав §5.3): подання й вирази
 * дослівних політик кличуть лише вбудовані з переліку, функції моделі й
 * поіменні функції провайдера — у будь-якому файлі, борг включно.
 */

const SHARED = "sql/public/extra.sql"
const DEBT_MODULE = "custom-tables/TaskNote/TaskNote.sql"
const MODEL_FUNCTION =
  "CREATE FUNCTION public.can_read(uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT true $$;\n"

const aggregate = (options: string) =>
  `CREATE AGGREGATE public.agg(int) (${options}, STYPE = int);\n`
const TRIGGER_FUNCTION =
  "CREATE FUNCTION public.on_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\n"
const trigger = (execute: string, when: string) =>
  `CREATE TRIGGER t BEFORE INSERT ON public.task_notes FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${execute}();\n`
const policy = (expression: string) =>
  `CREATE POLICY p ON public.task_notes FOR SELECT TO authenticated USING (${expression});\n`
const view = (expression: string) =>
  `CREATE VIEW public.v AS SELECT ${expression} AS x;\n`

/** Виклики поза переліком у діагностиках `sql.expression-call-not-allowed`. */
async function refusedCalls(file: string, sql: string) {
  const files = policyDomain(promotableTaskNote())
  files.set(file, sql)
  const result = await compile(await acceptDebt(files))
  return {
    calls: result.diagnostics
      .filter((d) => d.code === "sql.expression-call-not-allowed")
      .map((d) => d.params?.call),
    ok: result.ok,
  }
}

describe("expression units call only allowlisted functions (спека прав §5.3)", () => {
  const SET_CLAIMS = "pg_catalog.set_config('request.jwt.claims', '{}', false)"
  it.each([
    {
      name: "policy setting the claims",
      sql: policy(`${SET_CLAIMS} IS NOT NULL`),
      expected: ["pg_catalog.set_config"],
    },
    {
      name: "view setting the claims",
      sql: view(SET_CLAIMS),
      expected: ["pg_catalog.set_config"],
    },
    {
      name: "view executing SQL text",
      sql: view("query_to_xml('select 1', true, true, '')"),
      expected: ["query_to_xml"],
    },
    {
      name: "view calling an unknown provider function",
      sql: view("extensions.whatever()"),
      expected: ["extensions.whatever"],
    },
    {
      name: "policy advancing a sequence",
      sql: policy("nextval('public.s') > 0"),
      expected: ["nextval"],
    },
    {
      name: "policy calling an unqualified non-builtin",
      sql: MODEL_FUNCTION + policy("can_read(id)"),
      expected: ["can_read"],
    },
    {
      name: "policy comparing with auth.uid()",
      sql: policy("auth.uid() = id"),
      expected: [],
    },
    {
      name: "policy calling a model function",
      sql: MODEL_FUNCTION + policy("public.can_read(id)"),
      expected: [],
    },
    // Вбудовані з іменем відношення в тексті поза головою дозволені:
    // видно з них лише метадані.
    {
      name: "policy checking a table privilege",
      sql: policy("has_table_privilege('public.task_notes', 'select')"),
      expected: [],
    },
    {
      name: "view resolving a relation name",
      sql: view("pg_catalog.to_regclass('x.y')"),
      expected: [],
    },
    {
      name: "view calling builtins",
      sql: view("pg_catalog.lower('X') || gen_random_uuid()::text"),
      expected: [],
    },
    // Складові агрегату (І7, І9): їх виконує роль, що кличе агрегат.
    {
      name: "aggregate whose SFUNC is set_config",
      sql: aggregate("SFUNC = pg_catalog.set_config"),
      expected: ["pg_catalog.set_config"],
    },
    {
      name: "aggregate whose FINALFUNC is a provider function outside the list",
      sql: aggregate("SFUNC = int4pl, FINALFUNC = extensions.dblink_exec"),
      expected: ["extensions.dblink_exec"],
    },
    {
      name: "aggregate whose SFUNC is an unqualified non-builtin",
      sql: MODEL_FUNCTION + aggregate("SFUNC = can_read"),
      expected: ["can_read"],
    },
    {
      name: "aggregate over an unqualified builtin and a qualified model function",
      sql:
        MODEL_FUNCTION +
        aggregate("SFUNC = int4pl, FINALFUNC = public.can_read"),
      expected: [],
    },
    // Тригер (І8, І9): `EXECUTE FUNCTION` і `WHEN`.
    {
      name: "trigger executing a provider function outside the list",
      sql: trigger("extensions.whatever", "true"),
      expected: ["extensions.whatever"],
    },
    {
      name: "trigger whose WHEN calls a provider function outside the list",
      sql:
        TRIGGER_FUNCTION +
        trigger("public.on_note", "extensions.whatever() IS NOT NULL"),
      expected: ["extensions.whatever"],
    },
    {
      name: "trigger executing a pure function of an extension from the list",
      sql: trigger("extensions.moddatetime", "true"),
      expected: [],
    },
    {
      name: "trigger whose WHEN calls an extension function from the list",
      sql:
        TRIGGER_FUNCTION +
        trigger("public.on_note", "extensions.soundex('a') <> ''"),
      expected: [],
    },
    {
      name: "trigger executing tcn, which notifies outside the row",
      sql: trigger("extensions.triggered_change_notification", "true"),
      expected: ["extensions.triggered_change_notification"],
    },
    {
      name: "trigger executing an unqualified model function",
      sql: TRIGGER_FUNCTION + trigger("on_note", "true"),
      expected: ["on_note"],
    },
    {
      name: "trigger executing a model function",
      sql:
        TRIGGER_FUNCTION + trigger("public.on_note", "auth.uid() IS NOT NULL"),
      expected: [],
    },
    // Домен (І8): лише `DEFAULT`; `CHECK` судить правило голів.
    {
      name: "domain DEFAULT calling a provider function outside the list",
      sql: "CREATE DOMAIN public.d AS text DEFAULT extensions.whatever()::text;\n",
      expected: ["extensions.whatever"],
    },
    // Збіг з функцією моделі рятує лише в схемі застосунку (І21, Р7б).
    {
      name: "view calling a provider function that shares its name with a model function",
      sql:
        "CREATE FUNCTION extensions.dblink_exec(n int) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT n $$;\n" +
        view("extensions.dblink_exec('c', 'SELECT 1')"),
      expected: ["extensions.dblink_exec"],
    },
    {
      name: "view calling a model aggregate",
      sql:
        "CREATE AGGREGATE public.agg(int) (SFUNC = int4pl, STYPE = int);\n" +
        "CREATE VIEW public.v AS SELECT public.agg(1) AS x;\n",
      expected: [],
    },
  ])("$name", async ({ sql, expected }) => {
    // Спільний файл і модуль боргу прийнятої таблиці — борг: правило те саме.
    for (const file of [SHARED, DEBT_MODULE]) {
      const { calls, ok } = await refusedCalls(file, sql)
      expect(calls, file).toEqual(expected)
      // Дозволений вираз компілюється без помилок.
      if (expected.length === 0) expect(ok, file).toBe(true)
    }
  })
})

// `CHECK` домену судить суворіше правило голів: дозвільний перелік виразів його
// не дублює (друга діагностика була б шумом).
it("a domain CHECK is judged by the head rule only", async () => {
  const { calls } = await refusedCalls(
    SHARED,
    "CREATE DOMAIN public.d AS text CHECK (extensions.whatever() IS NOT NULL);\n"
  )
  expect(calls).toEqual([])
})

/*
 * `nextval`/`setval` на послідовність платформи судить форма `sequence` Правила
 * 1 (одне правило — одне місце): дозвільний перелік виразів її не дублює, але
 * решту викликів `nextval` в одиниці судить як раніше.
 */
describe("a call of a platform sequence is judged once", () => {
  async function codes(sql: string) {
    const files = policyDomain(promotableTaskNote())
    files.set(SHARED, sql)
    const result = await compile(await acceptDebt(files))
    return result.diagnostics
      .filter(
        (d) =>
          d.code === "sql.expression-call-not-allowed" ||
          d.code === "sql.kind-table-verbatim"
      )
      .map((d) => [d.code, d.params?.form ?? d.params?.call])
  }

  it.each([
    {
      name: "a view advancing a platform sequence",
      sql: view("nextval('simetra.row_version')"),
      expected: [["sql.kind-table-verbatim", "sequence"]],
    },
    {
      name: "a view with setval on a platform sequence",
      sql: view("pg_catalog.setval('simetra.row_version', 1)"),
      expected: [["sql.kind-table-verbatim", "sequence"]],
    },
    {
      name: "a policy with a non-literal argument",
      sql: policy("nextval(id::text::regclass) > 0"),
      expected: [["sql.kind-table-verbatim", "sequence"]],
    },
    {
      // Другий виклик — не платформної послідовності: його судить перелік.
      name: "a view advancing a platform and an application sequence",
      sql: view("nextval('simetra.row_version') + nextval('public.s')"),
      expected: [
        ["sql.expression-call-not-allowed", "nextval"],
        ["sql.kind-table-verbatim", "sequence"],
      ],
    },
    {
      name: "a view advancing an application sequence",
      sql: view("nextval('public.s')"),
      expected: [["sql.expression-call-not-allowed", "nextval"]],
    },
    // Раунд 3: ім'я без схеми судить форма `sequence` (одна діагностика).
    {
      name: "a view advancing an unqualified sequence",
      sql: view("nextval('ledger_id_seq')"),
      expected: [["sql.kind-table-verbatim", "sequence"]],
    },
    {
      name: "a policy reading currval of an unqualified sequence",
      sql: policy("currval('my_seq'::regclass) > 0"),
      expected: [["sql.kind-table-verbatim", "sequence"]],
    },
    {
      name: "a view reading currval of a qualified sequence",
      sql: view("currval('public.s')"),
      expected: [["sql.expression-call-not-allowed", "currval"]],
    },
    {
      name: "a view advancing an unqualified and a qualified sequence",
      sql: view("nextval('s') + nextval('public.s')"),
      expected: [
        ["sql.expression-call-not-allowed", "nextval"],
        ["sql.kind-table-verbatim", "sequence"],
      ],
    },
  ])("$name", async ({ sql, expected }) => {
    expect(await codes(sql)).toEqual(expected)
  })
})
