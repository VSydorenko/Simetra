import {
  INTEGER_TEXT,
  isPlainObject,
  decodeRow,
  splitKnownMarker,
  type KnownMarker,
  type LogicalRow,
  type RuntimeObject,
  type RuntimeSection,
  type WireRow,
  CommandFailure,
  WireDecodeError,
} from "simetra/model"

/*
 * Адаптер рядка бази до форми передачі (спека П4-B §4.4): значення декодує
 * `decodeRow` T0, той самий, що й у клієнта, тож сервер і клієнт не
 * розходяться в семантиці. Тут лише те, чим рядок бази відрізняється від
 * дроту: ТЧ за `table.name` замість id ТЧ і цілі, які `jsonb` дає числом.
 */

const internal = () => new CommandFailure({ code: "command.internal" })

/** Parses the JSON text of a result column; broken text is `command.internal`. */
export function parse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown
  } catch {
    throw internal()
  }
}

/** Ціле, яке `jsonb` дав числом, — рядком цілого, як його чекає дріт. */
const integerText = (value: unknown): unknown =>
  typeof value === "number" ? String(value) : value

function headWire(object: RuntimeObject, row: unknown): Map<string, unknown> {
  if (!isPlainObject(row)) throw internal()
  const wire = new Map(Object.entries(row))
  if (Object.hasOwn(row, object.versionColumn)) {
    wire.set(object.versionColumn, integerText(row[object.versionColumn]))
  }
  return wire
}

/**
 * Database lines of a tabular section in wire form: the line number as
 * integer text. A value of the wrong form passes through for `decodeRow` to
 * refuse.
 */
export function linesWire(section: RuntimeSection, lines: unknown): unknown {
  if (!Array.isArray(lines)) return lines
  return lines.map((line: unknown) =>
    isPlainObject(line) && Object.hasOwn(line, section.lineNumber)
      ? Object.fromEntries(
          new Map(Object.entries(line)).set(
            section.lineNumber,
            integerText(line[section.lineNumber])
          )
        )
      : line
  )
}

function decodeStrict(object: RuntimeObject, wire: WireRow): LogicalRow {
  try {
    return decodeRow(object, wire, { strict: true })
  } catch (error) {
    // Рядок бази не відповідає каталогу — дефект, а не помилка входу.
    if (error instanceof WireDecodeError) throw internal()
    throw error
  }
}

/**
 * Decodes a parsed core row (`to_jsonb(row) || <numeric/bigint as text>`,
 * sections under `tabular[<table.name>]`) into a runtime row; its sections
 * go to `tabularSections`, as in a read card. A row that does not match the
 * catalog is `command.internal`.
 */
export function decodeCoreRow(object: RuntimeObject, row: unknown): LogicalRow {
  const wire = headWire(object, row)
  const tabular = wire.get("tabular")
  if (isPlainObject(tabular)) {
    wire.delete("tabular")
    const sections = new Map<string, unknown>()
    for (const section of object.tabularSections) {
      if (!Object.hasOwn(tabular, section.table.name)) continue
      sections.set(section.id, linesWire(section, tabular[section.table.name]))
    }
    wire.set("tabularSections", Object.fromEntries(sections))
  }
  return decodeStrict(object, Object.fromEntries(wire))
}

/**
 * Decodes a read row: the head from the `row` column and, when the read asks
 * for them, sections already in wire form by section id. A key `tabular` of
 * the head is not sections: read sections come in a separate column (P4-B
 * spec §4.2).
 */
export function decodeReadRow(
  object: RuntimeObject,
  json: string,
  sections?: Record<string, unknown>
): LogicalRow {
  const wire = headWire(object, parse(json))
  if (sections !== undefined) wire.set("tabularSections", sections)
  return decodeStrict(object, Object.fromEntries(wire))
}

/**
 * Decodes a read row that may be a marker of a row the client holds (P4-B
 * spec §4.1) by the T0 rule `splitKnownMarker`: a marker's copies decode by
 * logical name; anything else is a row, as {@link decodeReadRow}.
 * `known` — the number of positions of the statement's `known`, 0 when it
 * had none: a position outside it is `command.internal`.
 */
export function decodeReadRowOrMarker(
  object: RuntimeObject,
  json: string,
  known: number
): LogicalRow | KnownMarker {
  const raw = parse(json)
  // Маркер шле лише умовний оператор і лише з позицією з `unnest` — інше
  // значення є дефектом, а не рядком.
  const position = (value: unknown): number => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value >= known
    ) {
      throw internal()
    }
    return value
  }
  const marker = splitKnownMarker(object.key, raw)
  if (marker === undefined) {
    return decodeStrict(object, Object.fromEntries(headWire(object, raw)))
  }
  const at = position(marker.known)
  return Object.keys(marker.copies).length === 0
    ? { known: at }
    : { known: at, copies: decodeStrict(object, marker.copies) }
}

/**
 * An owner version for the client: a safe integer from integer text or a
 * `jsonb` number, else `command.internal`.
 */
export function decodeSafeInteger(value: unknown): number {
  const text = integerText(value)
  const number =
    typeof text === "string" && INTEGER_TEXT.test(text) ? Number(text) : NaN
  if (!Number.isSafeInteger(number)) throw internal()
  return number
}
