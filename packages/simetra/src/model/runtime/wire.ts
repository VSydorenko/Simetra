import { isDate } from "../schemas/value-type"
import type {
  CatalogEntry,
  CatalogEntryAttribute,
  CatalogEntrySection,
} from "./catalog"
import { INTEGER_TEXT, encodeItemValue, isPlainObject } from "./values"

/**
 * Кодек форми передачі (спека П4-B §4.4): рядок рантайму за логічними
 * іменами ↔ рядок за фізичними колонками. Живе в T0, бо `encodeRow` кличе
 * T3, а `decodeRow` — обидва адаптери T4 (і T3 з B1b-2): одна семантика
 * значень з обох боків.
 *
 * Ключі виходу беруться лише з каталогу, а не з даних, і збираються через
 * `Map` → `Object.fromEntries`: ключ `__proto__` чи `constructor` у рядку не
 * змінює прототипу й не дає поля.
 */

/** A row keyed by physical columns, as it travels between server and client. */
export type WireRow = Record<string, unknown>

/** A row keyed by logical names, as in `CommandResult.rows`. */
export type LogicalRow = Record<string, unknown>

/** Ключ ТЧ рядка картки — і в логічній формі, і у формі передачі. */
const SECTIONS = "tabularSections"

/**
 * A runtime row value the codec cannot put on the wire: a server defect or a
 * database value outside the logical type, not an input error.
 */
// Не помилка входу: рядок рантайму вже пройшов валідацію.
export class WireEncodeError extends Error {
  /** Logical path of the value: `<name>` or `<section>.<index>.<name>`. */
  readonly path: string

  constructor(path: string) {
    super(`cannot encode ${path} for the wire`)
    this.name = "WireEncodeError"
    this.path = path
  }
}

/** A wire value of the wrong form for its catalog column. */
export class WireDecodeError extends Error {
  /** The physical column whose value is malformed. */
  readonly column: string

  constructor(column: string) {
    super(`malformed wire value in ${column}`)
    this.name = "WireDecodeError"
    this.column = column
  }
}

const own = (row: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(row, key)

// ---------------------------------------------------------------- encode

function encodeInteger(value: unknown, path: string): string {
  // Версія й номер рядка — `number` рантайму; рядком, бо PostgREST віддає
  // їх текстом (`::text`), і форма передачі однакова для обох джерел.
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new WireEncodeError(path)
  }
  return String(value)
}

function encodeKey(value: unknown): unknown {
  // Ключ — UUID чи ціле: ціле йде рядком цілого, як версія.
  return typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : value
}

function encodeValues(
  attributes: readonly CatalogEntryAttribute[],
  row: LogicalRow,
  prefix: string,
  out: Map<string, unknown>
): void {
  for (const attribute of attributes) {
    if (!own(row, attribute.name)) continue
    const value = row[attribute.name]
    const path = `${prefix}${attribute.name}`
    if (attribute.type === "Raw") {
      // Копію носія прав `scalar` відхиляє як вхід команди, а читання її
      // віддає: на дріт вона йде як є.
      out.set(attribute.column, value)
      continue
    }
    const encoded = encodeItemValue(attribute, value, path)
    if ("error" in encoded) throw new WireEncodeError(path)
    if (attribute.pair !== undefined) {
      const columns = encoded.value as Record<string, unknown>
      out.set(attribute.pair.typeColumn, columns[attribute.pair.typeColumn])
      out.set(attribute.column, columns[attribute.column])
    } else {
      out.set(attribute.column, encoded.value)
    }
  }
}

function encodeLine(
  section: CatalogEntrySection,
  line: unknown,
  prefix: string
): WireRow {
  if (!isPlainObject(line)) throw new WireEncodeError(prefix.slice(0, -1))
  const out = new Map<string, unknown>()
  if (own(line, section.keyName)) {
    out.set(section.key, encodeKey(line[section.keyName]))
  }
  if (own(line, section.parentName)) {
    out.set(section.parent, line[section.parentName])
  }
  if (own(line, section.lineNumberName)) {
    out.set(
      section.lineNumber,
      encodeInteger(
        line[section.lineNumberName],
        `${prefix}${section.lineNumberName}`
      )
    )
  }
  encodeValues(section.attributes, line, prefix, out)
  return Object.fromEntries(out)
}

/**
 * Encodes a runtime row (logical names) into its wire form (physical
 * columns): values go through `encodeItemValue` (a pair becomes two columns,
 * an enumeration its label, a `BigInt` integer text); the key, the version
 * and the line number become integer text; a card's `tabularSections` are
 * keyed by section id instead of logical name. Fields the entry does not
 * know are dropped; `Raw` values pass as is.
 *
 * Throws {@link WireEncodeError} for a value `encodeItemValue` rejects —
 * including database values outside the logical type, such as `infinity`
 * for `Date`/`DateTime` or `NaN` for `Numeric`.
 */
export function encodeRow(entry: CatalogEntry, row: LogicalRow): WireRow {
  const out = new Map<string, unknown>()
  if (own(row, entry.keyName)) out.set(entry.key, encodeKey(row[entry.keyName]))
  if (own(row, entry.versionName)) {
    out.set(
      entry.versionColumn,
      encodeInteger(row[entry.versionName], entry.versionName)
    )
  }
  encodeValues(entry.attributes, row, "", out)
  if (own(row, SECTIONS)) {
    const sections = row[SECTIONS]
    if (!isPlainObject(sections)) throw new WireEncodeError(SECTIONS)
    const wire = new Map<string, unknown>()
    for (const section of entry.tabularSections) {
      if (!own(sections, section.name)) continue
      const lines = sections[section.name]
      if (!Array.isArray(lines)) throw new WireEncodeError(section.name)
      wire.set(
        section.id,
        lines.map((line: unknown, index) =>
          encodeLine(section, line, `${section.name}.${index}.`)
        )
      )
    }
    out.set(SECTIONS, Object.fromEntries(wire))
  }
  return Object.fromEntries(out)
}

// ---------------------------------------------------------------- decode

// Обидві форми джерел: `T` (JSON PostgREST) і пробіл (текст Postgres); зсув
// `±hh`, `±hh:mm`, `±hhmm`, `±hh:mm:ss` (історичні пояси Postgres).
const DATE_TIME_WIRE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2})(?::?(\d{2})(?::?(\d{2}))?)?)$/

const pad = (value: number, width: number) => String(value).padStart(width, "0")

/**
 * Момент у фіксованій ширині UTC з мікросекундами: лексикографічний порядок
 * рядків = часовий. Розбір рядка, а не `Date`: той губить мікросекунди.
 * Дріб від зсуву не залежить (зсув — цілі секунди), тож `Date` рахує лише
 * цілі секунди, а дріб переноситься рядком.
 */
function normaliseDateTime(value: string, column: string): string {
  const match = DATE_TIME_WIRE.exec(value)
  if (match === null || !isDate(`${match[1]}-${match[2]}-${match[3]}`)) {
    throw new WireDecodeError(column)
  }
  const [year, month, day, hours, minutes, seconds] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number]
  const fraction = match[7] ?? ""
  // `timestamptz` зберігає мікросекунди: довший дріб — не значення бази.
  if (hours > 23 || minutes > 59 || seconds > 59 || fraction.length > 6) {
    throw new WireDecodeError(column)
  }
  const sign = match[8] === "-" ? -1 : 1
  const [zoneHours, zoneMinutes, zoneSeconds] = [
    match[9],
    match[10],
    match[11],
  ].map((part) => Number(part ?? 0)) as [number, number, number]
  const date = new Date(0)
  // `setUTCFullYear`, а не `Date.UTC`: той читає роки 0–99 як 1900+.
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(
    hours - sign * zoneHours,
    minutes - sign * zoneMinutes,
    seconds - sign * zoneSeconds
  )
  const utcYear = date.getUTCFullYear()
  if (utcYear < 1 || utcYear > 9999) throw new WireDecodeError(column)
  return (
    `${pad(utcYear, 4)}-${pad(date.getUTCMonth() + 1, 2)}-` +
    `${pad(date.getUTCDate(), 2)}T${pad(date.getUTCHours(), 2)}:` +
    `${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}.` +
    `${fraction.padEnd(6, "0")}Z`
  )
}

function decodeInteger(value: unknown, column: string): number {
  // Лише рядок цілого: число JSON означало б, що джерело не привело
  // колонку до тексту, і понад 2^53 воно вже спотворене.
  if (typeof value !== "string" || !INTEGER_TEXT.test(value)) {
    throw new WireDecodeError(column)
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new WireDecodeError(column)
  return number
}

/** Позначка «поле відсутнє» (В9): невідома мітка нового значення сервера. */
const ABSENT = Symbol("absent")

function decodeScalar(
  attribute: CatalogEntryAttribute,
  value: unknown,
  column: string
): unknown {
  const fail = () => {
    throw new WireDecodeError(column)
  }
  switch (attribute.type) {
    case "Integer":
    case "SmallInt":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? value
        : fail()
    case "BigInt":
      return typeof value === "string" && INTEGER_TEXT.test(value)
        ? BigInt(value)
        : fail()
    case "Boolean":
      return typeof value === "boolean" ? value : fail()
    case "DateTime":
      return typeof value === "string"
        ? normaliseDateTime(value, column)
        : fail()
    case "Ref":
      if (typeof value !== "string") return fail()
      if (attribute.enumValues !== undefined) {
        return (
          attribute.enumValues.find((v) => v.label === value)?.name ?? ABSENT
        )
      }
      return value
    case "Json":
    case "Raw":
      return value
    default:
      // `Numeric`, `Date`, `Bytes`, рядки й `UUID` — той самий рядок:
      // масштаб `Numeric` не губиться, перетворення — межа полів T5.
      return typeof value === "string" ? value : fail()
  }
}

function decodeValue(attribute: CatalogEntryAttribute, raw: WireRow): unknown {
  const value = raw[attribute.column]
  if (attribute.pair !== undefined) {
    const { typeColumn, targets } = attribute.pair
    const label = raw[typeColumn]
    if (label === null && value === null) return null
    if (typeof label !== "string") throw new WireDecodeError(typeColumn)
    if (typeof value !== "string") throw new WireDecodeError(attribute.column)
    const target = targets.find((t) => t.label === label)
    if (target === undefined) return ABSENT
    return { type: `${target.object.kind}.${target.object.name}`, id: value }
  }
  if (value === null) return null
  if (attribute.array === true) {
    if (!Array.isArray(value)) throw new WireDecodeError(attribute.column)
    const items = value.map((item: unknown) =>
      item === null ? null : decodeScalar(attribute, item, attribute.column)
    )
    // Масив з невідомою міткою не відтворити частково: поле відсутнє.
    return items.includes(ABSENT) ? ABSENT : items
  }
  return decodeScalar(attribute, value, attribute.column)
}

function decodeInto(
  attributes: readonly CatalogEntryAttribute[],
  raw: WireRow,
  out: Map<string, unknown>
): void {
  for (const attribute of attributes) {
    const present =
      own(raw, attribute.column) ||
      (attribute.pair !== undefined && own(raw, attribute.pair.typeColumn))
    // Відсутній ключ — відсутнє поле, не `null`: ядро лишає старе значення.
    if (!present) continue
    const value = decodeValue(attribute, raw)
    if (value !== ABSENT) out.set(attribute.name, value)
  }
}

/**
 * Decodes wire values of `attributes` into logical names. Physical keys
 * outside `attributes` are ignored, a missing column yields a missing field,
 * and an unknown enumeration label or pair target yields a missing field too.
 * Throws {@link WireDecodeError} for a value of the wrong form.
 */
export function decodeValues(
  attributes: readonly CatalogEntryAttribute[],
  raw: WireRow
): LogicalRow {
  const out = new Map<string, unknown>()
  decodeInto(attributes, raw, out)
  return Object.fromEntries(out)
}

function decodeLine(section: CatalogEntrySection, line: unknown): LogicalRow {
  if (!isPlainObject(line)) throw new WireDecodeError(section.id)
  const out = new Map<string, unknown>()
  if (own(line, section.key)) out.set(section.keyName, line[section.key])
  if (own(line, section.parent)) {
    out.set(section.parentName, line[section.parent])
  }
  if (own(line, section.lineNumber)) {
    out.set(
      section.lineNumberName,
      decodeInteger(line[section.lineNumber], section.lineNumber)
    )
  }
  decodeInto(section.attributes, line, out)
  return Object.fromEntries(out)
}

/**
 * Decodes a raw row of any source (Server Function or PostgREST) into a
 * collection row by the catalog entry (P4-B spec §4.4): `BigInt` becomes a JS
 * `bigint`; the version and the line number accept only integer text and
 * become a safe integer; `DateTime` becomes UTC `YYYY-MM-DDTHH:MM:SS.ffffffZ`;
 * an enumeration label becomes the value's logical name and a pair
 * `{ type: "<Kind>.<Name>", id }`; `Numeric`, `Date`, `Bytes`, `Json` and
 * `Raw` stay as they are. A card's `tabularSections` are keyed by logical
 * name instead of section id. Unknown keys, sections and labels are ignored
 * so an older client survives a model extension.
 *
 * Throws {@link WireDecodeError} with the physical column for a value of the
 * wrong form.
 */
export function decodeRow(entry: CatalogEntry, raw: WireRow): LogicalRow {
  if (!isPlainObject(raw)) throw new WireDecodeError(entry.key)
  const out = new Map<string, unknown>()
  if (own(raw, entry.key)) out.set(entry.keyName, raw[entry.key])
  if (own(raw, entry.versionColumn)) {
    out.set(
      entry.versionName,
      decodeInteger(raw[entry.versionColumn], entry.versionColumn)
    )
  }
  decodeInto(entry.attributes, raw, out)
  if (own(raw, SECTIONS)) {
    const sections = raw[SECTIONS]
    if (!isPlainObject(sections)) throw new WireDecodeError(SECTIONS)
    const logical = new Map<string, unknown>()
    for (const section of entry.tabularSections) {
      if (!own(sections, section.id)) continue
      const lines = sections[section.id]
      if (!Array.isArray(lines)) throw new WireDecodeError(section.id)
      logical.set(
        section.name,
        lines.map((line: unknown) => decodeLine(section, line))
      )
    }
    out.set(SECTIONS, Object.fromEntries(logical))
  }
  return Object.fromEntries(out)
}
