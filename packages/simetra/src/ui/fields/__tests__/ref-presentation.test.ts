import type { RowView } from "simetra/data/react"
import { describe, expect, it } from "vitest"
import {
  catalogEntry,
  catalogEntryAttribute,
} from "../../../model/runtime/__tests__/entries"
import { refPresentation } from "../ref-presentation"

const KEY = "00000000-0000-4000-8000-0000000000aa"
const row = (values: Record<string, unknown>): RowView => ({
  key: KEY,
  version: 1,
  values,
  state: "synced",
  staleFields: [],
})
const target = (...standard: string[]) =>
  catalogEntry({
    attributes: standard.map((name) =>
      catalogEntryAttribute({ name, column: name })
    ),
  })

describe("refPresentation", () => {
  it.each([
    ["description", target("description", "code"), "Acme"],
    ["code", target("code"), "C-1"],
    ["ключ", target(), KEY],
  ])("гілка %s", (_, entry, expected) => {
    expect(
      refPresentation(row({ description: "Acme", code: "C-1" }), entry)
    ).toBe(expected)
  })

  it("порожній description поступається коду", () => {
    expect(
      refPresentation(
        row({ description: "", code: "C-1" }),
        target("description", "code")
      )
    ).toBe("C-1")
  })

  it("рядок, якого немає чи прибрано, — порожній текст", () => {
    expect(refPresentation(null, target("description"))).toBe("")
    expect(
      refPresentation({ key: KEY, state: "removed" }, target("description"))
    ).toBe("")
  })
})
