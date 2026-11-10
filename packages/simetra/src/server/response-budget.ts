import {
  jsonBytes,
  LIMIT_REASONS,
  objectColumns,
  RESPONSE_BUDGET_BYTES,
  type CatalogIndex,
  type CommandError,
  type Filter,
  type WireChange,
  type WireCommandError,
  type WireOperation,
  type WireReadParts,
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

/** Розміри результату рядків: значення цілком, кожен рядок і рядок `included`. */
interface Measured {
  bytes: number
  rowSizes: readonly number[]
  includedSizes: ReadonlyMap<string, readonly number[]>
}

function measure(result: RowsResult): Measured {
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
  const bytes =
    jsonBytes(empty) +
    itemsBytes(rowSizes) +
    [...includedSizes.values()].reduce((sum, s) => sum + itemsBytes(s), 0)
  return { bytes, rowSizes, includedSizes }
}

/**
 * Результат, що вміщується в `room` байтів значення: сам результат, обрізана
 * сторінка (рішення Р8) чи `undefined`. Fail-closed: читання за ключами,
 * картка, «ТЧ власника» й сторінка без жодного рядка в межі не ріжуться.
 */
function fitValue(
  index: CatalogIndex,
  query: WireReadQuery,
  result: WireReadResult,
  room: number
): WireReadResult | undefined {
  if ("count" in result) return jsonBytes(result) <= room ? result : undefined
  const measured = measure(result)
  if (measured.bytes <= room) return result
  const shape = query as QueryShape
  if (!isPage(index, shape)) return undefined
  return cutPage(index, shape, result, measured, room)
}

function cutPage(
  index: CatalogIndex,
  query: QueryShape,
  result: RowsResult,
  { rowSizes, includedSizes }: Measured,
  room: number
): WireReadResult | undefined {
  const included = result.included ?? {}
  const refs = references(index, query, included)
  // База — з `more`: обрізана відповідь його несе, і саме це поле може
  // перетнути межу.
  let total = jsonBytes({
    ...result,
    rows: [],
    included: emptyIncluded(result.included),
    more: true,
  })
  const taken = new Map<string, Set<number>>()
  let kept = 0
  for (const [i, row] of result.rows.entries()) {
    let cost = rowSizes[i]! + (i > 0 ? 1 : 0)
    const pending = new Map<string, Set<number>>()
    // Маркер-позиція колонок не має: цілей `include` він не тягне.
    const record = typeof row === "object" ? row : undefined
    for (const { column, target, byKey } of refs) {
      if (record === undefined || !Object.hasOwn(record, column)) continue
      const done = taken.get(target)
      const fresh = pending.get(target) ?? new Set<number>()
      for (const j of byKey.get(record[column]) ?? []) {
        if (done?.has(j) === true || fresh.has(j)) continue
        // Кома — коли в масиві цілі вже є рядок, лишений чи щойно доданий.
        const before = (done?.size ?? 0) + fresh.size
        cost += includedSizes.get(target)![j]! + (before > 0 ? 1 : 0)
        fresh.add(j)
      }
      pending.set(target, fresh)
    }
    if (total + cost > room) break
    total += cost
    kept++
    for (const [target, fresh] of pending) {
      const done = taken.get(target) ?? new Set<number>()
      for (const j of fresh) done.add(j)
      taken.set(target, done)
    }
  }
  if (kept === 0) return undefined
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

/** One outcome of a `read` request in wire form. */
export type WireReadItem = WireReadParts["items"][number]

/**
 * A position of a `read` request for {@link fitParts}: an outcome the
 * handler already has (a refused part, a `version` part) or a query part the
 * runtime reads.
 */
export type ReadSlot = { item: WireReadItem } | { query: WireReadQuery }

/** The budget of one `read` response, see {@link fitParts}. */
export interface PartsBudget {
  /**
   * Decides the outcome of query part `part` (its position among the query
   * slots) from its encoded result, before the next part runs: `"overflow"`
   * — the parts after it must not run.
   */
  fit(part: number, result: WireReadResult): "accept" | "overflow"
  /**
   * The value of the response: the decided outcomes, `failed` errors for
   * the parts without one. A response still over the budget is
   * `response-too-large` whole. Throws for a query part with neither — a
   * server defect.
   */
  finish(
    epoch: string | null,
    failed: ReadonlyMap<number, WireCommandError>
  ): WireReadParts | CommandError
}

// Епоха — 64 hex чи `null`: до кінця транзакції бюджет міряє довшу форму.
const EPOCH_PLACEHOLDER = "0".repeat(64)
// Частина, ще не виконана, отримає хіба помилку: код, причину, UUID об'єкта
// й короткий шлях. Резерв тримає для неї місце; що його перевищить, ловить
// остаточна міра `finish`.
const PENDING_RESERVE_BYTES = 1024
// `{"ok":true,"value":…}` понад саме значення.
const OK_ITEM_OVERHEAD = jsonBytes({ ok: true, value: null }) - jsonBytes(null)

const BATCH_BUDGET: WireCommandError = {
  code: "command.unavailable",
  reason: "batch-budget",
}
const TOO_LARGE_ITEM: WireReadItem = {
  ok: false,
  error: { code: "command.invalid", reason: LIMIT_REASONS.responseTooLarge },
}

/**
 * The response budget of a `read` request (P4-B spec §4.1, §4.5): measures
 * the whole `DataResponse` `{ ok: true, value: { epoch, items }, serverHash }`
 * as the handler serializes it. A part fits into what the outcomes before it,
 * the ready outcomes and a reserve for every part not yet run leave. A part
 * over that remainder: a page is cut to its longest non-empty prefix that
 * fits, with `more: true`; otherwise, if it would fit in a response alone,
 * it is `command.unavailable` `reason: "batch-budget"` (the client rereads it
 * apart). Either way the parts after it are `batch-budget` and `fit` answers
 * `"overflow"`. A part that does not fit even alone is `command.invalid`
 * `reason: "response-too-large"`, and the parts after it still run.
 */
export function fitParts(
  index: CatalogIndex,
  slots: readonly ReadSlot[],
  serverHash: string
): PartsBudget {
  const queries: WireReadQuery[] = []
  const fixedBytes: number[] = []
  for (const slot of slots) {
    if ("query" in slot) queries.push(slot.query)
    else fixedBytes.push(jsonBytes(slot.item))
  }
  const decided: (WireReadItem | undefined)[] = queries.map(() => undefined)
  const decidedBytes: number[] = queries.map(() => 0)
  let overflowed = false
  const baseOf = (epoch: string | null) =>
    responseBytes({ epoch, items: [] }, serverHash) +
    Math.max(0, slots.length - 1)
  const base = baseOf(EPOCH_PLACEHOLDER)
  const fixed = fixedBytes.reduce((sum, size) => sum + size, 0)
  // Байти, що лишаються значенню частини `part` поміж інших елементів.
  const room = (part: number): number => {
    let used = base + fixed
    queries.forEach((_, p) => {
      if (p === part) return
      used +=
        decided[p] === undefined ? PENDING_RESERVE_BYTES : decidedBytes[p]!
    })
    return RESPONSE_BUDGET_BYTES - used - OK_ITEM_OVERHEAD
  }
  const decide = (part: number, item: WireReadItem) => {
    decided[part] = item
    decidedBytes[part] = jsonBytes(item)
  }
  // Сама в відповіді: без інших елементів і без ком між ними.
  const alone =
    RESPONSE_BUDGET_BYTES -
    responseBytes({ epoch: EPOCH_PLACEHOLDER, items: [] }, serverHash) -
    OK_ITEM_OVERHEAD

  return {
    fit(part, result) {
      const query = queries[part]
      if (query === undefined || decided[part] !== undefined) {
        throw new Error(`read part ${part} fitted twice or out of range`)
      }
      if (overflowed) {
        decide(part, { ok: false, error: BATCH_BUDGET })
        return "overflow"
      }
      const value = fitValue(index, query, result, room(part))
      if (value === result) {
        decide(part, { ok: true, value })
        return "accept"
      }
      if (value !== undefined) {
        decide(part, { ok: true, value })
        overflowed = true
        return "overflow"
      }
      if (fitValue(index, query, result, alone) !== undefined) {
        decide(part, { ok: false, error: BATCH_BUDGET })
        overflowed = true
        return "overflow"
      }
      decide(part, TOO_LARGE_ITEM)
      return "accept"
    },
    finish(epoch, failed) {
      let part = 0
      let total = baseOf(epoch)
      const items = slots.map((slot): WireReadItem => {
        if ("item" in slot) return slot.item
        const p = part++
        const done = decided[p]
        if (done !== undefined) {
          total += decidedBytes[p]!
          return done
        }
        const error = failed.get(p)
        if (error === undefined) {
          throw new Error(`read part ${p} has no outcome`)
        }
        const item: WireReadItem = { ok: false, error }
        total += jsonBytes(item)
        return item
      })
      if (total + fixed > RESPONSE_BUDGET_BYTES) return TOO_LARGE
      return { epoch, items }
    },
  }
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
