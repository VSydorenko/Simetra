// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { createElement } from "react"
import type { RowView } from "simetra/data/react"
import type { CatalogEntryAttribute } from "simetra/model"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  catalogEntry,
  catalogEntryAttribute,
} from "../../../model/runtime/__tests__/entries"
import { FieldEditor, FieldView } from "../field"

afterEach(cleanup)

const attr = (overrides: Partial<CatalogEntryAttribute>) =>
  catalogEntryAttribute({ name: "f", column: "f", ...overrides })

const ENUM = [
  { name: "Open", label: "open" },
  { name: "Closed", label: "closed" },
]
const PAIR = {
  typeColumn: "f_type",
  targets: [{ object: { kind: "Catalog" as const, name: "P" }, label: "p" }],
}
const NUMERIC = { type: "Numeric" as const, precision: 12, scale: 2 }

const shown = (attribute: CatalogEntryAttribute, value: unknown) => {
  const { container } = render(createElement(FieldView, { attribute, value }))
  return container.textContent
}

describe("FieldView — таблиця спеки П4-D §5.3", () => {
  const NOT_IN_SLICE = "Not shown in this slice"
  it.each<[string, Partial<CatalogEntryAttribute>, unknown, string]>([
    ["String", { type: "String" }, "abc", "abc"],
    ["Text", { type: "Text" }, "long", "long"],
    ["Integer", { type: "Integer" }, 5, "5"],
    ["SmallInt", { type: "SmallInt" }, -3, "-3"],
    [
      "BigInt 2^53+1 без втрат",
      { type: "BigInt" },
      "9007199254740993",
      "9007199254740993",
    ],
    ["Numeric без перетворення", NUMERIC, "10.50", "10.50"],
    ["Boolean так", { type: "Boolean" }, true, "Yes"],
    ["Boolean ні", { type: "Boolean" }, false, "No"],
    ["Date", { type: "Date" }, "2026-01-31", "2026-01-31"],
    [
      "DateTime",
      { type: "DateTime" },
      "2026-01-31T10:00:00Z",
      "2026-01-31T10:00:00Z",
    ],
    [
      "Ref на перерахування — мітка",
      { type: "Ref", enumValues: ENUM },
      "Closed",
      "closed",
    ],
    [
      "UUID",
      { type: "UUID" },
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001",
    ],
    ["Json", { type: "Json" }, { a: 1 }, NOT_IN_SLICE],
    ["Bytes", { type: "Bytes" }, "\\x00", NOT_IN_SLICE],
    ["масив", { type: "String", array: true }, ["a"], NOT_IN_SLICE],
    ["пара Ref", { type: "Ref", pair: PAIR }, "x", NOT_IN_SLICE],
    ["null — порожньо", { type: "String" }, null, ""],
  ])("%s", (_, overrides, value, expected) => {
    expect(shown(attr(overrides), value)).toBe(expected)
  })

  it("Ref на об'єкт показує представлення цілі", () => {
    const row: RowView = {
      key: "k",
      version: 1,
      values: { description: "Acme" },
      state: "synced",
      staleFields: [],
    }
    const entry = catalogEntry({ presentation: { attribute: "description" } })
    const { container } = render(
      createElement(FieldView, {
        attribute: attr({ type: "Ref" }),
        value: "k",
        target: { row, entry },
      })
    )
    expect(container.textContent).toBe("Acme")
  })
})

function edit(attribute: CatalogEntryAttribute, value: unknown = null) {
  const onChange = vi.fn()
  const view = render(
    createElement(FieldEditor, { attribute, value, onChange })
  )
  return { onChange, ...view }
}
const control = (c: HTMLElement) =>
  c.querySelector("input, textarea, select") as HTMLInputElement | null

describe("FieldEditor — редагування за таблицею §5.3", () => {
  it.each<[string, Partial<CatalogEntryAttribute>, string, string]>([
    ["String", { type: "String", maxLength: 5 }, "INPUT", "text"],
    ["Text", { type: "Text" }, "TEXTAREA", ""],
    ["Integer", { type: "Integer" }, "INPUT", "text"],
    ["BigInt", { type: "BigInt" }, "INPUT", "text"],
    ["Numeric", NUMERIC, "INPUT", "text"],
    ["Boolean", { type: "Boolean" }, "INPUT", "checkbox"],
    ["Date", { type: "Date" }, "INPUT", "date"],
    ["DateTime", { type: "DateTime" }, "INPUT", "datetime-local"],
    ["перерахування", { type: "Ref", enumValues: ENUM }, "SELECT", ""],
  ])("%s редагується", (_, overrides, tag, type) => {
    const { container } = edit(attr(overrides))
    const el = control(container)
    expect(el?.tagName).toBe(tag)
    if (type !== "") expect(el?.getAttribute("type")).toBe(type)
  })

  it.each<[string, Partial<CatalogEntryAttribute>]>([
    ["Ref на об'єкт", { type: "Ref" }],
    ["UUID", { type: "UUID" }],
    ["Json", { type: "Json" }],
    ["Bytes", { type: "Bytes" }],
    ["масив", { type: "String", array: true }],
    ["пара Ref", { type: "Ref", pair: PAIR }],
  ])("%s — лише читання", (_, overrides) => {
    const { container } = edit(attr(overrides), "x")
    expect(control(container)).toBeNull()
  })

  it("BigInt 2^53+1 іде рядком без втрат", () => {
    const { container, onChange } = edit(attr({ type: "BigInt" }))
    fireEvent.change(control(container)!, {
      target: { value: "9007199254740993" },
    })
    expect(onChange).toHaveBeenCalledWith("9007199254740993")
  })

  it("Numeric «10.50» іде рядком без перетворення; зайвий масштаб кодек відхиляє", () => {
    const { container, onChange } = edit(attr(NUMERIC))
    fireEvent.change(control(container)!, { target: { value: "10.50" } })
    expect(onChange).toHaveBeenLastCalledWith("10.50")
    fireEvent.change(control(container)!, { target: { value: "10.505" } })
    expect(onChange).toHaveBeenLastCalledWith("10.505", {
      code: "command.invalid",
      path: "f",
    })
  })

  it("Integer — число; поза межами типу кодек відхиляє", () => {
    const { container, onChange } = edit(attr({ type: "SmallInt" }))
    fireEvent.change(control(container)!, { target: { value: "12" } })
    expect(onChange).toHaveBeenLastCalledWith(12)
    fireEvent.change(control(container)!, { target: { value: "99999" } })
    expect(onChange).toHaveBeenLastCalledWith(
      99999,
      expect.objectContaining({ code: "command.invalid" })
    )
  })

  it.each([["0x10"], ["1e3"], ["abc"], ["1.5"], ["+5"]])(
    "Integer: %s лишається текстом і відхиляється кодеком",
    (text) => {
      const { container, onChange } = edit(attr({ type: "Integer" }))
      fireEvent.change(control(container)!, { target: { value: text } })
      expect(onChange).toHaveBeenCalledWith(
        text,
        expect.objectContaining({ code: "command.invalid" })
      )
    }
  )

  it("довжина String — з каталогу", () => {
    const { container, onChange } = edit(attr({ type: "String", maxLength: 3 }))
    fireEvent.change(control(container)!, { target: { value: "abcd" } })
    expect(onChange).toHaveBeenLastCalledWith(
      "abcd",
      expect.objectContaining({ code: "command.invalid" })
    )
  })

  it("порожнє поле — null; Boolean і перерахування віддають значення", () => {
    const text = edit(attr({ type: "String" }), "a")
    fireEvent.change(control(text.container)!, { target: { value: "" } })
    expect(text.onChange).toHaveBeenCalledWith(null)

    const bool = edit(attr({ type: "Boolean" }), false)
    fireEvent.click(control(bool.container)!)
    expect(bool.onChange).toHaveBeenCalledWith(true)

    const en = edit(attr({ type: "Ref", enumValues: ENUM }))
    fireEvent.change(control(en.container)!, { target: { value: "Closed" } })
    expect(en.onChange).toHaveBeenCalledWith("Closed")
  })

  it("DateTime: локальний запис стає моментом зі зсувом, який приймає кодек", () => {
    const { container, onChange } = edit(attr({ type: "DateTime" }))
    fireEvent.change(control(container)!, {
      target: { value: "2026-01-31T10:00" },
    })
    const [value, error] = onChange.mock.calls[0]!
    expect(value).toMatch(/Z$/)
    expect(error).toBeUndefined()
  })

  describe("DateTime у фіксованому поясі", () => {
    const zone = process.env.TZ
    beforeAll(() => {
      process.env.TZ = "Europe/Kyiv"
    })
    afterAll(() => {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    })

    it("наявне значення з секундами й мілісекундами показується повністю, правка хвилин їх не губить", () => {
      const { container, onChange } = edit(
        attr({ type: "DateTime" }),
        "2026-07-15T10:00:07.123Z"
      )
      const input = control(container)!
      expect(input.value).toBe("2026-07-15T13:00:07.123")
      fireEvent.change(input, { target: { value: "2026-07-15T13:05:07.123" } })
      expect(onChange).toHaveBeenCalledWith("2026-07-15T10:05:07.123Z")
    })
  })
})
