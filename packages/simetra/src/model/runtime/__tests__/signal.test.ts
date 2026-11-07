import { describe, expect, it } from "vitest"
import { ZERO_UUID } from "../core"
import {
  changeSignalSchema,
  channelTopic,
  invalidateSignalSchema,
  parseTopic,
  receivedChangeSchema,
  receivedInvalidateSchema,
  receivedRightsSchema,
  rightsSignalSchema,
  type Channel,
} from "../signal"

const KIND = "11111111-1111-4111-8111-111111111111"
const SCOPE = "22222222-2222-4222-8222-222222222222"
const OBJECT = "3333aaaa-3333-4333-8333-333333333333"
const USER = "44444444-4444-4444-8444-444444444444"
const COLUMN = "id"

describe("channel topics", () => {
  it.each<[string, Channel, string]>([
    [
      "changes",
      { kind: "changes", scopeKindId: KIND, scope: SCOPE, object: OBJECT },
      `simetra:${KIND}:${SCOPE}:${OBJECT}`,
    ],
    [
      "unscoped changes",
      {
        kind: "changes",
        scopeKindId: ZERO_UUID,
        scope: ZERO_UUID,
        object: OBJECT,
      },
      `simetra:${ZERO_UUID}:${ZERO_UUID}:${OBJECT}`,
    ],
    [
      "rights",
      { kind: "rights", scopeKindId: KIND, scope: SCOPE },
      `simetra-rights:${KIND}:${SCOPE}`,
    ],
    [
      "unscoped rights",
      { kind: "rights", scopeKindId: ZERO_UUID, scope: ZERO_UUID },
      `simetra-rights:${ZERO_UUID}:${ZERO_UUID}`,
    ],
    ["user", { kind: "user", userId: USER }, `simetra-user:${USER}`],
  ])("round-trips %s", (_name, channel, topic) => {
    expect(channelTopic(channel)).toBe(topic)
    expect(parseTopic(topic)).toEqual(channel)
  })

  it.each([
    ["a foreign format", "realtime:x"],
    ["an empty string", ""],
    ["an extra segment", `simetra:${KIND}:${SCOPE}:${OBJECT}:${OBJECT}`],
    ["a missing segment", `simetra:${KIND}:${SCOPE}`],
    ["an uppercase uuid", `simetra:${KIND}:${SCOPE}:${OBJECT.toUpperCase()}`],
    ["a non-uuid segment", `simetra:${KIND}:${SCOPE}:orders`],
    ["a prefix glued to a name", `simetraX:${KIND}:${SCOPE}:${OBJECT}`],
    [
      "a rights topic with an extra segment",
      `simetra-rights:${KIND}:${SCOPE}:${OBJECT}`,
    ],
    ["a user topic with a name", "simetra-user:alice"],
    ["a user topic with an extra segment", `simetra-user:${USER}:${USER}`],
  ])("refuses %s", (_name, topic) => {
    expect(parseTopic(topic)).toBeUndefined()
  })
})

describe("signal schemas", () => {
  const change = {
    object: OBJECT,
    op: "update",
    keys: { [COLUMN]: USER },
    row_ver: 3,
  }
  const invalidate = { object: OBJECT, op: "invalidate" }
  const rights = { op: "rights", row_ver: 7 }

  it.each([
    ["a change", changeSignalSchema, receivedChangeSchema, change],
    [
      "an invalidate",
      invalidateSignalSchema,
      receivedInvalidateSchema,
      invalidate,
    ],
    ["a rights signal", rightsSignalSchema, receivedRightsSchema, rights],
  ])(
    "%s has exactly its fields; the received form adds id",
    (_n, sent, got, ok) => {
      expect(sent.safeParse(ok).success).toBe(true)
      expect(sent.safeParse({ ...ok, extra: 1 }).success).toBe(false)
      expect(sent.safeParse({ ...ok, id: USER }).success).toBe(false)
      expect(got.safeParse({ ...ok, id: USER }).success).toBe(true)
      expect(got.safeParse(ok).success).toBe(false)
      expect(got.safeParse({ ...ok, id: "x" }).success).toBe(false)
      expect(got.safeParse({ ...ok, id: USER, extra: 1 }).success).toBe(false)
    }
  )

  it("refuses the removed sections field", () => {
    expect(
      changeSignalSchema.safeParse({ ...change, sections: [] }).success
    ).toBe(false)
  })

  it.each([
    ["op create", { ...change, op: "create" }, true],
    ["op markDeletion", { ...change, op: "markDeletion" }, true],
    ["op delete", { ...change, op: "delete" }, true],
    ["an unknown op", { ...change, op: "merge" }, false],
    ["no keys", { ...change, keys: {} }, false],
    ["two keys", { ...change, keys: { a: USER, b: USER } }, false],
    ["a non-uuid key value", { ...change, keys: { [COLUMN]: "x" } }, false],
    ["a fractional row_ver", { ...change, row_ver: 1.5 }, false],
    ["an unsafe row_ver", { ...change, row_ver: 2 ** 53 }, false],
    ["a non-uuid object", { ...change, object: "orders" }, false],
  ])("change: %s", (_n, value, ok) => {
    expect(changeSignalSchema.safeParse(value).success).toBe(ok)
  })

  it("refuses an unknown op on invalidate and rights", () => {
    expect(
      invalidateSignalSchema.safeParse({ ...invalidate, op: "update" }).success
    ).toBe(false)
    expect(
      rightsSignalSchema.safeParse({ ...rights, op: "invalidate" }).success
    ).toBe(false)
  })
})
