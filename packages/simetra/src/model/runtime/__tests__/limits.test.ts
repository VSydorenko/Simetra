import { describe, expect, it } from "vitest"
import { jsonBytes } from "../limits"

/** Міра — UTF-8 байти `JSON.stringify`, а не довжина рядка в UTF-16. */
describe("jsonBytes", () => {
  it.each<[string, unknown, number]>([
    ["ASCII", { a: "b" }, 9],
    ["Cyrillic: two bytes a letter", "ї", 4],
    ["emoji: four bytes, two UTF-16 units", "😀", 6],
    ["a quote escaped", '"', 4],
    ["a backslash escaped", "\\", 4],
    ["bigint as text", { a: 10n }, 10],
    ["nothing to serialize", undefined, 0],
  ])("%s", (_, value, bytes) => {
    expect(jsonBytes(value)).toBe(bytes)
  })
})
