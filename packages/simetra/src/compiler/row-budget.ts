import {
  RESPONSE_BUDGET_BYTES,
  jsonBytes,
  type CatalogEntryAttribute,
  type RuntimeCatalog,
  type RuntimeObject,
} from "simetra/model"
import type { SourceObject } from "./compile"
import { diagnostic, type Diagnostic } from "./diagnostics"

/**
 * A wire-row column the budget measures: a catalog attribute (a pair spans
 * its two columns) or a system column — the key or the parent key (`key`),
 * the version or the line number (`integerText`).
 */
export type BudgetColumn =
  CatalogEntryAttribute | { column: string; system: "key" | "integerText" }

/*
 * Верхні межі значень форми передачі в байтах `jsonBytes` (Р7): лапки рядка
 * враховано. Сталі, а не вимір прикладу: правило обіцяє межу для будь-якого
 * значення, яке `encodeRow` пропускає на дріт.
 */
/** `null` — найменше, що займає будь-яке значення колонки. */
const NULL_BYTES = 4
/** `"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`. */
const UUID_BYTES = 38
/** Ключ — UUID чи ціле рядком (`"-9223372036854775808"`, 22): більше — UUID. */
const KEY_BYTES = UUID_BYTES
/** Версія й номер рядка — безпечне ціле рядком: `"-9007199254740991"`. */
const INTEGER_TEXT_BYTES = 19
const SMALLINT_BYTES = 6 // -32768
const INTEGER_BYTES = 11 // -2147483648
/** `BigInt` іде рядком, щоб `jsonb` не округлив: `"-9223372036854775808"`. */
const BIGINT_BYTES = 22
const BOOLEAN_BYTES = 5 // false
/** `"YYYY-MM-DD"`: `isDate` пропускає лише чотири цифри року. */
const DATE_BYTES = 12
/**
 * `"YYYY-MM-DDTHH:MM:SS.ffffff+hh:mm:ss"`: база зберігає мікросекунди, а
 * найдовший зсув Postgres — з секундами.
 */
const DATE_TIME_BYTES = 37
/**
 * `Numeric` без точності — межа Postgres: 131 072 цифри до крапки й 16 383
 * після, плюс знак, крапка й лапки рядка.
 */
const NUMERIC_UNBOUNDED_BYTES = 131_072 + 16_383 + 2 + 2
/**
 * `Numeric(p, s)`: щонайбільше `p + 1` цифр (провідний нуль при `s = p`),
 * знак, крапка й лапки рядка.
 */
const NUMERIC_EXTRA_BYTES = 5
/**
 * `String(n)`: найгірша кодова точка — керівний символ, який `JSON.stringify`
 * екранує як `\u00XX` (6 байтів; інші кодові точки — до 4 байтів UTF-8), плюс
 * лапки.
 */
const STRING_BYTES_PER_CHAR = 6
/** `{` і `}` об'єкта рядка. */
const ROW_BRACES = 2

const labelsBytes = (labels: readonly string[]): number =>
  Math.max(NULL_BYTES, ...labels.map((label) => jsonBytes(label)))

/** Верхня межа одного значення колонки атрибута. */
function valueBytes(attribute: CatalogEntryAttribute): number {
  // Масив, `Text`, `Json` і `Bytes` межі типу не мають: її дає ефективне
  // `maxBytes` каталогу, тією самою мірою, якою його перевіряє вхід команди.
  if (attribute.maxBytes !== undefined) {
    return Math.max(NULL_BYTES, attribute.maxBytes)
  }
  switch (attribute.type) {
    case "UUID":
    case "Ref":
      return attribute.enumValues === undefined
        ? UUID_BYTES
        : labelsBytes(attribute.enumValues.map((v) => v.label))
    // Копію носія прав пише платформа, і вона — UUID: правило не рахує `Raw`
    // окремо й не обіцяє межі іншим сирим колонкам.
    case "Raw":
      return UUID_BYTES
    case "String":
      if (attribute.maxLength === undefined) {
        throw new Error(`internal: String ${attribute.name} has no maxLength`)
      }
      return STRING_BYTES_PER_CHAR * attribute.maxLength + 2
    case "Numeric":
      return attribute.precision === undefined
        ? NUMERIC_UNBOUNDED_BYTES
        : attribute.precision + NUMERIC_EXTRA_BYTES
    case "SmallInt":
      return SMALLINT_BYTES
    case "Integer":
      return INTEGER_BYTES
    case "BigInt":
      return BIGINT_BYTES
    case "Boolean":
      return BOOLEAN_BYTES
    case "Date":
      return DATE_BYTES
    case "DateTime":
      return DATE_TIME_BYTES
    case "Text":
    case "Json":
    case "Bytes":
      throw new Error(`internal: ${attribute.name} has no maxBytes`)
  }
}

/** Колонки форми передачі одного стовпця й межа значення кожної. */
function wireColumns(column: BudgetColumn): [string, number][] {
  if ("system" in column) {
    return [
      [column.column, column.system === "key" ? KEY_BYTES : INTEGER_TEXT_BYTES],
    ]
  }
  if (column.pair !== undefined) {
    return [
      [column.column, UUID_BYTES],
      [
        column.pair.typeColumn,
        labelsBytes(column.pair.targets.map((t) => t.label)),
      ],
    ]
  }
  return [[column.column, valueBytes(column)]]
}

/**
 * An upper bound of `jsonBytes` of a wire row with these columns (P4-B spec
 * Рд26): per column its quoted name, `:`, `,` and the bound of its value. A
 * column listed twice counts once, as the wire row has it once.
 */
export function rowBytesOf(columns: readonly BudgetColumn[]): number {
  // Скоуп скоупленого довідника — і реквізит, і колонка скоупу: рядок
  // форми передачі — об'єкт, тож колонка в ньому одна.
  const bounds = new Map<string, number>()
  for (const column of columns) {
    for (const [name, bytes] of wireColumns(column)) {
      bounds.set(name, Math.max(bytes, bounds.get(name) ?? 0))
    }
  }
  let total = ROW_BRACES
  for (const [name, bytes] of bounds) total += jsonBytes(name) + 2 + bytes
  return total
}

/** Звичайні колонки шапки — ті, що віддає списочне читання. */
function headerColumns(object: RuntimeObject): BudgetColumn[] {
  return [
    { column: object.key, system: "key" },
    { column: object.versionColumn, system: "integerText" },
    ...(object.scopeColumn === undefined
      ? []
      : [{ column: object.scopeColumn, system: "key" as const }]),
    ...object.attributes.filter((a) => a.load !== "lazy"),
  ]
}

/**
 * Бюджет рядка (спека П4-B Рд26): відповідь понад `RESPONSE_BUDGET_BYTES`
 * сторінка обрізає, а картка й рядок ТЧ — відмова, тож рядок списочної
 * форми чи рядок ТЧ, що сам може перевищити бюджет, ніколи б не дійшов до
 * клієнта — помилка. Ліниві поля йдуть лише карткою: їх сума понад бюджет —
 * попередження, бо картка з ними може не вміститися, а може й уміститися за
 * реальних значень.
 *
 * Біжить над каталогом рантайму, а не над файлами: межа рахується за формою
 * передачі (колонки пари, мітки перерахування, ефективне `maxBytes`), а її
 * знає лише проєкція моделі; і лише його об'єкти взагалі йдуть дротом.
 */
export function rowBudgetDiagnostics(
  catalog: RuntimeCatalog,
  objects: readonly SourceObject[]
): Diagnostic[] {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const diagnostics: Diagnostic[] = []
  for (const object of catalog.objects) {
    const source = byId.get(object.id)
    if (source === undefined) {
      throw new Error(`internal: catalog object ${object.name} has no source`)
    }
    const budget = String(RESPONSE_BUDGET_BYTES)
    const header = rowBytesOf(headerColumns(object))
    if (header > RESPONSE_BUDGET_BYTES) {
      diagnostics.push(
        diagnostic("attribute.row-over-budget", source.file, "", {
          row: object.name,
          bytes: String(header),
          budget,
        })
      )
    }
    const lazy = object.attributes.filter((a) => a.load === "lazy")
    const lazyBytes = rowBytesOf(lazy)
    if (lazy.length > 0 && lazyBytes > RESPONSE_BUDGET_BYTES) {
      diagnostics.push(
        diagnostic("attribute.lazy-over-budget", source.file, "", {
          object: object.name,
          bytes: String(lazyBytes),
          budget,
        })
      )
    }
    const { tabularSections: declared = [] } = source.data as {
      tabularSections?: { id?: string }[]
    }
    for (const section of object.tabularSections) {
      const bytes = rowBytesOf([
        { column: section.key, system: "key" },
        { column: section.parent, system: "key" },
        { column: section.lineNumber, system: "integerText" },
        ...section.attributes,
      ])
      if (bytes <= RESPONSE_BUDGET_BYTES) continue
      // Стандартна ТЧ у файлі не оголошена: вказівник — на сам об'єкт.
      const index = declared.findIndex((s) => s.id === section.id)
      diagnostics.push(
        diagnostic(
          "attribute.row-over-budget",
          source.file,
          index < 0 ? "" : `/tabularSections/${index}`,
          {
            row: `${object.name}.${section.name}`,
            bytes: String(bytes),
            budget,
          }
        )
      )
    }
  }
  return diagnostics
}
