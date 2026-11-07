import { describe, expect, it } from "vitest"
import { elementIdSchema, standardElementId } from "../schemas/element-id"

const OWNER = "00000000-0000-4000-8000-000000000101"

describe("elementIdSchema", () => {
  // Схема розбирає той самий формат, що будує `standardElementId`: інший
  // роздільник, крапка в імені (вона ділить `path`) чи не-UUID власника —
  // уже не id елемента.
  it.each([
    [
      "a synthetic id",
      standardElementId(OWNER, { logicalName: "delta" }),
      true,
    ],
    ["a UUID", OWNER, true],
    ["a non-UUID owner", "lines#delta", false],
    ["an empty name", `${OWNER}#`, false],
    ["a dot in the name", `${OWNER}#a.b`, false],
    ["two separators", `${OWNER}#a#b`, false],
    ["an empty string", "", false],
  ])("%s", (_, id, ok) => {
    expect(elementIdSchema.safeParse(id).success).toBe(ok)
  })
})
