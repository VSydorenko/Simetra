import {
  UUID_TEXT,
  encodeItemValue,
  isPlainObject,
  type CommandError,
  type Draft,
  type Encoded,
  type Operation,
  type RuntimeAttribute,
  type RuntimeObject,
  type RuntimeSection,
} from "simetra/model"

/**
 * Значення команд (Р-A3-7): вхід за логічними іменами перевіряється за
 * каталогом до бази; кодування одного значення — у T0 (`simetra/model`),
 * тут — збирання `p_item` команди й параметр `where`. Рядок результату ядра
 * декодується назад у логічні імена й типи сутності кодогену.
 */

const invalid = (path: string): { error: CommandError } => ({
  error: { code: "command.invalid", path },
})

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

/** Відмова входу на шляху; ловить її лише `encodeItem`. */
class InvalidInput {
  constructor(readonly path: string) {}
}

/**
 * Читання чернетки: геттер, що кидає, чи відкликаний `Proxy` — помилка
 * входу на цьому шляху, а не сирий виняток (чернетку міг повернути хук).
 */
function at<T>(path: string, read: () => T): T {
  try {
    return read()
  } catch {
    throw new InvalidInput(path)
  }
}

/** Власні ключі простого об'єкта; інакше — відмова на `path`. */
function keysOf(path: string, value: unknown): string[] {
  const keys = at(path, () =>
    isPlainObject(value) ? Object.keys(value) : undefined
  )
  if (keys === undefined) throw new InvalidInput(path)
  return keys
}

/**
 * The `p_item` of a save: the table key from `op.id`, physical columns,
 * `tabular` by section table. Перша помилка (Р-A3-8): реквізити — за
 * порядком каталогу, і поза грантом, і з невірним значенням; невідомі
 * ключі — після них, за порядком входу.
 */
export function encodeItem(
  object: RuntimeObject,
  op: Operation,
  draft: Draft<object>
): { item: Record<string, unknown> } | { error: CommandError } {
  try {
    return { item: itemOf(object, op, draft) }
  } catch (error) {
    if (error instanceof InvalidInput) return invalid(error.path)
    throw error
  }
}

function itemOf(
  object: RuntimeObject,
  op: Operation,
  draft: Draft<object>
): Record<string, unknown> {
  const item: Record<string, unknown> = { [object.key]: op.id }
  // `create` пише ключі гранту вставки, решта — ключі гранту оновлення.
  const allowed = (a: RuntimeAttribute) =>
    op.action === "create" ? a.insert : a.update
  const values = at("values", () => draft.values)
  if (values !== undefined) {
    writeAttributes(object.attributes, values, allowed, "values", "", item)
  }
  const sections = at("tabularSections", () => draft.tabularSections)
  if (sections === undefined) return item
  const names = keysOf("tabularSections", sections)
  const unknownSection = names.find(
    (name) => !object.tabularSections.some((s) => s.name === name)
  )
  if (unknownSection !== undefined) throw new InvalidInput(unknownSection)
  const tabular: Record<string, unknown> = {}
  for (const section of object.tabularSections) {
    if (!names.includes(section.name)) continue
    const rows = at(section.name, () => sections[section.name])
    tabular[section.table.name] = encodeRows(section, rows)
  }
  item.tabular = tabular
  return item
}

function encodeRows(
  section: RuntimeSection,
  rows: unknown
): Record<string, unknown>[] {
  const length = at(section.name, () =>
    Array.isArray(rows) ? rows.length : undefined
  )
  if (length === undefined) throw new InvalidInput(section.name)
  const encoded: Record<string, unknown>[] = []
  for (let i = 0; i < length; i++) {
    const path = `${section.name}.${i}`
    const row: unknown = at(path, () => (rows as unknown[])[i])
    keysOf(path, row)
    const keyPath = `${path}.${section.keyName}`
    const key = at(
      keyPath,
      () => (row as Record<string, unknown>)[section.keyName]
    )
    if (typeof key !== "string" || !UUID_TEXT.test(key)) {
      throw new InvalidInput(keyPath)
    }
    const out: Record<string, unknown> = { [section.key]: key }
    // Ядро звіряє рядок ТЧ з ключами вставки на будь-якій операції (`rowKeys`):
    // рядок ТЧ записується заново цілком.
    writeAttributes(
      section.attributes,
      row,
      (a) => a.insert,
      path,
      `${path}.`,
      out,
      section.keyName
    )
    encoded.push(out)
  }
  return encoded
}

/** Пише значення за каталогом у `out`; перша помилка — `InvalidInput`. */
function writeAttributes(
  attributes: readonly RuntimeAttribute[],
  values: unknown,
  allowed: (a: RuntimeAttribute) => boolean,
  containerPath: string,
  prefix: string,
  out: Record<string, unknown>,
  rowKey?: string
): void {
  const keys = new Set(keysOf(containerPath, values))
  if (rowKey !== undefined) keys.delete(rowKey)
  const source = values as Record<string, unknown>
  for (const attribute of attributes) {
    if (!keys.delete(attribute.name)) continue
    const path = `${prefix}${attribute.name}`
    if (!allowed(attribute)) throw new InvalidInput(path)
    const value = at(path, () => source[attribute.name])
    const encoded = encodeItemValue(attribute, value, path)
    if ("error" in encoded) throw new InvalidInput(encoded.error.path ?? path)
    if (attribute.pair !== undefined) {
      Object.assign(out, encoded.value)
    } else {
      out[attribute.column] = encoded.value
    }
  }
  // Лишилися ключі поза каталогом (і ключ таблиці шапки) — за порядком входу.
  const [unknown] = keys
  if (unknown !== undefined) throw new InvalidInput(`${prefix}${unknown}`)
}
