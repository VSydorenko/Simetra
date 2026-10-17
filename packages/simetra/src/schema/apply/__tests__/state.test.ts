import { describe, expect, it } from "vitest"
import {
  compile,
  type CompiledModel,
  type PromotionRecord,
} from "simetra/compiler"
import { PROVIDER_API_ROLES, quoteIdent } from "simetra/model"
import {
  FINGERPRINT_SECTIONS,
  renderApplyState,
  writeApplyStateStatements,
  type CatalogFingerprint,
  type DriftReport,
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

  it("gives the ledger a nullable promotion column", async () => {
    const sql = renderApplyState(await withoutUsers())
    const ledger = sql.slice(sql.indexOf("CREATE TABLE simetra.ledger ("))
    expect(ledger).toMatch(/^ {2}promotion jsonb,$/m)
  })

  it("gives the ledger a nullable rehearsal hash column", async () => {
    const sql = renderApplyState(await withoutUsers())
    const ledger = sql.slice(sql.indexOf("CREATE TABLE simetra.ledger ("))
    expect(ledger).toMatch(/^ {2}rehearsal_hash text,$/m)
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
        drift: null,
        promotion: null,
        rehearsalHash: null,
        applyId: "00000000-0000-4000-8000-000000000000",
      })
    ).toThrow(/fingerprint versions differ/)
  })

  /** Значення колонки ledger за її назвою в `INSERT`. */
  const ledgerValue = (
    drift: DriftReport | null,
    column: string,
    promotion: { hash: string; record: PromotionRecord } | null = null,
    rehearsalHash: string | null = null
  ): unknown => {
    const [, ledger] = writeApplyStateStatements({
      planHash: "p",
      fromHash: null,
      toHash: "t",
      snapshot: {},
      scope: { schemas: ["app"], provider: "supabase" },
      catalog: { tables: [], enumTypes: [], units: [] },
      engine: { name: "e", version: "1" },
      targetFingerprint: fingerprint(1),
      resultFingerprint: fingerprint(1),
      allow: ["drift"],
      drift,
      promotion,
      rehearsalHash,
      applyId: "00000000-0000-4000-8000-000000000000",
    })
    const columns = /\(([^)]*)\)/
      .exec(ledger!.sql)![1]!
      .split(",")
      .map((c) => c.trim())
    expect(columns).toContain(column)
    return ledger!.params[columns.indexOf(column)]
  }

  it("records the accepted drift in the ledger", () => {
    const drift: DriftReport = {
      reason: "drift",
      sections: ["owner"],
      paths: ["tables.app.t.columns.c"],
    }
    expect(ledgerValue(drift, "drift")).toBe(JSON.stringify(drift))
  })

  it("writes SQL NULL, not JSON null, for a plan without drift", () => {
    expect(ledgerValue(null, "drift")).toBeNull()
  })

  const RECORD: PromotionRecord = {
    format: 1,
    base: "0".repeat(64),
    result: "1".repeat(64),
    objectId: "00000000-0000-4000-8000-000000000001",
    kind: "Catalog",
    labelDropped: false,
    tables: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        schema: "app",
        from: "parties",
        to: "party",
      },
    ],
    columns: [],
    typeChanges: [],
    dataSteps: [],
    retired: [],
    relaxed: [],
    tightened: [],
    rowLevelSecurity: [],
    deleteSemantics: [],
    conversions: [],
    movedUnits: [],
    rewrittenUnits: [],
    contractChanges: [],
  }

  it("records the applied promotion with its hash", () => {
    const promotion = { hash: "h".repeat(64), record: RECORD }
    expect(ledgerValue(null, "promotion", promotion)).toBe(
      JSON.stringify(promotion)
    )
  })

  it("writes SQL NULL for a plan without promotion", () => {
    expect(ledgerValue(null, "promotion")).toBeNull()
    expect(ledgerValue(null, "rehearsal_hash")).toBeNull()
  })

  it("records the hash of the rehearsal report", () => {
    const promotion = { hash: "h".repeat(64), record: RECORD }
    expect(ledgerValue(null, "rehearsal_hash", promotion, "r".repeat(64))).toBe(
      "r".repeat(64)
    )
  })
})
