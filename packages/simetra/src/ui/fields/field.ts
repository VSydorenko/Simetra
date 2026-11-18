import {
  createElement,
  type ChangeEvent,
  type ReactElement,
  type ReactNode,
} from "react"
import type { RowView } from "simetra/data/react"
import {
  encodeItemValue,
  type CatalogEntry,
  type CatalogEntryAttribute,
  type CommandError,
} from "simetra/model"
import { useMessage } from "../messages"
import { refPresentation } from "./ref-presentation"

/** How a logical type is shown and edited in the slice (P4-D spec §5.3). */
type FieldKind =
  | "text"
  | "longText"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "dateTime"
  | "enum"
  | "object"
  | "uuid"
  | "unsupported"

function fieldKind(a: CatalogEntryAttribute): FieldKind {
  // Масив і пара — до типу: масив `String` не текстове поле.
  if (a.array === true || a.pair !== undefined) return "unsupported"
  switch (a.type) {
    case "String":
      return "text"
    case "Text":
      return "longText"
    case "Integer":
    case "SmallInt":
      return "integer"
    case "BigInt":
    case "Numeric":
      return "decimal"
    case "Boolean":
      return "boolean"
    case "Date":
      return "date"
    case "DateTime":
      return "dateTime"
    case "Ref":
      return a.enumValues === undefined ? "object" : "enum"
    case "UUID":
      return "uuid"
    default:
      return "unsupported"
  }
}

/** Whether the slice can edit the attribute at all; the rest is read-only. */
export function isEditableType(attribute: CatalogEntryAttribute): boolean {
  const kind = fieldKind(attribute)
  return kind !== "object" && kind !== "uuid" && kind !== "unsupported"
}

export interface FieldViewProps {
  attribute: CatalogEntryAttribute
  /** A logical value of the row, as the store holds it. */
  value: unknown
  /** The target of a `Ref` to an object: its row (from `refs`) and catalog entry. */
  target?: { row: RowView | null; entry: CatalogEntry }
}

/** Shows a value by the logical type of its attribute, without styling. */
export function FieldView({
  attribute,
  value,
  target,
}: FieldViewProps): ReactElement {
  const yes = useMessage("value.yes")
  const no = useMessage("value.no")
  const notInSlice = useMessage("value.notInSlice")
  const kind = fieldKind(attribute)
  let text: string
  if (kind === "unsupported") text = notInSlice
  else if (value === null || value === undefined) text = ""
  else if (kind === "boolean") text = value === true ? yes : no
  else if (kind === "enum") {
    text =
      attribute.enumValues?.find((v) => v.name === value)?.label ??
      String(value)
  } else if (kind === "object") {
    text =
      target === undefined
        ? String(value)
        : refPresentation(target.row, target.entry)
  } else {
    // Рядок з бази як є: `Numeric` і `BigInt` не проходять через `number`.
    text = String(value)
  }
  return createElement(
    "span",
    { "data-field": attribute.name, "data-type": attribute.type },
    text
  )
}

export interface FieldEditorProps {
  attribute: CatalogEntryAttribute
  value: unknown
  /**
   * Called with the logical value read from the input. `error` is the T0 codec
   * refusal (`command.invalid`); the value is then the raw text, so the input
   * keeps what the user typed.
   */
  onChange(value: unknown, error?: CommandError): void
  disabled?: boolean
}

const INTEGER_INPUT = /^-?\d+$/

const pad = (n: number, width = 2) => String(n).padStart(width, "0")

// `datetime-local` не має поясу, а кодек вимагає зсув: значення читається в
// поясі користувача й іде як момент (ISO UTC); назад — локальний запис моменту
// з секундами й мілісекундами, щоб правка не губила збережену точність.
function toLocalInput(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value !== "string") return String(value)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const ms = date.getMilliseconds()
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    (ms === 0 ? "" : `.${pad(ms, 3)}`)
  )
}

function fromLocalInput(text: string): string {
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? text : date.toISOString()
}

// Порожнє поле — `null`: так значення «не задано» пише й команда.
function read(kind: FieldKind, event: ChangeEvent<HTMLInputElement>): unknown {
  const target = event.target
  if (kind === "boolean") return target.checked
  if (target.value === "") return null
  // Лише запис цілого стає числом: `Number` прийняв би й `0x10`, `1e3`; решту
  // кодек відхиляє сам, тож вона лишається текстом.
  if (kind === "integer" && INTEGER_INPUT.test(target.value)) {
    return Number(target.value)
  }
  if (kind === "dateTime") return fromLocalInput(target.value)
  return target.value
}

/**
 * Edits a value by the logical type; types the slice does not edit render
 * {@link FieldView}. Validation is the T0 codec `encodeItemValue`, the same as
 * the core uses.
 */
export function FieldEditor({
  attribute,
  value,
  onChange,
  disabled,
}: FieldEditorProps): ReactNode {
  const kind = fieldKind(attribute)
  if (!isEditableType(attribute)) {
    return createElement(FieldView, { attribute, value })
  }
  const emit = (next: unknown) => {
    const encoded = encodeItemValue(attribute, next, attribute.name)
    if ("error" in encoded) onChange(next, encoded.error)
    else onChange(next)
  }
  const common = {
    name: attribute.name,
    "data-field": attribute.name,
    disabled,
  }
  const text = value === null || value === undefined ? "" : String(value)
  switch (kind) {
    case "boolean":
      return createElement("input", {
        ...common,
        type: "checkbox",
        checked: value === true,
        onChange: (e: ChangeEvent<HTMLInputElement>) => emit(read(kind, e)),
      })
    case "longText":
      return createElement("textarea", {
        ...common,
        value: text,
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => emit(e.target.value),
      })
    case "enum":
      return createElement(
        "select",
        {
          ...common,
          value: text,
          onChange: (e: ChangeEvent<HTMLSelectElement>) =>
            emit(e.target.value === "" ? null : e.target.value),
        },
        createElement("option", { key: "", value: "" }, ""),
        ...(attribute.enumValues ?? []).map((v) =>
          createElement("option", { key: v.name, value: v.name }, v.label)
        )
      )
    default:
      return createElement("input", {
        ...common,
        type:
          kind === "date"
            ? "date"
            : kind === "dateTime"
              ? "datetime-local"
              : "text",
        // Секунди не губляться: `step` за замовчуванням ховав би їх у списку.
        ...(kind === "dateTime" ? { step: "any" } : {}),
        // `maxLength` перевіряє кодек: атрибут input обрізав би вставку мовчки.
        value: kind === "dateTime" ? toLocalInput(value) : text,
        onChange: (e: ChangeEvent<HTMLInputElement>) => emit(read(kind, e)),
      })
  }
}
