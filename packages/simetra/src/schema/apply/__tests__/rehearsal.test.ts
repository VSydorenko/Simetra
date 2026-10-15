import { describe, expect, it } from "vitest"
import { countOf } from "simetra/schema"

describe("countOf", () => {
  it("reads a count as a safe integer", () => {
    expect(countOf("12")).toBe(12)
    expect(countOf(0)).toBe(0)
    expect(countOf("0")).toBe(0)
    // Від'ємне, понад безпечне ціле, дробове чи не лічильник — дефект порту
    for (const bad of [
      "-1",
      "9007199254740993",
      "1.5",
      "",
      "12a",
      null,
      1.5,
      -1,
    ])
      expect(() => countOf(bad), String(bad)).toThrow(Error)
  })
})
