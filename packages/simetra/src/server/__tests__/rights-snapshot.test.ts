import { rightsRowSchema, rightsSnapshotSchema } from "simetra/model"
import { describe, expect, it } from "vitest"
import { canonicalSnapshot } from "../rights-snapshot"

const U = "44444444-4444-4444-8444-444444444444"

describe("canonicalSnapshot", () => {
  // Поле, додане в схему (B6), не має мовчки випасти з відбитка й відповіді.
  it("keeps exactly the fields of the schemas", () => {
    const row = Object.fromEntries(
      Object.keys(rightsRowSchema.shape).map((key) => [key, null])
    )
    const snapshot = {
      userId: U,
      scopeSets: [],
      rights: [row],
    } as never
    const out = canonicalSnapshot(snapshot)
    expect(Object.keys(out).sort()).toEqual(
      Object.keys(rightsSnapshotSchema.shape).sort()
    )
    expect(Object.keys(out.rights[0]!).sort()).toEqual(
      Object.keys(rightsRowSchema.shape).sort()
    )
  })

  it("keeps the scope set fields", () => {
    const scopeSet = rightsSnapshotSchema.shape.scopeSets.element
    const entry = Object.fromEntries(
      Object.keys(scopeSet.shape).map((key) => [key, "x"])
    )
    const out = canonicalSnapshot({
      userId: U,
      scopeSets: [entry],
      rights: [],
    } as never)
    expect(Object.keys(out.scopeSets[0]!).sort()).toEqual(
      Object.keys(scopeSet.shape).sort()
    )
  })
})
