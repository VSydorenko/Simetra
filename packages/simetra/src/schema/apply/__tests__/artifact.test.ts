import { describe, expect, it } from "vitest"
import {
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  PLAN_FORMAT,
  PLATFORM_VERSION,
  parsePlan,
  planFileName,
  serializePlan,
  stampPlan,
  verifyPlanHash,
  type CatalogFingerprint,
  type FingerprintSection,
  type PlanArtifact,
} from "simetra/schema"

const fingerprint = (digit: string): CatalogFingerprint => ({
  version: FINGERPRINT_VERSION,
  sections: Object.fromEntries(
    FINGERPRINT_SECTIONS.map((s) => [s, digit.repeat(64)])
  ) as Record<FingerprintSection, string>,
})

const draft = (): Omit<PlanArtifact, "planHash"> => ({
  format: PLAN_FORMAT,
  platformVersion: PLATFORM_VERSION,
  engine: { name: "pg-delta", version: "1.0.0-alpha.56" },
  fingerprintVersion: FINGERPRINT_VERSION,
  fromHash: null,
  toHash: "f".repeat(64),
  scope: { schemas: ["app", "simetra"], provider: "supabase" },
  targetFingerprint: fingerprint("a"),
  desiredFingerprint: fingerprint("b"),
  steps: [
    {
      id: "s1",
      sql: "ALTER TABLE app.t DROP COLUMN c",
      verb: "alter",
      class: "destructive",
      lockClass: "accessExclusive",
      transactionality: "transactional",
      newSegmentBefore: false,
      lockedTables: [{ schema: "app", name: "t" }],
      produces: [],
      consumes: ["table:app.t"],
      destroys: ["column:app.t.c"],
      dataLoss: true,
      rewriteRisk: false,
    },
  ],
  requiredPermissions: ["s1"],
  resultCatalog: { tables: [], enumTypes: [], units: [] },
})

describe("plan artifact", () => {
  it("hashes the same content to the same planHash", async () => {
    const a = await stampPlan(draft())
    const b = await stampPlan(draft())
    expect(a.planHash).toMatch(/^[0-9a-f]{64}$/)
    expect(b.planHash).toBe(a.planHash)
    expect(await verifyPlanHash(a)).toBe(true)
  })

  it("covers the steps with the hash", async () => {
    const stamped = await stampPlan(draft())
    const changed = draft()
    changed.steps[0]!.sql = "ALTER TABLE app.t DROP COLUMN d"
    expect((await stampPlan(changed)).planHash).not.toBe(stamped.planHash)
    const tampered: PlanArtifact = { ...changed, planHash: stamped.planHash }
    expect(await verifyPlanHash(tampered)).toBe(false)
  })

  it("covers lockedTables with the hash", async () => {
    const stamped = await stampPlan(draft())
    const changed = draft()
    changed.steps[0]!.lockedTables = []
    expect((await stampPlan(changed)).planHash).not.toBe(stamped.planHash)
  })

  it("round-trips the file byte for byte", async () => {
    const text = serializePlan(await stampPlan(draft()))
    expect(text.endsWith("}\n")).toBe(true)
    expect(text.split("\n")[1]).toMatch(/^ {2}"[a-zA-Z]+": /)
    const parsed = parsePlan(text)
    if (!parsed.ok) throw new Error(parsed.message)
    expect(serializePlan(parsed.artifact)).toBe(text)
    expect(await verifyPlanHash(parsed.artifact)).toBe(true)
  })

  it("writes keys in canonical order", async () => {
    const text = serializePlan(await stampPlan(draft()))
    const top = [...text.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1])
    expect(top).toEqual([...top].sort())
  })

  it("rejects an unknown top-level key", async () => {
    const artifact = await stampPlan(draft())
    const parsed = parsePlan(
      serializePlan({ ...artifact, extra: 1 } as PlanArtifact)
    )
    expect(parsed.ok).toBe(false)
  })

  it("rejects an unknown key in a step", async () => {
    const artifact = await stampPlan(draft())
    const text = serializePlan(artifact).replace(
      '"class": "destructive"',
      '"class": "destructive",\n      "note": "x"'
    )
    // Відмова від схеми, а не від синтаксису
    expect(() => JSON.parse(text) as unknown).not.toThrow()
    expect(parsePlan(text).ok).toBe(false)
  })

  it("rejects text that is not JSON", () => {
    expect(parsePlan("{").ok).toBe(false)
  })

  it("names the file after both snapshot hashes", () => {
    expect(planFileName(null, "abcdef0123456789")).toBe(
      "initial-abcdef012345.plan.json"
    )
    expect(planFileName("0123456789abcdef", "fedcba9876543210")).toBe(
      "0123456789ab-fedcba987654.plan.json"
    )
  })
})
