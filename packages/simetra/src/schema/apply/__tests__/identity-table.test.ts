import { describe, expect, it } from "vitest"
import { compile, localize } from "simetra/compiler"
import { PROVIDER_IDENTITY_SOURCES, type DatabaseProvider } from "simetra/model"
import {
  catalog,
  expectClean,
  metaFiles,
  project,
} from "../../../compiler/__tests__/helpers"
import {
  hasIdentityTriggers,
  identityTableRefusal,
  type IdentityTableFacts,
} from "../plan"

const TABLE = "better_auth.user"

describe("identityTableRefusal", () => {
  // Відсутня схема дає ті самі факти, що й відсутня таблиця без `USAGE`:
  // `has_schema_privilege` на неї кинув би `3F000`, тож причина — таблиця
  it.each<[string, IdentityTableFacts, "table" | "privilege"]>([
    [
      "no schema",
      { usage: false, exists: false, trigger: false, triggers: [] },
      "table",
    ],
    [
      "no USAGE on the schema",
      { usage: false, exists: true, trigger: true, triggers: [] },
      "privilege",
    ],
    [
      "no table",
      { usage: true, exists: false, trigger: false, triggers: [] },
      "table",
    ],
    [
      "no TRIGGER on the table",
      { usage: true, exists: true, trigger: false, triggers: [] },
      "privilege",
    ],
  ])("refuses: %s", (_name, facts, reason) => {
    expect(identityTableRefusal(facts, TABLE)).toMatchObject({
      code: "plan.identity-table-missing",
      severity: "error",
      params: { table: TABLE, reason },
    })
  })

  it("passes complete facts", () => {
    expect(
      identityTableRefusal(
        { usage: true, exists: true, trigger: true, triggers: ["t"] },
        TABLE
      )
    ).toBeUndefined()
  })

  it.each(["table", "privilege"])(
    "gives the %s refusal its own hint",
    (reason) => {
      const facts: IdentityTableFacts =
        reason === "table"
          ? { usage: true, exists: false, trigger: false, triggers: [] }
          : { usage: true, exists: true, trigger: false, triggers: [] }
      const refusal = identityTableRefusal(facts, TABLE)!
      expect(refusal.message).toContain(TABLE)
      const { hint } = localize(refusal, "en")
      // Порада залежить від причини: виправлення різні, тож і поради
      expect(hint).toContain(
        reason === "table" ? "Better Auth migration" : "as superuser"
      )
      expect(hint).not.toContain(
        reason === "table" ? "as superuser" : "Better Auth migration"
      )
    }
  )
})

describe("hasIdentityTriggers", () => {
  async function unitsOf(provider: DatabaseProvider, users: boolean) {
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project({ database: { provider } }),
        ...(users
          ? {
              "catalogs/Users/Users.meta.json": catalog("Users", {
                role: "users",
                scope: "none",
              }),
            }
          : { "catalogs/Items/Items.meta.json": catalog("Items") }),
      })
    )
    expectClean(compiled)
    return compiled.model!.sqlUnits
  }

  it.each<DatabaseProvider>(["postgres", "supabase"])(
    "sees the provision triggers of a model with Users (%s)",
    async (provider) => {
      const table = PROVIDER_IDENTITY_SOURCES[provider].table
      expect(hasIdentityTriggers(await unitsOf(provider, true), table)).toBe(
        true
      )
      expect(hasIdentityTriggers(await unitsOf(provider, false), table)).toBe(
        false
      )
    }
  )
})
