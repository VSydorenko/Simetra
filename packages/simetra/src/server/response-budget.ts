import {
  jsonBytes,
  LIMIT_REASONS,
  objectColumns,
  RESPONSE_BUDGET_BYTES,
  type CatalogIndex,
  type CommandError,
  type Filter,
  type WireChange,
  type WireOperation,
  type WireReadQuery,
  type WireReadResult,
  type WireRow,
} from "simetra/model"

/**
 * Бюджет відповіді (спека П4-B §4.1, крок 6 §4.5, Рд26). Міряється вся
 * відповідь `DataResponse`, як її серіалізує обробник —
 * `{ ok: true, value, serverHash }`, — мірою `jsonBytes`. Розмір рахується
 * лінійно: база (відповідь без рядків і рядків `included`) — один раз, далі
 * кожен рядок — раз, з комами між елементами масиву.
 */

const TOO_LARGE: CommandError = {
  code: "command.invalid",
  reason: LIMIT_REASONS.responseTooLarge,
}

const responseBytes = (value: unknown, serverHash: string): number =>
  jsonBytes({ ok: true, value, serverHash })

/** Байти елементів масиву без дужок: самі елементи й коми між ними. */
const itemsBytes = (sizes: readonly number[]): number =>
  sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, sizes.length - 1)

type RowsResult = Extract<WireReadResult, { rows: unknown }>

/** `included` з тими самими ключами цілей, але без рядків. */
const emptyIncluded = (
  included: RowsResult["included"]
): RowsResult["included"] =>
  included === undefined
    ? undefined
    : Object.fromEntries(Object.keys(included).map((id) => [id, []]))

const hasKeyCondition = (filter: Filter, key: string): boolean => {
  if ("not" in filter) return hasKeyCondition(filter.not, key)
  if ("and" in filter) return filter.and.some((f) => hasKeyCondition(f, key))
  if ("or" in filter) return filter.or.some((f) => hasKeyCondition(f, key))
  return filter.attribute === key && (filter.op === "eq" || filter.op === "in")
}

type QueryShape = Partial<{
  object: string
  id: string
  owner: string
  limit: number
  tabularSection: string
  where: Filter
  include: string[]
}>

/**
 * Сторінка (рішення Р8): форма списку чи сторінки ТЧ (`limit`), фільтр якої
 * ніде в дереві не має `eq` чи `in` за ключем цілі. Fail-closed: умова за
 * ключем будь-де — читання за ключами, а його обрізаний префікс клієнт
 * прийняв би за відсутність рядків. Невідомий об'єкт чи ТЧ — теж не сторінка.
 */
function isPage(index: CatalogIndex, query: QueryShape): boolean {
  if (query.limit === undefined || "id" in query || "owner" in query) {
    return false
  }
  const entry = index.byId.get(query.object!)
  if (entry === undefined) return false
  const key =
    query.tabularSection === undefined
      ? entry.key
      : entry.tabularSections.find((s) => s.id === query.tabularSection)?.key
  if (key === undefined) return false
  return query.where === undefined || !hasKeyCondition(query.where, key)
}

/** Колонка `include` і рядки її цілі за значенням ключа. */
interface Reference {
  column: string
  target: string
  byKey: ReadonlyMap<unknown, readonly number[]>
}

function references(
  index: CatalogIndex,
  query: QueryShape,
  included: NonNullable<RowsResult["included"]>
): Reference[] {
  const entry = index.byId.get(query.object!)
  if (entry === undefined) return []
  const out: Reference[] = []
  for (const column of query.include ?? []) {
    const target = entry.attributes.find((a) => a.column === column)?.ref
      ?.object
    const targetEntry =
      target === undefined ? undefined : index.byId.get(target)
    if (
      target === undefined ||
      targetEntry === undefined ||
      !Object.hasOwn(included, target)
    ) {
      continue
    }
    const byKey = new Map<unknown, number[]>()
    included[target]!.forEach((row, i) => {
      const value = row[targetEntry.key]
      const list = byKey.get(value)
      if (list === undefined) byKey.set(value, [i])
      else list.push(i)
    })
    out.push({ column, target, byKey })
  }
  return out
}

/**
 * Fits a read result into the response budget (P4-B spec §4.1, decision Р8):
 * measures the whole `DataResponse` (`{ ok: true, value, serverHash }`).
 * A result that fits is returned as is. A page — a list or a section page
 * with no `eq` or `in` on the key anywhere in `where` — is cut to its longest
 * non-empty prefix that fits, with `more: true` and `included` rows only of
 * targets the kept rows reference. A key read, a card, the lines of an owner,
 * or a page whose first row does not fit is `command.invalid` with
 * `reason: "response-too-large"`, never cut.
 */
export function fitResponse(
  index: CatalogIndex,
  query: WireReadQuery,
  result: WireReadResult,
  serverHash: string
): WireReadResult | CommandError {
  if ("count" in result) return result
  const rowSizes = result.rows.map((row) => jsonBytes(row))
  const includedSizes = new Map(
    Object.entries(result.included ?? {}).map(([id, rows]) => [
      id,
      rows.map((row) => jsonBytes(row)),
    ])
  )
  const empty = {
    ...result,
    rows: [],
    included: emptyIncluded(result.included),
  }
  const full =
    responseBytes(empty, serverHash) +
    itemsBytes(rowSizes) +
    [...includedSizes.values()].reduce((sum, s) => sum + itemsBytes(s), 0)
  if (full <= RESPONSE_BUDGET_BYTES) return result
  const shape = query as QueryShape
  if (!isPage(index, shape)) return TOO_LARGE
  return cutPage(index, shape, result, rowSizes, includedSizes, serverHash)
}

function cutPage(
  index: CatalogIndex,
  query: QueryShape,
  result: RowsResult,
  rowSizes: readonly number[],
  includedSizes: ReadonlyMap<string, readonly number[]>,
  serverHash: string
): WireReadResult | CommandError {
  const included = result.included ?? {}
  const refs = references(index, query, included)
  // База — з `more`: обрізана відповідь його несе, і саме це поле може
  // перетнути межу.
  let total = responseBytes(
    {
      ...result,
      rows: [],
      included: emptyIncluded(result.included),
      more: true,
    },
    serverHash
  )
  const taken = new Map<string, Set<number>>()
  let kept = 0
  for (const [i, row] of result.rows.entries()) {
    let cost = rowSizes[i]! + (i > 0 ? 1 : 0)
    const pending = new Map<string, Set<number>>()
    for (const { column, target, byKey } of refs) {
      if (!Object.hasOwn(row, column)) continue
      const done = taken.get(target)
      const fresh = pending.get(target) ?? new Set<number>()
      for (const j of byKey.get(row[column]) ?? []) {
        if (done?.has(j) === true || fresh.has(j)) continue
        // Кома — коли в масиві цілі вже є рядок, лишений чи щойно доданий.
        const before = (done?.size ?? 0) + fresh.size
        cost += includedSizes.get(target)![j]! + (before > 0 ? 1 : 0)
        fresh.add(j)
      }
      pending.set(target, fresh)
    }
    if (total + cost > RESPONSE_BUDGET_BYTES) break
    total += cost
    kept++
    for (const [target, fresh] of pending) {
      const done = taken.get(target) ?? new Set<number>()
      for (const j of fresh) done.add(j)
      taken.set(target, done)
    }
  }
  if (kept === 0) return TOO_LARGE
  const out: RowsResult = { ...result, rows: result.rows.slice(0, kept) }
  if (result.included !== undefined) {
    out.included = Object.fromEntries(
      Object.entries(included).map(([id, rows]) => [
        id,
        rows.filter((_, j) => taken.get(id)?.has(j) === true),
      ])
    )
  }
  out.more = true
  return out
}

/** The value of a `run` response in wire form. */
export interface WireRunResult {
  rows?: WireRow[]
  changes: WireChange[]
}

// Ключ ТЧ закодованого рядка (`encodeRow`): рядок `run` їх не несе (Рд27).
const SECTIONS = "tabularSections"

/**
 * Fits a `run` result into the response budget (P4-B spec §4.5 step 6):
 * rows lose their lazy columns and tabular sections; if the whole
 * `DataResponse` still exceeds the budget, the result goes without `rows`
 * and the client rereads by key. Row `i` belongs to `operations[i]`
 * (`CommandResult.rows` — one row per input operation, in input order).
 *
 * `changes` never exceed the budget: there are at most `BATCH_MAX` batch
 * phases plus `BATCH_MAX` `ctx.run` phases, each a fixed set of short
 * fields, so they are always sent whole.
 *
 * Throws when the row count differs from the operation count or a row's
 * object is outside the catalog — a server defect the handler reports as
 * `command.internal`.
 */
export function fitRunResult(
  index: CatalogIndex,
  operations: readonly WireOperation[],
  result: { rows: WireRow[]; changes: WireChange[] },
  serverHash: string
): WireRunResult {
  if (result.rows.length !== operations.length) {
    throw new Error("run result rows do not match the operations")
  }
  const lazy = new Map<string, ReadonlySet<string>>()
  const lazyOf = (object: string): ReadonlySet<string> => {
    const known = lazy.get(object)
    if (known !== undefined) return known
    const entry = index.byId.get(object)
    if (entry === undefined) {
      throw new Error("run result row of an object outside the catalog")
    }
    const columns = new Set(objectColumns(entry).lazy)
    lazy.set(object, columns)
    return columns
  }
  const rows = result.rows.map((row, i) => {
    const skip = lazyOf(operations[i]!.object)
    return Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== SECTIONS && !skip.has(key))
    )
  })
  const value = { rows, changes: result.changes }
  return responseBytes(value, serverHash) <= RESPONSE_BUDGET_BYTES
    ? value
    : { changes: result.changes }
}
