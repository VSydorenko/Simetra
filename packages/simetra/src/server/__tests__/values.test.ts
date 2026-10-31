import { beforeAll, describe, expect, it } from "vitest"
import { buildRuntimeCatalog } from "simetra/compiler"
import type { Operation, RuntimeObject } from "simetra/model"
import {
  commandCoreLayer,
  compileRights,
  policyDomain,
  writeRoles,
} from "../../compiler/__tests__/fixtures/rights"
import { CommandFailure } from "../errors"
import { ID, OTHER, SUBJECT, attributeOf, sample } from "./fixtures"
import {
  decodeRow,
  encodeItem,
  encodeItemValue,
  encodePair,
  encodeParam,
} from "../values"

const create = (): Operation => ({
  action: "create",
  object: { kind: "Catalog", name: "Sample" },
  id: ID,
})
const update = (): Operation => ({
  action: "update",
  object: { kind: "Catalog", name: "Sample" },
  id: ID,
  expectedVersion: 3,
})

/** Масив з діркою на індексі 1. */
const holey = (): unknown[] => {
  const array: unknown[] = [1]
  array[2] = 3
  return array
}

const invalid = (path: string) => ({
  error: { code: "command.invalid", path },
})

describe("encodeItemValue / decodeRow round trip", () => {
  // [реквізит, вхід, значення p_item, рядок результату ядра, декодоване]
  it.each([
    ["code", "abc", "abc", "abc", "abc"],
    ["note", "long text", "long text", "long text", "long text"],
    ["owner", OTHER, OTHER, OTHER, OTHER],
    ["count", -2147483648, -2147483648, -2147483648, -2147483648],
    ["small", 32767, 32767, 32767, 32767],
    // `BigInt`: у `p_item` і в рядку ядра — текст, у JS — `bigint`.
    [
      "big",
      9007199254740993n,
      "9007199254740993",
      "9007199254740993",
      9007199254740993n,
    ],
    [
      "big",
      "-9223372036854775808",
      "-9223372036854775808",
      "-9223372036854775808",
      -9223372036854775808n,
    ],
    [
      "amount",
      "12345678901234567890.0123456789",
      "12345678901234567890.0123456789",
      "12345678901234567890.0123456789",
      "12345678901234567890.0123456789",
    ],
    ["flag", false, false, false, false],
    ["day", "2026-02-28", "2026-02-28", "2026-02-28", "2026-02-28"],
    [
      "at",
      "2026-10-31T10:00:00+02:00",
      "2026-10-31T10:00:00+02:00",
      "2026-10-31T08:00:00+00:00",
      "2026-10-31T08:00:00+00:00",
    ],
    ["blob", "\\x00ff", "\\x00ff", "\\x00ff", "\\x00ff"],
    // `Json` — значенням, не JSON-рядком.
    [
      "payload",
      { a: [1, "x", null, { b: true }] },
      { a: [1, "x", null, { b: true }] },
      { a: [1, "x", null, { b: true }] },
      { a: [1, "x", null, { b: true }] },
    ],
    ["payload", "plain", "plain", "plain", "plain"],
    ["tags", [1, null, 3], [1, null, 3], [1, null, 3], [1, null, 3]],
    ["bigs", [1n, "2"], ["1", "2"], ["1", "2"], [1n, 2n]],
    ["status", "Open", "open", "open", "Open"],
    [
      "statuses",
      ["Closed", null],
      ["closed", null],
      ["closed", null],
      ["Closed", null],
    ],
    ["link", OTHER, OTHER, OTHER, OTHER],
    ["mood", "happy", "happy", "happy", "happy"],
    ["note", null, null, null, null],
  ])("%s: %s", (name, input, item, stored, decoded) => {
    const attribute = attributeOf(name)
    expect(encodeItemValue(attribute, input, name)).toEqual({ value: item })
    expect(
      decodeRow(sample, JSON.stringify({ [attribute.column]: stored }))
    ).toEqual({ [name]: decoded })
  })

  it("a polymorphic pair: two columns in, { type, id } out", () => {
    expect(
      encodeItemValue(SUBJECT, { type: "Catalog.Region", id: OTHER }, "subject")
    ).toEqual({ value: { subject_type: "region", subject_col: OTHER } })
    expect(encodeItemValue(SUBJECT, null, "subject")).toEqual({
      value: { subject_type: null, subject_col: null },
    })
    expect(
      decodeRow(
        sample,
        JSON.stringify({ subject_type: "project", subject_col: OTHER })
      )
    ).toEqual({ subject: { type: "Catalog.Project", id: OTHER } })
    expect(
      decodeRow(
        sample,
        JSON.stringify({ subject_type: null, subject_col: null })
      )
    ).toEqual({ subject: null })
    expect(
      encodePair(SUBJECT, { type: "Catalog.Project", id: OTHER }, "subject")
    ).toEqual({ value: { label: "project", id: OTHER } })
  })

  it("a raw carrier copy decodes as is", () => {
    expect(decodeRow(sample, JSON.stringify({ copy_id_col: OTHER }))).toEqual({
      copy_id: OTHER,
    })
  })
})

describe("encodeParam", () => {
  it.each([
    ["code", "abc", "abc"],
    ["count", 42, "42"],
    ["big", 9007199254740993n, "9007199254740993"],
    ["amount", "1.5", "1.5"],
    ["flag", true, "true"],
    ["at", "2026-10-31T10:00:00Z", "2026-10-31T10:00:00Z"],
    ["status", "Closed", "closed"],
    ["blob", "\\xff", "\\xff"],
    ["note", null, null],
  ])("%s: %s", (name, input, text) => {
    expect(encodeParam(attributeOf(name), input, name)).toEqual({ value: text })
  })

  it("rejects Json and arrays in where", () => {
    expect(encodeParam(attributeOf("payload"), { a: 1 }, "payload")).toEqual(
      invalid("payload")
    )
    expect(encodeParam(attributeOf("tags"), [1], "tags")).toEqual(
      invalid("tags")
    )
  })

  it("applies the same value rules", () => {
    expect(encodeParam(attributeOf("code"), "abcd", "code")).toEqual(
      invalid("code")
    )
    expect(encodeParam(attributeOf("amount"), 1.5, "amount")).toEqual(
      invalid("amount")
    )
  })
})

describe("rejects lossy and invalid values", () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  it.each([
    // Review Focus 5: `Numeric` числом JS, зайвий scale, `DateTime` без зсуву, довжина.
    ["amount", 1.5],
    ["amount", "1.12345678901"],
    ["amount", "123456789012345678901"],
    ["amount", "1e3"],
    ["amount", "NaN"],
    ["at", "2026-10-31T10:00:00"],
    ["at", "2026-10-31"],
    ["code", "abcd"],
    // `NaN`, `Infinity`, дріб, межі цілих.
    ["count", Number.NaN],
    ["count", Number.POSITIVE_INFINITY],
    ["count", 1.5],
    ["count", 2147483648],
    ["count", "1"],
    ["small", 32768],
    // `BigInt` — лише `bigint` чи рядок цілого в межах `int8`.
    ["big", 1],
    ["big", "1.0"],
    ["big", 9223372036854775808n],
    // `Json` — лише чисті JSON-значення.
    ["payload", new Map([["a", 1]])],
    ["payload", new Date(0)],
    ["payload", 1n],
    ["payload", { a: undefined }],
    ["payload", { a: Number.NaN }],
    ["payload", holey()],
    ["payload", () => 1],
    ["payload", cyclic],
    // Інші типи — лише своєї форми.
    ["flag", "true"],
    ["owner", "not-a-uuid"],
    ["link", 7],
    ["day", "2026-02-30"],
    ["blob", "ff"],
    ["blob", "\\xf"],
    ["note", 1],
    ["mood", 1],
    // Невідоме значення перерахування.
    ["status", "open"],
    ["status", "Pending"],
    // Масив — лише масив без дірок.
    ["tags", 1],
    // Значення поза входом.
    ["code", undefined],
    ["copy_id", OTHER],
  ])("%s: %s", (name, input) => {
    expect(encodeItemValue(attributeOf(name), input, name)).toEqual(
      invalid(name)
    )
  })

  it("rejects a value that cannot be read", () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(
      encodeItemValue(attributeOf("payload"), revoked.proxy, "payload")
    ).toEqual(invalid("payload"))
  })

  it("points into an array element", () => {
    expect(encodeItemValue(attributeOf("tags"), [1, 2.5], "tags")).toEqual(
      invalid("tags.1")
    )
    // Дірка масиву — `undefined` елемента.
    expect(encodeItemValue(attributeOf("tags"), holey(), "tags")).toEqual(
      invalid("tags.1")
    )
    expect(
      encodeItemValue(attributeOf("statuses"), ["Open", "Nope"], "statuses")
    ).toEqual(invalid("statuses.1"))
  })

  it.each([
    [{ type: "Catalog.Ticket", id: OTHER }],
    [{ type: "project", id: OTHER }],
    [{ type: "Catalog.Project", id: "x" }],
    [{ type: "Catalog.Project", id: OTHER, extra: 1 }],
    [{ type: "Catalog.Project" }],
    [OTHER],
  ])("a pair %j", (input) => {
    expect(encodeItemValue(SUBJECT, input, "subject")).toEqual(
      invalid("subject")
    )
  })
})

describe("encodeItem", () => {
  it("maps logical names to physical columns, the key from op.id", () => {
    expect(
      encodeItem(sample, create(), {
        values: {
          code: "abc",
          amount: "1.5",
          status: "Open",
          subject: { type: "Catalog.Project", id: OTHER },
          frozen: "x",
        },
        tabularSections: {
          lines: [{ ref: OTHER, qty: 2, firstOnly: "f" }],
        },
      })
    ).toEqual({
      item: {
        id: ID,
        code_col: "abc",
        amount_col: "1.5",
        status_col: "open",
        subject_type: "project",
        subject_col: OTHER,
        frozen_col: "x",
        tabular: {
          sample_lines: [{ id: OTHER, qty_col: 2, firstOnly_col: "f" }],
        },
      },
    })
  })

  it("accepts an insert-only attribute of a new row on update", () => {
    expect(
      encodeItem(sample, update(), {
        values: { code: "abc" },
        tabularSections: { lines: [{ ref: OTHER, firstOnly: "f" }] },
      })
    ).toEqual({
      item: {
        id: ID,
        code_col: "abc",
        tabular: { sample_lines: [{ id: OTHER, firstOnly_col: "f" }] },
      },
    })
  })

  it("does not check required attributes (Р-A3-20)", () => {
    const required = {
      ...sample,
      attributes: [{ ...attributeOf("code"), required: true }],
    }
    expect(encodeItem(required, create(), {})).toEqual({ item: { id: ID } })
  })

  it.each([
    ["a key outside update", update(), { values: { frozen: "x" } }, "frozen"],
    ["a key outside insert", create(), { values: { computed: 1 } }, "computed"],
    ["the table key in values", create(), { values: { ref: OTHER } }, "ref"],
    ["the version in values", update(), { values: { version: 4 } }, "version"],
    ["an unknown attribute", create(), { values: { nope: 1 } }, "nope"],
    ["a raw carrier copy", create(), { values: { copy_id: OTHER } }, "copy_id"],
    ["undefined in values", create(), { values: { code: undefined } }, "code"],
    ["an invalid value", create(), { values: { count: 1.5 } }, "count"],
    [
      "a non-clonable value",
      create(),
      { values: { payload: { f: () => 1 } } },
      "payload",
    ],
    ["values that are not an object", create(), { values: [] }, "values"],
    ["an unknown section", create(), { tabularSections: { nope: [] } }, "nope"],
    [
      "a section that is not an array",
      create(),
      { tabularSections: { lines: {} } },
      "lines",
    ],
    [
      "a row without its key",
      update(),
      { tabularSections: { lines: [{ qty: 1 }] } },
      "lines.0.ref",
    ],
    [
      "a row key that is not a UUID",
      update(),
      { tabularSections: { lines: [{ ref: "x" }] } },
      "lines.0.ref",
    ],
    [
      "undefined in a row",
      create(),
      {
        tabularSections: {
          lines: [{ ref: OTHER }, { ref: ID, qty: undefined }],
        },
      },
      "lines.1.qty",
    ],
    [
      "a row attribute outside insert",
      create(),
      { tabularSections: { lines: [{ ref: OTHER, copy_id: ID }] } },
      "lines.0.copy_id",
    ],
    [
      "an invalid row value",
      create(),
      { tabularSections: { lines: [{ ref: OTHER, qty: "2" }] } },
      "lines.0.qty",
    ],
    [
      "a row that is not an object",
      create(),
      { tabularSections: { lines: [null] } },
      "lines.0",
    ],
  ])("rejects %s", (_, op, draft, path) => {
    expect(encodeItem(sample, op, draft as never)).toEqual(invalid(path))
  })

  it("reports the first error in catalog order", () => {
    expect(
      encodeItem(sample, create(), { values: { count: 1.5, code: "abcd" } })
    ).toEqual(invalid("code"))
  })
})

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

describe("on the compiled catalog", () => {
  let ticket: RuntimeObject
  beforeAll(async () => {
    const { model, diagnostics } = await compileRights(
      policyDomain(writeRoles(), commandCoreLayer())
    )
    expect(diagnostics).toEqual([])
    ticket = buildRuntimeCatalog(model!).objects.find(
      (o) => o.name === "Ticket"
    )!
  })

  it("a result row has the key under ref and the version under version", () => {
    expect(
      decodeRow(
        ticket,
        JSON.stringify({
          id: ID,
          version: "2",
          org_id: OTHER,
          code: "T-1",
          subject_type: "region",
          subject_id: OTHER,
          watchers: [OTHER],
          tabular: {
            ticket_checklist: [
              { id: OTHER, parent_id: ID, line_number: 1, region_id: ID },
            ],
          },
        })
      )
    ).toEqual({
      ref: ID,
      version: 2,
      org: OTHER,
      code: "T-1",
      subject: { type: "Catalog.Region", id: OTHER },
      watchers: [OTHER],
      checklist: [{ ref: OTHER, region_id: ID }],
    })
  })

  it("the scope is insert-only and the length counts characters", () => {
    expect(encodeItem(ticket, update(), { values: { org: OTHER } })).toEqual(
      invalid("org")
    )
    // Дев'ять символів, з них один поза BMP (дві кодові одиниці UTF-16).
    expect(
      encodeItem(ticket, create(), { values: { code: "T-123456😀" } })
    ).toEqual({ item: { id: ID, code: "T-123456😀" } })
    expect(
      encodeItem(ticket, create(), { values: { code: "T-1234567😀" } })
    ).toEqual(invalid("code"))
  })
})
