import {
  CommandFailure,
  LIMIT_REASONS,
  catalogIndex,
  readQueryFromWire,
  readQuerySchema,
  readResultToWire,
  type CatalogEntry,
  type CatalogIndex,
  type CommandError,
  type CommandErrorCode,
  type Filter,
  type MetadataRef,
  type ReadQuery,
  type ReadRows,
  type SourceAdapter,
  type WireRowsQuery,
  type WireRowsResult,
} from "simetra/model"
import {
  compareRows,
  evaluateFilter,
  fieldInfoOf,
  filterCollator,
} from "../filter"
import { scopeOf } from "../object-store"
import type { Key, ObjectName, ServerRow, Values } from "../types"

/**
 * Фейковий сервер і керований транспорт для тестів ядра T4. Сервер — джерело
 * правди з історією: кожна зміна бере наступне значення годинника, і воно ж
 * стає версією рядка (версія з послідовності, Рд24). Тому відповідь можна
 * виконати на будь-яку мить історії — так моделюються асинхронна репліка й
 * запит, що обігнав пізнішу зміну («показаний рядок = стан сервера на мить
 * його читання»). Відповідь доходить і тоді, коли викликача вже немає:
 * захист від пізніх відповідей тримає ядро, а не транспорт (звіт спайку §2).
 */

/** An object as the fake takes it: a reference or `"<kind>.<name>"`. */
export type FakeObject = MetadataRef | ObjectName

/** Configuration of {@link createFakeSource}. */
export interface FakeSourceInit {
  /** The catalog the fake server serves; the client maps with the same one. */
  readonly objects: readonly CatalogEntry[]
  /** `auto` answers every read itself; `manual` holds every read. Default `auto`. */
  readonly mode?: "auto" | "manual"
  /** The response budget in rows; see {@link FakeSource.responseRows}. */
  readonly responseRows?: number
}

/** One read the fake server received, in the order of arrival. */
export interface FakeReadLog {
  readonly wire: WireRowsQuery
  /** The logical query, when the wire query decoded. */
  readonly query: ReadQuery | undefined
  /** Server clock when the read arrived. */
  readonly issuedAt: number
  /** The wire answer, once delivered. */
  response?: WireRowsResult
  /** The refusal, once delivered. */
  error?: unknown
}

/** A read held by the fake transport until the test delivers it. */
export interface FakeRead {
  readonly log: FakeReadLog
  /** Logical name of the read object, when it decoded. */
  readonly object: ObjectName | undefined
  readonly query: ReadQuery | undefined
  readonly issuedAt: number
  /**
   * Executes the read on the server state at moment `at` (default: now) and
   * delivers the answer — or its refusal (`response-too-large`, an invalid
   * query). `at` below `issuedAt` is a stale replica.
   */
  answer(at?: number): void
  /** Delivers a refusal of the server without reading. */
  fail(error: CommandError | CommandErrorCode): void
}

/** The fake server and its controlled transport. */
export interface FakeSource {
  /** The adapter the core reads through. */
  readonly adapter: SourceAdapter
  readonly index: CatalogIndex
  /** Server clock: the moment of the last change; versions come from it. */
  readonly clock: number
  /**
   * Response budget in rows of the answer. Over it a read by keys, a card and
   * owner lines are refused `command.invalid` `response-too-large`; a page is
   * cut to its longest fitting prefix with `more: true`. Default: no limit.
   */
  responseRows: number
  /** `manual` holds every new read in {@link pending}. */
  mode: "auto" | "manual"
  /** In `auto` mode, a read matching this predicate is held anyway. */
  hold: ((read: FakeRead) => boolean) | undefined
  /** Reads held for the test, oldest first. */
  readonly pending: readonly FakeRead[]
  /** Every read received, in order. */
  readonly log: readonly FakeReadLog[]
  /** Reads received and not yet delivered. */
  readonly inFlight: number
  /** The largest {@link inFlight} seen since creation or {@link resetCounters}. */
  readonly maxInFlight: number
  resetCounters(): void
  /** Takes a held read out of the queue: by index (default the oldest) or predicate. */
  take(which?: number | ((read: FakeRead) => boolean)): FakeRead
  /** Answers every held read at the current moment, oldest first. */
  deliverAll(): void

  /** Creates a row (the key in its key field); returns its version. */
  insert(object: FakeObject, values: Values): number
  /** A foreign change of a live row: merges `values`; returns the new version. */
  edit(object: FakeObject, key: Key, values: Values): number
  /** A foreign deletion of a live row. */
  remove(object: FakeObject, key: Key): void
  /** Replaces the lines of a tabular section and raises the owner version. */
  setLines(
    object: FakeObject,
    owner: Key,
    section: string,
    lines: readonly Values[]
  ): number
  /** The row at moment `at` (default: now), visibility aside. */
  row(object: FakeObject, key: Key, at?: number): ServerRow | undefined
  /** Rows only of these scopes are visible (as RLS); `undefined` — all. */
  setVisibleScopes(scopes: Iterable<string | null> | undefined): void
  /** Marks a row as alone exceeding the response budget. */
  oversize(object: FakeObject, key: Key, on?: boolean): void
}

interface Revision<T> {
  readonly at: number
  readonly value: T | null
}

const nameOf = (object: FakeObject): ObjectName =>
  typeof object === "string" ? object : `${object.kind}.${object.name}`

/** Значення на мить `at`: остання ревізія не пізніше за неї. */
function valueAt<T>(history: readonly Revision<T>[], at: number): T | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.at <= at) return history[i]!.value
  }
  return null
}

const toError = (error: CommandError | CommandErrorCode): CommandError =>
  typeof error === "string" ? { code: error } : error

const tooLarge = () =>
  new CommandFailure({
    code: "command.invalid",
    reason: LIMIT_REASONS.responseTooLarge,
  })

/** Чи є в дереві умова `eq`/`in` за ключем — тоді це читання за ключами. */
function byKeys(filter: Filter | undefined, keyName: string): boolean {
  if (filter === undefined) return false
  if ("and" in filter) return filter.and.some((f) => byKeys(f, keyName))
  if ("or" in filter) return filter.or.some((f) => byKeys(f, keyName))
  if ("not" in filter) return byKeys(filter.not, keyName)
  return (
    filter.attribute === keyName && (filter.op === "eq" || filter.op === "in")
  )
}

/** Creates a fake server with a controlled transport (see {@link FakeSource}). */
export function createFakeSource(init: FakeSourceInit): FakeSource {
  const index = catalogIndex(init.objects)
  const collator = filterCollator()
  const tables = new Map<ObjectName, Map<Key, Revision<Values>[]>>()
  const lines = new Map<string, Revision<readonly Values[]>[]>()
  const oversized = new Set<string>()
  const pending: FakeRead[] = []
  const log: FakeReadLog[] = []
  let clock = 0
  let visible: Set<string | null> | undefined
  let inFlight = 0
  let maxInFlight = 0

  for (const entry of init.objects) {
    tables.set(`${entry.kind}.${entry.name}`, new Map())
  }

  const entryOf = (object: FakeObject): CatalogEntry => {
    const entry = index.byRef.get(nameOf(object))
    if (entry === undefined)
      throw new Error(`fake: unknown object ${nameOf(object)}`)
    return entry
  }
  const tableOf = (object: FakeObject) => tables.get(nameOf(entryOf(object)))!
  const linesId = (object: ObjectName, owner: Key, section: string) =>
    `${object}\u0000${owner}\u0000${section}`
  const isVisible = (entry: CatalogEntry, values: Values) =>
    visible === undefined || visible.has(scopeOf(entry, values))
  // Рядок понад бюджет не вміщується за жодного бюджету, і безмежного теж.
  const fits = (entry: CatalogEntry, rows: readonly Values[]) =>
    rows.length <= fake.responseRows &&
    rows.every(
      (row) =>
        !oversized.has(
          `${entry.kind}.${entry.name}\u0000${String(row[entry.keyName])}`
        )
    )

  const liveRow = (object: FakeObject, key: Key) => {
    const history = tableOf(object).get(key)
    const current = history === undefined ? null : valueAt(history, clock)
    if (history === undefined || current === null) {
      throw new Error(`fake: no live row ${nameOf(object)} ${key}`)
    }
    return { history, current }
  }

  const write = (object: FakeObject, key: Key, values: Values): number => {
    const entry = entryOf(object)
    const table = tableOf(object)
    const version = ++clock
    const history = table.get(key) ?? []
    history.push({
      at: version,
      value: { ...values, [entry.keyName]: key, [entry.versionName]: version },
    })
    table.set(key, history)
    return version
  }

  /** Видимі рядки об'єкта на мить `at`; списочна форма — без лінивих полів. */
  const rowsAt = (entry: CatalogEntry, at: number, card: boolean) => {
    const lazy = card
      ? new Set<string>()
      : new Set(
          entry.attributes.filter((a) => a.load === "lazy").map((a) => a.name)
        )
    const out: Values[] = []
    for (const history of tables.get(`${entry.kind}.${entry.name}`)!.values()) {
      const values = valueAt(history, at)
      if (values === null || !isVisible(entry, values)) continue
      out.push(
        lazy.size === 0
          ? values
          : Object.fromEntries(
              Object.entries(values).filter(([name]) => !lazy.has(name))
            )
      )
    }
    return out
  }

  const included = (
    entry: CatalogEntry,
    names: readonly string[] | undefined,
    rows: readonly Values[],
    at: number
  ) => {
    if (names === undefined) return undefined
    const out = new Map<string, Map<Key, Values>>()
    for (const name of names) {
      const target = entry.attributes.find((a) => a.name === name)?.ref
      const targetEntry =
        target === undefined ? undefined : index.byId.get(target.object)
      if (targetEntry === undefined) continue
      const wanted = new Set(rows.map((row) => row[name]))
      const group =
        out.get(`${targetEntry.kind}.${targetEntry.name}`) ?? new Map()
      for (const row of rowsAt(targetEntry, at, false)) {
        const key = row[targetEntry.keyName] as Key
        if (wanted.has(key)) group.set(key, row)
      }
      out.set(`${targetEntry.kind}.${targetEntry.name}`, group)
    }
    return Object.fromEntries(
      [...out].map(([name, group]) => [name, [...group.values()]])
    )
  }

  /** Виконання логічного запиту на мить `at` — як серверне читання під RLS. */
  const execute = (query: ReadQuery, at: number): ReadRows => {
    const parsed = readQuerySchema.safeParse(query)
    if (!parsed.success) {
      const [issue] = parsed.error.issues
      throw new CommandFailure({
        code: "command.invalid",
        path: (issue?.path ?? []).map(String).join("."),
      })
    }
    const entry = entryOf(query.object)
    if ("tabularSection" in query) {
      if (!("owner" in query)) {
        throw new Error(
          "fake: only owner lines of a tabular section are served"
        )
      }
      const owner = rowsAt(entry, at, false).find(
        (row) => row[entry.keyName] === query.owner
      )
      // Невидимий власник — порожня відповідь без версії, як у сервера.
      if (owner === undefined) return { rows: [] }
      const history = lines.get(
        linesId(nameOf(query.object), query.owner, query.tabularSection)
      )
      const rows = [...((history && valueAt(history, at)) ?? [])]
      if (rows.length > fake.responseRows) throw tooLarge()
      return { rows, ownerVersion: owner[entry.versionName] as number }
    }
    if ("count" in query) throw new Error("fake: counts are not served")
    const info = fieldInfoOf(entry)
    if ("id" in query) {
      const row = rowsAt(entry, at, true).find(
        (r) => r[entry.keyName] === query.id
      )
      if (row === undefined) return { rows: [] }
      const card: Record<string, unknown> = { ...row }
      if (query.tabularSections !== undefined) {
        const names =
          query.tabularSections === true
            ? entry.tabularSections.map((s) => s.name)
            : query.tabularSections
        card.tabularSections = Object.fromEntries(
          names.map((name) => {
            const history = lines.get(
              linesId(nameOf(query.object), query.id, name)
            )
            return [name, [...((history && valueAt(history, at)) ?? [])]]
          })
        )
      }
      if (!fits(entry, [card])) throw tooLarge()
      const extra = included(entry, query.include, [card], at)
      return extra === undefined
        ? { rows: [card] }
        : { rows: [card], included: extra }
    }
    const where = query.where
    let rows = rowsAt(entry, at, false)
    if (where !== undefined) {
      rows = rows.filter((row) => evaluateFilter(where, row, info, collator))
    }
    rows.sort(compareRows(query.orderBy ?? [], info, entry.keyName, collator))
    rows = rows.slice(query.offset ?? 0, (query.offset ?? 0) + query.limit)
    let more = false
    if (!fits(entry, rows)) {
      // Читання за ключами не обрізається (§4.1); сторінка — найдовшим префіксом.
      if (byKeys(where, entry.keyName)) throw tooLarge()
      let end = 0
      while (end < rows.length && fits(entry, rows.slice(0, end + 1))) end++
      if (end === 0) throw tooLarge()
      rows = rows.slice(0, end)
      more = true
    }
    const extra = included(entry, query.include, rows, at)
    return {
      rows,
      ...(extra === undefined ? {} : { included: extra }),
      ...(more ? { more: true as const } : {}),
    }
  }

  const fake: FakeSource = {
    index,
    get clock() {
      return clock
    },
    responseRows: init.responseRows ?? Infinity,
    mode: init.mode ?? "auto",
    hold: undefined,
    get pending() {
      return pending
    },
    get log() {
      return log
    },
    get inFlight() {
      return inFlight
    },
    get maxInFlight() {
      return maxInFlight
    },
    resetCounters() {
      maxInFlight = inFlight
    },
    take(which = 0) {
      const at =
        typeof which === "number" ? which : pending.findIndex((r) => which(r))
      const [read] = at < 0 ? [] : pending.splice(at, 1)
      if (read === undefined) throw new Error("fake: no such held read")
      return read
    },
    deliverAll() {
      while (pending.length > 0) pending.shift()!.answer()
    },
    adapter: {
      capabilities: { include: true },
      read(wire) {
        return new Promise<WireRowsResult>((resolve, reject) => {
          const decoded = readQueryFromWire(index, wire)
          const query = decoded.ok ? decoded.value : undefined
          const entry: FakeReadLog = { wire, query, issuedAt: clock }
          log.push(entry)
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          let done = false
          const deliver = (outcome: () => WireRowsResult) => {
            if (done) throw new Error("fake: read already delivered")
            done = true
            inFlight--
            try {
              entry.response = outcome()
              resolve(entry.response)
            } catch (error) {
              entry.error = error
              reject(error)
            }
          }
          const read: FakeRead = {
            log: entry,
            object: query === undefined ? undefined : nameOf(query.object),
            query,
            issuedAt: entry.issuedAt,
            answer(at = clock) {
              deliver(() => {
                if (!decoded.ok) {
                  // Чужий для каталогу сервера запит — відмова звірки (Рд12).
                  throw new CommandFailure(
                    "invalid" in decoded
                      ? decoded.invalid
                      : { code: "command.stale-client" }
                  )
                }
                return readResultToWire(
                  index,
                  decoded.value,
                  execute(decoded.value, at)
                ) as WireRowsResult
              })
            },
            fail(error) {
              deliver(() => {
                throw new CommandFailure(toError(error))
              })
            },
          }
          if (fake.mode === "manual" || fake.hold?.(read) === true) {
            pending.push(read)
            return
          }
          // Стан — на мить виконання, доставка — окремою мікрозадачею, тож
          // одночасні читання одного такту видно в лічильнику.
          const at = clock
          queueMicrotask(() => read.answer(at))
        })
      },
    },
    insert(object, values) {
      const entry = entryOf(object)
      const key = values[entry.keyName]
      if (typeof key !== "string") throw new Error("fake: a row needs its key")
      const history = tableOf(object).get(key)
      if (history !== undefined && valueAt(history, clock) !== null) {
        throw new Error(`fake: row ${key} exists`)
      }
      return write(object, key, values)
    },
    edit(object, key, values) {
      const { current } = liveRow(object, key)
      return write(object, key, { ...current, ...values })
    },
    remove(object, key) {
      const { history } = liveRow(object, key)
      history.push({ at: ++clock, value: null })
    },
    setLines(object, owner, section, rows) {
      const { current } = liveRow(object, owner)
      if (!entryOf(object).tabularSections.some((s) => s.name === section)) {
        throw new Error(`fake: unknown section ${section}`)
      }
      // Зміна рядків ТЧ підвищує версію власника (Рд27): той самий такт.
      const version = write(object, owner, current)
      const id = linesId(nameOf(entryOf(object)), owner, section)
      const history = lines.get(id) ?? []
      history.push({ at: version, value: rows.map((line) => ({ ...line })) })
      lines.set(id, history)
      return version
    },
    row(object, key, at = clock) {
      const entry = entryOf(object)
      const history = tableOf(object).get(key)
      const values = history === undefined ? null : valueAt(history, at)
      return values === null
        ? undefined
        : { key, version: values[entry.versionName] as number, values }
    },
    setVisibleScopes(scopes) {
      visible = scopes === undefined ? undefined : new Set(scopes)
    },
    oversize(object, key, on = true) {
      const id = `${nameOf(entryOf(object))}\u0000${key}`
      if (on) oversized.add(id)
      else oversized.delete(id)
    },
  }
  return fake
}
