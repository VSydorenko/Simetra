import { describe, expect, it } from "vitest"
import { z } from "zod"
import { BATCH_MAX, batchSchema, operationSchema } from "../operation"
import { TABULAR_LINES_MAX } from "../read"

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

const reasonsOf = (result: { error?: { issues: unknown[] } }) =>
  (result.error?.issues ?? []).map((issue) => {
    const { path, params } = issue as {
      path: PropertyKey[]
      params?: { reason?: unknown }
    }
    return { path, reason: params?.reason }
  })

/**
 * Межі довжини перевіряються до розбору елементів: Zod 4 не виконує `.max`
 * масиву, коли вже є issue елемента, тож хибні елементи сховали б причину.
 */
describe("length limits", () => {
  const valid = { action: "create", object: OBJECT }
  const invalid = { action: "create", object: OBJECT, id: "x" }
  const lines = (n: number) => Array.from({ length: n }, () => ({}))

  it.each<[string, unknown[], { path: PropertyKey[]; reason: unknown }[]]>([
    ["BATCH_MAX valid operations", Array(BATCH_MAX).fill(valid), []],
    [
      "BATCH_MAX + 1 valid operations",
      Array(BATCH_MAX + 1).fill(valid),
      [{ path: [], reason: "batch-too-large" }],
    ],
    [
      "BATCH_MAX + 1 invalid operations",
      Array(BATCH_MAX + 1).fill(invalid),
      [{ path: [], reason: "batch-too-large" }],
    ],
    [
      "a section of TABULAR_LINES_MAX lines",
      [{ ...valid, tabularSections: { lines: lines(TABULAR_LINES_MAX) } }],
      [],
    ],
    [
      "a section over TABULAR_LINES_MAX lines in the second operation",
      [
        valid,
        {
          action: "update",
          object: OBJECT,
          id: ID,
          expectedVersion: 1,
          tabularSections: { lines: lines(TABULAR_LINES_MAX + 1) },
        },
      ],
      [
        {
          path: [1, "tabularSections", "lines"],
          reason: "tabular-too-large",
        },
      ],
    ],
    [
      "an over-limit section of invalid lines",
      [
        {
          ...valid,
          tabularSections: { lines: Array(TABULAR_LINES_MAX + 1).fill(1) },
        },
      ],
      [{ path: [0, "tabularSections", "lines"], reason: "tabular-too-large" }],
    ],
  ])("%s", (_, batch, issues) => {
    expect(reasonsOf(batchSchema.safeParse(batch))).toEqual(issues)
  })

  // MCP `data-command` публікує `batchSchema` як JSON Schema входу: перевірка
  // меж не має підмінити форму елемента на `unknown`.
  it("keeps the input JSON Schema of the batch and its section rows", () => {
    const schema = z.toJSONSchema(batchSchema, { io: "input" }) as {
      minItems?: number
      items: { oneOf: { properties: Record<string, unknown> }[] }
    }
    expect(schema.minItems).toBe(1)
    const create = schema.items.oneOf[0]!.properties
    expect(create.tabularSections).toMatchObject({
      additionalProperties: { type: "array", items: { type: "object" } },
    })
  })
})
