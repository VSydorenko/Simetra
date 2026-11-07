import {
  objectColumns,
  type CatalogEntryAttribute,
  type ColumnLists,
  type DataRequest,
  type Filter,
  type ObjectColumns,
  type RuntimeCatalog,
  type RuntimeObject,
  type WireCommandError,
  type WireOperation,
  type WireReadQuery,
} from "simetra/model"

type Request = DataRequest["request"]
type RunRequest = Extract<Request, { type: "run" }>

/**
 * Звірка сумісності (спека П4-B §10, крок 3 обробника §4.5): запит форми
 * передачі проти каталогу сервера до перекладу й до бази.
 *
 * Результат — помилка форми передачі, а не `CommandError`: невідомий UUID
 * об'єкта не має `MetadataRef`, а клієнту потрібен саме UUID із запиту для
 * `onStaleClient(object)`. Обробник віддає її як є.
 *
 * Звірка суворіша за мапінг або рівна йому: що вона пропускає, мапінг уже не
 * назве `unknown` (там це дефект сервера, `command.internal`).
 *
 * `__proto__` у `values`, рядках ТЧ чи `creatorMember` сюди не доходить:
 * `z.record` Zod викидає цей ключ під час розбору конверта, тож звірка й
 * мапінг (`model/runtime/mapping.ts`) бачать той самий розібраний вхід —
 * ключ ігнорується розбором в обох місцях.
 */

const stale = (object: string): WireCommandError => ({
  code: "command.stale-client",
  object,
})

/** Колонки, які перевіряє звірка; набори — для лінійного пошуку. */
interface Contract {
  entry: RuntimeObject
  columns: ObjectColumns
}

class Catalog {
  private readonly byId: ReadonlyMap<string, RuntimeObject>
  private readonly contracts = new Map<string, Contract>()

  constructor(catalog: RuntimeCatalog) {
    this.byId = new Map(catalog.objects.map((o) => [o.id, o]))
  }

  contract(id: string): Contract | undefined {
    const known = this.contracts.get(id)
    if (known !== undefined) return known
    const entry = this.byId.get(id)
    if (entry === undefined) return undefined
    const contract = { entry, columns: objectColumns(entry) }
    this.contracts.set(id, contract)
    return contract
  }
}

/** Чи всі ключі запису — у дозволеному наборі; ключі — лише власні. */
const within = (record: object, allowed: ReadonlySet<string>): boolean =>
  Object.keys(record).every((key) => allowed.has(key))

/**
 * Checks a request in wire form against the server catalog before mapping
 * (P4-B spec §10): an unknown object UUID; for `run` — a missing or
 * different `kernelHash` of any operation's object, a column outside the
 * insert or update list of the action, an unknown section id; for `read` — a
 * filter, sort or `include` column outside the regular and lazy read lists
 * (pair type columns excluded: a read never names them), an unknown section
 * id. Returns `command.stale-client` with the request's object UUID, or
 * `undefined` when compatible; one incompatible operation refuses the whole
 * batch. Never throws on hostile names.
 */
export function checkCompatibility(
  catalog: RuntimeCatalog,
  request: Request
): WireCommandError | undefined {
  const contracts = new Catalog(catalog)
  if (request.type === "version") return undefined
  if (request.type === "read") return checkRead(contracts, request.query)
  return checkRun(contracts, request)
}

// ------------------------------------------------------------------- run

function checkRun(
  contracts: Catalog,
  request: RunRequest
): WireCommandError | undefined {
  const operations =
    request.batch ??
    (request.operation === undefined ? [] : [request.operation])
  const { kernels } = request
  for (const op of operations) {
    const contract = contracts.contract(op.object)
    if (contract === undefined) return stale(op.object)
    const hash =
      kernels !== undefined && Object.hasOwn(kernels, op.object)
        ? kernels[op.object]
        : undefined
    if (hash !== contract.entry.kernelHash) return stale(op.object)
    if (!operationFits(contracts, contract, op)) return stale(op.object)
  }
  return undefined
}

function operationFits(
  contracts: Catalog,
  { entry, columns }: Contract,
  op: WireOperation
): boolean {
  if (op.action !== "create" && op.action !== "update") return true
  const header = new Set(
    op.action === "create" ? columns.insert : columns.update
  )
  if (op.values !== undefined && !within(op.values, header)) return false
  if (op.tabularSections !== undefined) {
    for (const id of Object.keys(op.tabularSections)) {
      const section = columns.tabularSections.get(id)
      if (section === undefined) return false
      // Рядок ТЧ на будь-якій дії записується заново цілком, і T3 звіряє його
      // з ключами вставки (`encodeRows` у `values.ts`): той самий набір тут,
      // інакше звірка відхилила б рядок, який сервер приймає.
      const allowed = new Set(section.insert)
      if (!op.tabularSections[id]!.every((line) => within(line, allowed))) {
        return false
      }
    }
  }
  if (op.action === "create" && op.creatorMember !== undefined) {
    // Без довідника членства `creatorMember` відхиляє мапінг як `invalid` —
    // це вада входу, а не застарілий клієнт.
    if (entry.creatorMembership === undefined) return true
    const membership = contracts.contract(entry.creatorMembership)
    if (membership === undefined) return false
    if (!within(op.creatorMember, new Set(membership.columns.insert))) {
      return false
    }
  }
  return true
}

// ------------------------------------------------------------------ read

type QueryShape = Partial<{
  object: string
  tabularSection: string
  tabularSections: true | string[]
  where: Filter
  orderBy: { attribute: string }[]
  include: string[]
}>

// Колонка мітки пари є в переліку читання (рядок її несе), але запит її не
// називає: мапінг читання адресує пару її `column`. Без цього вирахування
// звірка пропустила б колонку, яку мапінг назве `unknown`.
const addressable = (
  lists: ColumnLists,
  attributes: readonly CatalogEntryAttribute[]
): ReadonlySet<string> => {
  const typeColumns = new Set(
    attributes.flatMap((a) => (a.pair === undefined ? [] : [a.pair.typeColumn]))
  )
  return new Set(
    [...lists.read, ...lists.lazy].filter((c) => !typeColumns.has(c))
  )
}

function filterColumns(filter: Filter, out: string[]): string[] {
  if ("not" in filter) return filterColumns(filter.not, out)
  if ("and" in filter) {
    for (const f of filter.and) filterColumns(f, out)
    return out
  }
  if ("or" in filter) {
    for (const f of filter.or) filterColumns(f, out)
    return out
  }
  out.push(filter.attribute)
  return out
}

function checkRead(
  contracts: Catalog,
  wire: WireReadQuery
): WireCommandError | undefined {
  const query = wire as QueryShape
  const object = query.object!
  const contract = contracts.contract(object)
  if (contract === undefined) return stale(object)
  const { entry, columns } = contract
  const header = addressable(columns, entry.attributes)
  let target = header
  if (query.tabularSection !== undefined) {
    const lists = columns.tabularSections.get(query.tabularSection)
    const section = entry.tabularSections.find(
      (s) => s.id === query.tabularSection
    )
    if (lists === undefined || section === undefined) return stale(object)
    target = addressable(lists, section.attributes)
  }
  if (
    Array.isArray(query.tabularSections) &&
    !query.tabularSections.every((id) => columns.tabularSections.has(id))
  ) {
    return stale(object)
  }
  const named = [
    ...(query.where === undefined ? [] : filterColumns(query.where, [])),
    ...(query.orderBy ?? []).map((item) => item.attribute),
  ]
  if (!named.every((column) => target.has(column))) return stale(object)
  // `include` є лише в картці й списку об'єкта: ціль — шапка.
  if (!(query.include ?? []).every((column) => header.has(column))) {
    return stale(object)
  }
  return undefined
}
