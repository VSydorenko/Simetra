import { describe, it, expect } from "vitest"
import { isSqlReservedWord } from "../schemas/sql-reserved-words"

describe("isSqlReservedWord", () => {
  it("matches reserved words case-insensitively", () => {
    expect(isSqlReservedWord("order")).toBe(true)
    expect(isSqlReservedWord("SELECT")).toBe(true)
    expect(isSqlReservedWord("Select")).toBe(true)
  })

  it("does not match names that merely contain a reserved word", () => {
    expect(isSqlReservedWord("orders")).toBe(false)
  })
})
