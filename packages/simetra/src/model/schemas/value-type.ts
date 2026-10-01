import { z } from "zod"
import type { SchemaRule } from "./rules"
import { metadataRefSchema } from "./metadata-ref"

export const LOGICAL_TYPES = [
  "UUID",
  "String",
  "Text",
  "Integer",
  "SmallInt",
  "BigInt",
  "Numeric",
  "Boolean",
  "Date",
  "DateTime",
  "Bytes",
  "Json",
  "Ref",
] as const

export type LogicalType = (typeof LOGICAL_TYPES)[number]

/** Поля типу, спільні для реквізиту, константи й колонки. */
export const valueTypeShape = {
  type: z.enum(LOGICAL_TYPES).meta({ description: "Logical value type." }),
  length: z.number().int().positive().optional().meta({
    description: "Maximum length; required for String and allowed only there.",
  }),
  precision: z.number().int().positive().optional().meta({
    description: "Total number of digits; allowed only for Numeric.",
  }),
  scale: z.number().int().nonnegative().optional().meta({
    description: "Digits after the decimal point; requires precision.",
  }),
  ref: metadataRefSchema.optional().meta({
    description:
      "Single reference target of a Ref value; mutually exclusive with allowedTypes.",
  }),
  // Порожня множина дала б пару колонок без CHECK на дискримінатор.
  allowedTypes: z.array(metadataRefSchema).min(1).optional().meta({
    description:
      "Polymorphic reference targets of a Ref value; mutually exclusive with ref.",
  }),
  array: z
    .boolean()
    .optional()
    .meta({ description: "Whether the value is an array of the type." }),
  /** Свідомо міжскоуповий Ref: FK без скоупної частини ключа. */
  crossScope: z.literal(true).optional().meta({
    description:
      "Marks a deliberately cross-scope Ref: the FK has no scope part in its key.",
  }),
}

export type ValueType = z.infer<z.ZodObject<typeof valueTypeShape>>

/** Скаляр типового значення реквізиту й константи (спека П2 §5). */
type DefaultValue = string | number | boolean

/** Межі цілих типів Postgres; `BigInt` — у межах точного числа JSON. */
const INTEGER_RANGES: Partial<Record<LogicalType, [number, number]>> = {
  SmallInt: [-(2 ** 15), 2 ** 15 - 1],
  Integer: [-(2 ** 31), 2 ** 31 - 1],
  BigInt: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
}

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/
const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Чи скаляр сумісний з логічним типом (спека П2 §5): інакше знімок містив би
 * `DEFAULT`, який Postgres відхилить. Одиночний `Ref` бере логічне ім'я
 * значення перерахування — його існування перевіряє стадія 4.
 */
function fitsType(type: LogicalType, value: DefaultValue): boolean {
  const range = INTEGER_RANGES[type]
  if (range !== undefined) {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= range[0] &&
      value <= range[1]
    )
  }
  switch (type) {
    case "Boolean":
      return typeof value === "boolean"
    case "Numeric":
      return (
        typeof value === "number" ||
        (typeof value === "string" && DECIMAL.test(value))
      )
    case "UUID":
      return typeof value === "string" && UUID_TEXT.test(value)
    default:
      return typeof value === "string"
  }
}

/**
 * Перевірки сумісності параметрів типу; кожне порушення несе код правила.
 * Типове значення перевіряється тут же — для реквізиту й константи одним
 * шляхом.
 */
export function refineValueType(
  value: ValueType & { defaultValue?: DefaultValue },
  ctx: z.RefinementCtx
): void {
  const issue = (rule: SchemaRule, message: string, path: string[]) =>
    ctx.addIssue({ code: "custom", message, path, params: { rule } })

  if (value.type === "String" && value.length === undefined) {
    issue("type.length-required", "String type requires length", ["length"])
  }
  if (value.type !== "String" && value.length !== undefined) {
    issue("type.length-not-allowed", "Only String type accepts length", [
      "length",
    ])
  }
  if (value.type !== "Numeric" && value.precision !== undefined) {
    issue("type.precision-not-allowed", "Only Numeric type accepts precision", [
      "precision",
    ])
  }
  if (value.scale !== undefined && value.precision === undefined) {
    issue("type.scale-requires-precision", "Scale requires precision", [
      "scale",
    ])
  }

  if (value.crossScope !== undefined && value.type !== "Ref") {
    issue("type.cross-scope-not-allowed", "Only Ref type accepts crossScope", [
      "crossScope",
    ])
  }

  const hasRef = value.ref !== undefined
  const hasAllowed = value.allowedTypes !== undefined
  if (value.type === "Ref") {
    if (!hasRef && !hasAllowed) {
      issue(
        "type.ref-target-required",
        "Ref type requires either ref or allowedTypes",
        ["ref"]
      )
    } else if (hasRef && hasAllowed) {
      issue(
        "type.ref-exclusive",
        "ref and allowedTypes are mutually exclusive",
        ["allowedTypes"]
      )
    }
  } else {
    if (hasRef) {
      issue("type.ref-not-allowed", "Only Ref type accepts ref", ["ref"])
    }
    if (hasAllowed) {
      issue("type.ref-not-allowed", "Only Ref type accepts allowedTypes", [
        "allowedTypes",
      ])
    }
  }

  const { defaultValue } = value
  if (defaultValue === undefined) return
  // Масив, поліморфна пара, байти й JSON не мають скалярного літерала, який
  // дав би коректний `DEFAULT` (спека П2 §5).
  if (
    value.array === true ||
    hasAllowed ||
    value.type === "Bytes" ||
    value.type === "Json"
  ) {
    issue(
      "type.default-not-allowed",
      "defaultValue is not allowed for an array, allowedTypes, Bytes or Json value",
      ["defaultValue"]
    )
  } else if (!fitsType(value.type, defaultValue)) {
    issue(
      "type.default-mismatch",
      "defaultValue does not match the logical type",
      ["defaultValue"]
    )
  }
}
