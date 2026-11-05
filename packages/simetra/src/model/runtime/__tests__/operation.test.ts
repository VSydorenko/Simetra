import { describe, expect, it } from "vitest"
import { operationSchema } from "../operation"

const ID = "11111111-1111-4111-8111-111111111111"
const OBJECT = { kind: "Catalog", name: "Organization" }

/**
 * Форми схеми операції. Обов'язковість `id` і дозвіл `creatorMember` — факти
 * каталогу (`operations.create.root`), їх вирішує T3 `prepareInput`.
 */
describe("operationSchema", () => {
  it.each<[string, unknown, boolean]>([
    ["create with an id", { action: "create", object: OBJECT, id: ID }, true],
    ["create without an id", { action: "create", object: OBJECT }, true],
    [
      "create with creatorMember",
      { action: "create", object: OBJECT, creatorMember: { title: "x" } },
      true,
    ],
    [
      "create with an empty creatorMember",
      { action: "create", object: OBJECT, creatorMember: {} },
      true,
    ],
    [
      "creatorMember that is not an object",
      { action: "create", object: OBJECT, creatorMember: [] },
      false,
    ],
    [
      "create with an id that is not a UUID",
      { action: "create", object: OBJECT, id: "x" },
      false,
    ],
    [
      "update without an id",
      { action: "update", object: OBJECT, expectedVersion: 1 },
      false,
    ],
    [
      "update with creatorMember",
      {
        action: "update",
        object: OBJECT,
        id: ID,
        expectedVersion: 1,
        creatorMember: {},
      },
      false,
    ],
    [
      "markDeletion without an id",
      {
        action: "markDeletion",
        object: OBJECT,
        expectedVersion: 1,
        mark: true,
      },
      false,
    ],
    [
      "delete without an id",
      { action: "delete", object: OBJECT, expectedVersion: 1 },
      false,
    ],
  ])("%s", (_, input, accepted) => {
    expect(operationSchema.safeParse(input).success).toBe(accepted)
  })
})
