import type { CatalogEntry, CatalogEntryAttribute } from "./catalog"

/** Column lists of one table of a catalog object. */
export interface ColumnLists {
  insert: readonly string[]
  update: readonly string[]
  /** Columns a list read returns (lazy ones excluded). */
  read: readonly string[]
  /** Columns only a single-record read returns. */
  lazy: readonly string[]
}

/**
 * Column lists of one tabular section: the header lists without `update`.
 */
// Рядок ТЧ при кожній дії записується наново цілком (масив ТЧ переписує рядки),
// тож і сумісність, і кодування рядків звіряють його лише з переліком вставки.
export type SectionColumnLists = Omit<ColumnLists, "update">

/**
 * Column lists of a header and of each tabular section, keyed by section id.
 */
export interface ObjectColumns extends ColumnLists {
  tabularSections: ReadonlyMap<string, SectionColumnLists>
}

// Пара займає дві колонки: значення й тип цілі.
const columnsOf = (attribute: CatalogEntryAttribute): string[] =>
  attribute.pair === undefined
    ? [attribute.column]
    : [attribute.column, attribute.pair.typeColumn]

// Без дублів, порядок — перше входження: скоуп скоупленого довідника є й
// реквізитом, а в кореня `scopeColumn` дорівнює ключу.
const unique = (columns: readonly string[]): string[] => [...new Set(columns)]

const flat = (attributes: readonly CatalogEntryAttribute[]): string[] =>
  attributes.flatMap(columnsOf)

/**
 * Column lists of a catalog object, derived from the shared part alone, so the
 * server and the client agree on them (P4-B spec §3).
 */
export function objectColumns(entry: CatalogEntry): ObjectColumns {
  const { attributes } = entry
  const eager = attributes.filter((a) => a.load !== "lazy")
  return {
    insert: unique(flat(attributes.filter((a) => a.insert))),
    update: unique(flat(attributes.filter((a) => a.update))),
    read: unique([
      entry.key,
      entry.versionColumn,
      ...(entry.scopeColumn === undefined ? [] : [entry.scopeColumn]),
      ...flat(eager),
    ]),
    lazy: unique(
      attributes.filter((a) => a.load === "lazy").flatMap(columnsOf)
    ),
    tabularSections: new Map(
      entry.tabularSections.map((section) => [
        section.id,
        {
          // Рядок ТЧ в операції завжди несе ключ.
          insert: unique([
            section.key,
            ...flat(section.attributes.filter((a) => a.insert)),
          ]),
          read: unique([
            section.key,
            section.parent,
            section.lineNumber,
            ...flat(section.attributes),
          ]),
          lazy: [],
        },
      ])
    ),
  }
}
