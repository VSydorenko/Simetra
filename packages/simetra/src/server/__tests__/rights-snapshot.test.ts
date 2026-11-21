import {
  RIGHTS_DIMENSION_VALUES_MAX,
  rightsRowSchema,
  rightsSnapshotSchema,
  type RightsSnapshot,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import {
  ANONYMOUS_SNAPSHOT,
  canonicalSnapshot,
  rightsVersionOf,
} from "../rights-snapshot"

const U = "44444444-4444-4444-8444-444444444444"
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const EMPTY = {
  userId: U,
  scopeSets: [],
  rights: [],
  members: [],
  dimensionValues: [],
} satisfies RightsSnapshot
const keysOf = (schema: { shape: object }) => Object.keys(schema.shape).sort()

describe("canonicalSnapshot", () => {
  // Поле, додане в схему (B6), не має мовчки випасти з відбитка й відповіді.
  it("keeps exactly the fields of the schemas", () => {
    const row = Object.fromEntries(
      Object.keys(rightsRowSchema.shape).map((key) => [key, null])
    )
    const snapshot = { ...EMPTY, rights: [row] } as never
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
    const out = canonicalSnapshot({ ...EMPTY, scopeSets: [entry] } as never)
    expect(Object.keys(out.scopeSets[0]!).sort()).toEqual(
      Object.keys(scopeSet.shape).sort()
    )
  })

  it("keeps the member and the dimension fields, the optional ones too", () => {
    const member = rightsSnapshotSchema.shape.members.element
    const dimension = rightsSnapshotSchema.shape.dimensionValues.element
    const out = canonicalSnapshot({
      ...EMPTY,
      members: [Object.fromEntries(keysOf(member).map((k) => [k, "x"]))],
      dimensionValues: [
        { dimension: U, values: [], truncated: true, digest: "d" },
      ],
    } as never)
    expect(Object.keys(out.members[0]!).sort()).toEqual(keysOf(member))
    expect(Object.keys(out.dimensionValues[0]!).sort()).toEqual(
      keysOf(dimension)
    )
  })

  it("omits truncated and digest of a dimension under the cap", () => {
    const out = canonicalSnapshot({
      ...EMPTY,
      dimensionValues: [{ dimension: U, values: [uuid(1)] }],
    })
    expect(out.dimensionValues).toStrictEqual([
      { dimension: U, values: [uuid(1)] },
    ])
  })

  it("orders members, dimensions and values by the full tuple, whatever the order of the base", () => {
    const sorted: RightsSnapshot = {
      ...EMPTY,
      members: [
        { scopeKind: uuid(1), scope: uuid(1), member: uuid(2) },
        { scopeKind: uuid(1), scope: uuid(2), member: uuid(1) },
        { scopeKind: uuid(2), scope: uuid(1), member: uuid(1) },
      ],
      dimensionValues: [
        { dimension: uuid(1), values: [uuid(1), uuid(2)] },
        { dimension: uuid(2), values: [uuid(3)] },
      ],
    }
    const shuffled: RightsSnapshot = {
      ...EMPTY,
      members: [...sorted.members].reverse(),
      dimensionValues: [
        { dimension: uuid(2), values: [uuid(3)] },
        { dimension: uuid(1), values: [uuid(2), uuid(1)] },
      ],
    }
    expect(canonicalSnapshot(shuffled)).toStrictEqual(sorted)
  })
})

describe("rightsVersionOf", () => {
  const truncated = (digest: string): RightsSnapshot => ({
    ...EMPTY,
    dimensionValues: [
      {
        dimension: U,
        values: Array.from({ length: RIGHTS_DIMENSION_VALUES_MAX }, (_, n) =>
          uuid(n)
        ),
        truncated: true,
        digest,
      },
    ],
  })

  // Значення за межею клієнт не бачить: змінитися може лише `digest`.
  it("changes when only the digest of a truncated dimension changes", async () => {
    expect(
      await rightsVersionOf(canonicalSnapshot(truncated("a".repeat(64))))
    ).not.toBe(
      await rightsVersionOf(canonicalSnapshot(truncated("b".repeat(64))))
    )
  })

  it("changes with a member and with a dimension value", async () => {
    const base = await rightsVersionOf(canonicalSnapshot(EMPTY))
    const member = {
      ...EMPTY,
      members: [{ scopeKind: U, scope: U, member: uuid(1) }],
    }
    const value = {
      ...EMPTY,
      dimensionValues: [{ dimension: U, values: [uuid(1)] }],
    }
    expect(await rightsVersionOf(canonicalSnapshot(member))).not.toBe(base)
    expect(await rightsVersionOf(canonicalSnapshot(value))).not.toBe(base)
  })

  it("the anonymous snapshot passes the schema with every array empty", () => {
    expect(rightsSnapshotSchema.parse(ANONYMOUS_SNAPSHOT)).toStrictEqual({
      userId: null,
      scopeSets: [],
      rights: [],
      members: [],
      dimensionValues: [],
    })
  })
})
