import { describe, expect, it } from "vitest"
import { decodeRow } from "../decode"
import { CommandFailure } from "../errors"
import { ID, OTHER, sample } from "./fixtures"

describe("decodeRow", () => {
  it("puts the key under keyName and the version as a number", () => {
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
      lines: [{ ref: OTHER, qty: 2, firstOnly: null }],
    })
  })

  it.each([
    ["a version beyond a safe integer", { version: "9007199254740992" }],
    ["a version that is not an integer", { version: "1.5" }],
    ["an unknown enumeration label", { status_col: "pending" }],
    ["an unknown pair label", { subject_type: "ticket", subject_col: OTHER }],
    ["a BigInt that is not an integer", { big_col: "1.5" }],
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
