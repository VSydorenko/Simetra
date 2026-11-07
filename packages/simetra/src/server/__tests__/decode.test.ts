import { CommandFailure } from "simetra/model"
import { describe, expect, it } from "vitest"
import { decodeCoreRow, decodeReadRow, decodeSafeInteger } from "../decode"
import { ID, OTHER, sample } from "./fixtures"

const SECTION_ID = sample.tabularSections[0]!.id

const internalOf = (decode: () => unknown) => {
  let thrown: unknown
  try {
    decode()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(CommandFailure)
  expect((thrown as CommandFailure).error).toEqual({ code: "command.internal" })
}

describe("decodeCoreRow", () => {
  it("puts sections under tabularSections; jsonb numbers become integers", () => {
    expect(
      decodeCoreRow(sample, {
        id: ID,
        // `jsonb` дає версію й номер рядка числом, дріт — рядком цілого.
        version: 7,
        code_col: "abc",
        at_col: "2026-10-31T10:00:00.5+02:00",
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
    ).toEqual({
      ref: ID,
      version: 7,
      code: "abc",
      at: "2026-10-31T08:00:00.500000Z",
      tabularSections: {
        lines: [
          { ref: OTHER, parent: ID, lineNumber: 1, qty: 2, firstOnly: null },
        ],
      },
    })
  })

  it("keeps a row without tabular free of tabularSections", () => {
    expect(decodeCoreRow(sample, { id: ID, version: "3" })).toEqual({
      ref: ID,
      version: 3,
    })
  })

  // Корінь віддає два рядки в одному JSON (спека П4 §6.13): кожен декодується
  // окремо своїм об'єктом каталогу.
  it("decodes both rows of a root core result", () => {
    const result = {
      root: { id: ID, version: 1, code_col: "r" },
      member: { id: OTHER, version: 1 },
    }
    expect(decodeCoreRow(sample, result.root)).toEqual({
      ref: ID,
      version: 1,
      code: "r",
    })
    expect(decodeCoreRow(sample, result.member)).toEqual({
      ref: OTHER,
      version: 1,
    })
  })

  it.each([
    ["a row that is not an object", []],
    ["a version beyond a safe integer", { version: 9007199254740992 }],
    ["a version that is not an integer", { version: 1.5 }],
    ["a version text that is not an integer", { version: "1.5" }],
    ["an unknown enumeration label", { status_col: "pending" }],
    ["an unknown label in an array", { statuses_col: ["open", "pending"] }],
    ["an unknown pair label", { subject_type: "ticket", subject_col: OTHER }],
    ["a BigInt that is not an integer", { big_col: "1.5" }],
    ["a DateTime infinity", { at_col: "infinity" }],
    ["a DateTime after year 9999", { at_col: "10000-01-01T00:00:00+00:00" }],
    [
      "a DateTime before year 1 in UTC",
      { at_col: "0001-01-01T00:30:00+01:00" },
    ],
    [
      "a line number that is not an integer",
      { tabular: { sample_lines: [{ id: OTHER, line_number: 1.5 }] } },
    ],
    ["lines that are not an array", { tabular: { sample_lines: {} } }],
  ])("%s is command.internal", (_, row) => {
    internalOf(() => decodeCoreRow(sample, row))
  })
})

describe("decodeReadRow", () => {
  it("does not take a tabular key of the head for sections", () => {
    // Секції читання приходять окремою колонкою, а не ключем рядка.
    expect(
      decodeReadRow(
        sample,
        JSON.stringify({ id: ID, version: 1, tabular: { sample_lines: [] } })
      )
    ).toEqual({ ref: ID, version: 1 })
  })

  it("decodes sections given in wire form by section id", () => {
    expect(
      decodeReadRow(sample, JSON.stringify({ id: ID, version: "2" }), {
        [SECTION_ID]: [{ id: OTHER, parent_id: ID, line_number: "2" }],
      })
    ).toEqual({
      ref: ID,
      version: 2,
      tabularSections: { lines: [{ ref: OTHER, parent: ID, lineNumber: 2 }] },
    })
  })

  it.each([
    ["broken JSON", "{"],
    ["an unknown enumeration label", JSON.stringify({ status_col: "x" })],
    ["a DateTime infinity", JSON.stringify({ at_col: "-infinity" })],
  ])("%s is command.internal", (_, json) => {
    internalOf(() => decodeReadRow(sample, json))
  })
})

describe("decodeSafeInteger", () => {
  it.each([
    [3, 3],
    ["3", 3],
  ])("%j is %d", (value, number) => {
    expect(decodeSafeInteger(value)).toBe(number)
  })

  it.each([1.5, "1.5", 9007199254740992, null])(
    "%j is command.internal",
    (value) => {
      internalOf(() => decodeSafeInteger(value))
    }
  )
})
