import { beforeAll, describe, expect, it } from "vitest"
import { compile, type Diagnostic } from "simetra/compiler"
import { PROVIDER_SCHEMAS } from "simetra/model"
import { readFiles, sqlStage } from "../pipeline"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import { reachableCalls, type ReachReason, type ReachTrust } from "../sql/reach"
import {
  COMMENT_COUNTER_FILE,
  COUNT_COMMENT_SQL_FILE,
  PROJECT_CATALOG_FILE,
  PROJECT_FILE,
  REGION_DIMENSION_ID,
  counterColumn,
  policyDomain,
  teamScopeKind,
  type Layer,
} from "./fixtures/rights"
import { dynamicFunction } from "./fixtures/sql-shape"
import {
  acceptDebt,
  expectClean,
  metaFiles,
  project,
  salesDocument,
  uuid,
} from "./helpers"

const SHARED = "sql/public/shared.sql"
const PROJECT_MODULE = PROJECT_CATALOG_FILE.replace(".meta.json", ".sql")
const COUNTER_MODULE = COMMENT_COUNTER_FILE.replace(".meta.json", ".sql")
const HEAD = "public.count_comment"
/** Згенерована функція членства `OrgMember` домену політик. */
const MY_MEMBER = "public.org_member_my_member"

/** Голова обходу — обробник лічильника домену політик з тілом `body`. */
const handler = (body: string, options = "") =>
  `CREATE FUNCTION public.count_comment() RETURNS trigger LANGUAGE plpgsql VOLATILE ${options} AS $$ BEGIN ${body} RETURN NEW; END $$;`
const EMPTY_PATH = "SET search_path = ''"

const sqlFunction = (name: string, body: string) =>
  `CREATE FUNCTION ${name}() RETURNS int LANGUAGE sql STABLE AS $$ ${body} $$;\n`
const plpgsqlFunction = (name: string, body: string) =>
  `CREATE FUNCTION ${name}() RETURNS int LANGUAGE plpgsql VOLATILE AS $$ BEGIN ${body} RETURN NULL; END $$;\n`

/** Знахідка обходу з ланцюжком від голови через `via` до `fn`. */
const found = (fn: string, reason: ReachReason, ...via: string[]) => ({
  function: fn,
  chain: [HEAD, ...via, fn],
  reason,
})

let parse: SqlParser
let plpgsql: PlpgsqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
})

const TRUST = (): ReachTrust => ({
  providerSchemas: new Set(PROVIDER_SCHEMAS.supabase),
  generated: new Set([MY_MEMBER]),
})

function files(head: string, shared: string, layers: Layer[]) {
  const result = policyDomain(...layers)
  result.set(COUNT_COMMENT_SQL_FILE, head)
  if (shared !== "") result.set(SHARED, shared)
  return result
}

/** Обхід від обробника над одиницями й знімком домену політик. */
function reach(head: string, shared = "", layers: Layer[] = []) {
  const { sql, stage3 } = sqlStage(
    readFiles(files(head, shared, layers)),
    parse
  )
  expect(sql.diagnostics).toEqual([])
  const unit = sql.units.find((u) => u.identity === `function:${HEAD}()`)
  expect(unit).toBeDefined()
  return reachableCalls(
    unit!,
    sql.units,
    TRUST(),
    parse,
    plpgsql,
    stage3?.physical.tables ?? []
  )
}

describe("reachableCalls", () => {
  it.each([
    {
      name: "plpgsql-perform",
      head: handler("PERFORM public.helper();"),
      shared: dynamicFunction("public.helper"),
      expected: [found("public.helper", "nonLiteralExecute")],
    },
    {
      name: "sql-chain",
      head: handler("PERFORM public.a();"),
      shared:
        sqlFunction("public.a", "SELECT public.b()") +
        sqlFunction("public.b", "SELECT public.c()") +
        "CREATE FUNCTION public.c() RETURNS int LANGUAGE plpython3u VOLATILE AS $$ return 1 $$;",
      expected: [found("public.c", "language", "public.a", "public.b")],
    },
    {
      // Виклик у тексті літерального EXECUTE обходиться; сам літерал — ні.
      name: "literal-execute",
      head: handler("PERFORM public.mid();"),
      shared:
        plpgsqlFunction("public.mid", "EXECUTE 'SELECT public.helper2()';") +
        dynamicFunction("public.helper2"),
      expected: [found("public.helper2", "nonLiteralExecute", "public.mid")],
    },
    {
      name: "dynamic-builtin",
      head: handler("PERFORM query_to_xml('select 1', true, true, '');"),
      shared: "",
      expected: [found("query_to_xml", "dynamicBuiltin")],
    },
    {
      name: "dynamic-builtin-catalog",
      head: handler("PERFORM pg_catalog.ts_stat('select 1');"),
      shared: "",
      expected: [found("pg_catalog.ts_stat", "dynamicBuiltin")],
    },
    {
      name: "provider-trusted",
      head: handler(
        "PERFORM extensions.gen_random_bytes(16); PERFORM auth.uid();"
      ),
      shared: "",
      expected: [],
    },
    {
      // Компілятор приймає функцію моделі в схемі провайдера: її пише
      // застосунок, тож вона обходиться, а не довіряється.
      name: "model-over-provider",
      head: handler("PERFORM extensions.helper();"),
      shared: dynamicFunction("extensions.helper"),
      expected: [found("extensions.helper", "nonLiteralExecute")],
    },
    {
      name: "unknown-schema",
      head: handler("PERFORM other_schema.fn();"),
      shared: "",
      expected: [found("other_schema.fn", "unknown")],
    },
    {
      name: "cycle",
      head: handler("PERFORM public.a();"),
      shared:
        sqlFunction("public.a", "SELECT public.b()") +
        sqlFunction("public.b", "SELECT public.a()"),
      expected: [],
    },
    {
      name: "platform-trusted",
      head: handler(
        `PERFORM simetra.current_user_id(); PERFORM ${MY_MEMBER}(NEW.id);`
      ),
      shared: "",
      expected: [],
    },
    {
      // Без власного search_path ім'я розв'язується за шляхом сесії.
      name: "unqualified-session-path",
      head: handler("PERFORM helper();"),
      shared: dynamicFunction("public.helper"),
      expected: [found("public.helper", "nonLiteralExecute")],
    },
    {
      name: "unqualified-empty-path",
      head: handler("PERFORM helper();", EMPTY_PATH),
      shared: dynamicFunction("public.helper"),
      expected: [],
    },
    {
      // Тіло саме повертає шлях сесії: далі ім'я знову розв'язується за ним.
      name: "body-sets-search-path",
      head: handler(
        "PERFORM set_config('search_path', 'public', true); PERFORM helper();",
        EMPTY_PATH
      ),
      shared: dynamicFunction("public.helper"),
      expected: [found("public.helper", "nonLiteralExecute")],
    },
    {
      name: "view-edge",
      head: handler("PERFORM 1 FROM public.v;"),
      shared:
        "CREATE VIEW public.v AS SELECT public.dyn() AS x;\n" +
        dynamicFunction("public.dyn"),
      expected: [found("public.dyn", "nonLiteralExecute", "public.v")],
    },
    {
      name: "view-unqualified",
      head: handler("PERFORM 1 FROM v;"),
      shared:
        "CREATE VIEW public.v AS SELECT public.dyn() AS x;\n" +
        dynamicFunction("public.dyn"),
      expected: [found("public.dyn", "nonLiteralExecute", "public.v")],
    },
    {
      name: "unsafe-provider",
      head: handler("PERFORM extensions.dblink_exec('c', 'select 1');"),
      shared: "",
      expected: [found("extensions.dblink_exec", "dynamicBuiltin")],
    },
    {
      name: "unqualified-unsafe-provider",
      head: handler("PERFORM dblink_exec('c', 'select 1');"),
      shared: "",
      expected: [found("dblink_exec", "dynamicBuiltin")],
    },
    {
      name: "policy-edge",
      head: handler(
        "INSERT INTO public.comment_counter (comment_id) VALUES (NEW.id);"
      ),
      shared:
        "CREATE POLICY p ON public.comment_counter USING (public.f(comment_id));\n" +
        dynamicFunction("public.f", "id uuid", "boolean"),
      expected: [
        found(
          "public.f",
          "nonLiteralExecute",
          "policy:public.comment_counter.p"
        ),
      ],
    },
    {
      // Некваліфіковану ціль політики Postgres розв'язав під час створення:
      // схема статично не відома, тож політика — на кожній однойменній.
      name: "policy-unqualified-target",
      head: handler(
        "INSERT INTO public.comment_counter (comment_id) VALUES (NEW.id);"
      ),
      shared:
        "CREATE POLICY p ON comment_counter USING (public.f(comment_id));\n" +
        dynamicFunction("public.f", "id uuid", "boolean"),
      expected: [
        found(
          "public.f",
          "nonLiteralExecute",
          "policy:public.comment_counter.p"
        ),
      ],
    },
    {
      name: "read-unqualified-policy",
      head: handler("PERFORM 1 FROM comment_counter;"),
      shared:
        "CREATE POLICY p ON public.comment_counter USING (public.f(comment_id));\n" +
        dynamicFunction("public.f", "id uuid", "boolean"),
      expected: [
        found(
          "public.f",
          "nonLiteralExecute",
          "policy:public.comment_counter.p"
        ),
      ],
    },
    {
      name: "literal-only",
      head: handler("PERFORM public.lit();"),
      shared: plpgsqlFunction("public.lit", "EXECUTE 'SELECT 1';"),
      expected: [],
    },
    {
      name: "reached-session-write",
      head: handler("PERFORM public.claims();"),
      shared: plpgsqlFunction(
        "public.claims",
        "PERFORM set_config('request.jwt.claims', '{}', true);"
      ),
      expected: [found("public.claims", "sessionWrite")],
    },
    {
      name: "reached-alter-claims",
      head: handler("PERFORM public.plain();"),
      shared:
        sqlFunction("public.plain", "SELECT 1") +
        "ALTER FUNCTION public.plain() SET request.jwt.claims = '{}';",
      expected: [found("public.plain", "sessionWrite")],
    },
    {
      // Порожній search_path голови скидає окремий ALTER: ім'я знову
      // розв'язується за шляхом сесії.
      name: "alter-reset-search-path",
      head: handler("PERFORM helper();", EMPTY_PATH),
      shared:
        dynamicFunction("public.helper") +
        "ALTER FUNCTION public.count_comment() RESET search_path;",
      expected: [found("public.helper", "nonLiteralExecute")],
    },
    {
      // `RESET ALL` окремого ALTER скидає й шлях досягнутої функції.
      name: "alter-reset-all-reached",
      head: handler("PERFORM public.mid();", EMPTY_PATH),
      shared:
        "CREATE FUNCTION public.mid() RETURNS int LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT helper() $$;\n" +
        dynamicFunction("public.helper") +
        "ALTER FUNCTION public.mid() RESET ALL;",
      expected: [found("public.helper", "nonLiteralExecute", "public.mid")],
    },
    {
      // Опції CREATE Postgres згортає по черзі: пізніший `RESET ALL` чи
      // `SET` того самого налаштування (ім'я нечутливе до регістру) скасовує
      // порожній шлях.
      name: "create-reset-all",
      head: handler("PERFORM helper();", `${EMPTY_PATH} RESET ALL`),
      shared: dynamicFunction("public.helper"),
      expected: [found("public.helper", "nonLiteralExecute")],
    },
    {
      name: "create-later-set-other-case",
      head: handler(
        "PERFORM helper();",
        `${EMPTY_PATH} SET "SEARCH_PATH" = 'public'`
      ),
      shared: dynamicFunction("public.helper"),
      expected: [found("public.helper", "nonLiteralExecute")],
    },
    {
      name: "body-set-search-path-statement",
      head: handler("SET search_path = public; PERFORM helper();", EMPTY_PATH),
      shared: dynamicFunction("public.helper"),
      expected: [found("public.helper", "nonLiteralExecute")],
    },
    {
      // Досягнута функція без власної опції шляху пише шлях викликача: далі
      // некваліфіковане ім'я голови розв'язується вже за ним.
      name: "reached-sets-search-path",
      head: handler("PERFORM public.setpath(); PERFORM helper();", EMPTY_PATH),
      shared:
        plpgsqlFunction(
          "public.setpath",
          "PERFORM set_config('search_path', 'public', true);"
        ) + dynamicFunction("public.helper"),
      expected: [found("public.helper", "nonLiteralExecute")],
    },
    {
      // Те саме робить політика таблиці, яку голова читає.
      name: "policy-sets-search-path",
      head: handler(
        "PERFORM 1 FROM public.comment_counter; PERFORM helper();",
        EMPTY_PATH
      ),
      shared:
        "CREATE POLICY p ON public.comment_counter USING (set_config('search_path', 'public', false) IS NOT NULL);\n" +
        dynamicFunction("public.helper"),
      expected: [found("public.helper", "nonLiteralExecute")],
    },
    {
      name: "call-statement",
      head: handler("CALL public.proc();"),
      shared:
        "CREATE PROCEDURE public.proc() LANGUAGE plpgsql AS $$ BEGIN EXECUTE format('SELECT %s', 1); END $$;",
      expected: [found("public.proc", "nonLiteralExecute")],
    },
    {
      // Перевантаження за типами компілятор не розрізняє: судить кожне.
      name: "overload",
      head: handler("PERFORM public.ov(1);"),
      shared:
        "CREATE FUNCTION public.ov(a int) RETURNS int LANGUAGE sql STABLE AS $$ SELECT a $$;\n" +
        dynamicFunction("public.ov", "a text"),
      expected: [found("public.ov", "nonLiteralExecute")],
    },
    {
      // Однойменна функція моделі не ховає вбудованої: `pg_catalog` у шляху
      // першим, а перевантаження розв'язується за типами.
      name: "decoy-builtin",
      head: handler("PERFORM query_to_xml('select 1', true, true, '');"),
      shared:
        "CREATE FUNCTION public.query_to_xml(q text, n boolean, t boolean, s text) RETURNS xml LANGUAGE sql STABLE AS $$ SELECT NULL::xml $$;",
      expected: [found("query_to_xml", "dynamicBuiltin")],
    },
    {
      // Значення за замовчуванням зв'язано під час створення з шляхом
      // сесії: порожній search_path функції його не звужує.
      name: "creation-bound-default",
      head: handler("PERFORM public.withdef();", EMPTY_PATH),
      shared:
        "CREATE FUNCTION public.withdef(a int DEFAULT dyn()) RETURNS int LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT a $$;\n" +
        dynamicFunction("public.dyn"),
      expected: [found("public.dyn", "nonLiteralExecute", "public.withdef")],
    },
    {
      name: "creation-bound-atomic-body",
      head: handler("PERFORM public.atomic();"),
      shared:
        "CREATE FUNCTION public.atomic() RETURNS int LANGUAGE sql STABLE SET search_path = '' BEGIN ATOMIC SELECT dyn(); END;\n" +
        dynamicFunction("public.dyn"),
      expected: [found("public.dyn", "nonLiteralExecute", "public.atomic")],
    },
    {
      // `c.dyn_attr` — виклик `dyn_attr(c)` функції з одним аргументом.
      name: "attribute-notation",
      head: handler("PERFORM c.dyn_attr FROM public.comment_counter c;"),
      shared: dynamicFunction("public.dyn_attr", "r public.comment_counter"),
      expected: [found("public.dyn_attr", "nonLiteralExecute")],
    },
  ])("$name", ({ head, shared, expected }) => {
    expect(reach(head, shared)).toEqual(expected)
  })

  // Вирази таблиці Postgres обчислює посеред запису: значення за
  // замовчуванням, перевірка, генерована колонка, ключ і предикат індексу —
  // ланки обходу; читання їх не обчислює.
  const counterIndex = (index: Record<string, unknown>): Layer => ({
    [COMMENT_COUNTER_FILE]: { indexes: [{ name: "counter_idx", ...index }] },
  })
  const throughTable = found(
    "public.dyn",
    "nonLiteralExecute",
    "public.comment_counter"
  )
  const insert =
    "INSERT INTO public.comment_counter (comment_id) VALUES (NEW.id);"
  it.each([
    {
      name: "table-default",
      body: "INSERT INTO public.comment_counter (comment_id) VALUES (NEW.id);",
      layer: counterColumn({ default: "public.dyn()" }),
      expected: [
        found("public.dyn", "nonLiteralExecute", "public.comment_counter"),
      ],
    },
    {
      name: "table-check",
      body: "UPDATE public.comment_counter SET comment_id = NEW.id;",
      layer: {
        [COMMENT_COUNTER_FILE]: {
          checks: [
            { name: "counter_check", expression: "public.dyn() IS NULL" },
          ],
        },
      },
      expected: [
        found("public.dyn", "nonLiteralExecute", "public.comment_counter"),
      ],
    },
    {
      // Вираз, якого розбір не читає, ховає свої виклики: fail-closed.
      name: "table-unparsable-default",
      body: "INSERT INTO public.comment_counter (comment_id) VALUES (NEW.id);",
      layer: counterColumn({ default: "public.dyn(" }),
      expected: [
        {
          function: "public.comment_counter",
          chain: [HEAD, "public.comment_counter"],
          reason: "unknown",
        },
      ],
    },
    {
      name: "table-generated",
      body: insert,
      layer: counterColumn({ generated: { expression: "public.dyn()" } }),
      expected: [throughTable],
    },
    {
      name: "table-index-where",
      body: insert,
      layer: counterIndex({
        keys: [{ column: "commentId" }],
        where: "public.dyn() IS NULL",
      }),
      expected: [throughTable],
    },
    {
      name: "table-index-expression-key",
      body: insert,
      layer: counterIndex({ keys: [{ expression: "public.dyn()" }] }),
      expected: [throughTable],
    },
    {
      name: "merge-write",
      body: "MERGE INTO public.comment_counter c USING (SELECT NEW.id AS id) s ON c.comment_id = s.id WHEN NOT MATCHED THEN INSERT (comment_id) VALUES (s.id);",
      layer: counterColumn({ default: "public.dyn()" }),
      expected: [throughTable],
    },
    {
      // Без власного search_path ім'я таблиці розв'язується за шляхом сесії.
      name: "write-unqualified-table",
      body: "INSERT INTO comment_counter (comment_id) VALUES (NEW.id);",
      layer: counterColumn({ default: "public.dyn()" }),
      expected: [throughTable],
    },
    {
      // Запис у просте подання Postgres переписує на запис у його базову
      // таблицю, тож обчислює й її вирази.
      name: "write-through-view",
      body: "INSERT INTO public.cv (comment_id) VALUES (NEW.id);",
      extra: "CREATE VIEW public.cv AS SELECT * FROM public.comment_counter;\n",
      layer: counterColumn({ default: "public.dyn()" }),
      expected: [
        found(
          "public.dyn",
          "nonLiteralExecute",
          "public.cv",
          "public.comment_counter"
        ),
      ],
    },
    {
      // Запис налаштувань сесії у виразі таблиці — та сама підміна claims,
      // що й у досягнутій функції.
      name: "table-default-session-write",
      body: insert,
      layer: counterColumn({
        default:
          "CASE WHEN set_config('request.jwt.claims', '{}', true) IS NULL THEN NULL ELSE gen_random_uuid() END",
      }),
      expected: [
        {
          function: "public.comment_counter",
          chain: [HEAD, "public.comment_counter"],
          reason: "sessionWrite",
        },
      ],
    },
    {
      name: "table-read-only",
      body: "PERFORM 1 FROM public.comment_counter;",
      layer: counterColumn({ default: "public.dyn()" }),
      expected: [],
    },
    {
      // Вираз таблиці, що пише шлях, змінює розв'язання імен голови.
      name: "table-default-sets-search-path",
      body: "INSERT INTO public.comment_counter (comment_id) VALUES (NEW.id); PERFORM dyn();",
      options: EMPTY_PATH,
      layer: counterColumn({
        default: "set_config('search_path', 'public', true)::uuid",
      }),
      expected: [found("public.dyn", "nonLiteralExecute")],
    },
  ])("$name", ({ body, layer, expected, options = "", extra = "" }) => {
    expect(
      reach(
        handler(body, options),
        extra + dynamicFunction("public.dyn", "", "uuid"),
        [layer]
      )
    ).toEqual(expected)
  })

  // Кожна форма plpgsql, що несе вираз чи запит, — ланка обходу; функція
  // `mid` повертає множину, тож у ній можливі й `RETURN QUERY`/`NEXT`.
  it.each([
    "v := public.dyn();",
    "a[public.dyn()] := 1;",
    "SELECT public.dyn() INTO v;",
    "RAISE NOTICE '%', public.dyn();",
    "ASSERT public.dyn() IS NULL;",
    "IF public.dyn() IS NULL THEN NULL; END IF;",
    "CASE public.dyn() WHEN 1 THEN NULL; ELSE NULL; END CASE;",
    "LOOP EXIT WHEN public.dyn() IS NULL; END LOOP;",
    "WHILE public.dyn() IS NULL LOOP EXIT; END LOOP;",
    "FOR i IN 1..public.dyn() LOOP END LOOP;",
    "FOR r IN SELECT public.dyn() LOOP END LOOP;",
    "FOREACH x IN ARRAY ARRAY[public.dyn()] LOOP END LOOP;",
    "OPEN c FOR SELECT public.dyn();",
    "OPEN c FOR EXECUTE 'SELECT public.dyn()';",
    "FOR r IN EXECUTE 'SELECT public.dyn()' LOOP END LOOP;",
    "EXECUTE 'SELECT $1' USING public.dyn();",
    "RETURN QUERY SELECT public.dyn();",
    "RETURN QUERY EXECUTE 'SELECT public.dyn()';",
    "RETURN NEXT public.dyn();",
    "INSERT INTO public.comment_counter (comment_id) SELECT NULL WHERE public.dyn() IS NULL;",
    "PERFORM 1 FROM public.dyn() AS d;",
    "RAISE NOTICE 'x' USING DETAIL = public.dyn();",
    "BEGIN NULL; EXCEPTION WHEN OTHERS THEN PERFORM public.dyn(); END;",
  ])("plpgsql form: %s", (form) => {
    const mid = `CREATE FUNCTION public.mid() RETURNS SETOF int LANGUAGE plpgsql VOLATILE AS $$ DECLARE v int; a int[]; r record; c refcursor; x int; BEGIN ${form} RETURN; END $$;\n`
    expect(
      reach(
        handler("PERFORM public.mid();"),
        mid + dynamicFunction("public.dyn")
      )
    ).toEqual([found("public.dyn", "nonLiteralExecute", "public.mid")])
  })

  it.each([
    { declare: "v int := public.dyn();", body: "" },
    { declare: "k CURSOR FOR SELECT public.dyn();", body: "OPEN k;" },
    // Ініціалізатор запису Postgres обчислює на вході в блок, а дерево
    // розбору його не несе.
    { declare: "r record := ROW(public.dyn());", body: "" },
  ])("plpgsql declaration: $declare", ({ declare, body }) => {
    const mid = `CREATE FUNCTION public.mid() RETURNS int LANGUAGE plpgsql VOLATILE AS $$ DECLARE ${declare} BEGIN ${body} RETURN NULL; END $$;\n`
    expect(
      reach(
        handler("PERFORM public.mid();"),
        mid + dynamicFunction("public.dyn")
      )
    ).toEqual([found("public.dyn", "nonLiteralExecute", "public.mid")])
  })

  // Текст, якого компілятор не прочитав, ховав би виклики: досягнута
  // функція з ним недосудна, а голова — знахідка сама собі.
  it.each([
    {
      name: "unreadable literal in a reached function",
      head: handler("PERFORM public.bad();"),
      shared: plpgsqlFunction("public.bad", "EXECUTE 'SELEC 1';"),
      expected: [found("public.bad", "unknown")],
    },
    {
      name: "unreadable sql body of a reached function",
      head: handler("PERFORM public.bad();"),
      shared: sqlFunction("public.bad", "SELEC 1"),
      expected: [found("public.bad", "unknown")],
    },
    {
      // Блок DO виконує plpgsql, тексту якого обхід не читає.
      name: "DO block in a reached function",
      head: handler("PERFORM public.bad();"),
      shared: plpgsqlFunction(
        "public.bad",
        "EXECUTE 'DO $d$ BEGIN PERFORM 1; END $d$';"
      ),
      expected: [found("public.bad", "unknown")],
    },
    {
      // `EXECUTE` підготовленого оператора сесії виконує текст, якого тіло не
      // несе.
      name: "prepared statement in a reached function",
      head: handler("PERFORM public.bad();"),
      shared: plpgsqlFunction("public.bad", "EXECUTE 'EXECUTE p';"),
      expected: [found("public.bad", "unknown")],
    },
    {
      name: "unreadable literal in the head",
      head: handler("EXECUTE 'SELEC 1';"),
      shared: "",
      expected: [{ function: HEAD, chain: [HEAD], reason: "unknown" }],
    },
  ])("$name", ({ head, shared, expected }) => {
    expect(reach(head, shared)).toEqual(expected)
  })
})

const brief = (diagnostics: readonly Diagnostic[], codes: readonly string[]) =>
  diagnostics
    .filter((d) => codes.includes(d.code))
    .map((d) => ({ code: d.code, file: d.file, params: d.params }))

/** Компіляція домену політик із прийнятим боргом: предмет — не ратчет. */
async function compiled(sql: Record<string, string>, layers: Layer[] = []) {
  const result = policyDomain(...layers)
  for (const [path, text] of Object.entries(sql)) result.set(path, text)
  return compile(await acceptDebt(result))
}

describe("checkLinks: sql.command-context-reach", () => {
  const reachCodes = ["sql.command-context-reach"]

  it("names the head, the reached function and the chain", async () => {
    const result = await compiled({
      [COUNT_COMMENT_SQL_FILE]: handler("PERFORM public.helper();"),
      [SHARED]: dynamicFunction("public.helper"),
    })
    expect(brief(result.diagnostics, reachCodes)).toEqual([
      {
        code: "sql.command-context-reach",
        file: COUNT_COMMENT_SQL_FILE,
        params: {
          function: "public.helper",
          chain: "public.count_comment → public.helper",
          reason: "nonLiteralExecute",
        },
      },
    ])
  })

  it("judges a function of a closed module as a head", async () => {
    const result = await compiled({
      [PROJECT_MODULE]: sqlFunction(
        "public.project_total",
        "SELECT public.helper()"
      ).replace("STABLE", "STABLE SET search_path = ''"),
      [SHARED]: dynamicFunction("public.helper"),
    })
    expect(brief(result.diagnostics, reachCodes)).toEqual([
      {
        code: "sql.command-context-reach",
        file: PROJECT_MODULE,
        params: {
          function: "public.helper",
          chain: "public.project_total → public.helper",
          reason: "nonLiteralExecute",
        },
      },
    ])
  })

  it("leaves the own body of a handler to its shell check", async () => {
    const result = await compiled({
      [COUNT_COMMENT_SQL_FILE]: handler("EXECUTE format('SELECT %s', 1);"),
    })
    expect(
      result.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => d.code)
    ).toEqual(["subscription.handler-not-closed"])
  })

  it("keeps dynamic SQL that closed code does not reach as debt", async () => {
    expectClean(await compiled({ [SHARED]: dynamicFunction("public.helper") }))
  })

  it("trusts the platform schema and generated functions", async () => {
    expectClean(
      await compiled({
        [COUNT_COMMENT_SQL_FILE]: handler(
          `PERFORM simetra.current_user_id(); PERFORM ${MY_MEMBER}(NEW.id);`
        ),
      })
    )
  })
})

/** Вимір `region` зі значеннями з функції `region_ids` і її ланкою. */
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
const DIMENSION_SQL =
  "CREATE FUNCTION public.region_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT public.region_link() $$;\n" +
  "CREATE FUNCTION public.region_link() RETURNS SETOF uuid LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT NULL::uuid $$;\n"
const PROJECT_FUNCTION =
  "CREATE FUNCTION public.project_label() RETURNS int LANGUAGE sql STABLE SECURITY INVOKER AS $$ SELECT 1 $$;\n"

describe("sql.function-settings-shell", () => {
  const codes = [
    "sql.function-settings-shell",
    "sql.statement-not-allowed",
    "sql.debt-grows",
  ]
  const shell = (file: string, fn: string, setting: string) => ({
    code: "sql.function-settings-shell",
    file,
    params: { function: fn, setting },
  })

  it.each([
    {
      name: "a closed module function made SECURITY DEFINER",
      sql: {
        [PROJECT_MODULE]: PROJECT_FUNCTION,
        [SHARED]: "ALTER FUNCTION public.project_label() SECURITY DEFINER;",
      },
      layers: [],
      expected: [shell(SHARED, "public.project_label", "security")],
    },
    {
      name: "a scope set function losing its search_path",
      sql: { [SHARED]: "ALTER FUNCTION public.team_ids() RESET search_path;" },
      layers: [teamScopeKind()],
      expected: [shell(SHARED, "public.team_ids", "search_path")],
    },
    {
      name: "a handler losing every option",
      sql: { [SHARED]: "ALTER FUNCTION public.count_comment() RESET ALL;" },
      layers: [],
      expected: [shell(SHARED, HEAD, "*")],
    },
    {
      name: "ALTER without arguments of a handler",
      sql: { [SHARED]: "ALTER FUNCTION public.count_comment RESET ALL;" },
      layers: [],
      expected: [shell(SHARED, HEAD, "*")],
    },
    {
      name: "a dimension values function made IMMUTABLE",
      sql: {
        [SHARED]:
          DIMENSION_SQL + "ALTER FUNCTION public.region_ids() IMMUTABLE;",
      },
      layers: [dimensionFunction()],
      expected: [shell(SHARED, "public.region_ids", "volatility")],
    },
    {
      name: "a link of a dimension chain losing its search_path",
      sql: {
        [SHARED]:
          DIMENSION_SQL +
          "ALTER FUNCTION public.region_link() RESET search_path;",
      },
      layers: [dimensionFunction()],
      expected: [shell(SHARED, "public.region_link", "search_path")],
    },
    {
      name: "ALTER inside a closed module",
      sql: {
        [PROJECT_MODULE]:
          PROJECT_FUNCTION +
          "ALTER FUNCTION public.project_label() SECURITY DEFINER;",
      },
      layers: [],
      expected: [
        shell(PROJECT_MODULE, "public.project_label", "security"),
        {
          code: "sql.statement-not-allowed",
          file: PROJECT_MODULE,
          params: {
            statement: "AlterFunctionStmt",
            line: 2,
            detail: "kindModule",
            class: "functionSettings",
          },
        },
      ],
    },
    {
      name: "claims set on a handler from a debt module",
      sql: {
        [COUNTER_MODULE]:
          "ALTER FUNCTION public.count_comment() SET request.jwt.claims = '{}';",
      },
      layers: [],
      expected: [shell(COUNTER_MODULE, HEAD, "request.jwt.claims")],
    },
  ])("rejects $name", async ({ sql, layers, expected }) => {
    const result = await compiled(sql, layers)
    expect(brief(result.diagnostics, codes)).toEqual(expected)
  })

  it("leaves ALTER FUNCTION of an ordinary shared function to the debt", async () => {
    expectClean(
      await compiled({
        [SHARED]:
          sqlFunction("public.plain", "SELECT 1") +
          "ALTER FUNCTION public.plain() SECURITY DEFINER;",
      })
    )
  })
})

describe("reach trust of generated functions", () => {
  // Обгортка запиту рухів несе запит застосунку, тож довіри не має; функції
  // оболонки проведення пише компілятор.
  it.each([
    { call: "public.sale_stock_movements(NEW.id)", reason: "unknown" },
    { call: "public.sale_post(NEW.id)", reason: undefined },
  ])("$call", async ({ call, reason }) => {
    const result = await compile(
      await acceptDebt(
        metaFiles({
          "project.meta.json": project(),
          ...salesDocument(),
          "event-subscriptions/StampSale/StampSale.meta.json": {
            id: uuid(7101),
            kind: "EventSubscription",
            name: "StampSale",
            physicalName: "stamp_sale",
            sources: [{ kind: "Document", name: "Sale" }],
            event: "onWrite",
            handler: { schema: "public", name: "stamp_sale" },
          },
          "sql/public/stamp-sale.sql": `CREATE FUNCTION public.stamp_sale() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM ${call}; RETURN NEW; END $$;`,
        })
      )
    )
    expect(
      result.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => [d.code, d.params?.reason])
    ).toEqual(
      reason === undefined ? [] : [["sql.command-context-reach", reason]]
    )
  })
})
