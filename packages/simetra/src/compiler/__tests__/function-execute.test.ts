import { beforeAll, describe, expect, it } from "vitest"
import { applyChanges, compile, fixFiles } from "simetra/compiler"
import { PLATFORM_ROLES } from "simetra/model"
import type { QualifiedName } from "../contracts"
import {
  buildFunctionExecuteUnits,
  type FunctionExecuteSources,
} from "../function-execute"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { readSqlUnits } from "../sql/units"
import {
  DOCS_GRANT,
  POLICY_DEBT,
  POLICY_FUNCTION,
  READ_POLICY,
  policyFiles,
} from "./fixtures/policy-function"
import {
  DIMENSION_SQL,
  compiledPolicyDomain,
  dimensionFunction,
} from "./fixtures/rights"
import {
  expectClean,
  acceptDebt,
  attribute,
  catalog,
  metaFiles,
  project,
  uuid,
} from "./helpers"

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const GRANTS_FILE = "sql/public/g.sql"

/** Вид скоупу `org` з оголошеною функцією множини `public.my_orgs()`. */
function scopeEntries(extra: Record<string, unknown> = {}) {
  return {
    "project.meta.json": project({
      scopeKinds: [
        {
          id: uuid(9001),
          name: "org",
          physicalName: "org_id",
          root: { object: { kind: "Catalog", name: "Organization" } },
          setFunction: { name: "my_orgs" },
        },
      ],
    }),
    "catalogs/Organization/Organization.meta.json": catalog("Organization", {
      scope: "org",
    }),
    "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
    ...extra,
  }
}

/** Проєкт, де функцію множини генерує членство: `public.org_member_scopes()`. */
function membershipEntries(extra: Record<string, unknown> = {}) {
  return {
    "project.meta.json": project({
      scopeKinds: [
        {
          id: uuid(9101),
          name: "org",
          physicalName: "org_id",
          root: { object: { kind: "Catalog", name: "Organization" } },
          setFunction: "membership",
        },
      ],
    }),
    "catalogs/Organization/Organization.meta.json": catalog("Organization", {
      scope: "org",
    }),
    "catalogs/Users/Users.meta.json": catalog("Users", {
      id: uuid(9102),
      role: "users",
      scope: "none",
    }),
    "catalogs/OrgMember/OrgMember.meta.json": catalog("OrgMember", {
      physicalName: "org",
      scope: "org",
      membership: { user: "user" },
      attributes: [
        attribute("user", {
          physicalName: "user_id",
          type: "Ref",
          ref: { kind: "Catalog", name: "Users" },
        }),
      ],
    }),
    ...extra,
  }
}

const HANDLER_SQL =
  "CREATE FUNCTION public.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN RETURN NEW; END $$;"

function subscription(n: number, name: string) {
  return {
    id: uuid(n),
    kind: "EventSubscription",
    name,
    physicalName: name.toLowerCase(),
    sources: [{ kind: "Catalog", name: "Item" }],
    event: "beforeWrite",
    handler: { name: "stamp" },
  }
}

async function compiled(files: Map<string, string>) {
  const result = await compile(files)
  expectClean(result, { allow: ["rights.scope-kind-unread"] })
  return result.model!
}

/** Компіляція з дослівними грантами у `GRANTS_FILE`; борг прийнято. */
/**
 * Діагностики компіляції без попередження виду скоупу: фікстури скоуплені й
 * без ролей, а перевірки тут — лише про гранти (як `allow` в `expectClean`).
 */
async function grantDiagnostics(entries: Record<string, unknown>, sql: string) {
  const files = await acceptDebt(metaFiles({ ...entries, [GRANTS_FILE]: sql }))
  return (await compile(files)).diagnostics.filter(
    (d) => d.code !== "rights.scope-kind-unread"
  )
}

/** Джерела генератора: лише форми платформи, без одиниць `CREATE`. */
const sources = (
  setFunctions: QualifiedName[],
  handlers: QualifiedName[]
): FunctionExecuteSources => ({
  forms: [
    ...setFunctions.map((fn) => ({
      function: fn,
      form: "setFunction" as const,
    })),
    ...handlers.map((fn) => ({
      function: fn,
      form: "subscriptionHandler" as const,
    })),
  ],
  declared: [],
  units: [],
  moduleOwners: new Set(),
})

describe("buildFunctionExecuteUnits", () => {
  it("a declared set function revokes PUBLIC and anon and grants authenticated, service_role and the command role", () => {
    const units = buildFunctionExecuteUnits(
      sources([{ schema: "public", name: "my_orgs" }], []),
      "supabase",
      "app",
      parse
    )
    expect(units.map((u) => u.sql).sort()).toEqual(
      [
        "REVOKE EXECUTE ON FUNCTION public.my_orgs() FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.my_orgs() FROM anon;",
        "GRANT EXECUTE ON FUNCTION public.my_orgs() TO authenticated;",
        "GRANT EXECUTE ON FUNCTION public.my_orgs() TO service_role;",
        `GRANT EXECUTE ON FUNCTION public.my_orgs() TO ${PLATFORM_ROLES.command};`,
      ].sort()
    )
    for (const unit of units) {
      expect(unit.generator).toBe("functionExecute")
      expect(unit.class).toBe("grant")
      expect(unit.file).toBeUndefined()
      expect(unit.module).toBe("app")
    }
  })

  it("a declared set function is executable by the command role", () => {
    const sql = buildFunctionExecuteUnits(
      sources([{ schema: "public", name: "my_orgs" }], []),
      "supabase",
      "app",
      parse
    ).map((u) => u.sql)
    expect(sql).toContain(
      `GRANT EXECUTE ON FUNCTION public.my_orgs() TO ${PLATFORM_ROLES.command};`
    )
    expect(sql).not.toContain(
      `REVOKE EXECUTE ON FUNCTION public.my_orgs() FROM ${PLATFORM_ROLES.command};`
    )
  })

  it("compile generates the set function grants of a scope kind", async () => {
    const model = await compiled(metaFiles(scopeEntries()))
    expect(
      model.sqlUnits
        .filter((u) => u.generator === "functionExecute")
        .map((u) => u.sql)
        .sort()
    ).toEqual(
      buildFunctionExecuteUnits(
        sources([{ schema: "public", name: "my_orgs" }], []),
        "supabase",
        "TestApp",
        parse
      )
        .map((u) => u.sql)
        .sort()
    )
  })

  it("setFunction membership gets no functionExecute unit and no duplicate identity", async () => {
    const model = await compiled(metaFiles(membershipEntries()))
    expect(
      model.sqlUnits.filter((u) => u.generator === "functionExecute")
    ).toEqual([])
    const identities = model.sqlUnits.map((u) => u.identity)
    expect(new Set(identities).size).toBe(identities.length)
  })

  it("a subscription handler is revoked from PUBLIC and every API role", () => {
    const units = buildFunctionExecuteUnits(
      sources([], [{ schema: "public", name: "stamp" }]),
      "supabase",
      "app",
      parse
    )
    expect(units.map((u) => u.sql).sort()).toEqual(
      [
        "REVOKE EXECUTE ON FUNCTION public.stamp() FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.stamp() FROM anon;",
        "REVOKE EXECUTE ON FUNCTION public.stamp() FROM authenticated;",
        "REVOKE EXECUTE ON FUNCTION public.stamp() FROM service_role;",
      ].sort()
    )
  })

  it("two subscriptions with one handler give one group of grants", async () => {
    const model = await compiled(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Item/Item.meta.json": catalog("Item", {
          attributes: [attribute("note", { type: "String", length: 20 })],
        }),
        "event-subscriptions/StampA/StampA.meta.json": subscription(
          9201,
          "StampA"
        ),
        "event-subscriptions/StampB/StampB.meta.json": subscription(
          9202,
          "StampB"
        ),
        "sql/public/stamp.sql": HANDLER_SQL,
      })
    )
    const units = model.sqlUnits.filter(
      (u) => u.generator === "functionExecute"
    )
    expect(units).toHaveLength(4)
    expect(units.every((u) => u.sql.startsWith("REVOKE"))).toBe(true)
  })
})

describe("sql.generated-grant", () => {
  it("a verbatim grant on a declared set function is an error", async () => {
    const diagnostics = await grantDiagnostics(
      scopeEntries(),
      "GRANT EXECUTE ON FUNCTION public.my_orgs() TO anon;"
    )
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      code: "sql.generated-grant",
      severity: "error",
      file: GRANTS_FILE,
      params: {
        identity: "grant:grant:function:public.my_orgs():anon:execute",
        line: 1,
        object: "public.my_orgs()",
      },
    })
  })

  it("a grant on another overload of the same name is not", async () => {
    const diagnostics = await grantDiagnostics(
      scopeEntries(),
      "GRANT EXECUTE ON FUNCTION public.my_orgs(text) TO anon;"
    )
    expect(diagnostics.filter((d) => d.code === "sql.generated-grant")).toEqual(
      []
    )
  })

  it("a verbatim grant on a kind table is an error, to any role", async () => {
    const diagnostics = await grantDiagnostics(
      scopeEntries(),
      "GRANT SELECT ON TABLE public.item TO some_group;"
    )
    expect(diagnostics.map((d) => [d.code, d.params?.object])).toEqual([
      ["sql.generated-grant", "public.item"],
    ])
  })

  it("a verbatim column grant on a kind table is an error", async () => {
    // Колонкові гранти таблиці виду теж належать платформі (Рт10): інакше
    // дослівний `UPDATE (x)` розширив би колонки зміни ролі команд.
    const diagnostics = await grantDiagnostics(
      scopeEntries(),
      `GRANT UPDATE (description) ON TABLE public.item TO ${PLATFORM_ROLES.command};`
    )
    expect(diagnostics.map((d) => [d.code, d.params?.object])).toEqual([
      ["sql.generated-grant", "public.item"],
    ])
  })

  it("a verbatim copy of a generated membership grant is generated-grant, not unit-duplicate", async () => {
    const diagnostics = await grantDiagnostics(
      membershipEntries(),
      "REVOKE EXECUTE ON FUNCTION public.org_member_scopes() FROM PUBLIC;"
    )
    expect(diagnostics.map((d) => [d.code, d.params?.object])).toEqual([
      ["sql.generated-grant", "public.org_member_scopes()"],
    ])
  })

  it("a grant on the set function without an argument list is an error", async () => {
    // Postgres резолвить `ON FUNCTION f` у єдину функцію з цим ім'ям.
    const diagnostics = await grantDiagnostics(
      scopeEntries(),
      "GRANT EXECUTE ON FUNCTION public.my_orgs TO anon;"
    )
    expect(diagnostics.map((d) => [d.code, d.params?.object])).toEqual([
      ["sql.generated-grant", "public.my_orgs"],
    ])
  })

  it("a grant without an argument list on another name is fine", async () => {
    const diagnostics = await grantDiagnostics(
      scopeEntries(),
      "GRANT EXECUTE ON FUNCTION public.my_orgs_x TO anon;"
    )
    expectClean({ diagnostics }, { allow: ["rights.scope-kind-unread"] })
  })

  it("a statement on a platform and another function names only the platform one", async () => {
    const diagnostics = await grantDiagnostics(
      scopeEntries(),
      "GRANT EXECUTE ON FUNCTION public.my_orgs(), public.other() TO anon;"
    )
    expect(diagnostics.map((d) => [d.code, d.params?.object])).toEqual([
      ["sql.generated-grant", "public.my_orgs()"],
    ])
  })

  it("a verbatim grant on another function is fine", async () => {
    const diagnostics = await grantDiagnostics(
      scopeEntries(),
      "GRANT EXECUTE ON FUNCTION public.other() TO anon;"
    )
    expectClean({ diagnostics }, { allow: ["rights.scope-kind-unread"] })
  })
})

/** Функція в закритій оболонці; `definer` — `SECURITY DEFINER`. */
const closedFn = (name: string, args = "", definer = false) =>
  `CREATE FUNCTION ${name}(${args}) RETURNS int LANGUAGE sql STABLE${definer ? " SECURITY DEFINER" : ""} SET search_path = '' AS $$ SELECT 1 $$;\n`

let nextDeclarationId = 9400
const functionsFile = (
  ...entries: {
    function: { schema?: string; name: string }
    callers: string[]
  }[]
) =>
  JSON.stringify({
    functions: entries.map((entry) => ({
      id: uuid(++nextDeclarationId),
      ...entry,
    })),
  })

const ITEM_FILE = "catalogs/Item/Item.meta.json"
const ITEM_MODULE = "catalogs/Item/Item.sql"

/** Компіляція `entries` на `provider` з прийнятим боргом; результат цілий. */
async function compiledOn(
  entries: Record<string, unknown>,
  provider: "supabase" | "postgres" = "supabase"
) {
  const files = await acceptDebt(
    metaFiles({
      "project.meta.json": project({ database: { provider } }),
      [ITEM_FILE]: catalog("Item", { scope: "none" }),
      ...entries,
    })
  )
  const result = await compile(files)
  return result
}

async function executeSql(
  entries: Record<string, unknown>,
  provider: "supabase" | "postgres" = "supabase"
) {
  const result = await compiledOn(entries, provider)
  expectClean(result)
  return result
    .model!.sqlUnits.filter((u) => u.generator === "functionExecute")
    .map((u) => u.sql)
    .sort()
}

describe("EXECUTE of declared, dimension and module functions", () => {
  it.each([
    {
      provider: "supabase" as const,
      callers: ["user"],
      expected: [
        "REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.f() FROM anon;",
        "REVOKE EXECUTE ON FUNCTION public.f() FROM service_role;",
        "GRANT EXECUTE ON FUNCTION public.f() TO authenticated;",
      ],
    },
    {
      provider: "postgres" as const,
      callers: ["user"],
      expected: [
        "REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.f() FROM simetra_anon;",
        "GRANT EXECUTE ON FUNCTION public.f() TO simetra_user;",
      ],
    },
    {
      provider: "supabase" as const,
      callers: ["anonymous", "service", "command"],
      expected: [
        "REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.f() FROM authenticated;",
        "GRANT EXECUTE ON FUNCTION public.f() TO anon;",
        "GRANT EXECUTE ON FUNCTION public.f() TO service_role;",
        `GRANT EXECUTE ON FUNCTION public.f() TO ${PLATFORM_ROLES.command};`,
      ],
    },
    {
      // Сервісної ролі профіль `postgres` не має: призначення пропускається.
      provider: "postgres" as const,
      callers: ["anonymous", "service", "command"],
      expected: [
        "REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.f() FROM simetra_user;",
        "GRANT EXECUTE ON FUNCTION public.f() TO simetra_anon;",
        `GRANT EXECUTE ON FUNCTION public.f() TO ${PLATFORM_ROLES.command};`,
      ],
    },
    {
      provider: "supabase" as const,
      callers: [],
      expected: [
        "REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.f() FROM anon;",
        "REVOKE EXECUTE ON FUNCTION public.f() FROM authenticated;",
        "REVOKE EXECUTE ON FUNCTION public.f() FROM service_role;",
      ],
    },
  ])(
    "a declared function with callers $callers on $provider",
    async ({ provider, callers, expected }) => {
      expect(
        await executeSql(
          {
            "sql/public/fns.sql": closedFn("public.f"),
            "sql/public/fns.functions.json": functionsFile({
              function: { name: "f" },
              callers,
            }),
          },
          provider
        )
      ).toEqual(expected.sort())
    }
  )

  it.each(["supabase", "postgres"] as const)(
    "a declared definer function with callers service is revoked from PUBLIC and every other API role on %s",
    async (provider) => {
      const sql = await executeSql(
        {
          "sql/public/fns.sql": closedFn("public.svc", "", true),
          "sql/public/fns.functions.json": functionsFile({
            function: { name: "svc" },
            callers: ["service"],
          }),
        },
        provider
      )
      expect(sql).toEqual(
        (provider === "supabase"
          ? [
              "REVOKE EXECUTE ON FUNCTION public.svc() FROM PUBLIC;",
              "REVOKE EXECUTE ON FUNCTION public.svc() FROM anon;",
              "REVOKE EXECUTE ON FUNCTION public.svc() FROM authenticated;",
              "GRANT EXECUTE ON FUNCTION public.svc() TO service_role;",
            ]
          : [
              "REVOKE EXECUTE ON FUNCTION public.svc() FROM PUBLIC;",
              "REVOKE EXECUTE ON FUNCTION public.svc() FROM simetra_anon;",
              "REVOKE EXECUTE ON FUNCTION public.svc() FROM simetra_user;",
            ]
        ).sort()
      )
    }
  )

  it("a declared function signature carries its argument types", async () => {
    expect(
      await executeSql({
        "sql/public/fns.sql": closedFn("public.f", "p_id uuid, p_names text[]"),
        "sql/public/fns.functions.json": functionsFile({
          function: { name: "f" },
          callers: ["user"],
        }),
      })
    ).toContain(
      "GRANT EXECUTE ON FUNCTION public.f(uuid, text[]) TO authenticated;"
    )
  })

  it("a declared function outside public gives USAGE on its schema to the callers", async () => {
    const result = await compiledOn({
      "sql/app/fns.sql": closedFn("app.f"),
      "sql/app/fns.functions.json": functionsFile({
        function: { schema: "app", name: "f" },
        callers: ["user", "command"],
      }),
    })
    expectClean(result)
    expect(
      result
        .model!.sqlUnits.filter((u) => u.generator === "schemaUsage")
        .map((u) => u.sql)
        .sort()
    ).toEqual(
      [
        "GRANT USAGE ON SCHEMA app TO authenticated;",
        `GRANT USAGE ON SCHEMA app TO ${PLATFORM_ROLES.command};`,
      ].sort()
    )
  })

  it("an undeclared module function with a parameter is revoked from PUBLIC and every API role", async () => {
    expect(
      await executeSql({
        [ITEM_MODULE]: closedFn("public.item_total", "p_id uuid"),
      })
    ).toEqual(
      [
        "REVOKE EXECUTE ON FUNCTION public.item_total(uuid) FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.item_total(uuid) FROM anon;",
        "REVOKE EXECUTE ON FUNCTION public.item_total(uuid) FROM authenticated;",
        "REVOKE EXECUTE ON FUNCTION public.item_total(uuid) FROM service_role;",
      ].sort()
    )
  })

  it("a declared module function gets its callers' grants", async () => {
    expect(
      await executeSql(
        {
          [ITEM_MODULE]: closedFn("public.item_total", "p_id uuid"),
          "catalogs/Item/Item.functions.json": functionsFile({
            function: { name: "item_total" },
            callers: ["user"],
          }),
        },
        "postgres"
      )
    ).toEqual(
      [
        "REVOKE EXECUTE ON FUNCTION public.item_total(uuid) FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.item_total(uuid) FROM simetra_anon;",
        "GRANT EXECUTE ON FUNCTION public.item_total(uuid) TO simetra_user;",
      ].sort()
    )
  })

  it("a dimension value function is revoked from PUBLIC and every API role", async () => {
    const result = await compiledPolicyDomain(
      { "sql/public/region.sql": DIMENSION_SQL },
      [dimensionFunction()]
    )
    expect(
      result
        .model!.sqlUnits.filter(
          (u) => u.generator === "functionExecute" && u.sql.includes("region_")
        )
        .map((u) => u.sql)
        .sort()
    ).toEqual(
      [
        "REVOKE EXECUTE ON FUNCTION public.region_ids() FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.region_ids() FROM anon;",
        "REVOKE EXECUTE ON FUNCTION public.region_ids() FROM authenticated;",
        "REVOKE EXECUTE ON FUNCTION public.region_ids() FROM service_role;",
      ].sort()
    )
  })
})

describe("sql.generated-grant on declared, dimension and module functions", () => {
  /** Коди й цілі `sql.generated-grant` компіляції з дослівним `GRANTS_FILE`. */
  async function generatedGrants(
    entries: Record<string, unknown>,
    sql: string
  ) {
    const result = await compiledOn({ ...entries, [GRANTS_FILE]: sql })
    return result.diagnostics.map((d) => [d.code, d.params?.object])
  }

  const service = {
    "sql/public/fns.sql": closedFn("public.svc", "", true),
    "sql/public/fns.functions.json": functionsFile({
      function: { name: "svc" },
      callers: ["service"],
    }),
  }

  it.each(["anon", PLATFORM_ROLES.command])(
    "a verbatim grant to %s on a declared definer function with callers service",
    async (role) => {
      expect(
        await generatedGrants(
          service,
          `GRANT EXECUTE ON FUNCTION public.svc() TO ${role};`
        )
      ).toEqual([["sql.generated-grant", "public.svc()"]])
    }
  )

  it("a verbatim revoke on a declared function", async () => {
    expect(
      await generatedGrants(
        service,
        "REVOKE EXECUTE ON FUNCTION public.svc() FROM service_role;"
      )
    ).toEqual([["sql.generated-grant", "public.svc()"]])
  })

  it("a verbatim grant on a module function with a parameter", async () => {
    expect(
      await generatedGrants(
        { [ITEM_MODULE]: closedFn("public.item_total", "p_id uuid") },
        "GRANT EXECUTE ON FUNCTION public.item_total(uuid) TO authenticated;"
      )
    ).toEqual([["sql.generated-grant", "public.item_total(uuid)"]])
  })

  it("a verbatim grant on a dimension value function", async () => {
    const result = await compiledPolicyDomain(
      {
        "sql/public/region.sql": DIMENSION_SQL,
        [GRANTS_FILE]:
          "GRANT EXECUTE ON FUNCTION public.region_ids() TO authenticated;",
      },
      [dimensionFunction()]
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "sql.generated-grant")
        .map((d) => d.params?.object)
    ).toEqual(["public.region_ids()"])
  })
})

describe("EXECUTE of functions with quoted identifier parts", () => {
  // Підпис гранту — ключ ідентичності, де кожна частина імені за `quoteIdent`
  // (#297): межа лапкованого ідентифікатора, регістр і `.`, `,`, `"` у ньому
  // доходять до `REVOKE`/`GRANT` як є, тож грант влучає рівно в цю функцію.
  /** Гранти задекларованої `fn` з файлу `file` на профілі `postgres`. */
  const declaredGrants = (
    sql: string,
    fn: { schema?: string; name: string },
    file = "sql/public/fns.sql"
  ) =>
    executeSql(
      {
        [file]: sql,
        [file.replace(".sql", ".functions.json")]: functionsFile({
          function: fn,
          callers: ["user"],
        }),
      },
      "postgres"
    )
  const grantsOn = (signature: string) =>
    [
      `REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC;`,
      `REVOKE EXECUTE ON FUNCTION ${signature} FROM simetra_anon;`,
      `GRANT EXECUTE ON FUNCTION ${signature} TO simetra_user;`,
    ].sort()

  it.each([
    {
      part: "a name in upper case",
      sql: closedFn('public."F"'),
      fn: { name: "F" },
      signature: 'public."F"()',
    },
    {
      part: "a name with a dot",
      sql: closedFn('public."a.b"'),
      fn: { name: "a.b" },
      signature: 'public."a.b"()',
    },
    {
      part: "a schema in upper case",
      sql: closedFn('"Sch".f'),
      fn: { schema: "Sch", name: "f" },
      signature: '"Sch".f()',
      file: "sql/Sch/fns.sql",
    },
    {
      part: "an argument type with a dot",
      sql: closedFn("public.f", 'a app."Code.Type"'),
      fn: { name: "f" },
      signature: 'public.f(app."Code.Type")',
    },
    {
      part: "an argument type with a comma",
      sql: closedFn("public.f", 'a "a,b"'),
      fn: { name: "f" },
      signature: 'public.f("a,b")',
    },
    {
      part: "an argument array type with a double quote",
      sql: closedFn("public.f", 'a int, b public."x""y"[]'),
      fn: { name: "f" },
      signature: 'public.f(int4, public."x""y"[])',
    },
    {
      part: "a model domain with a comma",
      sql:
        'CREATE DOMAIN public."x,y" AS int;\n' +
        closedFn("public.f", 'a "x,y"'),
      fn: { name: "f" },
      signature: 'public.f(public."x,y")',
    },
  ])(
    "a declared function with $part grants on its quoted signature",
    async ({ sql, fn, signature, file }) => {
      expect(await declaredGrants(sql, fn, file)).toEqual(grantsOn(signature))
    }
  )

  it("an undeclared module function with such an argument type is revoked too", async () => {
    expect(
      await executeSql(
        { [ITEM_MODULE]: closedFn("public.g", 'a app."Code.Type"') },
        "postgres"
      )
    ).toEqual(
      [
        'REVOKE EXECUTE ON FUNCTION public.g(app."Code.Type") FROM PUBLIC;',
        'REVOKE EXECUTE ON FUNCTION public.g(app."Code.Type") FROM simetra_anon;',
        'REVOKE EXECUTE ON FUNCTION public.g(app."Code.Type") FROM simetra_user;',
      ].sort()
    )
  })

  it("buildFunctionExecuteUnits grants every function, quoted parts included", () => {
    const { units } = readSqlUnits(
      [
        {
          file: "sql/public/fns.sql",
          text:
            closedFn("public.f", 'a app."Code.Type"') + closedFn("public.g"),
          schema: "public",
        },
      ],
      parse,
      []
    )
    const declared = units.map((unit, i) => ({
      declaration: {
        id: uuid(9490 + i),
        function: { name: unit.name },
        callers: ["user" as const],
      },
      file: "sql/public/fns.functions.json",
      pointer: `/functions/${i}`,
      unit,
      key: { schema: unit.schema, name: unit.name },
    }))
    const sql = buildFunctionExecuteUnits(
      { forms: [], declared, units, moduleOwners: new Set() },
      "postgres",
      "app",
      parse
    ).map((u) => u.sql)
    expect(sql.sort()).toEqual(
      [
        ...grantsOn('public.f(app."Code.Type")'),
        ...grantsOn("public.g()"),
      ].sort()
    )
  })

  it('type modifiers, arrays and the quoted catalog type "char" grant as before', async () => {
    expect(
      await executeSql({
        "sql/public/fns.sql": closedFn(
          "public.f",
          'a numeric(3,1)[], b "char", c varchar(3)'
        ),
        "sql/public/fns.functions.json": functionsFile({
          function: { name: "f" },
          callers: ["user"],
        }),
      })
    ).toEqual(
      [
        'REVOKE EXECUTE ON FUNCTION public.f("numeric"[], "char", "varchar") FROM PUBLIC;',
        'REVOKE EXECUTE ON FUNCTION public.f("numeric"[], "char", "varchar") FROM anon;',
        'REVOKE EXECUTE ON FUNCTION public.f("numeric"[], "char", "varchar") FROM service_role;',
        'GRANT EXECUTE ON FUNCTION public.f("numeric"[], "char", "varchar") TO authenticated;',
      ].sort()
    )
  })
})

describe("sql.generated-grant and a foreign function with the same unquoted text", () => {
  // Дослівний грант на чужу функцію, текст якої без лапок збігається з
  // підписом задекларованої, — не грант платформи: його не названо
  // `sql.generated-grant`, і `fix` його не вирізає (#297).
  it.each([
    {
      part: "the case of the name",
      sql: closedFn('public."F"') + closedFn("public.f"),
      fn: { name: "F" },
      grant: "GRANT EXECUTE ON FUNCTION public.f() TO simetra_anon;",
    },
    {
      part: "the boundary of a dot",
      sql: closedFn('public."a.b"'),
      fn: { name: "a.b" },
      grant: 'GRANT EXECUTE ON FUNCTION "public.a".b() TO simetra_anon;',
    },
    {
      part: "the boundary of a comma in a type",
      sql: closedFn("public.f", 'a "x,y"'),
      fn: { name: "f" },
      grant: "GRANT EXECUTE ON FUNCTION public.f(x, y) TO simetra_anon;",
    },
  ])(
    "a verbatim grant differing only by $part is not generated-grant and fix keeps it",
    async ({ sql, fn, grant }) => {
      const files = await acceptDebt(
        metaFiles({
          "project.meta.json": project({ database: { provider: "postgres" } }),
          [ITEM_FILE]: catalog("Item", { scope: "none" }),
          "sql/public/fns.sql": sql,
          "sql/public/fns.functions.json": functionsFile({
            function: fn,
            callers: ["user"],
          }),
          [GRANTS_FILE]: grant,
        })
      )
      expect(
        (await compile(files)).diagnostics.filter(
          (d) => d.code === "sql.generated-grant"
        )
      ).toEqual([])
      const fixed = await fixFiles(files, {
        schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
        newId: () => uuid(9599),
      })
      expect(applyChanges(files, fixed.changes).get(GRANTS_FILE)).toBe(grant)
    }
  )
})

describe("sql.function-argument-type-reference", () => {
  // `pg_proc` зберігає тип колонки на момент `CREATE`, а `GRANT` резолвить
  // `%type` заново: після зміни типу колонки грант влучив би в чуже
  // перевантаження. Тож функція з виведеним `EXECUTE` і аргументом `%type` —
  // помилка без гранту (fail-closed, #300).
  const found = (result: Awaited<ReturnType<typeof compiledOn>>) =>
    result.diagnostics
      .filter((d) => d.code === "sql.function-argument-type-reference")
      .map((d) => [d.severity, d.file, d.params?.function, d.params?.argument])
  const executeUnits = (result: Awaited<ReturnType<typeof compiledOn>>) =>
    (result.model?.sqlUnits ?? [])
      .filter((u) => u.generator === "functionExecute")
      .map((u) => u.sql)

  it("a declared function with a %type argument is an error without a grant", async () => {
    const result = await compiledOn({
      "sql/public/fns.sql":
        closedFn("public.f", 'a public."Item".code%type') +
        closedFn("public.g"),
      "sql/public/fns.functions.json": functionsFile(
        { function: { name: "f" }, callers: ["user"] },
        { function: { name: "g" }, callers: ["user"] }
      ),
    })
    expect(found(result)).toEqual([
      ["error", "sql/public/fns.sql", "public.f", 'public."Item".code%type'],
    ])
    expect(result.ok).toBe(false)
  })

  it("buildFunctionExecuteUnits gives no grant to a %type function and keeps the others", () => {
    const { units } = readSqlUnits(
      [
        {
          file: "sql/public/fns.sql",
          text:
            closedFn("public.f", "a public.item.code%type") +
            closedFn("public.g"),
          schema: "public",
        },
      ],
      parse,
      []
    )
    const declared = units.map((unit, i) => ({
      declaration: {
        id: uuid(9580 + i),
        function: { name: unit.name },
        callers: ["user" as const],
      },
      file: "sql/public/fns.functions.json",
      pointer: `/functions/${i}`,
      unit,
      key: { schema: unit.schema, name: unit.name },
    }))
    expect(
      buildFunctionExecuteUnits(
        { forms: [], declared, units, moduleOwners: new Set() },
        "postgres",
        "app",
        parse
      )
        .map((u) => u.sql)
        .sort()
    ).toEqual(
      [
        "REVOKE EXECUTE ON FUNCTION public.g() FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.g() FROM simetra_anon;",
        "GRANT EXECUTE ON FUNCTION public.g() TO simetra_user;",
      ].sort()
    )
  })

  it("an undeclared module function with a %type argument is an error too", async () => {
    const result = await compiledOn({
      [ITEM_MODULE]: closedFn("public.g", "a public.item.code%type"),
    })
    expect(found(result)).toEqual([
      ["error", ITEM_MODULE, "public.g", "public.item.code%type"],
    ])
    expect(executeUnits(result)).toEqual([])
  })

  it("a function without a derived EXECUTE may take a %type argument", async () => {
    const result = await compiledOn({
      "sql/public/fns.sql": closedFn("public.f", "a public.item.code%type"),
    })
    expect(found(result)).toEqual([])
    expect(executeUnits(result)).toEqual([])
  })
})

describe("EXECUTE of a policy function (І3)", () => {
  // Призначення — ролі `TO` політик-викликачів `SELECT`/`ALL` з викликом у
  // `USING`, що мають `SELECT` на T; решта ролей API відкликається.
  const policyGrants = async (sql: string, debt: readonly string[]) => {
    const result = await compile(policyFiles(sql, debt))
    expect(result.diagnostics).toEqual([])
    return result
      .model!.sqlUnits.filter(
        (u) => u.generator === "functionExecute" && u.sql.includes("public.f()")
      )
      .map((u) => u.sql)
      .sort()
  }

  it("grants only the reading role of the caller policy", async () => {
    expect(
      await policyGrants(
        POLICY_FUNCTION() + READ_POLICY() + DOCS_GRANT(),
        POLICY_DEBT()
      )
    ).toEqual(
      [
        "REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.f() FROM anon;",
        "REVOKE EXECUTE ON FUNCTION public.f() FROM service_role;",
        "GRANT EXECUTE ON FUNCTION public.f() TO authenticated;",
      ].sort()
    )
  })

  it("grants every reading role that selects T", async () => {
    expect(
      await policyGrants(
        POLICY_FUNCTION() +
          READ_POLICY("authenticated, service_role") +
          DOCS_GRANT() +
          DOCS_GRANT("service_role"),
        POLICY_DEBT(["docs_read"], ["authenticated", "service_role"])
      )
    ).toEqual(
      [
        "REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;",
        "REVOKE EXECUTE ON FUNCTION public.f() FROM anon;",
        "GRANT EXECUTE ON FUNCTION public.f() TO authenticated;",
        "GRANT EXECUTE ON FUNCTION public.f() TO service_role;",
      ].sort()
    )
  })

  it("a verbatim EXECUTE grant on a policy function is sql.generated-grant", async () => {
    const result = await compile(
      policyFiles(
        POLICY_FUNCTION() +
          READ_POLICY() +
          DOCS_GRANT() +
          "GRANT EXECUTE ON FUNCTION public.f() TO authenticated;\n",
        [
          ...POLICY_DEBT(),
          "grant:grant:function:public.f():authenticated:execute",
        ].sort()
      )
    )
    expect(result.diagnostics.map((d) => [d.code, d.params?.object])).toEqual([
      ["sql.generated-grant", "public.f()"],
    ])
  })
})
