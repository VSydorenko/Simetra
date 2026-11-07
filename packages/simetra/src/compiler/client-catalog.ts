import type {
  CatalogEntry,
  CatalogEntryAttribute,
  CatalogEntrySection,
  ClientCatalog,
  RuntimeAttribute,
  RuntimeCatalog,
  RuntimeObject,
  RuntimeSection,
} from "simetra/model"

// Необов'язкове поле лише тоді, коли воно є: відсутній ключ, а не `undefined`,
// тримає JSON і рівність записів однаковими.
const present = <K extends string, V>(
  key: K,
  value: V | undefined
): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>)

// Поля перелічено явно, а не відкинуто серверні: нове поле запису рантайму
// не потрапляє до клієнта, доки його не названо тут (рішення В7 B1b-1).
const attributeOf = (a: RuntimeAttribute): CatalogEntryAttribute => ({
  name: a.name,
  column: a.column,
  type: a.type,
  ...present("array", a.array),
  required: a.required,
  ...present("maxLength", a.maxLength),
  ...present("precision", a.precision),
  ...present("scale", a.scale),
  insert: a.insert,
  update: a.update,
  ...present("generated", a.generated),
  ...present("enumValues", a.enumValues),
  ...present("pair", a.pair),
  ...present("ref", a.ref),
  ...present("load", a.load),
})

const sectionOf = (s: RuntimeSection): CatalogEntrySection => ({
  id: s.id,
  name: s.name,
  table: s.table,
  key: s.key,
  keyName: s.keyName,
  parent: s.parent,
  parentName: s.parentName,
  lineNumber: s.lineNumber,
  lineNumberName: s.lineNumberName,
  parentConstraint: s.parentConstraint,
  attributes: s.attributes.map(attributeOf),
})

const entryOf = (o: RuntimeObject): CatalogEntry => ({
  id: o.id,
  name: o.name,
  kind: o.kind,
  kindLabel: o.kindLabel,
  table: o.table,
  key: o.key,
  keyName: o.keyName,
  versionColumn: o.versionColumn,
  versionName: o.versionName,
  ...present("scopeKindId", o.scopeKindId),
  ...present("scopeColumn", o.scopeColumn),
  ...present("creatorMembership", o.creatorMembership),
  kernelHash: o.kernelHash,
  signal: o.signal,
  attributes: o.attributes.map(attributeOf),
  tabularSections: o.tabularSections.map(sectionOf),
})

/**
 * The client catalog of a runtime catalog: each entry projected onto the
 * shared part, in the runtime order (P4-B spec §3).
 */
export function buildClientCatalog(runtime: RuntimeCatalog): ClientCatalog {
  return {
    format: runtime.format,
    snapshotHash: runtime.snapshotHash,
    provider: runtime.provider,
    objects: runtime.objects.map(entryOf),
  }
}
