import { describe, expect, it } from "vitest"
import {
  RIGHTS_DIMENSION_VALUES_MAX,
  rightsSnapshotSchema,
} from "../rights-snapshot"

const ID = "11111111-1111-4111-8111-111111111111"
const DIGEST = "d".repeat(64)
const EMPTY = {
  userId: null,
  scopeSets: [],
  rights: [],
  members: [],
  dimensionValues: [],
}
const values = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`
  )
const withDimension = (entry: object) => ({
  ...EMPTY,
  userId: ID,
  dimensionValues: [{ dimension: ID, ...entry }],
})
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
    ["an anonymous snapshot", true, EMPTY],
    [
      "a user with a scope set and an everyUser row",
      true,
      {
        ...EMPTY,
        userId: ID,
        scopeSets: [{ scopeKind: "company", scope: ID }],
        rights: [ROW],
      },
    ],
    [
      "a level and an extent outside any list",
      true,
      {
        ...EMPTY,
        userId: ID,
        rights: [{ ...ROW, level: "future", extent: "other" }],
      },
    ],
    ["an extra field", false, { ...EMPTY, versions: [] }],
    [
      "an extra field in a row",
      false,
      { ...EMPTY, rights: [{ ...ROW, effect: "allow" }] },
    ],
    ["a user that is not a UUID", false, { ...EMPTY, userId: "x" }],
    ["a missing array", false, { userId: null, rights: [] }],
    [
      "a member row",
      true,
      {
        ...EMPTY,
        userId: ID,
        members: [{ scopeKind: ID, scope: ID, member: ID }],
      },
    ],
    [
      "a member row with an extra field",
      false,
      {
        ...EMPTY,
        members: [{ scopeKind: ID, scope: ID, member: ID, role: "x" }],
      },
    ],
    ["dimension values", true, withDimension({ values: values(2) })],
    [
      "a truncated dimension with exactly the cap and a digest",
      true,
      withDimension({
        values: values(RIGHTS_DIMENSION_VALUES_MAX),
        truncated: true,
        digest: DIGEST,
      }),
    ],
    [
      "more values than the cap",
      false,
      withDimension({ values: values(RIGHTS_DIMENSION_VALUES_MAX + 1) }),
    ],
    [
      "truncated without a digest",
      false,
      withDimension({
        values: values(RIGHTS_DIMENSION_VALUES_MAX),
        truncated: true,
      }),
    ],
    [
      "truncated below the cap",
      false,
      withDimension({ values: values(2), truncated: true, digest: DIGEST }),
    ],
    [
      "a digest without truncation",
      false,
      withDimension({ values: values(2), digest: DIGEST }),
    ],
    [
      "truncated: false",
      false,
      withDimension({ values: values(2), truncated: false }),
    ],
  ])("%s", (_, ok, value) => {
    expect(rightsSnapshotSchema.safeParse(value).success).toBe(ok)
  })
})
