import { describe, expect, it } from "vitest"
import {
  compareFingerprints,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
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
