import { describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import { PROVIDER_API_ROLES, quoteIdent } from "simetra/model"
import {
  FINGERPRINT_SECTIONS,
  renderApplyState,
  writeApplyStateStatements,
  type CatalogFingerprint,
  type FingerprintSection,
} from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
} from "../../../compiler/__tests__/helpers"

async function model(files: Record<string, unknown>): Promise<CompiledModel> {
  const compiled = await compile(
    metaFiles({ "project.meta.json": project(), ...files })
  )
  expect(compiled.diagnostics).toEqual([])
  return compiled.model!
}

const withoutUsers = () =>
  model({ "catalogs/Party/Party.meta.json": catalog("Party") })

const withUsers = () =>
  model({
    "catalogs/Users/Users.meta.json": catalog("Users", {
      role: "users",
      scope: "none",
    }),
  })

const usage = Object.values(PROVIDER_API_ROLES.supabase).map(
  (role) => `GRANT USAGE ON SCHEMA simetra TO ${quoteIdent(role)};`
)

describe("renderApplyState", () => {
  it("creates the schema with marker and ledger", async () => {
    const sql = renderApplyState(await withoutUsers())
    expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS simetra;")
    expect(sql).toContain("CREATE TABLE simetra.marker (")
    expect(sql).toContain("CREATE TABLE simetra.ledger (")
  })

  it("secures the schema itself when the platform layer is absent", async () => {
    const sql = renderApplyState(await withoutUsers())
    expect(sql).toContain("REVOKE ALL ON SCHEMA simetra FROM PUBLIC;")
    expect(usage).toHaveLength(3)
    for (const grant of usage) expect(sql).toContain(grant)
  })

  it("leaves schema grants to the platform layer when it is present", async () => {
    const m = await withUsers()
    const sql = renderApplyState(m)
    expect(sql).not.toContain("REVOKE")
    expect(sql).not.toContain("GRANT")
    // Ті самі одиниці вже дає платформний шар — дубля не буде
    const layer = m.sqlUnits.map((u) => u.sql)
    expect(layer).toContain("REVOKE ALL ON SCHEMA simetra FROM PUBLIC;")
    for (const grant of usage) expect(layer).toContain(grant)
  })

  it("grants nothing on the state tables", async () => {
    for (const m of [await withoutUsers(), await withUsers()]) {
      const sql = renderApplyState(m)
      expect(sql).not.toMatch(/ON\s+TABLE/i)
      expect(sql).not.toMatch(/ON\s+ALL\s+TABLES/i)
      expect(sql).not.toMatch(/GRANT\s+(?!USAGE ON SCHEMA)/i)
    }
  })
})

describe("writeApplyStateStatements", () => {
  const fingerprint = (version: number): CatalogFingerprint => ({
    version,
    sections: Object.fromEntries(
      FINGERPRINT_SECTIONS.map((s) => [s, s])
    ) as Record<FingerprintSection, string>,
  })

  it("refuses fingerprints of different versions: the ledger has one version column", () => {
    expect(() =>
      writeApplyStateStatements({
        planHash: "p",
        fromHash: null,
        toHash: "t",
        snapshot: {},
        scope: { schemas: ["app"], provider: "supabase" },
        catalog: { tables: [], enumTypes: [], units: [] },
        engine: { name: "e", version: "1" },
        targetFingerprint: fingerprint(1),
        resultFingerprint: fingerprint(2),
        allow: [],
        applyId: "00000000-0000-4000-8000-000000000000",
      })
    ).toThrow(/fingerprint versions differ/)
  })
})
