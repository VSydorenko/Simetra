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

/** Межі цілих типів Postgres; `BigInt`-число — у межах точного числа JSON. */
const INTEGER_RANGES: Partial<Record<LogicalType, [number, number]>> = {
  SmallInt: [-(2 ** 15), 2 ** 15 - 1],
  Integer: [-(2 ** 31), 2 ** 31 - 1],
  BigInt: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
}

/** Межі `int8`: за межею точного числа JSON `BigInt` береться рядком. */
const INT8_RANGE: [bigint, bigint] = [-(2n ** 63n), 2n ** 63n - 1n]

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/
const INTEGER_TEXT = /^[+-]?\d+$/
const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/
/**
 * ISO 8601 з поясом (`Z`, `±hh`, `±hh:mm`, `±hhmm`): момент без поясу Postgres
 * прочитав би в поясі сесії.
 */
const DATE_TIME_TEXT =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/

/**
 * JSON-форма скаляра для типу (спека П2 §5): булеве, число чи рядок. Чи
 * значення в межах типу — окреме питання (`isWithinType`).
 */
function fitsType(type: LogicalType, value: DefaultValue): boolean {
  switch (type) {
    case "Boolean":
      return typeof value === "boolean"
    case "SmallInt":
    case "Integer":
      return typeof value === "number"
    case "BigInt":
    case "Numeric":
      return typeof value === "number" || typeof value === "string"
    default:
      return typeof value === "string"
  }
}

/**
 * Чи значення правильної форми лежить у множині значень типу: інакше знімок
 * містив би `DEFAULT`, який Postgres відхилить або мовчки округлить.
 * Одиночний `Ref` бере логічне ім'я значення перерахування — його існування
 * перевіряє стадія 4.
 */
function isWithinType(value: ValueType, raw: DefaultValue): boolean {
  if (typeof raw === "number" && INTEGER_RANGES[value.type] !== undefined) {
    const [min, max] = INTEGER_RANGES[value.type]!
    return Number.isInteger(raw) && raw >= min && raw <= max
  }
  const text = String(raw)
  switch (value.type) {
    case "BigInt":
      return (
        INTEGER_TEXT.test(text) &&
        BigInt(text) >= INT8_RANGE[0] &&
        BigInt(text) <= INT8_RANGE[1]
      )
    case "Numeric":
      // Рядок — лише десятковий дріб; експоненту дає тільки запис числа JSON.
      return (
        (typeof raw === "number" || DECIMAL.test(text)) &&
        fitsNumeric(text, value.precision, value.scale)
      )
    case "UUID":
      return UUID_TEXT.test(text)
    case "String":
      // varchar(n) рахує символи, а не кодові одиниці UTF-16.
      return value.length === undefined || [...text].length <= value.length
    case "Date":
      return isDate(text)
    case "DateTime":
      return isDateTime(text)
    default:
      return true
  }
}

/**
 * `numeric(p, s)`: цілих цифр не більше `p - s`, дробових — не більше `s`
 * (зайві дробові Postgres мовчки округлив би). Число JSON читається через
 * десятковий запис, зокрема експоненційний.
 */
function fitsNumeric(
  text: string,
  precision: number | undefined,
  scale: number | undefined
): boolean {
  const exponent = /^([^eE]*)[eE]([+-]?\d+)$/.exec(text)
  const mantissa = exponent?.[1] ?? text
  if (!DECIMAL.test(mantissa)) return false
  if (precision === undefined) return true
  const [whole = "", fraction = ""] = mantissa.replace(/^[+-]/, "").split(".")
  const digits = whole + fraction
  // Позиція десяткової коми в рядку цифр після зсуву на експоненту.
  const point = whole.length + Number(exponent?.[2] ?? 0)
  const significant = digits.replace(/^0+/, "")
  const leading = digits.length - significant.length
  const trimmed = significant.replace(/0+$/, "")
  if (trimmed === "") return true
  const integerDigits = Math.max(0, point - leading)
  const fractionDigits = Math.max(0, leading + trimmed.length - point)
  const allowedScale = scale ?? 0
  return (
    integerDigits <= precision - allowedScale && fractionDigits <= allowedScale
  )
}

/** Календарний день `YYYY-MM-DD`: `2026-02-30` Postgres відхилить. */
function isDate(text: string): boolean {
  const match = DATE_TEXT.exec(text)
  if (match === null) return false
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ]
  // Року 0 у Postgres немає (перед 0001 іде 1 BC), а запис з BC сюди не
  // проходить, тож рік 0000 — помилка, а не день до нашої ери.
  if (year < 1) return false
  // `setUTCFullYear`, а не `Date.UTC`: той читає роки 0–99 як 1900+.
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function isDateTime(text: string): boolean {
  const match = DATE_TIME_TEXT.exec(text)
  if (match === null || !isDate(match[1]!)) return false
  const [hours, minutes, seconds, zoneHours, zoneMinutes] = [
    match[2],
    match[3],
    match[4] ?? "0",
    match[5] ?? "0",
    match[6] ?? "0",
  ].map(Number) as [number, number, number, number, number]
  return (
    hours < 24 &&
    minutes < 60 &&
    seconds < 60 &&
    // Зсув поясу понад ±15:59 Postgres відхиляє (displacement out of range).
    zoneHours <= 15 &&
    zoneMinutes < 60
  )
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
  } else if (!isWithinType(value, defaultValue)) {
    issue("type.default-invalid", "defaultValue is outside the type", [
      "defaultValue",
    ])
  }
}
