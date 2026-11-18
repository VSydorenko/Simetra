import type { CatalogEntry, CatalogEntryAttribute } from "simetra/model"

/** A column of a list or a field of a card: the catalog attribute and its title. */
export interface FieldColumn {
  /** Логічне ім'я реквізиту: ключ значень рядка. */
  name: string
  /** Заголовок — логічне ім'я (спека П4-D §5.1). */
  title: string
  attribute: CatalogEntryAttribute
}

/**
 * Службова колонка — не реквізит для людини: ключ, версія, колонка скоупу й
 * колонка-мітка пари (`typeColumn`). Ключ і версія в `attributes` каталогу вже
 * не трапляються, але фільтр їх називає, щоб форма каталогу не вирішувала, що
 * показувати; колонка скоупу в скоупленого довідника є й реквізитом.
 */
function serviceColumns(entry: CatalogEntry): ReadonlySet<string> {
  return new Set([
    entry.key,
    entry.versionColumn,
    ...(entry.scopeColumn === undefined ? [] : [entry.scopeColumn]),
    ...entry.attributes.flatMap((a) =>
      a.pair === undefined ? [] : [a.pair.typeColumn]
    ),
  ])
}

function columnsOf(
  entry: CatalogEntry,
  include: (attribute: CatalogEntryAttribute) => boolean
): FieldColumn[] {
  const service = serviceColumns(entry)
  return entry.attributes
    .filter((a) => include(a) && !service.has(a.column))
    .map((attribute) => ({
      name: attribute.name,
      title: attribute.name,
      attribute,
    }))
}

/** List columns: eager header attributes in catalog order, no service ones. */
export function headerColumns(entry: CatalogEntry): FieldColumn[] {
  return columnsOf(entry, (a) => a.load !== "lazy")
}

/** Card fields: like {@link headerColumns}, lazy attributes included. */
export function cardFields(entry: CatalogEntry): FieldColumn[] {
  return columnsOf(entry, () => true)
}
