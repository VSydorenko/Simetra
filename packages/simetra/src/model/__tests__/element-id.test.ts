import { describe, expect, it } from "vitest"
import {
  elementIdSchema,
  parseStandardElementId,
  standardElementId,
} from "../schemas/element-id"

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

describe("parseStandardElementId", () => {
  // Розбір і будова — одна пара: те, що будує `standardElementId`, розбирається
  // назад; UUID оголошеного елемента й зіпсований id — не стандартний елемент.
  it.each([
    [
      "a synthetic id",
      standardElementId(OWNER, { logicalName: "delta" }),
      { ownerId: OWNER, name: "delta" },
    ],
    ["a UUID", OWNER, undefined],
    ["a non-UUID owner", "lines#delta", undefined],
    ["an empty name", `${OWNER}#`, undefined],
    ["a dot in the name", `${OWNER}#a.b`, undefined],
    ["two separators", `${OWNER}#a#b`, undefined],
    ["an empty string", "", undefined],
  ])("%s", (_, id, parsed) => {
    expect(parseStandardElementId(id)).toEqual(parsed)
  })
})
