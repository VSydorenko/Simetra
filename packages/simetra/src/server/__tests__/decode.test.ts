import { CommandFailure } from "simetra/model"
import { describe, expect, it } from "vitest"
import { decodeCardRow, decodeLine, decodeRow } from "../decode"
import { ID, OTHER, sample } from "./fixtures"

describe("decodeRow", () => {
  it("puts the key under keyName, the version and the line number as numbers", () => {
    expect(
      decodeRow(
        sample,
        JSON.stringify({
          id: ID,
          version: "7",
          code_col: "abc",
          unknown_col: 1,
          tabular: {
            sample_lines: [
              {
                id: OTHER,
                parent_id: ID,
                line_number: 1,
                qty_col: 2,
                firstOnly_col: null,
              },
            ],
          },
        })
      )
    ).toEqual({
      ref: ID,
      version: 7,
      code: "abc",
      lines: [
        { ref: OTHER, parent: ID, lineNumber: 1, qty: 2, firstOnly: null },
      ],
    })
  })

  it.each([
    ["a version beyond a safe integer", { version: "9007199254740992" }],
    ["a version that is not an integer", { version: "1.5" }],
    ["an unknown enumeration label", { status_col: "pending" }],
    ["an unknown pair label", { subject_type: "ticket", subject_col: OTHER }],
    ["a BigInt that is not an integer", { big_col: "1.5" }],
    [
      "a line number that is not an integer",
      { tabular: { sample_lines: [{ id: OTHER, line_number: 1.5 }] } },
    ],
  ])("%s is command.internal", (_, row) => {
    let thrown: unknown
    try {
      decodeRow(sample, JSON.stringify(row))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CommandFailure)
    expect((thrown as CommandFailure).error).toEqual({
      code: "command.internal",
    })
  })
})

describe("decodeLine", () => {
  it("decodes a line with its owner and line number", () => {
    expect(
      decodeLine(sample.tabularSections[0]!, {
        id: OTHER,
        parent_id: ID,
        line_number: "2",
        qty_col: 3,
      })
    ).toEqual({ ref: OTHER, parent: ID, lineNumber: 2, qty: 3 })
  })
})

describe("decodeCardRow", () => {
  it("does not take a tabular key of the row for sections", () => {
    // Секції картки приходять окремою колонкою, а не ключем рядка.
    expect(
      decodeCardRow(
        sample,
        JSON.stringify({ id: ID, version: 1, tabular: { sample_lines: [] } })
      )
    ).toEqual({ ref: ID, version: 1 })
  })
})
