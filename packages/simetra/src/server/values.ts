import {
  UUID_TEXT,
  isDate,
  isDateTime,
  isWithinType,
  type CommandError,
  type Draft,
  type Operation,
  type RuntimeAttribute,
  type RuntimeObject,
  type RuntimeSection,
} from "simetra/model"

/**
 * Значення команд (Р-A3-7): вхід за логічними іменами перевіряється за
 * каталогом до бази — тип, межі, довжина, точність, — щоб база не округлила
 * й не обрізала його мовчки; рядок результату ядра декодується назад у
 * логічні імена й типи сутності кодогену.
 */

type Encoded<T> = { value: T } | { error: CommandError }

const invalid = (path: string): { error: CommandError } => ({
  error: { code: "command.invalid", path },
})

// Рядок, який дає `bytea_output = hex`: кодоген теж читає `Bytes` рядком.
const BYTES_TEXT = /^\\x(?:[0-9a-fA-F]{2})*$/
export const INTEGER_TEXT = /^[+-]?\d+$/

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
  if (value === null || typeof value === "string") return value
  if (typeof value === "boolean") return value
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
function scalar(attribute: RuntimeAttribute, value: unknown): unknown {
  if (value === null) return null
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
    case "PgEnum":
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
      // Лише зі зсувом: момент без поясу база прочитала б у поясі сесії.
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
  attribute: RuntimeAttribute,
  value: unknown,
  path: string
): Encoded<{ label: string | null; id: string | null }> {
  if (value === null) return { value: { label: null, id: null } }
  const targets = attribute.pair?.targets ?? []
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.id !== "string" ||
    !UUID_TEXT.test(value.id)
  ) {
    return invalid(path)
  }
  const target = targets.find(
    (t) => `${t.object.kind}.${t.object.name}` === value.type
  )
  return target === undefined
    ? invalid(path)
    : { value: { label: target.label, id: value.id } }
}

/**
 * A logical value as JSON for `p_item` (`jsonb_populate_record`); a pair
 * yields both of its columns.
 */
export function encodeItemValue(
  attribute: RuntimeAttribute,
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

/**
 * A logical value as the text of a bound `where` parameter. Json and arrays
 * are not comparable by equality there.
 */
export function encodeParam(
  attribute: RuntimeAttribute,
  value: unknown,
  path: string
): Encoded<string | null> {
  if (attribute.pair !== undefined) {
    // Пара — дві рівності; кожну частину дає `encodePair`.
    throw new Error(`internal: pair ${attribute.name} goes through encodePair`)
  }
  if (attribute.array === true || attribute.type === "Json") {
    return invalid(path)
  }
  const encoded = encodeItemValue(attribute, value, path)
  if ("error" in encoded) return encoded
  return { value: encoded.value === null ? null : String(encoded.value) }
}

/**
 * The `p_item` of a save: the table key from `op.id`, physical columns,
 * `tabular` by section table. Помилки: ключі поза каталогом — у порядку
 * входу, далі реквізити в порядку каталогу (Р-A3-8).
 */
export function encodeItem(
  object: RuntimeObject,
  op: Operation,
  draft: Draft<object>
): { item: Record<string, unknown> } | { error: CommandError } {
  const item: Record<string, unknown> = { [object.key]: op.id }
  // `create` пише ключі гранту вставки, решта — ключі гранту оновлення.
  const allowed = (a: RuntimeAttribute) =>
    op.action === "create" ? a.insert : a.update
  const header = writeAttributes(
    object.attributes,
    draft.values,
    allowed,
    object.keyName,
    "values",
    "",
    item
  )
  if (header !== undefined) return header
  if (draft.tabularSections === undefined) return { item }
  if (!isPlainObject(draft.tabularSections)) return invalid("tabularSections")
  const sections = draft.tabularSections
  const unknownSection = Object.keys(sections).find(
    (name) => !object.tabularSections.some((s) => s.name === name)
  )
  if (unknownSection !== undefined) return invalid(unknownSection)
  const tabular: Record<string, unknown> = {}
  for (const section of object.tabularSections) {
    if (!Object.hasOwn(sections, section.name)) continue
    const rows = encodeRows(section, sections[section.name])
    if ("error" in rows) return rows
    tabular[section.table.name] = rows.rows
  }
  item.tabular = tabular
  return { item }
}

function encodeRows(
  section: RuntimeSection,
  rows: unknown
): { rows: Record<string, unknown>[] } | { error: CommandError } {
  if (!Array.isArray(rows)) return invalid(section.name)
  const encoded: Record<string, unknown>[] = []
  for (let i = 0; i < rows.length; i++) {
    const path = `${section.name}.${i}`
    const row: unknown = rows[i]
    if (!isPlainObject(row)) return invalid(path)
    const key = row[section.keyName]
    if (typeof key !== "string" || !UUID_TEXT.test(key)) {
      return invalid(`${path}.${section.keyName}`)
    }
    const out: Record<string, unknown> = { [section.key]: key }
    // Ядро звіряє рядок ТЧ з ключами вставки на будь-якій операції (`rowKeys`):
    // рядок ТЧ записується заново цілком.
    const error = writeAttributes(
      section.attributes,
      row,
      (a) => a.insert,
      section.keyName,
      path,
      `${path}.`,
      out,
      true
    )
    if (error !== undefined) return error
    encoded.push(out)
  }
  return { rows: encoded }
}

/** Пише значення за каталогом у `out`; повертає першу помилку. */
function writeAttributes(
  attributes: readonly RuntimeAttribute[],
  values: unknown,
  allowed: (a: RuntimeAttribute) => boolean,
  keyName: string,
  containerPath: string,
  prefix: string,
  out: Record<string, unknown>,
  keyIncluded = false
): { error: CommandError } | undefined {
  if (values === undefined) return undefined
  if (!isPlainObject(values)) return invalid(containerPath)
  const writable = new Map(
    attributes.filter(allowed).map((a) => [a.name, a] as const)
  )
  const outside = Object.keys(values).find(
    (name) => !(keyIncluded && name === keyName) && !writable.has(name)
  )
  if (outside !== undefined) return invalid(`${prefix}${outside}`)
  for (const attribute of attributes) {
    if (!writable.has(attribute.name) || !Object.hasOwn(values, attribute.name))
      continue
    const path = `${prefix}${attribute.name}`
    const encoded = encodeItemValue(attribute, values[attribute.name], path)
    if ("error" in encoded) return encoded
    if (attribute.pair !== undefined) {
      Object.assign(out, encoded.value)
    } else {
      out[attribute.column] = encoded.value
    }
  }
  return undefined
}
