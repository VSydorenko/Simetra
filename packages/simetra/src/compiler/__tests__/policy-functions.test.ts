import { beforeAll, describe, expect, it } from "vitest"
import type { DatabaseProvider, PhysicalTable } from "simetra/model"
import { isRepairError, repairKeys } from "../diagnostics"
import type { PlatformFormSource } from "../sql/closed-forms"
import { HEAD_BUILTINS } from "../sql/head-builtins"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import {
  checkPolicyFunctionHeads,
  policyFunctions,
  type PolicyFunctionsInput,
} from "../sql/policy-functions"
import { readSqlUnits } from "../sql/units"

let parse: SqlParser
let plpgsql: PlpgsqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
})

/** Прийнята таблиця знімка: колонки `uuid`, якщо тип не названо. */
function table(
  name: string,
  columns: readonly (string | [string, string])[],
  rowLevelSecurity: PhysicalTable["rowLevelSecurity"] = "off"
): PhysicalTable {
  const cols = columns.map((c): [string, string] =>
    typeof c === "string" ? [c, "uuid"] : c
  )
  return {
    schema: "public",
    name,
    origin: { objectId: `00000000-0000-4000-8000-${name.padStart(12, "0")}` },
    rowLevelSecurity,
    columns: cols.map(([n, type]) => ({
      name: n,
      type,
      notNull: true,
      origin: {},
    })),
    primaryKey: { name: `${name}_pkey`, columns: [cols[0]![0]] },
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
  }
}

/** T — `docs` під RLS; `members` і `flags` без RLS; `secrets` під RLS. */
const TABLES = [
  table("docs", ["id", "team_id", "owner_id", ["status", "text"]], "enabled"),
  table("members", ["id", "team_id", "user_id"]),
  table("flags", ["id"]),
  table("secrets", ["id"], "enabled"),
  table("codes", [["code", "text"]]),
]

const SHELL = "STABLE SECURITY DEFINER SET search_path = ''"
const JOIN = "FROM public.docs d JOIN public.members m ON m.team_id = d.team_id"
const ACTOR = "m.user_id = (SELECT auth.uid())"

/** Функція `public.f` у формі функції політики, якщо не перевизначено. */
function fn(
  body = `SELECT d.id ${JOIN} WHERE ${ACTOR}`,
  {
    args = "",
    returns = "SETOF uuid",
    language = "sql",
    shell = SHELL,
  }: { args?: string; returns?: string; language?: string; shell?: string } = {}
): string {
  return `CREATE FUNCTION public.f(${args}) RETURNS ${returns} LANGUAGE ${language} ${shell} AS $$ ${body} $$;\n`
}

/** Тіло з додатковими кон'юнктами після прив'язки до актора. */
const where = (...extra: string[]) =>
  fn(`SELECT d.id ${JOIN} WHERE ${[ACTOR, ...extra].join(" AND ")}`)

const policy = (
  using = "id IN (SELECT public.f())",
  { name = "docs_read", on = "docs", cmd = "SELECT", to = "authenticated" } = {}
) =>
  `CREATE POLICY ${name} ON public.${on} FOR ${cmd} TO ${to} USING (${using});\n`

const restrictive = (using: string, to = "authenticated") =>
  `CREATE POLICY lim ON public.docs AS RESTRICTIVE FOR SELECT TO ${to} USING (${using});\n`

const GRANT = "GRANT SELECT ON TABLE public.docs TO authenticated;\n"
const POLICY = policy()

function input(
  sql: string,
  {
    provider = "supabase",
    forms = [],
  }: { provider?: DatabaseProvider; forms?: PlatformFormSource[] } = {}
): PolicyFunctionsInput {
  const read = readSqlUnits(
    [{ file: "sql/public/debt.sql", text: sql, schema: "public" }],
    parse,
    []
  )
  expect(read.diagnostics).toEqual([])
  return {
    units: read.units,
    tables: TABLES,
    provider,
    forms,
    membershipFunctions: new Set(),
    parse,
    plpgsql,
  }
}

/** Діагностики як [функція, причина, решта причин]. */
function judged(sql: string, options?: Parameters<typeof input>[1]) {
  const result = policyFunctions(input(sql, options))
  return {
    diagnostics: result.diagnostics.map((d) => [
      d.code,
      `${d.params?.schema}.${d.params?.name}`,
      d.params?.reason,
      d.params?.detail,
    ]),
    functions: result.functions.map((f) => ({
      function: `${f.function.schema}.${f.function.name}`,
      table: `${f.table.schema}.${f.table.name}`,
      callers: f.callers.map((c) => c.identity),
      purposes: f.purposes,
    })),
  }
}

const refused = (reason: string, detail?: string) => ({
  diagnostics: [["sql.policy-helper-correlated", "public.f", reason, detail]],
  functions: [],
})

const accepted = (purposes: string[] = ["user"]) => ({
  diagnostics: [],
  functions: [
    {
      function: "public.f",
      table: "public.docs",
      callers: ["policy:public.docs.docs_read"],
      purposes,
    },
  ],
})

describe("policyFunctions: the form (І2)", () => {
  it("accepts the key of T bound to the actor through a join chain", () => {
    expect(judged(fn() + POLICY + GRANT)).toEqual(accepted())
  })

  // І2: кожна причина Р5 — свій рядок; мутація перевірки причини лишає
  // функцію формою, і рядок червоніє.
  it.each<{ name: string; sql: string; reason: string; detail?: string }>([
    // parameters, language, volatility, returns
    {
      name: "a parameter",
      sql:
        fn(undefined, { args: "p uuid" }) +
        policy("id IN (SELECT public.f(team_id))") +
        GRANT,
      reason: "parameters",
      detail: "policyShape",
    },
    {
      name: "plpgsql",
      sql:
        fn(`BEGIN RETURN QUERY SELECT d.id ${JOIN} WHERE ${ACTOR}; END`, {
          language: "plpgsql",
        }) +
        POLICY +
        GRANT,
      reason: "language",
    },
    {
      name: "VOLATILE",
      sql:
        fn(undefined, {
          shell: "VOLATILE SECURITY DEFINER SET search_path = ''",
        }) +
        POLICY +
        GRANT,
      reason: "volatility",
    },
    {
      name: "boolean",
      sql: fn(undefined, { returns: "boolean" }) + POLICY + GRANT,
      reason: "returns",
    },
    // outputKey
    {
      name: "ids of co-members through a self-join of memberships",
      sql:
        fn(
          `SELECT m2.user_id FROM public.members m1 JOIN public.members m2 ON m2.team_id = m1.team_id WHERE m1.user_id = (SELECT auth.uid())`
        ) +
        POLICY +
        GRANT,
      reason: "outputKey",
    },
    {
      name: "calling policies on several tables",
      sql:
        fn() +
        POLICY +
        policy(undefined, { name: "flags_read", on: "flags" }) +
        GRANT,
      reason: "outputKey",
      detail: "policyShape, policyRoles",
    },
    {
      name: "T twice in FROM",
      sql:
        fn(
          `SELECT d.id ${JOIN} JOIN public.docs d2 ON d2.id = d.id WHERE ${ACTOR}`
        ) +
        POLICY +
        GRANT,
      reason: "outputKey",
    },
    {
      name: "the key of T is not uuid",
      sql:
        fn(
          `SELECT c.code FROM public.codes c JOIN public.members m ON m.id = c.code WHERE ${ACTOR}`
        ) +
        policy("code IN (SELECT public.f())", { on: "codes" }) +
        "GRANT SELECT ON TABLE public.codes TO authenticated;\n",
      reason: "outputKey",
      detail: "policyShape",
    },
    // restrictiveBound
    {
      name: "a missing bound",
      sql: fn() + POLICY + GRANT + restrictive("status = 'open'"),
      reason: "restrictiveBound",
    },
    {
      name: "a missing bound TO PUBLIC",
      sql: fn() + POLICY + GRANT + restrictive("status = 'open'", "PUBLIC"),
      reason: "restrictiveBound",
    },
    {
      name: "a missing bound of an unknown role (Р3)",
      sql: fn() + POLICY + GRANT + restrictive("status = 'open'", "app_admin"),
      reason: "restrictiveBound",
    },
    {
      name: "a bound with current_user",
      sql:
        where("d.status <> current_user") +
        POLICY +
        GRANT +
        restrictive("status <> current_user"),
      reason: "restrictiveBound",
    },
    {
      name: "a bound with pg_has_role",
      sql:
        where("pg_catalog.pg_has_role('staff', 'member')") +
        POLICY +
        GRANT +
        restrictive("pg_catalog.pg_has_role('staff', 'member')"),
      reason: "restrictiveBound",
    },
    {
      name: "a bound that reads a table under RLS",
      sql:
        where("d.team_id IN (SELECT s.id FROM public.secrets s)") +
        POLICY +
        GRANT +
        restrictive("team_id IN (SELECT s.id FROM public.secrets s)"),
      reason: "restrictiveBound",
    },
    {
      name: "a bound that reads a security_invoker view",
      sql:
        "CREATE VIEW public.v WITH (security_invoker = true) AS SELECT f.id FROM public.flags f;\n" +
        where("d.team_id IN (SELECT v.id FROM public.v v)") +
        POLICY +
        GRANT +
        restrictive("team_id IN (SELECT v.id FROM public.v v)"),
      reason: "restrictiveBound",
    },
    {
      name: "a bound that reaches pg_has_role through an invoker function",
      sql:
        "CREATE FUNCTION public.is_staff() RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT pg_catalog.pg_has_role('staff', 'member') $$;\n" +
        where("public.is_staff()") +
        POLICY +
        GRANT +
        restrictive("public.is_staff()"),
      reason: "restrictiveBound",
    },
    // actorUnbound
    {
      name: "<>",
      sql:
        fn(`SELECT d.id ${JOIN} WHERE m.user_id <> (SELECT auth.uid())`) +
        POLICY +
        GRANT,
      reason: "actorUnbound",
    },
    {
      name: "OR true",
      sql: fn(`SELECT d.id ${JOIN} WHERE ${ACTOR} OR true`) + POLICY + GRANT,
      reason: "actorUnbound",
    },
    {
      name: "a cross join without a chain",
      sql:
        fn(`SELECT d.id FROM public.docs d, public.members m WHERE ${ACTOR}`) +
        POLICY +
        GRANT,
      reason: "actorUnbound",
    },
    {
      name: "UNION",
      sql:
        fn(
          `SELECT d.id ${JOIN} WHERE ${ACTOR} UNION SELECT d.id FROM public.docs d`
        ) +
        POLICY +
        GRANT,
      reason: "actorUnbound",
    },
    {
      name: "a derived table",
      sql:
        fn(
          `SELECT d.id FROM (SELECT x.id, x.team_id FROM public.docs x) d JOIN public.members m ON m.team_id = d.team_id WHERE ${ACTOR}`
        ) +
        POLICY +
        GRANT,
      reason: "actorUnbound",
    },
    {
      name: "WITH",
      sql:
        fn(`WITH w AS (SELECT 1) SELECT d.id ${JOIN} WHERE ${ACTOR}`) +
        POLICY +
        GRANT,
      reason: "actorUnbound",
    },
    {
      name: "a set-returning function in FROM",
      sql:
        fn(
          `SELECT d.id ${JOIN}, pg_catalog.generate_series(1, 2) g WHERE ${ACTOR}`
        ) +
        POLICY +
        GRANT,
      reason: "actorUnbound",
    },
    {
      name: "an outer join",
      sql:
        fn(
          `SELECT d.id FROM public.docs d LEFT JOIN public.members m ON m.team_id = d.team_id WHERE ${ACTOR}`
        ) +
        POLICY +
        GRANT,
      reason: "actorUnbound",
    },
    {
      name: "an expression in the output",
      sql: fn(`SELECT d.id::uuid ${JOIN} WHERE ${ACTOR}`) + POLICY + GRANT,
      reason: "actorUnbound",
    },
    {
      name: "= auth.role()",
      sql:
        fn(`SELECT d.id ${JOIN} WHERE m.user_id = auth.role()`) +
        POLICY +
        GRANT,
      reason: "actorUnbound",
    },
    {
      name: "a raw claim read",
      sql:
        fn(
          `SELECT d.id ${JOIN} WHERE m.user_id = (pg_catalog.current_setting('request.jwt.claims', true)::json->>'sub')::uuid`
        ) +
        POLICY +
        GRANT,
      reason: "actorUnbound",
    },
    // policyShape
    {
      name: "AND of atoms",
      sql:
        fn() +
        policy("id IN (SELECT public.f()) AND id IN (SELECT public.f())") +
        GRANT,
      reason: "policyShape",
    },
    {
      name: "NOT",
      sql: fn() + policy("NOT (id IN (SELECT public.f()))") + GRANT,
      reason: "policyShape",
    },
    {
      name: "a foreign condition",
      sql:
        fn() + policy("id IN (SELECT public.f()) OR status = 'open'") + GRANT,
      reason: "policyShape",
    },
    {
      name: "an atom over a column that is not the key",
      sql: fn() + policy("team_id IN (SELECT public.f())") + GRANT,
      reason: "policyShape",
    },
    // policyRoles
    {
      name: "TO PUBLIC",
      sql: fn() + policy(undefined, { to: "PUBLIC" }) + GRANT,
      reason: "policyRoles",
    },
    {
      name: "TO a role without a session",
      sql:
        fn() +
        policy(undefined, { to: "anon" }) +
        "GRANT SELECT ON TABLE public.docs TO anon;\n",
      reason: "policyRoles",
    },
    {
      name: "the only caller FOR UPDATE beside a narrower SELECT",
      sql:
        fn() +
        policy(undefined, { name: "docs_write", cmd: "UPDATE" }) +
        policy("status = 'open'") +
        GRANT,
      reason: "policyRoles",
    },
    {
      name: "a role only in FOR ALL … WITH CHECK",
      sql:
        fn() +
        "CREATE POLICY docs_all ON public.docs FOR ALL TO authenticated USING (true) WITH CHECK (id IN (SELECT public.f()));\n" +
        GRANT,
      reason: "policyRoles",
    },
    {
      name: "a role without SELECT on T",
      sql: fn() + POLICY,
      reason: "policyRoles",
    },
    {
      name: "a role whose SELECT on T is revoked",
      sql:
        fn() +
        POLICY +
        GRANT +
        "REVOKE SELECT ON TABLE public.docs FROM authenticated;\n",
      reason: "policyRoles",
    },
    {
      name: "a second role without SELECT on T (service_role)",
      sql:
        fn() + policy(undefined, { to: "authenticated, service_role" }) + GRANT,
      reason: "policyRoles",
    },
  ])("refuses $name", ({ sql, reason, detail }) => {
    expect(judged(sql)).toEqual(refused(reason, detail))
  })

  // Позитивні пари: заборонене в межі червоніє за вмістом, а не за
  // нерозпізнаною формою порівняння.
  it.each<{ name: string; sql: string }>([
    {
      name: "the bound in WHERE",
      sql:
        where("d.status = 'open'") +
        POLICY +
        GRANT +
        restrictive("status = 'open'"),
    },
    {
      name: "the bound TO PUBLIC in WHERE, qualified by the table",
      sql:
        where("d.status = 'open'") +
        POLICY +
        GRANT +
        restrictive("docs.status = 'open'", "PUBLIC"),
    },
    {
      name: "a bound of another profile role (anon) left out",
      sql: fn() + POLICY + GRANT + restrictive("status = 'open'", "anon"),
    },
    {
      name: "a bound reading a table without RLS",
      sql:
        where("d.team_id IN (SELECT s.id FROM public.flags s)") +
        POLICY +
        GRANT +
        restrictive("team_id IN (SELECT x.id FROM public.flags x)"),
    },
    {
      name: "a bound through an invoker function without forbidden calls",
      sql:
        "CREATE FUNCTION public.is_open() RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT true $$;\n" +
        where("public.is_open()") +
        POLICY +
        GRANT +
        restrictive("public.is_open()"),
    },
    {
      name: "an OR of atoms over policy functions",
      sql:
        fn() +
        "CREATE FUNCTION public.g() RETURNS SETOF uuid LANGUAGE sql " +
        SHELL +
        ` AS $$ SELECT d.id FROM public.docs d WHERE d.owner_id = auth.uid() $$;\n` +
        policy(
          "id IN (SELECT public.f()) OR id = ANY (ARRAY(SELECT public.g()))"
        ) +
        GRANT,
    },
    {
      name: "the actor equality written the other way round",
      sql:
        fn(`SELECT d.id ${JOIN} WHERE auth.uid() = m.user_id`) + POLICY + GRANT,
    },
  ])("accepts $name", ({ sql }) => {
    const { diagnostics, functions } = judged(sql)
    expect(diagnostics).toEqual([])
    expect(functions.map((f) => f.function)).toContain("public.f")
  })

  it("binds the actor through a scope set function", () => {
    const sql =
      fn(
        `SELECT d.id FROM public.docs d WHERE d.team_id IN (SELECT public.team_ids())`
      ) +
      POLICY +
      GRANT
    const forms: PlatformFormSource[] = [
      { function: { schema: "public", name: "team_ids" }, form: "setFunction" },
    ]
    expect(judged(sql, { forms })).toEqual(accepted())
    expect(judged(sql)).toEqual(refused("actorUnbound"))
  })

  it("on postgres takes simetra.current_user_id() and not auth.uid()", () => {
    const grant = "GRANT SELECT ON TABLE public.docs TO simetra_user;\n"
    const own = policy(undefined, { to: "simetra_user" })
    expect(
      judged(
        fn(
          `SELECT d.id ${JOIN} WHERE m.user_id = (SELECT simetra.current_user_id())`
        ) +
          own +
          grant,
        { provider: "postgres" }
      )
    ).toEqual(accepted())
    expect(judged(fn() + own + grant, { provider: "postgres" })).toEqual(
      refused("actorUnbound")
    )
  })

  it("derives the purposes of every reading caller role with SELECT on T", () => {
    expect(
      judged(
        fn() +
          policy(undefined, { to: "authenticated, service_role" }) +
          "GRANT SELECT ON TABLE public.docs TO authenticated, service_role;\n"
      )
    ).toEqual(accepted(["user", "service"]))
  })
})

describe("policyFunctions: recognition (Р2)", () => {
  it("skips an invoker function and another platform form", () => {
    const forms: PlatformFormSource[] = [
      { function: { schema: "public", name: "f" }, form: "setFunction" },
    ]
    expect(judged(fn() + POLICY + GRANT, { forms })).toEqual({
      diagnostics: [],
      functions: [],
    })
    expect(
      judged(fn(undefined, { shell: "STABLE SET search_path = ''" }) + POLICY)
    ).toEqual({ diagnostics: [], functions: [] })
  })

  it("refuses a policy that calls a values function of a dimension", () => {
    const forms: PlatformFormSource[] = [
      { function: { schema: "public", name: "f" }, form: "dimension" },
    ]
    expect(judged(fn() + POLICY + GRANT, { forms })).toEqual(
      refused("policyShape")
    )
  })

  it("is a repair-class error keyed by the function", () => {
    const { diagnostics } = policyFunctions(input(fn() + POLICY))
    expect(diagnostics.map(isRepairError)).toEqual([true])
    expect(repairKeys(diagnostics)).toEqual([
      { code: "sql.policy-helper-correlated", schema: "public", name: "f" },
    ])
  })
})

describe("checkPolicyFunctionHeads", () => {
  it("judges the head of a policy function with Rule 3", () => {
    const base = input(
      where("pg_catalog.inet_client_addr() IS NULL") + POLICY + GRANT
    )
    const { functions, diagnostics } = policyFunctions(base)
    expect(diagnostics).toEqual([])
    const scope = {
      units: base.units,
      readable: new Map(TABLES.map((t) => [`${t.schema}.${t.name}`, t])),
      trusted: new Set(["auth.uid"]),
      builtins: new Set(HEAD_BUILTINS),
      wrappers: new Map(),
      parse,
      plpgsql,
    }
    expect(
      checkPolicyFunctionHeads(functions, scope).map((d) => [
        d.code,
        d.params?.construct,
        d.params?.detail,
      ])
    ).toEqual([["sql.head-not-allowed", "call", "pg_catalog.inet_client_addr"]])
  })
})
