import { beforeAll, describe, expect, it } from "vitest"
import { PROVIDER_API_ROLES, type DatabaseProvider } from "simetra/model"
import { compile } from "../compile"
import { executeGrants, grantRole } from "../sql/execute-grants"
import { tableGrants } from "../access-units"
import { platformSchemaGrants } from "../platform/units"
import { readReferenceDomain } from "./fixtures/reference-domain"
import supabaseGrants from "./fixtures/reference-supabase-grants.json"

/** Референсний домен, перекомпільований під профіль `provider`. */
async function compileReference(provider: DatabaseProvider) {
  const files = readReferenceDomain()
  const project = JSON.parse(files.get("project.meta.json") ?? "") as {
    database: { provider: string }
  }
  project.database.provider = provider
  files.set("project.meta.json", JSON.stringify(project))
  const result = await compile(files)
  return { result, units: result.model?.sqlUnits ?? [] }
}

const isGrant = (sql: string) => /^\s*(GRANT|REVOKE)\b/i.test(sql)

describe("grant generators on a profile without the service role", () => {
  it("has no service role", () => {
    expect(PROVIDER_API_ROLES.postgres.service).toBeNull()
    expect(grantRole("service", "postgres")).toBeNull()
  })

  it.each([
    [
      "executeGrants",
      () =>
        executeGrants("app.f()", ["user", "service", "command"], "postgres"),
    ],
    [
      "tableGrants",
      () =>
        tableGrants(
          { schema: "app", name: "t" },
          ["user", "anonymous", "service"],
          "postgres",
          { insert: ["a"], update: ["b"], delete: true }
        ),
    ],
    ["platformSchemaGrants", () => platformSchemaGrants("postgres")],
  ])("%s: no statement for the service role, no null", (_, generate) => {
    const sql = generate().join("\n")
    expect(sql).not.toMatch(/service/)
    expect(sql).not.toMatch(/null/i)
    expect(sql).toContain("simetra_user")
  })

  it("executeGrants revokes the request roles that are not named", () => {
    expect(executeGrants("app.f()", ["command"], "postgres")).toEqual([
      "REVOKE EXECUTE ON FUNCTION app.f() FROM PUBLIC;",
      "REVOKE EXECUTE ON FUNCTION app.f() FROM simetra_user;",
      "REVOKE EXECUTE ON FUNCTION app.f() FROM simetra_anon;",
      "GRANT EXECUTE ON FUNCTION app.f() TO simetra_command;",
    ])
  })

  // Відсутній ключ мапи ролей під час виконання (`undefined`) має бути
  // пропущений так само, як `null`, а не надрукований як роль "undefined"
  it("executeGrants skips a role that is undefined at runtime", () => {
    const roles = PROVIDER_API_ROLES.postgres as { anonymous?: string | null }
    const saved = roles.anonymous
    delete roles.anonymous
    try {
      expect(grantRole("anonymous", "postgres")).toBeNull()
      const sql = executeGrants(
        "app.f()",
        ["user", "anonymous"],
        "postgres"
      ).join("\n")
      expect(sql).not.toMatch(/undefined/)
      expect(sql).toContain("simetra_user")
    } finally {
      roles.anonymous = saved
    }
  })

  describe("the whole reference domain compiled for postgres", () => {
    let units: { sql: string }[]
    beforeAll(async () => {
      const compiled = await compileReference("postgres")
      expect(
        compiled.result.diagnostics.filter((d) => d.severity === "error")
      ).toEqual([])
      units = compiled.units
    })

    it("grants nothing to a service role and never prints null", () => {
      const grants = units.map((u) => u.sql).filter(isGrant)
      expect(grants.length).toBeGreaterThan(0)
      // Отримувач — слово після останнього TO/FROM; ім'я об'єкта "service_*"
      // не є роллю, тож шукаємо за отримувачем, а не за підрядком.
      const grantees = new Set(
        grants.map((sql) => /\b(?:TO|FROM)\s+("?\w+"?);$/.exec(sql)?.[1])
      )
      expect([...grantees].sort()).toEqual([
        "PUBLIC",
        "simetra_anon",
        "simetra_command",
        "simetra_user",
      ])
      expect(grants.some((sql) => sql.includes("simetra_user"))).toBe(true)
    })

    it("provisioning SQL quotes the mixed-case Better Auth columns", () => {
      const sql = units.map((u) => u.sql).join("\n")
      expect(sql).toContain('better_auth."user"')
      expect(sql).toContain('"isAnonymous"')
    })
  })
})

describe("supabase grants are unchanged", () => {
  // Перелік зібрано компіляцією `examples/reference` на `supabase` на коміті
  // до зміни (f7ed92d9): лише оператори GRANT/REVOKE, не весь SQL.
  it("reference domain: the GRANT/REVOKE statements equal the baseline", async () => {
    const { units } = await compileReference("supabase")
    const grants = units.map((u) => u.sql.trim()).filter(isGrant)
    expect(grants).toEqual(supabaseGrants)
  })
})
