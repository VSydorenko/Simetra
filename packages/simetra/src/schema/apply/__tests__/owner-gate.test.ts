import { describe, expect, it } from "vitest"
import { ownerRefusal } from "../owner-gate"

describe("ownerRefusal", () => {
  it.each([
    ["no BYPASSRLS, not superuser", { bypassrls: false, superuser: false }],
    ["no row for the role (fail-closed)", undefined],
  ])("refuses: %s", (_name, row) => {
    expect(ownerRefusal(row)).toMatchObject({
      code: "plan.owner-not-bypassrls",
      severity: "error",
    })
  })

  it.each([
    ["BYPASSRLS", { bypassrls: true, superuser: false }],
    ["superuser", { bypassrls: false, superuser: true }],
  ])("passes: %s", (_name, row) => {
    expect(ownerRefusal(row)).toBeUndefined()
  })
})
