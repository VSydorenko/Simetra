import {
  UUID_TEXT,
  isDate,
  isDateTime,
  isWithinType,
  normalDateTime,
} from "../schemas/value-type"
import type { CatalogEntryAttribute } from "./catalog"
import { LIMIT_REASONS, type CommandError } from "./errors"
import { jsonBytes } from "./limits"

/**
 * Кодування значень за спільною частиною запису каталогу (Р-A3-7, Р-A4-12):
 * вхід за логічними іменами перевіряється до бази — тип, межі, довжина,
 * точність, — щоб база не округлила й не обрізала його мовчки. Живе в T0, бо його
 * споживають і T3 (команди), і T2 (інструмент обслуговування прав): T2 не
 * може імпортувати T3.
 */

export type Encoded<T> = { value: T } | { error: CommandError }

const invalid = (path: string): { error: CommandError } => ({
  error: { code: "command.invalid", path },
})

// Рядок, який дає `bytea_output = hex`: кодоген теж читає `Bytes` рядком.
const BYTES_TEXT = /^\\x(?:[0-9a-fA-F]{2})*$/
export const INTEGER_TEXT = /^[+-]?\d+$/
// `\u0000` і непарний сурогат: `text` і `jsonb` їх не зберігають, і база
// відмовила б сирою помилкою вже в транзакції.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const storable = (text: string) =>
  !text.includes("\u0000") && !LONE_SURROGATE.test(text)

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Копія чистого JSON-значення; `undefined` — значення не JSON. Копія, а не
 * саме значення: `jsonb` не має `Map`, `Date`, `bigint`, `undefined`, і
 * `JSON.stringify` мовчки змінив би їх (`{}`, рядок, пропуск), а не відмовив.
 */
function pureJson(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "string") return storable(value) ? value : undefined
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value !== "object" || ancestors.has(value)) return undefined
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const copy: unknown[] = []
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) return undefined
        const element = pureJson(value[i], ancestors)
        if (element === undefined) return undefined
        copy.push(element)
      }
      return copy
    }
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length) {
      return undefined
    }
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (!storable(key)) return undefined
      const element = pureJson(item, ancestors)
      if (element === undefined) return undefined
      // `defineProperty`: ключ `__proto__` з входу лишається даними.
      Object.defineProperty(copy, key, {
        value: element,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return copy
  } finally {
    ancestors.delete(value)
  }
}

/** Скаляр у форму `p_item`; `undefined` — значення не цього типу. */
function scalar(attribute: CatalogEntryAttribute, value: unknown): unknown {
  if (value === null) return null
  if (typeof value === "string" && !storable(value)) return undefined
  switch (attribute.type) {
    case "Integer":
    case "SmallInt":
      return typeof value === "number" &&
        isWithinType({ type: attribute.type }, value)
        ? value
        : undefined
    case "BigInt": {
      const text =
        typeof value === "bigint"
          ? String(value)
          : typeof value === "string"
            ? value
            : undefined
      // Рядок, а не число JSON: `jsonb` округлив би ціле понад 2^53.
      return text !== undefined &&
        INTEGER_TEXT.test(text) &&
        isWithinType({ type: "BigInt" }, text)
        ? text
        : undefined
    }
    case "Numeric":
      return typeof value === "string" &&
        isWithinType(
          {
            type: "Numeric",
            precision: attribute.precision,
            scale: attribute.scale,
          },
          value
        )
        ? value
        : undefined
    case "Boolean":
      return typeof value === "boolean" ? value : undefined
    case "String":
      return typeof value === "string" &&
        isWithinType({ type: "String", length: attribute.maxLength }, value)
        ? value
        : undefined
    case "Text":
      return typeof value === "string" ? value : undefined
    case "UUID":
      return typeof value === "string" && UUID_TEXT.test(value)
        ? value
        : undefined
    case "Ref":
      if (attribute.enumValues !== undefined) {
        // Мітку знає лише база: на вході — логічне ім'я значення.
        return attribute.enumValues.find((v) => v.name === value)?.label
      }
      return typeof value === "string" && UUID_TEXT.test(value)
        ? value
        : undefined
    case "Date":
      return typeof value === "string" && isDate(value) ? value : undefined
    case "DateTime":
      // Лише зі зсувом: момент без поясу база прочитала б у поясі сесії;
      // `isDateTime` тримає й правило дроту (рік 1–9999 в UTC).
      return typeof value === "string" && isDateTime(value) ? value : undefined
    case "Bytes":
      return typeof value === "string" && BYTES_TEXT.test(value)
        ? value
        : undefined
    case "Json":
      return pureJson(value, new Set())
    case "Raw":
      // Копія носія прав: її пише платформа, не вхід.
      return undefined
  }
}

/**
 * A polymorphic pair `{ type: "<Kind>.<Name>", id }` as the label and the id
 * of its two columns.
 */
export function encodePair(
  attribute: CatalogEntryAttribute,
  value: unknown,
  path: string
): Encoded<{ label: string | null; id: string | null }> {
  if (value === null) return { value: { label: null, id: null } }
  const targets = attribute.pair?.targets ?? []
  // Пару читає і `where` читання поза обгорткою `encodeItemValue`: геттер,
  // що кидає, чи відкликаний проксі — помилка входу, а не сирий виняток.
  try {
    if (!isPlainObject(value) || Object.keys(value).length !== 2) {
      return invalid(path)
    }
    // Кожне поле читається раз: геттер не підмінить перевірене значення.
    const { id, type } = value
    if (typeof id !== "string" || !UUID_TEXT.test(id)) return invalid(path)
    const target = targets.find(
      (t) => `${t.object.kind}.${t.object.name}` === type
    )
    return target === undefined
      ? invalid(path)
      : { value: { label: target.label, id } }
  } catch {
    return invalid(path)
  }
}

/**
 * A logical value as JSON for `p_item` (`jsonb_populate_record`); a pair
 * yields both of its columns.
 */
export function encodeItemValue(
  attribute: CatalogEntryAttribute,
  value: unknown,
  path: string
): Encoded<unknown> {
  try {
    if (value === undefined) return invalid(path)
    if (attribute.pair !== undefined) {
      const pair = encodePair(attribute, value, path)
      if ("error" in pair) return pair
      return {
        value: {
          [attribute.pair.typeColumn]: pair.value.label,
          [attribute.column]: pair.value.id,
        },
      }
    }
    if (attribute.array === true && value !== null) {
      if (!Array.isArray(value)) return invalid(path)
      const items: unknown[] = []
      for (let i = 0; i < value.length; i++) {
        const item = i in value ? scalar(attribute, value[i]) : undefined
        if (item === undefined) return invalid(`${path}.${i}`)
        items.push(item)
      }
      return { value: items }
    }
    const item = scalar(attribute, value)
    return item === undefined ? invalid(path) : { value: item }
  } catch {
    // Геттер, що кидає, чи відкликаний проксі: значення не прочитати.
    return invalid(path)
  }
}

// Число з дробом без експоненти: вхід `Numeric` рядком уже пройшов `scalar`.
const DECIMAL_PARTS = /^([+-]?)0*(\d*)(?:\.(\d*))?$/

/**
 * Верхня межа рядка, яким база віддасть `Numeric(p, s)`: знак, ціла частина
 * без провідних нулів, крапка й рівно `s` дробових цифр (масштаб типу, а не
 * входу). Дробових цифр понад `s` база округлює, і перенос може додати цілу
 * цифру — вона входить у межу.
 */
function numericWire(text: string, scale: number): string {
  const match = DECIMAL_PARTS.exec(text)
  if (match === null) return text
  const [, sign = "", whole = "", fraction = ""] = match
  const carry = fraction.length > scale ? "0" : ""
  const integer = carry + (whole === "" ? "0" : whole)
  return scale > 0
    ? `${sign === "-" ? "-" : ""}${integer}.${"0".repeat(scale)}`
    : `${sign === "-" ? "-" : ""}${integer}`
}

/**
 * Значення в тій формі, якою воно піде дротом, — лише для міри `maxBytes`.
 * Р7: `maxBytes` і бюджет рядка — одна міра, `jsonBytes` форми передачі;
 * без цього масив `Numeric(20, 10)` з `"0"` пройшов би межу входу, а дротом
 * виріс би вчетверо, і межа рядка компілятора не була б верхньою.
 */
function wireMeasure(
  attribute: CatalogEntryAttribute,
  value: unknown
): unknown {
  let wire: ((text: string) => string) | undefined
  if (attribute.type === "DateTime") {
    wire = (text) => normalDateTime(text) ?? text
  } else if (attribute.type === "Numeric" && attribute.scale !== undefined) {
    const { scale } = attribute
    wire = (text) => numericWire(text, scale)
  }
  if (wire === undefined) return value
  const one = (item: unknown) => (typeof item === "string" ? wire(item) : item)
  return Array.isArray(value) ? value.map(one) : one(value)
}

/**
 * Options of {@link encodeAttributes}: who may write and how errors are named.
 * Generic over the attribute type, so `allowed` may read the caller's
 * catalog (runtime or shared).
 */
export interface EncodeAttributesOptions<
  A extends CatalogEntryAttribute = CatalogEntryAttribute,
> {
  /** Чи пише вхід реквізит: грант вставки чи оновлення. */
  allowed: (attribute: A) => boolean
  /** Логічні імена, які примушує платформа (ключ, скоуп, користувач учасника). */
  forced?: readonly string[]
  /** Шлях самого контейнера: відмова, коли він не простий об'єкт. */
  path: string
  /** Префікс шляху реквізиту й невідомого ключа. */
  prefix: string
  /** Ключ рядка ТЧ: його пише викликач, а не обхід. */
  rowKey?: string
  /**
   * Refuse a value over its attribute's `maxBytes` (`reason: "too-large"`).
   * Only command input sets it: a stored value over the limit still reads.
   */
  maxBytes?: true
}

/**
 * Один обхід реквізитів значень (Р-A6-13): шапка операції, рядок ТЧ,
 * `creatorMember` і `member` інструмента обслуговування кодуються тут, тож
 * шляхи не розходяться. `values` — простий об'єкт, де кожен ключ — реквізит
 * каталогу, дозволений `allowed` і не примушений. Результат — фізичні
 * колонки → значення для `jsonb_populate_record`. Перша помилка (Р-A3-8):
 * реквізити — за порядком каталогу, невідомі ключі — після них, за порядком
 * входу.
 */
export function encodeAttributes<A extends CatalogEntryAttribute>(
  attributes: readonly A[],
  values: unknown,
  options: EncodeAttributesOptions<A>
): { columns: Record<string, unknown> } | { error: CommandError } {
  const { allowed, forced = [], path, prefix, rowKey, maxBytes } = options
  let keys: Set<string>
  try {
    if (!isPlainObject(values)) return invalid(path)
    keys = new Set(Object.keys(values))
  } catch {
    // Відкликаний проксі: ключів не прочитати.
    return invalid(path)
  }
  if (rowKey !== undefined) keys.delete(rowKey)
  const source = values as Record<string, unknown>
  const columns: Record<string, unknown> = {}
  for (const attribute of attributes) {
    if (!keys.delete(attribute.name)) continue
    const at = `${prefix}${attribute.name}`
    if (!allowed(attribute) || forced.includes(attribute.name)) {
      return invalid(at)
    }
    let value: unknown
    try {
      value = source[attribute.name]
    } catch {
      return invalid(at)
    }
    const encoded = encodeItemValue(attribute, value, at)
    if ("error" in encoded) return encoded
    // Міра — закодоване значення форми передачі (Р7), та сама, якою бюджет
    // відповіді рахує рядок: межа входу й межа читання не розходяться.
    // Масив міряється цілком.
    if (
      maxBytes === true &&
      attribute.maxBytes !== undefined &&
      jsonBytes(wireMeasure(attribute, encoded.value)) > attribute.maxBytes
    ) {
      return {
        error: {
          code: "command.invalid",
          path: at,
          reason: LIMIT_REASONS.tooLarge,
        },
      }
    }
    if (attribute.pair !== undefined) {
      Object.assign(columns, encoded.value)
    } else {
      columns[attribute.column] = encoded.value
    }
  }
  const [unknown] = keys
  return unknown === undefined ? { columns } : invalid(`${prefix}${unknown}`)
}
