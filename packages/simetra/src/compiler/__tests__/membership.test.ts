import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import { attribute, catalog, metaFiles, project, uuid } from "./helpers"

const MEMBER_FILE = "catalogs/OrgMember/OrgMember.meta.json"
const ORG_FILE = "catalogs/Organization/Organization.meta.json"
const USERS_FILE = "catalogs/Users/Users.meta.json"

function membershipProject(setFunction: unknown = "membership") {
  return project({
    defaultSchema: "app",
    scopeKinds: [
      {
        id: uuid(80),
        name: "org",
        physicalName: "org_id",
        root: { object: { kind: "Catalog", name: "Organization" } },
        setFunction,
      },
    ],
  })
}

function userAttribute(overrides: Record<string, unknown> = {}) {
  return attribute("user", {
    physicalName: "user_id",
    type: "Ref",
    ref: { kind: "Catalog", name: "Users" },
    ...overrides,
  })
}

function member(name = "OrgMember", overrides: Record<string, unknown> = {}) {
  return catalog(name, {
    id: uuid(81),
    scope: "org",
    membership: { user: "user" },
    attributes: [userAttribute()],
    ...overrides,
  })
}

function files(overrides: Record<string, unknown> = {}) {
  return {
    "project.meta.json": membershipProject(),
    [ORG_FILE]: catalog("Organization", { scope: "org" }),
    [USERS_FILE]: catalog("Users", {
      id: uuid(70),
      role: "users",
      scope: "none",
    }),
    [MEMBER_FILE]: member(),
    ...overrides,
  }
}

async function compileOk(entries: Record<string, unknown>) {
  const result = await compile(metaFiles(entries))
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

function tableOf(physical: { tables: PhysicalTable[] }, name: string) {
  const table = physical.tables.find(
    (t) => t.schema === "app" && t.name === name
  )
  expect(table, name).toBeDefined()
  return table!
}

const MY_MEMBER = "function:app.org_member_my_member(uuid)"
const MEMBER_SCOPES = "function:app.org_member_member_scopes()"

describe("membership", () => {
  it("membership derives a NULLS DISTINCT unique key and two generated functions", async () => {
    const model = await compileOk(files())
    expect(tableOf(model.physical, "org_member").uniques).toContainEqual(
      expect.objectContaining({
        columns: ["org_id", "user_id"],
        nullsNotDistinct: false,
      })
    )
    const ids = model.sqlUnits.map((u) => u.identity)
    expect(ids).toEqual(expect.arrayContaining([MY_MEMBER, MEMBER_SCOPES]))
    const unit = (identity: string) =>
      model.sqlUnits.find((u) => u.identity === identity)!
    for (const identity of [MY_MEMBER, MEMBER_SCOPES]) {
      const { sql, file, ownerObjectId, schema } = unit(identity)
      expect(file).toBeUndefined()
      expect(ownerObjectId).toBe(uuid(81))
      expect(schema).toBe("app")
      expect(sql).toContain("LANGUAGE sql STABLE SECURITY DEFINER")
      expect(sql).toContain("SET search_path = ''")
      expect(sql).toContain("(SELECT simetra.current_user_id())")
    }
  })

  it("generated membership functions have the exact expected text", async () => {
    const model = await compileOk(files())
    const sqlOf = (identity: string) =>
      model.sqlUnits.find((u) => u.identity === identity)!.sql
    // Точний текст, а не фрагменти: фільтр за скоупом, колонка результату й
    // фільтр користувача — те, що підміна на «WHERE true» чи не ту колонку
    // зламала б мовчки.
    expect(sqlOf(MY_MEMBER)).toBe(
      [
        "CREATE OR REPLACE FUNCTION app.org_member_my_member(p_scope uuid)",
        "RETURNS uuid",
        "LANGUAGE sql STABLE SECURITY DEFINER",
        "SET search_path = ''",
        "AS $simetra$",
        "SELECT m.id",
        "FROM app.org_member m",
        "WHERE m.org_id = org_member_my_member.p_scope",
        "  AND m.user_id IS NOT NULL",
        "  AND m.user_id = (SELECT simetra.current_user_id())",
        "$simetra$;",
      ].join("\n")
    )
    expect(sqlOf(MEMBER_SCOPES)).toBe(
      [
        "CREATE OR REPLACE FUNCTION app.org_member_member_scopes()",
        "RETURNS SETOF uuid",
        "LANGUAGE sql STABLE SECURITY DEFINER",
        "SET search_path = ''",
        "AS $simetra$",
        "SELECT m.org_id",
        "FROM app.org_member m",
        "WHERE m.user_id IS NOT NULL",
        "  AND m.user_id = (SELECT simetra.current_user_id())",
        "$simetra$;",
      ].join("\n")
    )
  })

  it("generated membership functions revoke PUBLIC and anon and grant authenticated and service_role", async () => {
    const model = await compileOk(files())
    // Гранти самого членства: платформний шар «Користувачів» має власні.
    const grants = model.sqlUnits
      .filter((u) => u.class === "grant" && u.ownerObjectId === uuid(81))
      .map((u) => u.sql)
    // `PUBLIC` — дефолт Postgres, `anon` — типові привілеї схеми
    // провайдера: `REVOKE … FROM PUBLIC` їх не знімає. Сервісна роль виконує
    // функції й отримує порожній результат замість помилки доступу.
    expect(grants.sort()).toEqual([
      "GRANT EXECUTE ON FUNCTION app.org_member_member_scopes() TO authenticated;",
      "GRANT EXECUTE ON FUNCTION app.org_member_member_scopes() TO service_role;",
      "GRANT EXECUTE ON FUNCTION app.org_member_my_member(uuid) TO authenticated;",
      "GRANT EXECUTE ON FUNCTION app.org_member_my_member(uuid) TO service_role;",
      "REVOKE EXECUTE ON FUNCTION app.org_member_member_scopes() FROM PUBLIC;",
      "REVOKE EXECUTE ON FUNCTION app.org_member_member_scopes() FROM anon;",
      "REVOKE EXECUTE ON FUNCTION app.org_member_my_member(uuid) FROM PUBLIC;",
      "REVOKE EXECUTE ON FUNCTION app.org_member_my_member(uuid) FROM anon;",
    ])
    // REVOKE раніше за GRANT, функція — раніше за обидва, таблиця — раніше за функцію.
    const order = model.creationOrder.map((n) =>
      n.type === "unit" ? n.identity : `${n.type}:${n.schema}.${n.name}`
    )
    const at = (prefix: string) =>
      order.findIndex((label) => label.startsWith(prefix))
    expect(at("table:app.org_member")).toBeLessThan(at(MY_MEMBER))
    const grantOf = (prefix: string) =>
      model.sqlUnits.find((u) => u.sql.startsWith(prefix))!.identity
    const revoke = grantOf(
      "REVOKE EXECUTE ON FUNCTION app.org_member_my_member"
    )
    const grant = grantOf("GRANT EXECUTE ON FUNCTION app.org_member_my_member")
    expect(at(MY_MEMBER)).toBeLessThan(at(revoke))
    expect(at(revoke)).toBeLessThan(at(grant))
  })

  it("scope kind with setFunction membership uses the generated set function", async () => {
    const model = await compileOk(files())
    expect(model.scopeKinds[0]!.setFunction).toEqual({
      schema: "app",
      name: "org_member_member_scopes",
    })
    expect(model.contracts.membership).toEqual([
      {
        objectId: uuid(81),
        scopeKindId: uuid(80),
        table: { schema: "app", name: "org_member" },
        scopeColumn: "org_id",
        userColumn: "user_id",
        myMemberFunction: { schema: "app", name: "org_member_my_member" },
        setFunction: { schema: "app", name: "org_member_member_scopes" },
      },
    ])
  })

  it("a scope kind with its own set function gets only the member lookup", async () => {
    const model = await compileOk(
      files({ "project.meta.json": membershipProject({ name: "org_ids" }) })
    )
    const ids = model.sqlUnits.map((u) => u.identity)
    expect(ids).toContain(MY_MEMBER)
    expect(ids).not.toContain(MEMBER_SCOPES)
    expect(model.scopeKinds[0]!.setFunction).toEqual({
      schema: "app",
      name: "org_ids",
    })
    expect(model.contracts.membership[0]!.setFunction).toBeUndefined()
  })

  it("the membership user is in the reference index", async () => {
    const model = await compileOk(files())
    const [membershipUser] = model.references.filter(
      (r) => r.role === "catalog.membershipUser"
    )
    expect(membershipUser).toMatchObject({
      from: { file: MEMBER_FILE, pointer: "/membership/user" },
      to: { kind: "Element" },
    })
  })

  it("a unique user attribute does not duplicate the membership key", async () => {
    // `unique: true` реквізиту вже дає ключ (скоуп, користувач): другий такий
    // самий ключ був би зайвим індексом.
    const model = await compileOk(
      files({
        [MEMBER_FILE]: member("OrgMember", {
          attributes: [userAttribute({ unique: true })],
        }),
      })
    )
    const keys = tableOf(model.physical, "org_member").uniques.filter(
      (u) => u.columns.join() === "org_id,user_id"
    )
    expect(keys).toHaveLength(1)
  })

  it("setFunction membership looks for a membership catalog of its own scope kind only", async () => {
    // Членство чужого виду не може задовольнити вид, що його не має: перевірка
    // `scope === kind.name` відрізняє «є членство десь» від «є членство виду».
    const result = await compile(
      metaFiles(
        files({
          "project.meta.json": project({
            defaultSchema: "app",
            scopeKinds: [
              {
                id: uuid(80),
                name: "org",
                physicalName: "org_id",
                root: { object: { kind: "Catalog", name: "Organization" } },
                setFunction: "membership",
              },
              {
                id: uuid(83),
                name: "team",
                physicalName: "team_id",
                root: { object: { kind: "Catalog", name: "Team" } },
                setFunction: { name: "team_ids" },
              },
            ],
          }),
          "catalogs/Team/Team.meta.json": catalog("Team", { scope: "team" }),
          [MEMBER_FILE]: member("OrgMember", { scope: "team" }),
        })
      )
    )
    const found = result.diagnostics.filter(
      (d) => d.code === "scope.membership-missing"
    )
    expect(found.map((d) => `${d.file} ${d.pointer}`)).toEqual([
      "project.meta.json /scopeKinds/0/setFunction",
    ])
  })

  it("membership.user resolves to the named attribute, not the first one", async () => {
    const model = await compileOk(
      files({
        [MEMBER_FILE]: member("OrgMember", {
          attributes: [
            attribute("note", { id: uuid(90), type: "Text" }),
            userAttribute({ id: uuid(91) }),
          ],
        }),
      })
    )
    const [membershipUser] = model.references.filter(
      (r) => r.role === "catalog.membershipUser"
    )
    expect(membershipUser!.to).toEqual({ kind: "Element", id: uuid(91) })
  })

  it("a verbatim function named like a generated one is an error", async () => {
    const result = await compile(
      metaFiles(
        files({
          "sql/app/clash.sql":
            "CREATE FUNCTION app.org_member_my_member() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;",
        })
      )
    )
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "physical.function-duplicate"
    )
  })

  it.each<[string, Record<string, unknown>, string, string]>([
    [
      "unscoped",
      { [MEMBER_FILE]: member("OrgMember", { scope: "none" }) },
      "membership.not-scoped",
      `${MEMBER_FILE} /membership`,
    ],
    [
      "membership on the scope root",
      {
        [ORG_FILE]: catalog("Organization", {
          scope: "org",
          membership: { user: "user" },
          attributes: [userAttribute()],
        }),
      },
      "membership.not-scoped",
      `${ORG_FILE} /membership`,
    ],
    [
      "user attribute is an array",
      {
        [MEMBER_FILE]: member("OrgMember", {
          attributes: [userAttribute({ array: true })],
        }),
      },
      "membership.user-not-users-ref",
      `${MEMBER_FILE} /membership/user`,
    ],
    [
      "user attribute is missing",
      {
        [MEMBER_FILE]: member("OrgMember", { membership: { user: "nobody" } }),
      },
      "membership.user-not-users-ref",
      `${MEMBER_FILE} /membership/user`,
    ],
    [
      "user attribute is polymorphic",
      {
        [MEMBER_FILE]: member("OrgMember", {
          attributes: [
            userAttribute({
              ref: undefined,
              allowedTypes: [
                { kind: "Catalog", name: "Users" },
                { kind: "Catalog", name: "Organization" },
              ],
            }),
          ],
        }),
      },
      "membership.user-not-users-ref",
      `${MEMBER_FILE} /membership/user`,
    ],
    [
      "user attribute references another catalog",
      {
        [MEMBER_FILE]: member("OrgMember", {
          attributes: [
            userAttribute({ ref: { kind: "Catalog", name: "Organization" } }),
          ],
        }),
      },
      "membership.user-not-users-ref",
      `${MEMBER_FILE} /membership/user`,
    ],
    [
      "two membership catalogs of one scope kind",
      {
        "catalogs/OrgSeat/OrgSeat.meta.json": member("OrgSeat", {
          id: uuid(82),
        }),
      },
      "membership.duplicate",
      "catalogs/OrgSeat/OrgSeat.meta.json /membership",
    ],
    [
      "setFunction membership without a catalog",
      { [MEMBER_FILE]: undefined },
      "scope.membership-missing",
      "project.meta.json /scopeKinds/0/setFunction",
    ],
    [
      "no users catalog",
      {
        [USERS_FILE]: undefined,
        [MEMBER_FILE]: member("OrgMember", {
          attributes: [
            userAttribute({ ref: { kind: "Catalog", name: "Organization" } }),
          ],
        }),
      },
      "users.catalog-missing",
      `${MEMBER_FILE} /membership`,
    ],
  ])("%s is an error", async (_title, overrides, code, at) => {
    const entries = Object.fromEntries(
      Object.entries(files(overrides)).filter(([, v]) => v !== undefined)
    )
    const result = await compile(metaFiles(entries))
    const found = result.diagnostics.filter((d) => d.code === code)
    expect(found.map((d) => `${d.file} ${d.pointer}`)).toEqual([at])
    expect(found[0]!.severity).toBe("error")
  })
})
