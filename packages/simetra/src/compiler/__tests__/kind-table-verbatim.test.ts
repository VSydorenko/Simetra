import { describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  fixFiles,
  promoteObject,
  type Diagnostic,
} from "simetra/compiler"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_OWNER_ROLES,
  SQL_DEBT_FILE,
  quoteIdent,
  type DatabaseProvider,
} from "simetra/model"
import {
  CHECKLIST_TABLE,
  HOURS_TABLES,
  TASK_FILE,
  TASK_NOTE_ADOPTED_TABLE,
  policyDomain,
  promotableTaskNote,
  taskNoteMapping,
} from "./fixtures/rights"
import { SNAPSHOT_TABLES } from "../rights/actor-snapshot"
import { tableGrants } from "../access-units"
import { ROW_VERSION_SEQUENCE } from "../mechanics-units"
import { executeGrants, sequenceRevokes } from "../sql/execute-grants"
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
      identity: 'policy:public.task."P"',
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
/**
 * Подання моделі `v1` над `v2` над `public.task` — автооновлювані. З
 * `security_invoker`: подання без нього саме шлях запису (форма `view`), а
 * випадок тут про DML тіла.
 */
const VIEWS =
  "CREATE VIEW public.v2 WITH (security_invoker = true) AS SELECT * FROM public.task;\nCREATE VIEW public.v1 WITH (security_invoker = true) AS SELECT * FROM public.v2;\n"

const bodyVerbatim = (
  file: string,
  table: string,
  statement: string,
  fn = "public.f",
  identity = `function:${fn}()`,
  line = 1,
  unqualified = false
) => ({
  code: "sql.kind-table-verbatim",
  file,
  params: {
    identity,
    function: fn,
    table,
    form: "functionBody",
    statement,
    line,
    ...(unqualified ? { unqualified: "yes" } : {}),
  },
})

describe("sql.kind-table-verbatim: application SQL does not write a kind table (Rule 1, спека прав §6.1)", () => {
  // Таблицю виду пишуть лише ядро команд, оболонка проведення й тригери
  // платформи: DML застосунку в неї обійшов би права, рухи й перевірки
  // команди. Ціль — лише відношення, яке оператор змінює (`relation`), тож
  // таблиця, яку DML лише читає, ціллю не є. Такий оператор боргом не буває,
  // тож неперелічена функція поза оболонкою не дає `sql.debt-grows`.
  it.each([
    {
      name: "INSERT",
      sql: plpgsqlFn("INSERT INTO public.task (id) VALUES (NULL)"),
      expected: bodyVerbatim(EXTRA, "public.task", "InsertStmt"),
    },
    {
      name: "UPDATE",
      sql: plpgsqlFn("UPDATE public.task SET id = id WHERE false"),
      expected: bodyVerbatim(EXTRA, "public.task", "UpdateStmt"),
    },
    {
      name: "DELETE in an sql body",
      sql: sqlFn("DELETE FROM public.task WHERE false"),
      expected: bodyVerbatim(EXTRA, "public.task", "DeleteStmt"),
    },
    {
      name: "MERGE",
      sql: plpgsqlFn(
        "MERGE INTO public.task t USING (SELECT 1 AS x) s ON false WHEN NOT MATCHED THEN DO NOTHING"
      ),
      expected: bodyVerbatim(EXTRA, "public.task", "MergeStmt"),
    },
    {
      name: "a tabular section table",
      sql: plpgsqlFn(`DELETE FROM public.${CHECKLIST_TABLE} WHERE false`),
      expected: bodyVerbatim(EXTRA, `public.${CHECKLIST_TABLE}`, "DeleteStmt"),
    },
    {
      name: "the movements table of a register",
      sql: plpgsqlFn(
        `DELETE FROM public.${HOURS_TABLES.movements} WHERE false`
      ),
      expected: bodyVerbatim(
        EXTRA,
        `public.${HOURS_TABLES.movements}`,
        "DeleteStmt"
      ),
    },
    {
      // Тригери платформи переносять запис у джерело ідентичностей у
      // «Користувачі» й `simetra.identities` (спека прав §6.1).
      name: "the identity source table of the provider",
      sql: plpgsqlFn("UPDATE auth.users SET email = NULL WHERE false"),
      expected: bodyVerbatim(EXTRA, "auth.users", "UpdateStmt"),
    },
    {
      name: "DML in a literal EXECUTE",
      sql: plpgsqlFn("EXECUTE 'DELETE FROM public.task WHERE false'"),
      expected: bodyVerbatim(EXTRA, "public.task", "DeleteStmt"),
    },
    {
      name: "a DO block in a body",
      sql: plpgsqlFn(
        "DO $d$ BEGIN DELETE FROM public.task WHERE false; END $d$"
      ),
      expected: bodyVerbatim(EXTRA, "public.task", "DeleteStmt"),
    },
    {
      name: "BEGIN ATOMIC",
      sql: "CREATE FUNCTION public.f() RETURNS void LANGUAGE sql BEGIN ATOMIC INSERT INTO public.task (id) VALUES (NULL); END",
      expected: bodyVerbatim(EXTRA, "public.task", "InsertStmt"),
    },
    {
      // Вкладений оператор, що змінює дані, судиться окремо.
      name: "a data-modifying CTE",
      sql: sqlFn("WITH d AS (DELETE FROM public.task RETURNING 1) SELECT 1"),
      expected: bodyVerbatim(EXTRA, "public.task", "DeleteStmt"),
    },
    {
      // Postgres переписує запис в автооновлюване подання на базову таблицю,
      // тож подання моделі розгортається до відношень визначення.
      name: "a model view over a model view over a kind table",
      sql: VIEWS + plpgsqlFn("INSERT INTO public.v1 (id) VALUES (NULL)"),
      expected: bodyVerbatim(
        EXTRA,
        "public.task",
        "InsertStmt",
        "public.f",
        "function:public.f()",
        3
      ),
    },
    {
      name: "procedure",
      sql: "CREATE PROCEDURE public.f() LANGUAGE sql AS $$ DELETE FROM public.task WHERE false $$",
      expected: bodyVerbatim(
        EXTRA,
        "public.task",
        "DeleteStmt",
        "public.f",
        "procedure:public.f()"
      ),
    },
    {
      // Шлях пошуку під час виконання статично не відомий: ім'я судиться за
      // будь-якою схемою, як у дослівної політики.
      name: "unqualified table in a function of another schema",
      file: OTHER_SCHEMA,
      sql: plpgsqlFn("DELETE FROM task WHERE false", "app.f"),
      expected: bodyVerbatim(
        OTHER_SCHEMA,
        "public.task",
        "DeleteStmt",
        "app.f",
        "function:app.f()",
        1,
        true
      ),
    },
    {
      name: "in a kind module",
      file: TASK_MODULE,
      sql: plpgsqlFn(
        "DELETE FROM public.task WHERE false",
        "public.task_reopen"
      ),
      expected: bodyVerbatim(
        TASK_MODULE,
        "public.task",
        "DeleteStmt",
        "public.task_reopen"
      ),
    },
    {
      name: "in the debt module of an adopted table",
      file: TASK_NOTE_MODULE,
      sql: sqlFn(`DELETE FROM public.${HOURS_TABLES.movements} WHERE false`),
      expected: bodyVerbatim(
        TASK_NOTE_MODULE,
        `public.${HOURS_TABLES.movements}`,
        "DeleteStmt"
      ),
    },
  ])("$name → error, not debt", async ({ file = EXTRA, sql, expected }) => {
    const result = await compile(await acceptDebt(files({ [file]: sql })))
    expect(brief(result.diagnostics)).toEqual([expected])
  })

  // Таблиці схеми `simetra` пише лише платформа: `rightsAdminTables` і
  // `identities` дають їм походження об'єкта виду, тож Правило 1 судить і
  // їх. Без походження функція застосунку переписала б знімок актора чи
  // журнал прав повз команду.
  it.each([
    "simetra.rights_versions",
    "simetra.rights_journal",
    "simetra.rights_tx_pending",
    "simetra.identities",
    ...Object.values(SNAPSHOT_TABLES).map((t) => `${t.schema}.${t.name}`),
  ])(
    "%s → error: a platform table of the snapshot is a kind table",
    async (table) => {
      const result = await compile(
        await acceptDebt(
          files({ [EXTRA]: plpgsqlFn(`DELETE FROM ${table} WHERE false`) })
        )
      )
      expect(brief(result.diagnostics)).toEqual([
        bodyVerbatim(EXTRA, table, "DeleteStmt"),
      ])
    }
  )

  // Уся схема `simetra` закрита для DML застосунку (Правило 1): стан
  // застосування, квитанції й черга сигналів живуть поза знімком, а
  // `SECURITY DEFINER`-функція писала б їх від імені власника. Кваліфікована
  // ціль — будь-яке ім'я схеми, некваліфікована — fail-closed за відомими
  // таблицями схеми.
  it.each([
    {
      name: "INSERT into a table of the apply state",
      sql: plpgsqlFn("INSERT INTO simetra.ledger DEFAULT VALUES"),
      expected: bodyVerbatim(EXTRA, "simetra.ledger", "InsertStmt"),
    },
    {
      name: "UPDATE of the epoch row",
      sql: sqlFn("UPDATE simetra.version_epoch SET epoch = gen_random_uuid()"),
      expected: bodyVerbatim(EXTRA, "simetra.version_epoch", "UpdateStmt"),
    },
    {
      name: "DELETE from a table the snapshot does not know",
      sql: plpgsqlFn("DELETE FROM simetra.outbox WHERE false"),
      expected: bodyVerbatim(EXTRA, "simetra.outbox", "DeleteStmt"),
    },
    {
      name: "MERGE into a platform table",
      sql: plpgsqlFn(
        "MERGE INTO simetra.receipts r USING (SELECT 1 AS x) s ON false WHEN NOT MATCHED THEN DO NOTHING"
      ),
      expected: bodyVerbatim(EXTRA, "simetra.receipts", "MergeStmt"),
    },
    {
      name: "a SECURITY DEFINER function",
      sql: "CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$ BEGIN DELETE FROM simetra.marker WHERE false; END $$",
      expected: bodyVerbatim(EXTRA, "simetra.marker", "DeleteStmt"),
    },
    {
      // Шлях пошуку викликача може вести в `simetra`.
      name: "an unqualified table of the apply state",
      sql: plpgsqlFn("DELETE FROM ledger WHERE false"),
      expected: bodyVerbatim(
        EXTRA,
        "simetra.ledger",
        "DeleteStmt",
        "public.f",
        "function:public.f()",
        1,
        true
      ),
    },
    {
      name: "a DO block in a body",
      sql: plpgsqlFn(
        "DO $d$ BEGIN DELETE FROM simetra.outbox WHERE false; END $d$"
      ),
      expected: bodyVerbatim(EXTRA, "simetra.outbox", "DeleteStmt"),
    },
    {
      name: "a data-modifying CTE",
      sql: sqlFn("WITH d AS (DELETE FROM simetra.outbox RETURNING 1) SELECT 1"),
      expected: bodyVerbatim(EXTRA, "simetra.outbox", "DeleteStmt"),
    },
    {
      name: "DML in a literal EXECUTE",
      sql: plpgsqlFn("EXECUTE 'INSERT INTO simetra.outbox DEFAULT VALUES'"),
      expected: bodyVerbatim(EXTRA, "simetra.outbox", "InsertStmt"),
    },
  ])(
    "$name → error: a table of the platform schema",
    async ({ sql, expected }) => {
      const result = await compile(await acceptDebt(files({ [EXTRA]: sql })))
      expect(brief(result.diagnostics)).toEqual([expected])
    }
  )

  it("reading a table of the platform schema stays allowed", async () => {
    const result = await compile(
      await acceptDebt(
        files({
          [EXTRA]: plpgsqlFn(
            "PERFORM 1 FROM simetra.version_epoch",
            "public.f",
            ""
          ),
        })
      )
    )
    expect(brief(result.diagnostics)).toEqual([])
  })

  it("a listed function with such a body is an error and a stale entry", async () => {
    const result = await compile(
      files({ [EXTRA]: sqlFn("DELETE FROM public.task WHERE false") }, [
        "function:public.f()",
      ])
    )
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "sql.debt-stale",
      "sql.kind-table-verbatim",
    ])
  })

  // Читання й блокування рядків таблиці виду — під RLS і правами таблиці,
  // як запит команди; таблиця, яку DML лише читає (`FROM`, `USING`), ціллю
  // не є.
  it.each([
    ["SELECT", "PERFORM 1 FROM public.task"],
    ["SELECT … INTO", "SELECT count(*) INTO STRICT n FROM public.task"],
    ["SELECT … FOR UPDATE", "PERFORM 1 FROM public.task FOR UPDATE"],
    ["LOCK", "LOCK TABLE public.task IN SHARE MODE"],
    [
      "INSERT into a CustomTable",
      `INSERT INTO public.${TASK_NOTE_ADOPTED_TABLE} (id) SELECT id FROM public.task`,
    ],
    [
      "UPDATE … FROM a kind table",
      `UPDATE public.${TASK_NOTE_ADOPTED_TABLE} n SET name = n.name FROM public.task t WHERE n.task_id = t.id`,
    ],
    [
      "DELETE … USING a kind table",
      `DELETE FROM public.${TASK_NOTE_ADOPTED_TABLE} n USING public.task t WHERE n.task_id = t.id`,
    ],
    [
      "MERGE … USING a kind table",
      `MERGE INTO public.${TASK_NOTE_ADOPTED_TABLE} n USING public.task t ON n.task_id = t.id WHEN MATCHED THEN DELETE`,
    ],
  ])("%s → no error", async (_, body) => {
    // Функція без волатильності — борг: перелік приймає його, і лишається
    // лише те, що судить це правило.
    const result = await compile(
      await acceptDebt(files({ [EXTRA]: plpgsqlFn(body, "public.f", "") }))
    )
    expect(brief(result.diagnostics)).toEqual([])
  })
})

describe("other verbatim forms on a kind table keep their own codes", () => {
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

describe("promotion and verbatim policies", () => {
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

// Шляхи запису Правила 1 крім DML тіла (спека прав §6.1, підрозділ «Шляхи
// запису й посилання на функції»): подання, гранти, типові привілеї, тригер і
// політика на джерелі ідентичностей, зміна послідовності платформи. Кожен
// рядок — один шлях перелічувача `writePaths`.
const API = PROVIDER_API_ROLES.supabase
const API_ROLES = [API.user, API.anonymous, API.service].join(", ")
const COMMAND = PLATFORM_ROLES.command
const FROM_API = `${API.user}, ${API.anonymous}, ${API.service}`
const IDENTITY = "auth.users"

/** Помилки Правила 1 з одиниць файлу `EXTRA`, у стислому вигляді. */
async function rule1(
  sql: string,
  file = EXTRA
): Promise<Record<string, string | number | undefined>[]> {
  const result = await compile(await acceptDebt(files({ [file]: sql })))
  return result.diagnostics
    .filter((d) => d.code === "sql.kind-table-verbatim")
    .map((d) => ({ ...d.params, file: d.file }))
}

const viewPath = (
  identity: string,
  roles: string,
  table = "public.task",
  line = 1
) => ({
  file: EXTRA,
  identity,
  table,
  form: "view",
  roles,
  line,
})

describe("sql.kind-table-verbatim: a view writes a kind table (І2–І5)", () => {
  const V = "CREATE VIEW public.v"
  const OVER = "AS SELECT t.id FROM public.task t"
  const revokeApi = `REVOKE ALL ON public.v FROM PUBLIC, ${FROM_API};`

  it.each([
    {
      name: "an updatable view without security_invoker (every API role writes by default)",
      sql: `${V} ${OVER};`,
      expected: [viewPath("view:public.v", API_ROLES)],
    },
    {
      name: "security_invoker = false",
      sql: `${V} WITH (security_invoker = false) ${OVER};`,
      expected: [viewPath("view:public.v", API_ROLES)],
    },
    {
      // Невідоме значення опції — подання без неї (fail-closed).
      name: "an unknown value of security_invoker",
      sql: `${V} WITH (security_invoker = maybe) ${OVER};`,
      expected: [viewPath("view:public.v", API_ROLES)],
    },
    {
      // Postgres судить автооновлюваність за використанням віконних функцій, а
      // не за наявністю клаузи WINDOW: невикористане вікно подання не закриває.
      name: "a view with an unused WINDOW clause",
      sql: `${V} AS SELECT t.id FROM public.task t WINDOW w AS (ORDER BY t.id);`,
      expected: [viewPath("view:public.v", API_ROLES)],
    },
    {
      name: "a view with WHERE and a column list",
      sql: `${V} AS SELECT t.id FROM public.task t WHERE t.id IS NOT NULL;`,
      expected: [viewPath("view:public.v", API_ROLES)],
    },
    {
      // Невпізнана функція у списку вибору неоновлюваність не доводить.
      name: "a view with a scalar function in the select list",
      sql: `${V} AS SELECT lower(t.id::text) AS id FROM public.task t;`,
      expected: [viewPath("view:public.v", API_ROLES)],
    },
    {
      name: "a view over the identity source of the provider",
      sql: `${V} AS SELECT u.id FROM ${IDENTITY} u;`,
      expected: [viewPath("view:public.v", API_ROLES, IDENTITY)],
    },
    {
      // Шлях пошуку сесії може вести в `simetra`: некваліфіковане ім'я судиться
      // за відомими таблицями схеми.
      name: "a view over an unqualified table of the platform schema",
      sql: `${V} AS SELECT l.id FROM ledger l;`,
      expected: [viewPath("view:public.v", API_ROLES, "simetra.ledger")],
    },
    {
      // Вкладене подання без `security_invoker` судиться окремим входом.
      name: "a view over a view without security_invoker: both are paths",
      sql: `CREATE VIEW public.v2 AS SELECT * FROM public.task;\n${V} AS SELECT * FROM public.v2;`,
      expected: [
        viewPath("view:public.v2", API_ROLES, "public.task", 1),
        viewPath("view:public.v", API_ROLES, "public.task", 2),
      ],
    },
    {
      name: "a view with the write revoked from PUBLIC and the API roles but granted to the command role",
      sql: `${V} ${OVER};\n${revokeApi}\nGRANT UPDATE ON public.v TO ${COMMAND};`,
      expected: [viewPath("view:public.v", COMMAND)],
    },
    {
      // Ключ цілі гранту — за правилом ідентичності (#297): відкликання й
      // грант на подання `"V"` мають влучити в нього.
      name: "a view named in quotes with the write revoked from PUBLIC and the API roles but granted to the command role",
      sql: `CREATE VIEW public."V" ${OVER};\nREVOKE ALL ON public."V" FROM PUBLIC, ${FROM_API};\nGRANT UPDATE ON public."V" TO ${COMMAND};`,
      expected: [viewPath('view:public."V"', COMMAND)],
    },
    {
      // `PUBLIC` пише крізь подання лише явним грантом, а з ним — і кожна роль API.
      name: "a view with an explicit grant to PUBLIC",
      sql: `${V} ${OVER};\n${revokeApi}\nGRANT INSERT ON public.v TO PUBLIC;`,
      expected: [viewPath("view:public.v", `PUBLIC, ${API_ROLES}`)],
    },
    {
      name: "a view with a column grant of the write",
      sql: `${V} ${OVER};\n${revokeApi}\nGRANT UPDATE (id) ON public.v TO ${COMMAND};`,
      expected: [viewPath("view:public.v", COMMAND)],
    },
    {
      // Відкликано лише `INSERT`: `UPDATE` і `DELETE` крізь подання лишились.
      name: "a view with only INSERT revoked",
      sql: `${V} ${OVER};\nREVOKE INSERT ON public.v FROM PUBLIC, ${FROM_API};`,
      expected: [viewPath("view:public.v", API_ROLES)],
    },
    {
      // Типові привілеї схеми діють незалежно від порядку операторів.
      name: "a view in a schema whose default privileges give an API role the write",
      sql: `${V} ${OVER};\n${revokeApi}\nALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT ON TABLES TO ${API.user};`,
      expected: [viewPath("view:public.v", API.user)],
      withDefaults: true,
    },
  ])("$name → error", async ({ sql, expected, withDefaults }) => {
    const found = await rule1(sql)
    const views = found.filter((p) => p.form === "view")
    expect(views).toEqual(expected)
    if (withDefaults !== true) expect(found).toEqual(views)
  })

  it.each([
    {
      name: "security_invoker",
      sql: `${V} WITH (security_invoker = true) ${OVER};`,
    },
    {
      name: "security_invoker = on",
      sql: `${V} WITH (security_invoker = on) ${OVER};`,
    },
    {
      // Подання з `security_invoker` — не шлях, а вкладене без нього судиться саме.
      name: "an invoker view over a view without security_invoker",
      sql: `CREATE VIEW public.v2 WITH (security_invoker = true) AS SELECT * FROM public.task;\n${V} WITH (security_invoker = true) AS SELECT * FROM public.v2;`,
    },
    {
      name: "DISTINCT",
      sql: `${V} AS SELECT DISTINCT t.id FROM public.task t;`,
    },
    {
      name: "GROUP BY",
      sql: `${V} AS SELECT t.id FROM public.task t GROUP BY t.id;`,
    },
    {
      name: "HAVING",
      sql: `${V} AS SELECT t.id FROM public.task t GROUP BY t.id HAVING count(*) > 0;`,
    },
    { name: "LIMIT", sql: `${V} AS SELECT t.id FROM public.task t LIMIT 1;` },
    { name: "OFFSET", sql: `${V} AS SELECT t.id FROM public.task t OFFSET 1;` },
    {
      name: "WITH",
      sql: `${V} AS WITH x AS (SELECT 1) SELECT t.id FROM public.task t;`,
    },
    {
      name: "UNION",
      sql: `${V} AS SELECT t.id FROM public.task t UNION SELECT t.id FROM public.task t;`,
    },
    {
      name: "a join",
      sql: `${V} AS SELECT t.id FROM public.task t JOIN public.task u ON u.id = t.id;`,
    },
    {
      name: "two relations in FROM",
      sql: `${V} AS SELECT t.id FROM public.task t, public.task u;`,
    },
    {
      name: "a subquery in FROM",
      sql: `${V} AS SELECT s.id FROM (SELECT id FROM public.task) s;`,
    },
    {
      name: "an aggregate",
      sql: `${V} AS SELECT count(*) AS id FROM public.task t;`,
    },
    {
      name: "a window function",
      sql: `${V} AS SELECT row_number() OVER () AS id FROM public.task t;`,
    },
    {
      name: "a window function over a named window",
      sql: `${V} AS SELECT row_number() OVER w AS id FROM public.task t WINDOW w AS (ORDER BY t.id);`,
    },
    {
      name: "the write revoked from PUBLIC and every API role",
      sql: `${V} ${OVER};\nREVOKE ALL ON public.v FROM PUBLIC, ${FROM_API};`,
    },
    {
      name: "INSERT, UPDATE and DELETE revoked one by one",
      sql: `${V} ${OVER};\nREVOKE INSERT, UPDATE, DELETE ON public.v FROM PUBLIC, ${FROM_API};`,
    },
    {
      name: "a view over a table that is not a kind table",
      sql: `${V} AS SELECT n.id FROM public.${TASK_NOTE_ADOPTED_TABLE} n;`,
    },
    {
      name: "a materialized view",
      sql: `CREATE MATERIALIZED VIEW public.v AS SELECT t.id FROM public.task t;`,
    },
  ])("$name → no path", async ({ sql }) => {
    expect(await rule1(sql)).toEqual([])
  })

  it("a view without security_invoker in the debt module of an adopted table is an error", async () => {
    expect(await rule1(`${V} ${OVER};`, TASK_NOTE_MODULE)).toEqual([
      { ...viewPath("view:public.v", API_ROLES), file: TASK_NOTE_MODULE },
    ])
  })
})

describe("sql.kind-table-verbatim: a grant of the write (І6, І19)", () => {
  it.each([
    {
      name: "INSERT on the identity source to the command role",
      sql: `GRANT INSERT ON ${IDENTITY} TO ${COMMAND};`,
      roles: COMMAND,
    },
    {
      // Привілей `TRIGGER` дав би ролі самій вішати тригер `BEFORE`.
      name: "TRIGGER",
      sql: `GRANT TRIGGER ON ${IDENTITY} TO ${API.user};`,
      roles: API.user,
    },
    {
      name: "TRUNCATE",
      sql: `GRANT TRUNCATE ON ${IDENTITY} TO ${COMMAND};`,
      roles: COMMAND,
    },
    {
      name: "ALL",
      sql: `GRANT ALL ON ${IDENTITY} TO ${COMMAND};`,
      roles: COMMAND,
    },
    {
      name: "a column grant to PUBLIC",
      sql: `GRANT UPDATE (email) ON ${IDENTITY} TO PUBLIC;`,
      roles: "PUBLIC",
    },
    {
      name: "a mixed privilege list",
      sql: `GRANT SELECT, DELETE ON ${IDENTITY} TO ${COMMAND};`,
      roles: COMMAND,
    },
    {
      name: "several grantees",
      sql: `GRANT UPDATE ON ${IDENTITY} TO ${COMMAND}, ${API.anonymous};`,
      roles: `${COMMAND}, ${API.anonymous}`,
    },
  ])("$name → error", async ({ sql, roles }) => {
    const found = await rule1(sql)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ form: "grant", table: IDENTITY, roles })
  })

  // Грант на всі таблиці схеми закриває сама граматика одиниць: Правилу 1 його
  // судити нема чого.
  it("GRANT … ON ALL TABLES IN SCHEMA → sql.statement-not-allowed", async () => {
    const result = await compile(
      await acceptDebt(
        files({
          [EXTRA]: `GRANT INSERT ON ALL TABLES IN SCHEMA auth TO ${COMMAND};`,
        })
      )
    )
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "sql.statement-not-allowed",
    ])
  })

  it.each([
    { name: "SELECT", sql: `GRANT SELECT ON ${IDENTITY} TO ${COMMAND};` },
    {
      name: "REFERENCES",
      sql: `GRANT REFERENCES ON ${IDENTITY} TO ${COMMAND};`,
    },
    { name: "a REVOKE", sql: `REVOKE INSERT ON ${IDENTITY} FROM ${COMMAND};` },
    {
      name: "the owner of the provider",
      sql: `GRANT INSERT ON ${IDENTITY} TO ${PROVIDER_OWNER_ROLES.supabase};`,
    },
    {
      name: "a table that is not a kind table",
      sql: `GRANT INSERT ON public.${TASK_NOTE_ADOPTED_TABLE} TO ${COMMAND};`,
    },
  ])("$name → no path", async ({ sql }) => {
    expect(await rule1(sql)).toEqual([])
  })

  it("a grant on a table with the generator grants stays sql.generated-grant alone", async () => {
    const result = await compile(
      await acceptDebt(
        files({ [EXTRA]: `GRANT INSERT ON public.task TO ${API.user};` })
      )
    )
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "sql.generated-grant",
    ])
  })

  // Пропуск гранту генератора звіряє ключ цілі за правилом ідентичності
  // (#297): таблиця виду з ім'ям у лапках не дістає другої діагностики.
  it("a grant on a kind table named in quotes stays sql.generated-grant alone", async () => {
    const domain = policyDomain(promotableTaskNote(), {
      [TASK_FILE]: { physicalName: "Task" },
    })
    domain.set(EXTRA, `GRANT INSERT ON public."Task" TO ${API.user};`)
    const result = await compile(await acceptDebt(domain))
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "sql.generated-grant",
    ])
  })

  // Грант на що завгодно в `simetra` відмовляє `schema.reserved` ще до
  // Правила 1: другої діагностики немає.
  it.each([
    `GRANT INSERT ON simetra.ledger TO ${COMMAND};`,
    `GRANT INSERT ON simetra.identities TO ${COMMAND};`,
    `GRANT USAGE ON SEQUENCE simetra.row_version TO ${API.user};`,
    `GRANT CREATE ON SCHEMA simetra TO ${API.user};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA simetra GRANT INSERT ON TABLES TO ${COMMAND};`,
  ])("%s → schema.reserved alone", async (sql) => {
    const result = await compile(await acceptDebt(files({ [EXTRA]: sql })))
    expect(result.diagnostics.map((d) => d.code)).toEqual(["schema.reserved"])
  })
})

describe("sql.kind-table-verbatim: default privileges of the application (І15–І16)", () => {
  const OWNER = PROVIDER_OWNER_ROLES.supabase
  it.each([
    {
      name: "global, TABLES, an API role",
      sql: `ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${API.anonymous};`,
      table: "*",
      roles: API.anonymous,
    },
    {
      name: "global with FOR ROLE the owner",
      sql: `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT SELECT ON TABLES TO ${OWNER};`,
      table: "*",
      roles: OWNER,
    },
    {
      name: "global, SEQUENCES",
      sql: `ALTER DEFAULT PRIVILEGES GRANT USAGE ON SEQUENCES TO ${API.user};`,
      table: "*",
      roles: API.user,
    },
    {
      name: "global, TYPES",
      sql: `ALTER DEFAULT PRIVILEGES GRANT USAGE ON TYPES TO ${API.user};`,
      table: "*",
      roles: API.user,
    },
    {
      name: "global, SCHEMAS",
      sql: `ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO ${API.user};`,
      table: "*",
      roles: API.user,
    },
    {
      name: "IN SCHEMA to PUBLIC",
      sql: "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC;",
      table: "public.*",
      roles: "PUBLIC",
    },
    {
      name: "IN SCHEMA to the command role",
      sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT ON TABLES TO ${COMMAND};`,
      table: "public.*",
      roles: COMMAND,
    },
    {
      name: "IN SCHEMA to another role",
      sql: "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO somebody;",
      table: "public.*",
      roles: "somebody",
    },
    {
      // Право передачі дало б ролі API перевидати `EXECUTE` згенерованої функції.
      name: "IN SCHEMA to an API role WITH GRANT OPTION",
      sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${API.user} WITH GRANT OPTION;`,
      table: "public.*",
      roles: API.user,
    },
    {
      // `FOR ROLE` з кількох ролей: ADP діє на об'єкти кожної названої ролі.
      name: "FOR ROLE of several roles to a non-API role",
      sql: `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER}, somebody IN SCHEMA public GRANT SELECT ON TABLES TO ${OWNER};`,
      table: "public.*",
      roles: OWNER,
    },
    {
      name: "FOR ROLE a role to another role",
      sql: `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT SELECT ON TABLES TO ${COMMAND};`,
      table: "public.*",
      roles: COMMAND,
    },
    {
      // Без `FOR ROLE` виняток провайдера діє, лише коли кожен отримувач —
      // власник чи роль API.
      name: "no FOR ROLE: the owner together with the command role",
      sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${OWNER}, ${COMMAND};`,
      table: "public.*",
      roles: `${OWNER}, ${COMMAND}`,
    },
    {
      // `CURRENT_USER` — «інша роль»: статично не відомо, хто це.
      name: "CURRENT_USER",
      sql: "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO CURRENT_USER;",
      table: "public.*",
      roles: "CURRENT_USER",
    },
    {
      name: "several schemas",
      sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA public, app GRANT SELECT ON TABLES TO PUBLIC;`,
      table: "public.*, app.*",
      roles: "PUBLIC",
    },
  ])("$name → error", async ({ sql, table, roles }) => {
    const found = await rule1(sql)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ form: "defaultPrivileges", table, roles })
  })

  it.each([
    {
      name: "IN SCHEMA to API roles",
      sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${API.user}, ${API.anonymous};`,
    },
    {
      // Так виглядає ADP провайдера в керованій схемі (платформна спека §6.7).
      name: "the provider preset: FOR ROLE the owner to the owner and the API roles",
      sql: `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT ALL ON TABLES TO ${OWNER}, ${FROM_API};`,
    },
    {
      name: "the provider preset without FOR ROLE",
      sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${OWNER}, ${FROM_API};`,
    },
    {
      name: "a REVOKE form, global",
      sql: `ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM ${COMMAND};`,
    },
    {
      name: "a REVOKE form, IN SCHEMA",
      sql: "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;",
    },
  ])("$name → no error", async ({ sql }) => {
    expect(await rule1(sql)).toEqual([])
  })

  // `GRANT`-ADP на функції судить `sql.default-privileges-execute` (спека
  // декларацій §5.1): Правило 1 другої діагностики не дає.
  it("ADP on FUNCTIONS is judged by sql.default-privileges-execute alone", async () => {
    const result = await compile(
      await acceptDebt(
        files({
          [EXTRA]: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${COMMAND};`,
        })
      )
    )
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "sql.default-privileges-execute",
    ])
  })
})

describe("sql.kind-table-verbatim: trigger and policy on the identity source (І17)", () => {
  const trig = (timing: string, table = IDENTITY) =>
    `CREATE TRIGGER t ${timing} UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${HANDLER}`
  const found = async (sql: string) =>
    (await rule1(sql)).map((p) => ({ form: p.form, table: p.table }))

  it.each([
    // `BEFORE` змінює `NEW`, тож пише джерело без DML.
    { name: "BEFORE trigger", sql: trig("BEFORE"), form: "trigger" },
    { name: "INSTEAD OF trigger", sql: trig("INSTEAD OF"), form: "trigger" },
    {
      name: "a verbatim policy",
      sql: policy(IDENTITY),
      form: "policy",
    },
    {
      name: "a restrictive policy",
      sql: `CREATE POLICY p ON ${IDENTITY} AS RESTRICTIVE FOR ALL TO ${API.user} USING (false)`,
      form: "policy",
    },
  ])("$name → error", async ({ sql, form }) => {
    expect(await found(sql)).toEqual([{ form, table: IDENTITY }])
  })

  it.each([
    { name: "AFTER trigger", sql: trig("AFTER") },
    {
      name: "AFTER constraint trigger",
      sql: `CREATE CONSTRAINT TRIGGER t AFTER UPDATE ON ${IDENTITY} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${HANDLER}`,
    },
  ])("$name → no path", async ({ sql }) => {
    expect(await found(sql)).toEqual([])
  })
})

describe("sql.kind-table-verbatim: a sequence of the platform changes (І20)", () => {
  const body = (
    expression: string,
    shell = "SECURITY DEFINER SET search_path = ''"
  ) =>
    `CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql VOLATILE ${shell} AS $$ DECLARE n bigint; BEGIN ${expression}; END $$`
  const sequence = (table: string, statement: string) => ({
    form: "sequence",
    table,
    statement,
    function: "public.f",
  })
  const found = async (sql: string) =>
    (await rule1(sql)).map(({ form, table, statement, function: fn }) => ({
      form,
      table,
      statement,
      function: fn,
    }))

  it.each([
    {
      name: "setval of a platform sequence",
      sql: body("PERFORM setval('simetra.row_version', 1)"),
      expected: sequence("simetra.row_version", "setval"),
    },
    {
      name: "nextval with a regclass cast",
      sql: body("n := nextval('simetra.row_version'::regclass)"),
      expected: sequence("simetra.row_version", "nextval"),
    },
    {
      name: "a quoted name",
      sql: body(`n := nextval('"simetra"."row_version"')`),
      expected: sequence("simetra.row_version", "nextval"),
    },
    {
      name: "pg_catalog.setval",
      sql: body("PERFORM pg_catalog.setval('simetra.anything', 1)"),
      expected: sequence("simetra.anything", "setval"),
    },
    {
      name: "a function without a closed shell",
      sql: body("PERFORM setval('simetra.row_version', 1)", ""),
      expected: sequence("simetra.row_version", "setval"),
    },
    {
      // Що викликається, статично не відомо (fail-closed).
      name: "a non-literal argument",
      sql: body("n := nextval(seq_name::regclass)").replace(
        "n bigint;",
        "n bigint; seq_name text := 'x';"
      ),
      expected: sequence("*", "nextval"),
    },
    {
      name: "a concatenated name",
      sql: body("n := nextval(('simetra.' || 'row_version')::regclass)"),
      expected: sequence("*", "nextval"),
    },
    {
      name: "a call in a SQL body",
      sql: "CREATE FUNCTION public.f() RETURNS bigint LANGUAGE sql AS $$ SELECT nextval('simetra.row_version') $$",
      expected: sequence("simetra.row_version", "nextval"),
    },
  ])("$name → error", async ({ sql, expected }) => {
    expect(await found(sql)).toEqual([expected])
  })

  it.each([
    {
      name: "a sequence of the application",
      sql: body("n := nextval('public.my_seq')"),
    },
    {
      name: "setval of a sequence of the application",
      sql: body("PERFORM setval('public.my_seq', 1)"),
    },
    { name: "currval", sql: body("n := currval('simetra.row_version')") },
    {
      name: "currval of a qualified sequence of the application",
      sql: body("n := currval('public.my_seq'::regclass)"),
    },
  ])("$name → no path", async ({ sql }) => {
    expect(await found(sql)).toEqual([])
  })

  // Раунд 3: ім'я послідовності без схеми — помилка за структурою, не за
  // переліком платформи. Шлях пошуку сесії може вести в `simetra`, а перелік
  // пропускав кожну нову послідовність (identity таблиці стану поза знімком).
  const unqualified = (table: string, statement: string) => ({
    ...sequence(table, statement),
    unqualified: "yes",
  })
  const foundMarked = async (sql: string) =>
    (await rule1(sql)).map(
      ({ form, table, statement, function: fn, unqualified: mark }) => ({
        form,
        table,
        statement,
        function: fn,
        unqualified: mark,
      })
    )
  it.each(
    ["signal_outbox_id_seq", "rights_journal_seq_seq", "ledger_id_seq"].flatMap(
      (name) => [
        {
          name: `nextval('${name}')`,
          sql: body(`n := nextval('${name}')`),
          expected: unqualified(name, "nextval"),
        },
        {
          name: `setval('${name}'::regclass, 1)`,
          sql: body(`PERFORM setval('${name}'::regclass, 1)`),
          expected: unqualified(name, "setval"),
        },
        {
          name: `currval('${name}')`,
          sql: body(`n := currval('${name}')`),
          expected: unqualified(name, "currval"),
        },
      ]
    )
  )("$name → error «qualify with a schema»", async ({ sql, expected }) => {
    expect(await foundMarked(sql)).toEqual([expected])
  })

  it.each([
    {
      // Рішення архітекторки раунду 3: власна послідовність без схеми теж
      // помилка (раніше проходила, коли ім'я не було в переліку платформи).
      name: "an unqualified sequence of the application",
      sql: body("n := nextval('my_seq')"),
      expected: unqualified("my_seq", "nextval"),
    },
    {
      name: "an unqualified name cast to regclass",
      sql: body("n := nextval('row_version'::regclass)"),
      expected: unqualified("row_version", "nextval"),
    },
    {
      name: "an unqualified quoted name",
      sql: body(`n := nextval('"My_Seq"')`),
      expected: unqualified("My_Seq", "nextval"),
    },
    {
      name: "pg_catalog.currval of an unqualified name",
      sql: body("n := pg_catalog.currval('my_seq')"),
      expected: unqualified("my_seq", "currval"),
    },
  ])("$name → error «qualify with a schema»", async ({ sql, expected }) => {
    expect(await foundMarked(sql)).toEqual([expected])
  })
})

// Передумова правила ADP (І22): ACL, який платформа виводить для таблиці виду,
// згенерованої функції й послідовності, спершу відкликає все в `PUBLIC` і в
// кожної ролі API, тож ADP `IN SCHEMA` ролям API без права передачі нічого не
// додає. Гранти ролям поза API — лише від генератора.
describe("the derived ACL leaves an API role only what the generator lists (І22)", () => {
  const providers = Object.keys(PROVIDER_API_ROLES) as DatabaseProvider[]
  const apiOf = (provider: DatabaseProvider) =>
    Object.values(PROVIDER_API_ROLES[provider]).filter(
      (role): role is string => typeof role === "string"
    )
  const revokes = (sql: readonly string[], target: string, roles: string[]) =>
    ["PUBLIC", ...roles].map((role) =>
      sql.find(
        (s) =>
          s.startsWith(`REVOKE`) &&
          s.includes(target) &&
          s.endsWith(`FROM ${role};`)
      )
    )

  it.each(providers)("table of a kind, %s", (provider) => {
    const sql = tableGrants({ schema: "public", name: "t" }, ["user"], provider)
    const roles = apiOf(provider).map((r) => quoteIdent(r))
    expect(
      revokes(sql, "TABLE public.t", roles).every((s) => s !== undefined)
    ).toBe(true)
  })

  it.each(providers)("generated function without callers, %s", (provider) => {
    const sql = executeGrants("public.f()", [], provider)
    const roles = apiOf(provider).map((r) => quoteIdent(r))
    expect(
      revokes(sql, "FUNCTION public.f()", roles).every((s) => s !== undefined)
    ).toBe(true)
    expect(sql.some((s) => s.startsWith("GRANT"))).toBe(false)
  })

  it.each(providers)(
    "generated function with a caller keeps only that role, %s",
    (provider) => {
      const user = PROVIDER_API_ROLES[provider].user
      const sql = executeGrants("public.f()", ["user"], provider)
      expect(sql.filter((s) => s.startsWith("GRANT"))).toEqual([
        `GRANT EXECUTE ON FUNCTION public.f() TO ${quoteIdent(user)};`,
      ])
      expect(sql.some((s) => s.endsWith(`FROM ${quoteIdent(user)};`))).toBe(
        false
      )
    }
  )

  it.each(providers)("sequence of the platform, %s", (provider) => {
    const sql = sequenceRevokes(ROW_VERSION_SEQUENCE, provider)
    const roles = apiOf(provider).map((r) => quoteIdent(r))
    expect(
      revokes(sql, "SEQUENCE simetra.row_version", roles).every(
        (s) => s !== undefined
      )
    ).toBe(true)
    expect(sql.some((s) => s.startsWith("GRANT"))).toBe(false)
  })
})

// Раунд виправлення 1: обхідні шляхи судяться fail-closed (спека прав §6.1) —
// некваліфікована чи невідома ціль, динамічний отримувач і форма, яку тіло
// функції не вичерпує.
describe("sql.kind-table-verbatim: fail-closed routes of the enumerator", () => {
  const roles = (found: { roles?: unknown }[]) => found.map((p) => p.roles)

  // F1: пропуск гранту генератора судить ту саму ціль, яку називає
  // `sql.generated-grant` (ключ `table|схема.ім'я` одиниці), а не членство
  // таблиці в множині RLS.
  it("an unqualified grant in a file of another schema is judged", async () => {
    const found = await rule1(
      `GRANT INSERT ON task TO ${COMMAND};`,
      OTHER_SCHEMA
    )
    expect(found).toMatchObject([
      { form: "grant", table: "public.task", roles: COMMAND },
    ])
  })

  // F2: `CURRENT_USER`/`SESSION_USER`/`CURRENT_ROLE` — «інша роль».
  it.each(["CURRENT_USER", "SESSION_USER", "CURRENT_ROLE"])(
    "a grant of the write to %s is judged",
    async (grantee) => {
      const found = await rule1(`GRANT INSERT ON ${IDENTITY} TO ${grantee};`)
      expect(roles(found)).toEqual([grantee])
    }
  )

  // F3 + F4: привілеї на послідовність платформи — доступ до `setval`/`nextval`.
  it.each([
    {
      name: "UPDATE on the row version sequence, unqualified",
      sql: `GRANT UPDATE ON SEQUENCE row_version TO ${API.anonymous};`,
      table: "row_version",
    },
    {
      name: "USAGE on the row version sequence, unqualified",
      sql: `GRANT USAGE ON SEQUENCE row_version TO ${API.anonymous};`,
      table: "row_version",
    },
    {
      name: "ALL on the outbox sequence, unqualified",
      sql: `GRANT ALL ON SEQUENCE signal_outbox_id_seq TO ${API.anonymous};`,
      table: "signal_outbox_id_seq",
    },
  ])("$name → error", async ({ sql, table }) => {
    expect(await rule1(sql)).toMatchObject([
      { form: "grant", table, roles: API.anonymous },
    ])
  })

  it.each([
    {
      name: "SELECT on a platform sequence",
      sql: `GRANT SELECT ON SEQUENCE row_version TO ${API.anonymous};`,
    },
    {
      name: "USAGE on a qualified sequence of the application",
      sql: `GRANT USAGE ON SEQUENCE public.my_seq TO ${API.anonymous};`,
    },
    {
      name: "UPDATE by the table syntax on a qualified sequence of the application",
      sql: `GRANT UPDATE ON public.my_seq TO ${API.anonymous};`,
    },
    {
      name: "a REVOKE",
      sql: `REVOKE USAGE ON SEQUENCE row_version FROM ${API.anonymous};`,
    },
  ])("$name → no path", async ({ sql }) => {
    expect(await rule1(sql)).toEqual([])
  })

  const sequencePathsOf = async (sql: string) =>
    (await rule1(sql)).map(({ form, table, statement }) => ({
      form,
      table,
      statement,
    }))

  // F4: перелік платформних послідовностей — з того, що генерує платформа.
  it("nextval of the outbox sequence by its unqualified name is judged", async () => {
    expect(
      await sequencePathsOf(
        plpgsqlFn(
          "n := nextval('signal_outbox_id_seq')",
          "public.f",
          "SECURITY DEFINER SET search_path = ''"
        )
      )
    ).toEqual([
      {
        form: "sequence",
        table: "signal_outbox_id_seq",
        statement: "nextval",
      },
    ])
  })

  // F5: форма `sequence` обходить дерево кожної одиниці.
  it.each([
    {
      name: "a view reading nextval",
      sql: "CREATE VIEW public.v AS SELECT nextval('simetra.row_version') AS id",
    },
    {
      name: "a materialized view reading nextval",
      sql: "CREATE MATERIALIZED VIEW public.v AS SELECT nextval('simetra.row_version') AS id",
    },
    {
      name: "a domain DEFAULT",
      sql: "CREATE DOMAIN public.d AS bigint DEFAULT nextval('simetra.row_version')",
    },
    {
      name: "a policy condition",
      sql: "CREATE POLICY p ON public.my_table FOR SELECT TO authenticated USING (nextval('simetra.row_version') > 0)",
    },
  ])("$name → error", async ({ sql }) => {
    expect(await sequencePathsOf(sql)).toEqual([
      { form: "sequence", table: "simetra.row_version", statement: "nextval" },
    ])
  })

  // F6: некваліфіковане ім'я будь-якої таблиці платформи — ціль Правила 1.
  it("DML into a platform table by its unqualified name is judged", async () => {
    const found = await rule1(
      plpgsqlFn("INSERT INTO signal_outbox (channel) VALUES ('x')")
    )
    expect(found).toMatchObject([
      { form: "functionBody", table: "simetra.signal_outbox" },
    ])
  })

  // F7: динамічні позначки не є «однією роллю = отримувачем».
  it.each(["CURRENT_USER", "SESSION_USER", "CURRENT_ROLE"])(
    "ADP FOR ROLE %s to the same mark is judged",
    async (mark) => {
      const found = await rule1(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${mark} IN SCHEMA public GRANT SELECT ON TABLES TO ${mark};`
      )
      expect(roles(found)).toEqual([mark])
    }
  )

  // Раунд 2, G1: послідовності платформи — з identity-колонок знімка таблиць
  // `simetra`, а не з другого ручного переліку.
  it("nextval of the rights journal sequence by its unqualified name is judged", async () => {
    expect(
      await sequencePathsOf(
        plpgsqlFn(
          "n := nextval('rights_journal_seq_seq')",
          "public.f",
          "SECURITY DEFINER SET search_path = ''"
        )
      )
    ).toEqual([
      {
        form: "sequence",
        table: "rights_journal_seq_seq",
        statement: "nextval",
      },
    ])
  })

  it("USAGE on the rights journal sequence is judged", async () => {
    expect(
      await rule1(
        `GRANT USAGE ON SEQUENCE rights_journal_seq_seq TO ${API.anonymous};`
      )
    ).toMatchObject([
      {
        form: "grant",
        table: "rights_journal_seq_seq",
        roles: API.anonymous,
      },
    ])
  })

  // G2: Postgres приймає грант синтаксисом TABLE на послідовність.
  it.each([
    {
      name: "UPDATE by the table syntax",
      sql: `GRANT UPDATE ON row_version TO ${API.anonymous};`,
      table: "row_version",
    },
    {
      name: "ALL by the explicit TABLE syntax",
      sql: `GRANT ALL ON TABLE signal_outbox_id_seq TO ${API.anonymous};`,
      table: "signal_outbox_id_seq",
    },
  ])("$name → error", async ({ sql, table }) => {
    expect(await rule1(sql)).toMatchObject([
      { form: "grant", table, roles: API.anonymous },
    ])
  })

  // Некваліфікована власна послідовність: ім'я без схеми в DDL судиться
  // fail-closed, хоч би яке воно було (Р8).
  it("USAGE on an unqualified sequence of the application → error", async () => {
    expect(
      await rule1(`GRANT USAGE ON SEQUENCE my_seq TO ${API.anonymous};`)
    ).toMatchObject([
      {
        form: "grant",
        table: "my_seq",
        roles: API.anonymous,
        unqualified: "yes",
      },
    ])
  })

  it("SELECT by the table syntax on a platform sequence → no path", async () => {
    expect(
      await rule1(`GRANT SELECT ON row_version TO ${API.anonymous};`)
    ).toEqual([])
  })

  // Раунд 3: грант запису послідовності на ім'я без схеми — помилка обома
  // синтаксисами, будь-якій ролі, хоч яке це ім'я (Р8: ім'я без схеми в DDL —
  // fail-closed); `SELECT` — не запис.
  it.each(
    ["signal_outbox_id_seq", "rights_journal_seq_seq", "ledger_id_seq"].flatMap(
      (name) =>
        ["UPDATE", "USAGE", "ALL"].flatMap((privilege) => [
          `GRANT ${privilege} ON SEQUENCE ${name} TO ${API.anonymous};`,
          `GRANT ${privilege} ON TABLE ${name} TO ${API.anonymous};`,
          `GRANT ${privilege} ON ${name} TO somebody;`,
        ])
    )
  )("%s → error «qualify with a schema»", async (sql) => {
    const name = /ON (?:SEQUENCE |TABLE )?(\w+)/.exec(sql)![1]
    expect(await rule1(sql)).toMatchObject([
      { form: "grant", table: name, unqualified: "yes" },
    ])
  })

  it.each([
    `GRANT SELECT ON SEQUENCE ledger_id_seq TO ${API.anonymous};`,
    `GRANT SELECT ON TABLE ledger_id_seq TO ${API.anonymous};`,
    `GRANT USAGE ON SEQUENCE public.my_seq TO ${API.anonymous};`,
  ])("%s → no path", async (sql) => {
    expect(await rule1(sql)).toEqual([])
  })

  // G3: параметр `unqualified` лише для імені без схеми.
  it("a target from an unqualified name carries the unqualified mark", async () => {
    const unqualified = await rule1(
      `GRANT INSERT ON identities TO ${API.user};`
    )
    expect(unqualified).toMatchObject([
      { form: "grant", table: "simetra.identities", unqualified: "yes" },
    ])
    const qualified = await rule1(`GRANT INSERT ON ${IDENTITY} TO ${API.user};`)
    expect(qualified.map((p) => p.unqualified)).toEqual([undefined])
  })
})
