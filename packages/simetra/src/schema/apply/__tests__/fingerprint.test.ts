import { describe, expect, it } from "vitest"
import {
  compareFingerprints,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  readFingerprint,
  type ApplyTransaction,
  type CatalogFingerprint,
  type FingerprintSection,
} from "simetra/schema"

/** Відбиток, у якому кожна секція має власний хеш; `over` перекриває окремі. */
function fingerprint(
  over: Partial<Record<FingerprintSection, string>> = {},
  version = FINGERPRINT_VERSION
): CatalogFingerprint {
  const sections = Object.fromEntries(
    FINGERPRINT_SECTIONS.map((s) => [s, `hash-${s}`])
  ) as Record<FingerprintSection, string>
  return { version, sections: { ...sections, ...over } }
}

describe("compareFingerprints", () => {
  it("is not comparable across versions", () => {
    expect(
      compareFingerprints(
        fingerprint(),
        fingerprint({}, FINGERPRINT_VERSION + 1),
        { owner: true }
      )
    ).toEqual({ comparable: false })
  })

  it("ignores the owner section unless asked", () => {
    const a = fingerprint()
    const b = fingerprint({ owner: "other" })
    expect(compareFingerprints(a, b, { owner: false })).toEqual({
      comparable: true,
      differing: [],
    })
    expect(compareFingerprints(a, b, { owner: true })).toEqual({
      comparable: true,
      differing: ["owner"],
    })
  })

  it("lists differing sections in section order", () => {
    const a = fingerprint()
    const b = fingerprint({ policies: "x", columns: "y" })
    expect(compareFingerprints(a, b, { owner: true })).toEqual({
      comparable: true,
      differing: ["columns", "policies"],
    })
  })
})

describe("readFingerprint", () => {
  it("turns JIT off inside the savepoint, before the read, and rolls it back", async () => {
    const sqls: string[] = []
    const tx = {
      query: async (sql: string) => {
        sqls.push(sql)
        return [Object.fromEntries(FINGERPRINT_SECTIONS.map((s) => [s, "h"]))]
      },
    } as unknown as ApplyTransaction
    await readFingerprint(tx, { schemas: ["app"], provider: "postgres" })
    const at = (prefix: string) => sqls.findIndex((q) => q.startsWith(prefix))
    expect(at("SAVEPOINT simetra_fingerprint")).toBe(0)
    expect(at("SET LOCAL jit = off")).toBeGreaterThan(0)
    expect(at("SET LOCAL jit = off")).toBeLessThan(
      sqls.findIndex((q) => q.includes("encode(sha256"))
    )
    expect(at("ROLLBACK TO SAVEPOINT simetra_fingerprint")).toBeGreaterThan(
      sqls.findIndex((q) => q.includes("encode(sha256"))
    )
  })
})
