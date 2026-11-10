import { describe, expect, it } from "vitest"
import { computeRowView } from "../snapshot"
import { harness, K1, row } from "./store-support"

const EA = "a".repeat(64)
const EB = "b".repeat(64)

const put = (h: ReturnType<typeof harness>, versionEpoch: string | null) =>
  h.write((s) =>
    h.store.put(
      s,
      { ...row(K1, 1, { notes: "n" }), versionEpoch },
      h.now(),
      true
    )
  )

describe("computeRowView staleFields (B1c Р5)", () => {
  it("a lazy field read in the epoch of the row is not stale", () => {
    const h = harness()
    put(h, EA)
    const view = computeRowView(K1, h.store.get(K1)!, ["notes"], undefined)
    expect(view).toMatchObject({ staleFields: [] })
  })

  it("a lazy field of an old epoch is stale although its version is not lower", () => {
    const h = harness()
    put(h, EA)
    h.write((s) =>
      h.store.put(s, { ...row(K1, 1), versionEpoch: EB }, h.now(), false)
    )
    const view = computeRowView(K1, h.store.get(K1)!, ["notes"], undefined)
    expect(view).toMatchObject({ version: 1, staleFields: ["notes"] })
  })

  it("a null epoch compares by version as usual", () => {
    const h = harness()
    put(h, null)
    const view = computeRowView(K1, h.store.get(K1)!, ["notes"], undefined)
    expect(view).toMatchObject({ staleFields: [] })
  })
})
