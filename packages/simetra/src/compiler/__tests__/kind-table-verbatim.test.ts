import { describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  fixFiles,
  promoteObject,
  type Diagnostic,
} from "simetra/compiler"
import { SQL_DEBT_FILE } from "simetra/model"
import {
  CHECKLIST_TABLE,
  HOURS_TABLES,
  TASK_NOTE_ADOPTED_TABLE,
  policyDomain,
  promotableTaskNote,
  taskNoteMapping,
} from "./fixtures/rights"
import { acceptDebt, uuid } from "./helpers"

const EXTRA = "sql/public/extra.sql"
const OTHER_SCHEMA = "sql/app/extra.sql"
const TASK_NOTE_MODULE = "custom-tables/TaskNote/TaskNote.sql"
const TASK_MODULE = "documents/Task/Task.sql"
const HANDLER = "public.count_comment()"

const policy = (table: string, name = "p") =>
  `CREATE POLICY ${name} ON ${table} FOR SELECT TO authenticated USING (true)`
const trigger = (table: string) =>
  `CREATE TRIGGER t BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${HANDLER}`

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

const verbatim = (
  file: string,
  identity: string,
  table: string,
  form: "policy" | "trigger"
) => ({
  code: "sql.kind-table-verbatim",
  file,
  params: { identity, table, form, line: 1 },
})

describe("sql.kind-table-verbatim", () => {
  // Таблиця виду — будь-яка таблиця знімка об'єкта виду, що не є прийнятою:
  // основна, ТЧ, похідна таблиця регістра, системний довідник прав. Форма
  // імені (некваліфіковане, у лапках, у файлі іншої схеми) не рятує: ціль —
  // з дерева розбору, а не з тексту.
  it.each([
    {
      name: "policy on the main table of a document",
      file: EXTRA,
      sql: policy("public.task"),
      identity: "policy:public.task.p",
      table: "public.task",
      form: "policy" as const,
    },
    {
      name: "policy on a tabular section table",
      file: EXTRA,
      sql: policy(`public.${CHECKLIST_TABLE}`),
      identity: `policy:public.${CHECKLIST_TABLE}.p`,
      table: `public.${CHECKLIST_TABLE}`,
      form: "policy" as const,
    },
    {
      name: "policy on the movements table of a register",
      file: EXTRA,
      sql: policy(`public.${HOURS_TABLES.movements}`),
      identity: `policy:public.${HOURS_TABLES.movements}.p`,
      table: `public.${HOURS_TABLES.movements}`,
      form: "policy" as const,
    },
    {
      name: "policy on the totals table of a register",
      file: EXTRA,
      sql: policy(`public.${HOURS_TABLES.totals}`),
      identity: `policy:public.${HOURS_TABLES.totals}.p`,
      table: `public.${HOURS_TABLES.totals}`,
      form: "policy" as const,
    },
    {
      name: "policy on a rights system catalog",
      file: EXTRA,
      sql: policy("public.org_roles"),
      identity: "policy:public.org_roles.p",
      table: "public.org_roles",
      form: "policy" as const,
    },
    {
      name: "restrictive policy",
      file: EXTRA,
      sql: "CREATE POLICY p ON public.task AS RESTRICTIVE FOR ALL TO authenticated USING (false)",
      identity: "policy:public.task.p",
      table: "public.task",
      form: "policy" as const,
    },
    {
      name: "unqualified table in a file of its schema",
      file: EXTRA,
      sql: policy("task"),
      identity: "policy:public.task.p",
      table: "public.task",
      form: "policy" as const,
    },
    {
      name: "quoted identifiers",
      file: EXTRA,
      sql: policy('"public"."task"', '"P"'),
      identity: "policy:public.task.P",
      table: "public.task",
      form: "policy" as const,
    },
    {
      // Рендер не задає `search_path`: некваліфіковане ім'я Postgres
      // розв'яже за шляхом сесії, тож схема файлу його не захищає.
      name: "unqualified table in a file of another schema",
      file: OTHER_SCHEMA,
      sql: policy("task"),
      identity: "policy:app.task.p",
      table: "public.task",
      form: "policy" as const,
    },
    {
      name: "trigger on the main table",
      file: EXTRA,
      sql: trigger("public.task"),
      identity: "trigger:public.task.t",
      table: "public.task",
      form: "trigger" as const,
    },
    {
      name: "constraint trigger",
      file: EXTRA,
      sql: `CREATE CONSTRAINT TRIGGER t AFTER UPDATE ON public.task DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${HANDLER}`,
      identity: "trigger:public.task.t",
      table: "public.task",
      form: "trigger" as const,
    },
    {
      name: "CREATE OR REPLACE TRIGGER on a tabular section",
      file: EXTRA,
      sql: `CREATE OR REPLACE TRIGGER t AFTER INSERT ON public.${CHECKLIST_TABLE} FOR EACH ROW EXECUTE FUNCTION ${HANDLER}`,
      identity: `trigger:public.${CHECKLIST_TABLE}.t`,
      table: `public.${CHECKLIST_TABLE}`,
      form: "trigger" as const,
    },
    {
      name: "statement trigger with a transition table",
      file: EXTRA,
      sql: `CREATE TRIGGER t AFTER UPDATE ON public.${HOURS_TABLES.movements} REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION ${HANDLER}`,
      identity: `trigger:public.${HOURS_TABLES.movements}.t`,
      table: `public.${HOURS_TABLES.movements}`,
      form: "trigger" as const,
    },
    {
      name: "policy in the debt module of an adopted table",
      file: TASK_NOTE_MODULE,
      sql: policy("public.task"),
      identity: "policy:public.task.p",
      table: "public.task",
      form: "policy" as const,
    },
    {
      name: "unqualified trigger in the debt module of an adopted table",
      file: TASK_NOTE_MODULE,
      sql: trigger(CHECKLIST_TABLE),
      identity: `trigger:public.${CHECKLIST_TABLE}.t`,
      table: `public.${CHECKLIST_TABLE}`,
      form: "trigger" as const,
    },
  ])(
    "$name → error, not debt",
    async ({ file, sql, identity, table, form }) => {
      // Без `sql-debt.json` перелік порожній: одиниця-борг дала б і
      // `sql.debt-grows`, а заборонена форма боргом не є.
      const result = await compile(files({ [file]: sql }))
      expect(brief(result.diagnostics)).toEqual([
        verbatim(file, identity, table, form),
      ])
    }
  )

  it("a listed verbatim policy on a kind table is an error and a stale entry", async () => {
    const result = await compile(
      files({ [EXTRA]: policy("public.task") }, ["policy:public.task.p"])
    )
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "sql.debt-stale",
      "sql.kind-table-verbatim",
    ])
  })

  it("fix drops a listed verbatim policy on a kind table from the debt list", async () => {
    // `fix` (як і introspect) рахує борг тим самим правилом, що й компіляція:
    // дослівна політика на таблиці виду боргом не буває, тож запис про неї
    // `fix` прибирає, а не лишає застарілим назавжди.
    const before = files({ [EXTRA]: policy("public.task") }, [
      "policy:public.task.p",
    ])
    let n = 970_000
    const result = await fixFiles(before, {
      schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
      newId: () => uuid(++n),
    })
    const fixed = applyChanges(before, result.changes)
    expect(JSON.parse(fixed.get(SQL_DEBT_FILE)!).units).toEqual([])
    expect((await compile(fixed)).diagnostics.map((d) => d.code)).toEqual([
      "sql.kind-table-verbatim",
    ])
  })

  it("a verbatim policy on an adopted table stays debt", async () => {
    const sql = {
      [TASK_NOTE_MODULE]: policy(`public.${TASK_NOTE_ADOPTED_TABLE}`),
    }
    const identity = `policy:public.${TASK_NOTE_ADOPTED_TABLE}.p`
    expect(brief((await compile(files(sql))).diagnostics)).toEqual([
      {
        code: "sql.debt-grows",
        file: TASK_NOTE_MODULE,
        params: { identity, line: 1 },
      },
    ])
    expect((await compile(files(sql, [identity]))).diagnostics).toEqual([])
  })

  it("a policy in a kind module is refused by the module rule alone", async () => {
    const result = await compile(
      files({ [TASK_MODULE]: policy("public.task") })
    )
    expect(result.diagnostics.map((d) => [d.code, d.params?.detail])).toEqual([
      ["sql.statement-not-allowed", "kindModule"],
    ])
  })
})

/** Функція plpgsql у закритій оболонці (боргом не є) з тілом `body`. */
const plpgsqlFn = (body: string, name = "public.f", shell = "VOLATILE") =>
  `CREATE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql ${shell} AS $$ DECLARE n int; BEGIN ${body}; END $$`
/** Функція `LANGUAGE sql` без волатильності — поза оболонкою, тобто борг. */
const sqlFn = (body: string) =>
  `CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ ${body} $$`

const bodyVerbatim = (
  file: string,
  table: string,
  statement: string,
  fn = "public.f",
  identity = `function:${fn}()`
) => ({
  code: "sql.kind-table-verbatim",
  file,
  params: {
    identity,
    function: fn,
    table,
    form: "functionBody",
    statement,
    line: 1,
  },
})

describe("sql.kind-table-verbatim: a function body changes a kind table (Р2c1-15)", () => {
  // Тіло будь-якої функції чи процедури, у будь-якому файлі, лише читає й
  // пише рядки таблиці виду (DML) і блокує її (`LOCK`): решта операторів
  // змінила б таблицю повз права й перевірки платформи — `TRUNCATE` повз RLS,
  // політика, тригер чи грант під час виконання. Такий оператор боргом не
  // буває, тож неперелічена функція поза оболонкою не дає `sql.debt-grows`.
  it.each([
    {
      name: "CREATE POLICY in a plpgsql body",
      file: EXTRA,
      sql: plpgsqlFn(policy("public.task")),
      expected: bodyVerbatim(EXTRA, "public.task", "CreatePolicyStmt"),
    },
    {
      // Функція поза оболонкою — борг, але не з таким тілом.
      name: "ALTER TABLE … DISABLE ROW LEVEL SECURITY in an sql body",
      file: EXTRA,
      sql: sqlFn("ALTER TABLE public.task DISABLE ROW LEVEL SECURITY"),
      expected: bodyVerbatim(EXTRA, "public.task", "AlterTableStmt"),
    },
    {
      name: "TRUNCATE of a tabular section table",
      file: EXTRA,
      sql: plpgsqlFn(`TRUNCATE public.${CHECKLIST_TABLE}`),
      expected: bodyVerbatim(
        EXTRA,
        `public.${CHECKLIST_TABLE}`,
        "TruncateStmt"
      ),
    },
    {
      name: "GRANT",
      file: EXTRA,
      sql: plpgsqlFn("GRANT INSERT ON public.task TO authenticated"),
      expected: bodyVerbatim(EXTRA, "public.task", "GrantStmt"),
    },
    {
      name: "literal EXECUTE 'CREATE POLICY …'",
      file: EXTRA,
      sql: plpgsqlFn(`EXECUTE '${policy("public.task")}'`),
      expected: bodyVerbatim(EXTRA, "public.task", "CreatePolicyStmt"),
    },
    {
      name: "in a kind module",
      file: TASK_MODULE,
      sql: plpgsqlFn(
        "ALTER TABLE public.task DISABLE TRIGGER ALL",
        "public.task_reopen"
      ),
      expected: bodyVerbatim(
        TASK_MODULE,
        "public.task",
        "AlterTableStmt",
        "public.task_reopen"
      ),
    },
    {
      name: "in the debt module of an adopted table",
      file: TASK_NOTE_MODULE,
      sql: sqlFn(`DROP POLICY task_read ON public.${HOURS_TABLES.movements}`),
      expected: bodyVerbatim(
        TASK_NOTE_MODULE,
        `public.${HOURS_TABLES.movements}`,
        "DropStmt"
      ),
    },
    {
      // Проба рев'ю: закрита оболонка не робить таке тіло дозволеним.
      name: "VOLATILE SECURITY DEFINER SET search_path = '' creating a policy",
      file: EXTRA,
      sql: plpgsqlFn(
        policy("public.task"),
        "public.f",
        "VOLATILE SECURITY DEFINER SET search_path = ''"
      ),
      expected: bodyVerbatim(EXTRA, "public.task", "CreatePolicyStmt"),
    },
    {
      name: "procedure",
      file: EXTRA,
      sql: "CREATE PROCEDURE public.f() LANGUAGE sql AS $$ CREATE INDEX ON public.task (id) $$",
      expected: bodyVerbatim(
        EXTRA,
        "public.task",
        "IndexStmt",
        "public.f",
        "procedure:public.f()"
      ),
    },
    {
      name: "COMMENT ON TABLE",
      file: EXTRA,
      sql: plpgsqlFn("COMMENT ON TABLE public.org_roles IS 'x'"),
      expected: bodyVerbatim(EXTRA, "public.org_roles", "CommentStmt"),
    },
    {
      name: "SECURITY LABEL ON TABLE",
      file: EXTRA,
      sql: plpgsqlFn("SECURITY LABEL FOR anon ON TABLE public.task IS 'x'"),
      expected: bodyVerbatim(EXTRA, "public.task", "SecLabelStmt"),
    },
    {
      // Шлях пошуку під час виконання статично не відомий: ім'я судиться за
      // будь-якою схемою, як у дослівної політики.
      name: "unqualified table in a function of another schema",
      file: OTHER_SCHEMA,
      sql: plpgsqlFn(policy("task"), "app.f"),
      expected: bodyVerbatim(
        OTHER_SCHEMA,
        "public.task",
        "CreatePolicyStmt",
        "app.f"
      ),
    },
    {
      name: "a child table of a kind table",
      file: EXTRA,
      sql: plpgsqlFn(
        "CREATE TABLE public.task_extra () INHERITS (public.task)"
      ),
      expected: bodyVerbatim(EXTRA, "public.task", "CreateStmt"),
    },
    {
      // Схема цілком: грант на кожну її таблицю, зокрема таблиці виду.
      name: "GRANT … ON ALL TABLES IN SCHEMA",
      file: EXTRA,
      sql: plpgsqlFn(
        "GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO authenticated"
      ),
      expected: bodyVerbatim(EXTRA, "public.announcement", "GrantStmt"),
    },
    {
      name: "DROP SCHEMA",
      file: EXTRA,
      sql: plpgsqlFn("DROP SCHEMA public CASCADE"),
      expected: bodyVerbatim(EXTRA, "public.announcement", "DropStmt"),
    },
    {
      name: "ALTER SCHEMA … RENAME",
      file: EXTRA,
      sql: plpgsqlFn("ALTER SCHEMA public RENAME TO old_public"),
      expected: bodyVerbatim(EXTRA, "public.announcement", "RenameStmt"),
    },
    {
      // Власник схеми може видалити будь-яку її таблицю.
      name: "ALTER SCHEMA … OWNER",
      file: EXTRA,
      sql: plpgsqlFn("ALTER SCHEMA public OWNER TO authenticated"),
      expected: bodyVerbatim(EXTRA, "public.announcement", "AlterOwnerStmt"),
    },
    {
      name: "a DO block in a body",
      file: EXTRA,
      sql: plpgsqlFn("DO $d$ BEGIN TRUNCATE public.task; END $d$"),
      expected: bodyVerbatim(EXTRA, "public.task", "TruncateStmt"),
    },
    {
      name: "a function defined in a body",
      file: EXTRA,
      sql: plpgsqlFn(
        "CREATE FUNCTION pg_temp.g() RETURNS void LANGUAGE sql AS $g$ TRUNCATE public.task $g$; PERFORM pg_temp.g()"
      ),
      expected: bodyVerbatim(EXTRA, "public.task", "TruncateStmt"),
    },
  ])("$name → error, not debt", async ({ file, sql, expected }) => {
    const result = await compile(files({ [file]: sql }))
    expect(brief(result.diagnostics)).toEqual([expected])
  })

  it("a listed function with such a body is an error and a stale entry", async () => {
    const result = await compile(
      files({ [EXTRA]: sqlFn("TRUNCATE public.task") }, ["function:public.f()"])
    )
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "sql.debt-stale",
      "sql.kind-table-verbatim",
    ])
  })

  // Рядки DML — під RLS і правами таблиці, як і запит команди; `LOCK` рядків
  // не змінює. Таблиця виду, яку оператор поза DML лише читає вкладеним
  // запитом, його ціллю не є.
  it.each([
    ["SELECT", "PERFORM 1 FROM public.task"],
    ["SELECT … INTO", "SELECT count(*) INTO STRICT n FROM public.task"],
    [
      "INSERT",
      `INSERT INTO public.${CHECKLIST_TABLE} SELECT * FROM public.${CHECKLIST_TABLE} WHERE false`,
    ],
    ["UPDATE", "UPDATE public.task SET id = id WHERE false"],
    ["DELETE", "DELETE FROM public.task WHERE false"],
    [
      "MERGE",
      "MERGE INTO public.task t USING (SELECT 1 AS x) s ON false WHEN NOT MATCHED THEN DO NOTHING",
    ],
    ["LOCK", "LOCK TABLE public.task IN SHARE MODE"],
    [
      "DML in a literal EXECUTE",
      "EXECUTE 'DELETE FROM public.task WHERE false'",
    ],
    ["a policy on a CustomTable", policy(`public.${TASK_NOTE_ADOPTED_TABLE}`)],
    ["TRUNCATE of a CustomTable", `TRUNCATE public.${TASK_NOTE_ADOPTED_TABLE}`],
    [
      "a policy on a CustomTable reading a kind table",
      `CREATE POLICY p ON public.${TASK_NOTE_ADOPTED_TABLE} FOR SELECT USING (EXISTS (SELECT 1 FROM public.task))`,
    ],
    [
      "a temporary table copied from a kind table",
      "CREATE TEMP TABLE snapshot AS SELECT * FROM public.task",
    ],
  ])("%s → no error", async (_, body) => {
    // Літеральний `EXECUTE` виводить функцію з оболонки, тож вона — борг:
    // перелік приймає його, і лишається лише те, що судить це правило.
    const result = await compile(
      await acceptDebt(files({ [EXTRA]: plpgsqlFn(body) }))
    )
    expect(brief(result.diagnostics)).toEqual([])
  })
})

describe("other verbatim forms on a kind table keep their own codes (Р2c1-2)", () => {
  it.each([
    "ALTER TABLE public.task DISABLE ROW LEVEL SECURITY",
    "ALTER TABLE public.task NO FORCE ROW LEVEL SECURITY",
    "ALTER TABLE public.task DISABLE TRIGGER ALL",
    "ALTER TABLE public.task ENABLE ALWAYS TRIGGER t",
    "ALTER TABLE public.task ENABLE REPLICA RULE r",
    "ALTER TABLE public.task OWNER TO authenticated",
    "ALTER TABLE public.task ATTACH PARTITION public.task_part FOR VALUES IN (1)",
    "ALTER TABLE public.task INHERIT public.task_comment",
    "CREATE TABLE public.task_part PARTITION OF public.task FOR VALUES IN (1)",
    "CREATE TABLE public.task_child () INHERITS (public.task)",
    "CREATE RULE r AS ON UPDATE TO public.task DO INSTEAD NOTHING",
    "ALTER POLICY p ON public.task USING (true)",
    "ALTER TRIGGER t ON public.task RENAME TO u",
    "DROP POLICY p ON public.task",
    `CREATE EVENT TRIGGER e ON ddl_command_end EXECUTE FUNCTION ${HANDLER}`,
  ])("%s → sql.statement-not-allowed", async (sql) => {
    const result = await compile(files({ [EXTRA]: sql }))
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "sql.statement-not-allowed",
    ])
  })

  it.each([
    "GRANT INSERT ON public.task TO authenticated",
    // Привілей TRIGGER дав би ролі самій вішати тригер на таблицю виду.
    "GRANT TRIGGER ON public.task TO authenticated",
    "GRANT SELECT ON task TO anon",
  ])("%s → sql.generated-grant", async (sql) => {
    const result = await compile(await acceptDebt(files({ [EXTRA]: sql })))
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "sql.generated-grant",
    ])
  })
})

describe("promotion and verbatim policies (Р2c1-3)", () => {
  it("a promotion removes verbatim policies of the promoted table", async () => {
    const identity = `policy:public.${TASK_NOTE_ADOPTED_TABLE}.task_notes_read`
    const before = await acceptDebt(
      files({
        [TASK_NOTE_MODULE]: policy(
          `public.${TASK_NOTE_ADOPTED_TABLE}`,
          "task_notes_read"
        ),
      })
    )
    expect((await compile(before)).diagnostics).toEqual([])
    const mapping = taskNoteMapping()
    mapping.conversions = { [identity]: "platform" }
    let n = 960_000
    const result = await promoteObject(before, mapping, {
      schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
      newId: () => uuid(++n),
    })
    expect(result.diagnostics).toEqual([])
    const after = await compile(applyChanges(before, result.changes), {
      baseline: before,
    })
    expect(after.diagnostics).toEqual([])
  })
})
