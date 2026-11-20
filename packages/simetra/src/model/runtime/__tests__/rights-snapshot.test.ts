import { describe, expect, it } from "vitest"
import { rightsSnapshotSchema } from "../rights-snapshot"

const ID = "11111111-1111-4111-8111-111111111111"
const ROW = {
  level: "everyUser",
  levelId: null,
  scope: null,
  container: null,
  object: "Catalog.Task",
  action: "read",
  extent: "all",
  dimensionId: null,
}

describe("rightsSnapshotSchema", () => {
  it.each<[string, boolean, unknown]>([
    [
      "an anonymous snapshot",
      true,
      { userId: null, scopeSets: [], rights: [] },
    ],
    [
      "a user with a scope set and an everyUser row",
      true,
      {
        userId: ID,
        scopeSets: [{ scopeKind: "company", scope: ID }],
        rights: [ROW],
      },
    ],
    [
      "a level and an extent outside any list",
      true,
      {
        userId: ID,
        scopeSets: [],
        rights: [{ ...ROW, level: "future", extent: "other" }],
      },
    ],
    [
      "an extra field",
      false,
      { userId: null, scopeSets: [], rights: [], versions: [] },
    ],
    [
      "an extra field in a row",
      false,
      { userId: null, scopeSets: [], rights: [{ ...ROW, effect: "allow" }] },
    ],
    [
      "a user that is not a UUID",
      false,
      { userId: "x", scopeSets: [], rights: [] },
    ],
    ["a missing array", false, { userId: null, rights: [] }],
  ])("%s", (_, ok, value) => {
    expect(rightsSnapshotSchema.safeParse(value).success).toBe(ok)
  })
})
