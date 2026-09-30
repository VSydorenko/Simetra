import { describe, expect, it } from "vitest"
import { extractMovementBlocks } from "../movement-blocks"

describe("extractMovementBlocks", () => {
  it("extracts named blocks and keeps line numbers", () => {
    const text = [
      "-- @movements Stock",
      "SELECT 1",
      "FROM a",
      "-- @end  ",
      "",
      "-- @movements Rates",
      "SELECT 2",
      "-- @end",
    ].join("\n")
    expect(extractMovementBlocks(text)).toEqual({
      blocks: [
        { register: "Stock", sql: "SELECT 1\nFROM a", line: 1 },
        { register: "Rates", sql: "SELECT 2", line: 6 },
      ],
      errors: [],
    })
  })

  it("rest of the file is not a block", () => {
    const text = "SELECT 0;\n-- @movements Stock\nSELECT 1\n-- @end\nSELECT 9;"
    expect(extractMovementBlocks(text).blocks).toEqual([
      { register: "Stock", sql: "SELECT 1", line: 2 },
    ])
  })

  it("unterminated block", () => {
    const result = extractMovementBlocks("\n-- @movements Stock\nSELECT 1")
    expect(result.blocks).toEqual([])
    expect(result.errors).toEqual([expect.objectContaining({ line: 2 })])
  })

  it("nested marker", () => {
    const result = extractMovementBlocks(
      "-- @movements A\n-- @movements B\nSELECT 1\n-- @end"
    )
    expect(result.errors).toEqual([expect.objectContaining({ line: 2 })])
    expect(result.blocks).toHaveLength(1)
  })

  it("stray end", () => {
    const result = extractMovementBlocks("SELECT 1\n-- @end")
    expect(result.errors).toEqual([expect.objectContaining({ line: 2 })])
  })

  it("empty name", () => {
    const result = extractMovementBlocks("-- @movements  \nSELECT 1\n-- @end")
    expect(result.errors).toEqual([expect.objectContaining({ line: 1 })])
    expect(result.blocks).toEqual([])
  })
})
