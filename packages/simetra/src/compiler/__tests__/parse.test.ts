import { describe, expect, it } from "vitest"
import { byteOffsets } from "../sql/parse"

describe("byteOffsets", () => {
  it("translates UTF-8 byte offsets into UTF-16 indexes", () => {
    const text = "'Привіт', abc"
    // Лапка 1 + шість кириличних літер по 2 байти + лапка, кома, пробіл 3.
    expect(byteOffsets(text)(16)).toBe(text.indexOf("abc"))
  })

  it("counts a surrogate pair as four bytes and two UTF-16 units", () => {
    const text = "😀x"
    expect(byteOffsets(text)(4)).toBe(2)
    expect(byteOffsets(text)(5)).toBe(3)
  })

  it("throws for a byte in the middle of a character", () => {
    expect(() => byteOffsets("'Привіт', abc")(2)).toThrow(/character boundary/)
  })
})
