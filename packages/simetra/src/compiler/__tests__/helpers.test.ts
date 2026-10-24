import { describe, expect, it } from "vitest"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { expectClean } from "./helpers"

const WARNING = diagnostic(
  "rights.scope-kind-unread",
  "project.meta.json",
  "/scopeKinds/0",
  { scopeKind: "org" }
)
const OTHER_WARNING = diagnostic(
  "physical.reserved-word",
  "catalogs/Item/Item.meta.json",
  "/name"
)
const ERROR = diagnostic("project.missing", "project.meta.json", "")

describe("expectClean", () => {
  it.each<[string, Diagnostic[]]>([
    ["no diagnostics", []],
    ["an allowed warning", [WARNING]],
  ])("passes on %s", (_, diagnostics) => {
    expectClean({ diagnostics }, { allow: ["rights.scope-kind-unread"] })
  })

  it.each<[string, Diagnostic[], { allow?: readonly Diagnostic["code"][] }]>([
    [
      "an error even when its code is allowed",
      [ERROR],
      { allow: ["project.missing"] },
    ],
    [
      "a warning outside allow",
      [WARNING, OTHER_WARNING],
      { allow: ["rights.scope-kind-unread"] },
    ],
    ["a warning without allow", [WARNING], {}],
  ])("fails on %s", (_, diagnostics, options) => {
    expect(() => expectClean({ diagnostics }, options)).toThrow()
  })
})
