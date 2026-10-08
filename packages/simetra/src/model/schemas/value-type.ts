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

/** Значення заповнення: вираз, який рахує сама БД на вставці (спека промоції §9.2). */
export const FILL_VALUES = ["now", "today", "newUuid"] as const
/** Порожнє значення: `true` — порожній масив, `object`/`array` — порожній JSON. */
export const EMPTY_VALUES = [true, "object", "array"] as const

const FILL_TYPES: Record<(typeof FILL_VALUES)[number], LogicalType> = {
  now: "DateTime",
  today: "Date",
  newUuid: "UUID",
}

/**
 * Типове значення реквізиту й константи: скаляр (спека П2 §5) або об'єктна
 * форма `fill` / `empty` — вираз колонки без літерала в метаданих.
 */
export type DefaultValue =
  | string
  | number
  | boolean
  | { fill: (typeof FILL_VALUES)[number] }
  | { empty: (typeof EMPTY_VALUES)[number] }

/** Схема `defaultValue`; суворі об'єкти, щоб зайвий ключ не пройшов мовчки. */
export const defaultValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.strictObject({
    fill: z.enum(FILL_VALUES).meta({
      description:
        "Fill expression computed by the database: now (DateTime), today (Date), newUuid (UUID).",
    }),
  }),
  z.strictObject({
    empty: z.union([z.literal(true), z.enum(["object", "array"])]).meta({
      description:
        "Empty value: true for an array of any type, object or array for a scalar Json.",
    }),
  }),
])

/** Скаляр відрізняється від об'єктної форми заповнення. */
export function isScalarDefault(
  value: DefaultValue
): value is string | number | boolean {
  return typeof value !== "object"
}

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
 * Об'єктні форми типового значення (спека промоції §9.2): `fill` — лише на
 * скалярі свого типу, `empty` — лише на масиві або скалярному Json. Підказка
 * називає форму, яку слід ужити.
 */
function refineObjectDefault(
  value: ValueType,
  defaultValue: Exclude<DefaultValue, string | number | boolean>,
  issue: (
    rule: SchemaRule,
    message: string,
    path: string[],
    expected?: string
  ) => void
): void {
  const path = ["defaultValue"]
  if ("fill" in defaultValue) {
    const wanted = FILL_TYPES[defaultValue.fill]
    if (value.array === true || value.type !== wanted) {
      const form = FILL_VALUES.find((f) => FILL_TYPES[f] === value.type)
      issue(
        "type.default-fill-mismatch",
        "fill does not match the logical type",
        path,
        value.array !== true && form !== undefined
          ? `{ "fill": "${form}" }`
          : ""
      )
    }
    return
  }
  const ok =
    value.array === true
      ? defaultValue.empty === true
      : value.type === "Json" && defaultValue.empty !== true
  if (ok) return
  issue(
    "type.default-empty-mismatch",
    "empty does not match the logical type",
    path,
    value.array === true
      ? '{ "empty": true }'
      : value.type === "Json"
        ? '{ "empty": "object" } or { "empty": "array" }'
        : ""
  )
}

/**
 * Перевірки унікальності реквізиту: порівняння без регістру має сенс лише для
 * скалярного рядка, а звуження `uniqueWithin` — лише для вже унікального
 * реквізиту. Місце (власник чи батько об'єкта) перевіряє стадія 4: схема не
 * знає виду об'єкта.
 */
export function refineUnique(
  value: ValueType & { unique?: boolean | "ignoreCase" },
  ctx: z.RefinementCtx
): void {
  if (
    value.unique === "ignoreCase" &&
    (value.array === true || (value.type !== "String" && value.type !== "Text"))
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'unique "ignoreCase" applies only to a scalar String or Text',
      path: ["unique"],
      params: { rule: "type.unique-ignore-case-type" satisfies SchemaRule },
    })
  }
}

/** `uniqueWithin` звужує вже наявну унікальність, тож без `unique` безглуздий. */
export function refineUniqueWithin(
  value: { unique?: boolean | "ignoreCase"; uniqueWithin?: "owner" | "parent" },
  ctx: z.RefinementCtx
): void {
  if (
    value.uniqueWithin !== undefined &&
    (value.unique === undefined || value.unique === false)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "uniqueWithin requires unique",
      path: ["uniqueWithin"],
      params: {
        rule: "attribute.unique-within-requires-unique" satisfies SchemaRule,
      },
    })
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
  const issue = (
    rule: SchemaRule,
    message: string,
    path: string[],
    expected?: string
  ) =>
    ctx.addIssue({
      code: "custom",
      message,
      path,
      params: expected === undefined ? { rule } : { rule, expected },
    })

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
  if (!isScalarDefault(defaultValue)) {
    refineObjectDefault(value, defaultValue, issue)
    return
  }
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

/** Поля меж числа й формату рядка реквізиту (спека промоції §9.3). */
export interface ValueCheckProps {
  nonNegative?: true
  positive?: true
  minValue?: number | string
  maxValue?: number | string
  pattern?: string
  minLength?: number
}

const NUMERIC_BOUND_TYPES: readonly LogicalType[] = [
  "Integer",
  "SmallInt",
  "BigInt",
  "Numeric",
]

/**
 * Конструкції JS-виразу, яких регулярні вирази Postgres (POSIX ARE) не знають
 * або читають інакше: іменовані групи, `\p{…}`/`\P{…}`, `\k<…>`, а також
 * `\b`/`\B` (в ARE це символ повернення й синонім скісної риски, межа слова
 * — `\y`), групи-модифікатори `(?i:…)`/`(?-i:…)` (ARE їх не знає),
 * `\u{…}` (в ARE `\u` — рівно чотири цифри) і `\xHH` (ARE поглинає всі
 * наступні шістнадцяткові цифри, тож `\x41B` там — інший символ, ніж у JS).
 * Ці вирази `new RegExp` приймає, а CHECK на розгортанні впав би або
 * перевіряв би інше. Розбір по символах, щоб екранована скісна риска й клас
 * `[...]` не давали хибних спрацювань.
 */
function usesJsOnlyRegexSyntax(pattern: string): boolean {
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === "\\") {
      const next = pattern[i + 1]
      if (next === "p" || next === "P" || next === "k" || next === "x")
        return true
      if (next === "u" && pattern[i + 2] === "{") return true
      if (!inClass && (next === "b" || next === "B")) return true
      i++
    } else if (inClass) {
      if (char === "]") inClass = false
    } else if (char === "[") {
      inClass = true
    } else if (char === "(" && pattern[i + 1] === "?") {
      const mark = pattern[i + 2]
      // Іменована група `(?<name>`, але не огляд назад `(?<=`/`(?<!`.
      if (mark === "<" && pattern[i + 3] !== "=" && pattern[i + 3] !== "!")
        return true
      // Модифікатор: `(?` з літерою прапорця або `-`.
      if (mark !== undefined && /[a-zA-Z-]/.test(mark)) return true
    }
  }
  return false
}

/** Десятковий запис у вигляді `цілі × 10^степінь` — для точного порівняння меж. */
function decimalParts(value: number | string): { int: bigint; exp: number } {
  const match = /^([+-]?)(\d*)\.?(\d*)(?:[eE]([+-]?\d+))?$/.exec(String(value))!
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match
  const int = BigInt(`${whole}${fraction}` || "0")
  return {
    int: sign === "-" ? -int : int,
    exp: Number(exponent) - fraction.length,
  }
}

function compareDecimals(a: number | string, b: number | string): number {
  const left = decimalParts(a)
  const right = decimalParts(b)
  const exp = Math.min(left.exp, right.exp)
  const x = left.int * 10n ** BigInt(left.exp - exp)
  const y = right.int * 10n ** BigInt(right.exp - exp)
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * Межі числа й формат рядка (спека промоції §9.3): властивість лише на
 * скалярі свого типу, межі — у множині значень типу й упорядковані, вираз
 * мусить бути придатним для Postgres. Схема пропускає лише те, що компілятор
 * зможе виразити CHECK-ом колонки.
 */
export function refineValueChecks(
  value: ValueType & ValueCheckProps,
  ctx: z.RefinementCtx
): void {
  const issue = (rule: SchemaRule, message: string, path: string) =>
    ctx.addIssue({
      code: "custom",
      message,
      path: [path],
      params: { rule },
    })
  const scalar = value.array !== true
  const numeric = scalar && NUMERIC_BOUND_TYPES.includes(value.type)
  const textual = scalar && (value.type === "String" || value.type === "Text")

  for (const key of [
    "nonNegative",
    "positive",
    "minValue",
    "maxValue",
  ] as const) {
    if (value[key] !== undefined && !numeric) {
      issue(
        "type.bound-type",
        "Numeric bounds apply only to a scalar Integer, SmallInt, BigInt or Numeric",
        key
      )
    }
  }
  for (const key of ["pattern", "minLength"] as const) {
    if (value[key] !== undefined && !textual) {
      issue(
        "type.format-type",
        "pattern and minLength apply only to a scalar String or Text",
        key
      )
    }
  }

  if (numeric) {
    if (value.positive !== undefined && value.nonNegative !== undefined) {
      issue(
        "type.bound-conflict",
        "positive and nonNegative are mutually exclusive",
        "nonNegative"
      )
    }
    let valid = true
    for (const key of ["minValue", "maxValue"] as const) {
      const bound = value[key]
      if (bound === undefined) continue
      // Рядок-межа — лише десятковий дріб; ту саму форму й межі типу, що в
      // типового значення, тож перевірка спільна.
      const fits =
        fitsType(value.type, bound) &&
        (typeof bound === "number" || DECIMAL.test(bound)) &&
        isWithinType(value, bound)
      if (!fits) {
        valid = false
        issue("type.bound-invalid", `${key} is outside the type`, key)
      }
    }
    if (
      valid &&
      value.minValue !== undefined &&
      value.maxValue !== undefined &&
      compareDecimals(value.minValue, value.maxValue) > 0
    ) {
      issue("type.bound-order", "minValue must not exceed maxValue", "minValue")
    }
  }

  if (textual && value.pattern !== undefined) {
    let compiles = true
    try {
      new RegExp(value.pattern, "u")
    } catch {
      compiles = false
    }
    if (!compiles || usesJsOnlyRegexSyntax(value.pattern)) {
      issue(
        "type.pattern-invalid",
        "pattern is not a valid expression for both JavaScript and Postgres",
        "pattern"
      )
    }
  }
}

/**
 * Чи скалярне типове значення порушує власний CHECK реквізиту: непорожність
 * обов'язкового рядка, формат і межі числа (ті самі умови, що стадія 3 кладе
 * в CHECK колонки). Статично й лише над скаляром: вираз заповнення (`fill`,
 * `empty`) обчислює БД, і такі значення тут не судяться.
 */
export function defaultViolatesValueChecks(
  value: ValueType &
    ValueCheckProps & { required?: boolean; defaultValue?: DefaultValue }
): boolean {
  const { defaultValue } = value
  if (defaultValue === undefined || !isScalarDefault(defaultValue)) return false
  if (typeof defaultValue === "string" && value.array !== true) {
    const textual = value.type === "String" || value.type === "Text"
    // POSIX `\s` CHECK-а непорожності й JS `\s` збігаються на ASCII-пробілах.
    if (textual && value.required === true && /^\s*$/.test(defaultValue))
      return true
    if (
      textual &&
      value.pattern !== undefined &&
      !new RegExp(value.pattern, "u").test(defaultValue)
    )
      return true
    // `char_length` рахує символи, а не кодові одиниці UTF-16.
    if (
      textual &&
      value.minLength !== undefined &&
      [...defaultValue].length < value.minLength
    )
      return true
  }
  if (
    value.array !== true &&
    NUMERIC_BOUND_TYPES.includes(value.type) &&
    typeof defaultValue !== "boolean"
  ) {
    const below = (bound: number | string) =>
      compareDecimals(defaultValue, bound) < 0
    if (value.nonNegative === true && below(0)) return true
    if (value.positive === true && compareDecimals(defaultValue, 0) <= 0)
      return true
    if (value.minValue !== undefined && below(value.minValue)) return true
    if (
      value.maxValue !== undefined &&
      compareDecimals(defaultValue, value.maxValue) > 0
    )
      return true
  }
  return false
}
