import { describe, expect, it } from "vitest"
import { sqlFunctionsFileSchema } from "../schemas/sql-functions"

const ID_A = "0b6f4c1e-2a3d-4e5f-8a9b-1c2d3e4f5a6b"
const ID_B = "1c7a5d2f-3b4e-4f6a-9b0c-2d3e4f5a6b7c"

/** Запис декларації: лише поле, про яке випадок, відрізняється від типового. */
function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: ID_A,
    function: { schema: "app", name: "approve" },
    callers: ["user"],
    ...overrides,
  }
}

/** Код issue: правило T0 з `params.rule`, інакше код Zod; і шлях. */
function issues(input: unknown): [string, string][] {
  const result = sqlFunctionsFileSchema.safeParse(input)
  if (result.success) return []
  return result.error.issues.map((issue) => {
    const rule =
      issue.code === "custom"
        ? (issue.params as { rule?: string } | undefined)?.rule
        : undefined
    return [rule ?? issue.code, issue.path.join("/")]
  })
}

describe("sqlFunctionsFileSchema", () => {
  it.each([
    [
      "the spec form with a row check",
      {
        $schema: "../../schemas/functions.schema.json",
        functions: [
          entry({
            callers: ["user", "service"],
            check: {
              action: "approve",
              object: { kind: "Document", name: "Invoice" },
              row: "p_invoice",
            },
          }),
        ],
      },
    ],
    ["an empty file", { functions: [] }],
    ["empty callers and no check", { functions: [entry({ callers: [] })] }],
    [
      "every caller purpose",
      {
        functions: [
          entry({ callers: ["user", "anonymous", "service", "command"] }),
        ],
      },
    ],
    [
      // Дві цілі разом — причина `twoTargets` компілятора, не схеми.
      "row and scope together",
      {
        functions: [
          entry({
            check: {
              action: "create",
              object: { kind: "Catalog", name: "Item" },
              row: "p_row",
              scope: "p_scope",
            },
          }),
        ],
      },
    ],
    [
      "an entry without schema before entries with a schema",
      {
        functions: [
          entry({ id: ID_B, function: { name: "zeta" } }),
          entry({ function: { schema: "a", name: "alpha" } }),
        ],
      },
    ],
    [
      "sorted by schema, then by name in code units",
      {
        functions: [
          entry({ id: ID_B, function: { schema: "a", name: "Z" } }),
          entry({ function: { schema: "a", name: "a" } }),
          entry({ function: { schema: "b", name: "a" } }),
        ],
      },
    ],
  ])("accepts %s", (_, input) => {
    expect(issues(input)).toEqual([])
  })

  it.each([
    [
      "an unknown top-level key",
      { functions: [], extra: 1 },
      [["unrecognized_keys", ""]],
    ],
    [
      "an unknown key of an entry",
      { functions: [entry({ grants: [] })] },
      [["unrecognized_keys", "functions/0"]],
    ],
    [
      "an unknown key of a check",
      {
        functions: [
          entry({
            check: {
              action: "read",
              object: { kind: "Catalog", name: "Item" },
              target: "p_id",
            },
          }),
        ],
      },
      [["unrecognized_keys", "functions/0/check"]],
    ],
    [
      // Роль споживача сигналів платформна (Р4): функції застосунку її немає.
      "the signal consumer purpose",
      { functions: [entry({ callers: ["signalConsumer"] })] },
      [["invalid_value", "functions/0/callers/0"]],
    ],
    [
      "an unknown caller",
      { functions: [entry({ callers: ["user", "owner"] })] },
      [["invalid_value", "functions/0/callers/1"]],
    ],
    [
      "missing callers",
      { functions: [entry({ callers: undefined })] },
      [["invalid_type", "functions/0/callers"]],
    ],
    [
      "the platform schema",
      { functions: [entry({ function: { schema: "simetra", name: "x" } })] },
      [["schema.reserved", "functions/0/function/schema"]],
    ],
    [
      "entries out of order",
      {
        functions: [
          entry({ id: ID_B, function: { schema: "b", name: "a" } }),
          entry({ function: { schema: "a", name: "z" } }),
        ],
      },
      [["declarations.not-canonical", "functions/1"]],
    ],
    [
      "an entry with a schema before an entry without",
      {
        functions: [
          entry({ id: ID_B, function: { schema: "a", name: "a" } }),
          entry({ function: { name: "a" } }),
        ],
      },
      [["declarations.not-canonical", "functions/1"]],
    ],
    [
      // Дубль записаного значення; дубль після підстановки `defaultSchema` —
      // `sql.declaration-duplicate` компілятора.
      "the same written function twice",
      {
        functions: [entry({ id: ID_B }), entry({ callers: ["service"] })],
      },
      [["declarations.not-canonical", "functions/1"]],
    ],
  ])("rejects %s", (_, input, expected) => {
    expect(issues(input)).toEqual(expected)
  })

  it("keeps schema and name of the function as separate fields", () => {
    // Ідентифікатор із крапкою — дві різні функції, а не одна «a.b.c».
    const parsed = sqlFunctionsFileSchema.parse({
      functions: [
        entry({ id: ID_B, function: { schema: "a", name: "b.c" } }),
        entry({ function: { schema: "a.b", name: "c" } }),
      ],
    })
    expect(parsed.functions.map((f) => f.function)).toEqual([
      { schema: "a", name: "b.c" },
      { schema: "a.b", name: "c" },
    ])
  })
})
