import { beforeAll, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { buildFunctionExecuteUnits } from "../function-execute"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import {
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
  "CREATE FUNCTION public.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$;"

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
  expect(result.diagnostics).toEqual([])
  return result.model!
}

/** Компіляція з дослівними грантами у `GRANTS_FILE`; борг прийнято. */
async function grantDiagnostics(entries: Record<string, unknown>, sql: string) {
  const files = await acceptDebt(metaFiles({ ...entries, [GRANTS_FILE]: sql }))
  return (await compile(files)).diagnostics
}

describe("buildFunctionExecuteUnits", () => {
  it("a declared set function revokes PUBLIC and anon and grants authenticated and service_role", () => {
    const units = buildFunctionExecuteUnits(
      [{ schema: "public", name: "my_orgs" }],
      [],
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
      ].sort()
    )
    for (const unit of units) {
      expect(unit.generator).toBe("functionExecute")
      expect(unit.class).toBe("grant")
      expect(unit.file).toBeUndefined()
      expect(unit.module).toBe("app")
    }
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
        [{ schema: "public", name: "my_orgs" }],
        [],
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
      [],
      [{ schema: "public", name: "stamp" }],
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
    expect(diagnostics).toEqual([])
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
    expect(diagnostics).toEqual([])
  })
})
