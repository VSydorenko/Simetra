import type { MetadataRef } from "../schemas/metadata-ref"
import type {
  CatalogEntry,
  CatalogEntryAttribute,
  CatalogEntrySection,
} from "./catalog"
import type { WireChange, WireCommandError, WireOperation } from "./envelope"
import type { CommandError } from "./errors"
import type { Operation } from "./operation"
import { pathFromWire, pathToWire } from "./path"
import type { Change } from "./result"
import { encodeItemValue, isPlainObject } from "./values"

/**
 * Мапінг «логічне ↔ фізичне» операції, помилки й набору змін (спека П4-B
 * §4.0). Типізований над спільною частиною запису, тож сервер мапить
 * каталогом рантайму, а T4 — клієнтським, тим самим кодом.
 *
 * Імена з даних не стають ключами напряму: вихід збирається через `Map` →
 * `Object.fromEntries`, а ім'я шукається перебором каталогу, тож `__proto__`
 * чи `constructor` — невідоме ім'я, а не зміна прототипу.
 */

/** Catalog entries by UUID and by `{ kind, name }`. */
export interface CatalogIndex {
  readonly byId: ReadonlyMap<string, CatalogEntry>
  readonly byRef: ReadonlyMap<string, CatalogEntry>
}

// Вид — закритий перелік без крапки, тож ключ однозначний.
const refKey = (ref: MetadataRef) => `${ref.kind}.${ref.name}`

/** Indexes catalog entries (runtime or client) for the mapping functions. */
export function catalogIndex(objects: readonly CatalogEntry[]): CatalogIndex {
  return {
    byId: new Map(objects.map((o) => [o.id, o])),
    byRef: new Map(objects.map((o) => [refKey(o), o])),
  }
}

/**
 * A name outside the catalog: `object` is the object's UUID (or the
 * request's identifier of an unknown object), `section` the section id,
 * `column` a physical and `name` a logical name.
 */
export interface MappedUnknown {
  object: string
  section?: string
  column?: string
  name?: string
}

/**
 * The outcome of a mapping: the mapped value, a name outside the catalog
 * (`unknown` — an input defect of T4 or, on the server after the
 * compatibility check, a server defect), or an input the mapping itself
 * refuses (`invalid`, with the logical path).
 */
export type Mapped<T> =
  | { ok: true; value: T }
  | { ok: false; unknown: MappedUnknown }
  | { ok: false; invalid: CommandError }

type Refused = Exclude<Mapped<never>, { ok: true }>

/**
 * Відмова зсередини обходу: так перша відмова зупиняє весь обхід без
 * перевірок після кожного рівня. Назовні не виходить — її ловить `mapped`.
 */
class Refusal {
  constructor(readonly result: Refused) {}
}

const refuseUnknown = (unknown: MappedUnknown): never => {
  throw new Refusal({ ok: false, unknown })
}

const refuseInvalid = (path: string): never => {
  throw new Refusal({
    ok: false,
    invalid: { code: "command.invalid", path },
  })
}

function mapped<T>(run: () => T): Mapped<T> {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    if (error instanceof Refusal) return error.result
    throw error
  }
}

const own = (record: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(record, key)

type Row = Record<string, unknown>

/** Поле без перекладу значення: ключ, версія, власник і номер рядка ТЧ. */
type Plain = { name: string; column: string }

/** Набір полів одного рівня: шапка, рядок ТЧ чи `creatorMember`. */
interface Level {
  plain: readonly Plain[]
  attributes: readonly CatalogEntryAttribute[]
  /** Логічний префікс шляху відмови `invalid`. */
  prefix: string
  /** Де шукалося ім'я — для `unknown`. */
  where: { object: string; section?: string }
}

const headerPlain = (entry: CatalogEntry): Plain[] => [
  { name: entry.keyName, column: entry.key },
  { name: entry.versionName, column: entry.versionColumn },
]

const linePlain = (section: CatalogEntrySection): Plain[] => [
  { name: section.keyName, column: section.key },
  { name: section.parentName, column: section.parent },
  { name: section.lineNumberName, column: section.lineNumber },
]

const MEMBER = "creatorMember"

// ---------------------------------------------------------------- to wire

function levelToWire(level: Level, record: unknown, path: string): Row {
  if (!isPlainObject(record)) return refuseInvalid(path)
  const { plain, attributes, prefix, where } = level
  // Спершу невідомі імена: це дефект T4, і він важливіший за значення.
  for (const key of Object.keys(record)) {
    if (
      !plain.some((f) => f.name === key) &&
      !attributes.some((a) => a.name === key)
    ) {
      refuseUnknown({ ...where, name: key })
    }
  }
  const out = new Map<string, unknown>()
  for (const field of plain) {
    if (own(record, field.name)) out.set(field.column, record[field.name])
  }
  for (const attribute of attributes) {
    // Відсутнє лишається відсутнім (В9): ядро лишає старе значення.
    if (!own(record, attribute.name)) continue
    const encoded = encodeItemValue(
      attribute,
      record[attribute.name],
      `${prefix}${attribute.name}`
    )
    if ("error" in encoded)
      throw new Refusal({ ok: false, invalid: encoded.error })
    if (attribute.pair !== undefined) {
      const columns = encoded.value as Row
      const { typeColumn } = attribute.pair
      out.set(typeColumn, columns[typeColumn])
      out.set(attribute.column, columns[attribute.column])
    } else {
      out.set(attribute.column, encoded.value)
    }
  }
  return Object.fromEntries(out)
}

function sectionsToWire(entry: CatalogEntry, sections: unknown): Row {
  if (!isPlainObject(sections)) return refuseInvalid("tabularSections")
  const out = new Map<string, unknown>()
  for (const name of Object.keys(sections)) {
    const section = entry.tabularSections.find((s) => s.name === name)
    if (section === undefined) return refuseUnknown({ object: entry.id, name })
    const lines = sections[name]
    if (!Array.isArray(lines)) return refuseInvalid(name)
    out.set(
      section.id,
      lines.map((line: unknown, i) =>
        levelToWire(
          {
            plain: linePlain(section),
            attributes: section.attributes,
            prefix: `${name}.${i}.`,
            where: { object: entry.id, section: section.id },
          },
          line,
          `${name}.${i}`
        )
      )
    )
  }
  return Object.fromEntries(out)
}

/** Довідник членства кореня з творцем; без нього `creatorMember` — відмова. */
function membershipOf(index: CatalogIndex, entry: CatalogEntry): CatalogEntry {
  if (entry.creatorMembership === undefined) return refuseInvalid(MEMBER)
  return (
    index.byId.get(entry.creatorMembership) ??
    refuseUnknown({ object: entry.creatorMembership })
  )
}

const memberLevel = (membership: CatalogEntry): Level => ({
  plain: headerPlain(membership),
  attributes: membership.attributes,
  prefix: `${MEMBER}.`,
  where: { object: membership.id },
})

/**
 * Maps a logical operation to its wire form (T4): the object becomes its
 * UUID, names become physical columns and section ids, values go through
 * `encodeItemValue` (a pair becomes two columns, an enumeration its label).
 * A name outside the catalog is `unknown`; a value `encodeItemValue`
 * refuses is `invalid` with the logical path. A field absent from the input
 * stays absent.
 */
export function operationToWire(
  index: CatalogIndex,
  op: Operation
): Mapped<WireOperation> {
  return mapped(() => {
    const entry =
      index.byRef.get(refKey(op.object)) ??
      refuseUnknown({ object: refKey(op.object) })
    const out: Row = { ...op, object: entry.id }
    if ("values" in op && op.values !== undefined) {
      out.values = levelToWire(
        {
          plain: headerPlain(entry),
          attributes: entry.attributes,
          prefix: "",
          where: { object: entry.id },
        },
        op.values,
        "values"
      )
    }
    if ("tabularSections" in op && op.tabularSections !== undefined) {
      out.tabularSections = sectionsToWire(entry, op.tabularSections)
    }
    if ("creatorMember" in op && op.creatorMember !== undefined) {
      const membership = membershipOf(index, entry)
      out.creatorMember = levelToWire(
        memberLevel(membership),
        op.creatorMember,
        MEMBER
      )
    }
    return out as WireOperation
  })
}

// -------------------------------------------------------------- from wire

/**
 * Мітка перерахування → логічне ім'я, суворо: невідома мітка (зокрема ім'я
 * замість мітки) — `invalid`, бо інакше `runtime.run` прийняв би ім'я, яке
 * клієнт помилково надіслав без перекладу.
 */
function enumFromWire(
  attribute: CatalogEntryAttribute,
  value: unknown,
  path: string
): unknown {
  const one = (item: unknown, at: string): unknown => {
    if (item === null) return null
    const name =
      typeof item === "string"
        ? attribute.enumValues?.find((v) => v.label === item)?.name
        : undefined
    return name ?? refuseInvalid(at)
  }
  if (attribute.array !== true) return one(value, path)
  if (value === null) return null
  if (!Array.isArray(value)) return refuseInvalid(path)
  return value.map((item: unknown, i) => one(item, `${path}.${i}`))
}

/** Пара з двох колонок → `{ type, id }`; id перевіряє вже `runtime.run`. */
function pairFromWire(
  attribute: CatalogEntryAttribute,
  record: Row,
  path: string
): unknown {
  const { typeColumn, targets } = attribute.pair!
  const label = record[typeColumn]
  const id = record[attribute.column]
  const both = own(record, typeColumn) && own(record, attribute.column)
  if (both && label === null && id === null) return null
  const target =
    both && typeof label === "string"
      ? targets.find((t) => t.label === label)
      : undefined
  if (target === undefined) return refuseInvalid(path)
  return { type: `${target.object.kind}.${target.object.name}`, id }
}

function levelFromWire(level: Level, record: unknown, path: string): Row {
  if (!isPlainObject(record)) return refuseInvalid(path)
  const { plain, attributes, prefix, where } = level
  for (const key of Object.keys(record)) {
    if (
      !plain.some((f) => f.column === key) &&
      !attributes.some((a) => a.column === key || a.pair?.typeColumn === key)
    ) {
      refuseUnknown({ ...where, column: key })
    }
  }
  const out = new Map<string, unknown>()
  for (const field of plain) {
    if (own(record, field.column)) out.set(field.name, record[field.column])
  }
  for (const attribute of attributes) {
    const at = `${prefix}${attribute.name}`
    if (attribute.pair !== undefined) {
      if (
        own(record, attribute.pair.typeColumn) ||
        own(record, attribute.column)
      ) {
        out.set(attribute.name, pairFromWire(attribute, record, at))
      }
      continue
    }
    // Відсутнє лишається відсутнім (В9).
    if (!own(record, attribute.column)) continue
    const value = record[attribute.column]
    // Решту значень (`BigInt` текстом, `Numeric`, дати, `Json`, `Raw`)
    // перевіряє `runtime.run`: друга перевірка тут розійшлася б з нею.
    out.set(
      attribute.name,
      attribute.enumValues === undefined
        ? value
        : enumFromWire(attribute, value, at)
    )
  }
  return Object.fromEntries(out)
}

function sectionsFromWire(entry: CatalogEntry, sections: unknown): Row {
  if (!isPlainObject(sections)) return refuseInvalid("tabularSections")
  const out = new Map<string, unknown>()
  for (const id of Object.keys(sections)) {
    const section = entry.tabularSections.find((s) => s.id === id)
    if (section === undefined) {
      return refuseUnknown({ object: entry.id, section: id })
    }
    const lines = sections[id]
    if (!Array.isArray(lines)) return refuseInvalid(section.name)
    out.set(
      section.name,
      lines.map((line: unknown, i) =>
        levelFromWire(
          {
            plain: linePlain(section),
            attributes: section.attributes,
            prefix: `${section.name}.${i}.`,
            where: { object: entry.id, section: section.id },
          },
          line,
          `${section.name}.${i}`
        )
      )
    )
  }
  return Object.fromEntries(out)
}

/**
 * Maps a wire operation to its logical form (server). An unknown object,
 * section id or physical column is `unknown`, never ignored. Enumeration
 * labels and pairs are translated strictly: an unknown label is `invalid`
 * with the logical path. Other values pass as they are, for `runtime.run`
 * to validate. A field absent from the input stays absent. Never throws.
 */
export function operationFromWire(
  index: CatalogIndex,
  wire: WireOperation
): Mapped<Operation> {
  return mapped(() => {
    const entry =
      index.byId.get(wire.object) ?? refuseUnknown({ object: wire.object })
    const out: Row = {
      ...wire,
      object: { kind: entry.kind, name: entry.name },
    }
    if ("values" in wire && wire.values !== undefined) {
      out.values = levelFromWire(
        {
          plain: headerPlain(entry),
          attributes: entry.attributes,
          prefix: "",
          where: { object: entry.id },
        },
        wire.values,
        "values"
      )
    }
    if ("tabularSections" in wire && wire.tabularSections !== undefined) {
      out.tabularSections = sectionsFromWire(entry, wire.tabularSections)
    }
    if ("creatorMember" in wire && wire.creatorMember !== undefined) {
      const membership = membershipOf(index, entry)
      out.creatorMember = levelFromWire(
        memberLevel(membership),
        wire.creatorMember,
        MEMBER
      )
    }
    return out as Operation
  })
}

// ------------------------------------------------------- errors, changes

/**
 * Maps a command error to its wire form: `object` becomes its UUID, `path`
 * and `attributes` map through that object's entry. Without a known
 * `object`, `path` and `attributes` stay unchanged (the server sets `object`
 * on every error with either).
 */
export function errorToWire(
  index: CatalogIndex,
  error: CommandError
): WireCommandError {
  const { object, path, attributes, ...rest } = error
  const entry =
    object === undefined ? undefined : index.byRef.get(refKey(object))
  const map = (p: string) =>
    entry === undefined ? p : pathToWire(index, entry.id, p)
  return {
    ...rest,
    ...(entry === undefined ? {} : { object: entry.id }),
    ...(path === undefined ? {} : { path: map(path) }),
    ...(attributes === undefined ? {} : { attributes: attributes.map(map) }),
  }
}

/** The inverse of {@link errorToWire}. */
export function errorFromWire(
  index: CatalogIndex,
  error: WireCommandError
): CommandError {
  const { object, path, attributes, ...rest } = error
  const entry = object === undefined ? undefined : index.byId.get(object)
  const map = (p: string) =>
    entry === undefined ? p : pathFromWire(index, entry.id, p)
  return {
    ...rest,
    ...(entry === undefined
      ? {}
      : { object: { kind: entry.kind, name: entry.name } }),
    ...(path === undefined ? {} : { path: map(path) }),
    ...(attributes === undefined ? {} : { attributes: attributes.map(map) }),
  }
}

/** Maps the object of every change to its UUID; the rest is unchanged. */
export function changesToWire(
  index: CatalogIndex,
  changes: readonly Change[]
): Mapped<WireChange[]> {
  return mapped(() =>
    changes.map((change) => {
      const entry =
        index.byRef.get(refKey(change.object)) ??
        refuseUnknown({ object: refKey(change.object) })
      return { ...change, object: entry.id }
    })
  )
}

/** Maps the object UUID of every change to its reference. */
export function changesFromWire(
  index: CatalogIndex,
  changes: readonly WireChange[]
): Mapped<Change[]> {
  return mapped(() =>
    changes.map((change) => {
      const entry =
        index.byId.get(change.object) ??
        refuseUnknown({ object: change.object })
      return { ...change, object: { kind: entry.kind, name: entry.name } }
    })
  )
}
