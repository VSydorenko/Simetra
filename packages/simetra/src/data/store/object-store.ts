import type { CatalogEntry } from "simetra/model"
import { keyId, pairId } from "./epoch"
import type { Scope, Session } from "./session"
import type { CoreLogEntry, Key, ObjectName, ServerRow, Values } from "./types"

/**
 * The version rule (P4-B spec §6.2 rule 1, Рд24) — one function for every
 * write path. Returns `undefined` when `incoming` is older; an equal or newer
 * version merges partially: a missing (lazy) field stays, an explicit `null`
 * is written.
 */
export function mergeVersioned(
  current: ServerRow | undefined,
  incoming: ServerRow
): ServerRow | undefined {
  if (current === undefined) return incoming
  if (incoming.version < current.version) return undefined
  return {
    key: current.key,
    version: incoming.version,
    values: { ...current.values, ...incoming.values },
  }
}

// Логічне поле скоупу: у кореня виду скоупу — сам ключ, інакше — реквізит,
// чия колонка є колонкою скоупу (П11).
function scopeFieldOf(entry: CatalogEntry): string | undefined {
  if (entry.scopeColumn === undefined) return undefined
  if (entry.scopeColumn === entry.key) return entry.keyName
  return entry.attributes.find((a) => a.column === entry.scopeColumn)?.name
}

/**
 * The scope of a row (P4-B plan П11): the key of a scope-kind root, the value
 * of the attribute on the scope column otherwise, `null` for an object
 * without a scope column.
 */
export function scopeOf(entry: CatalogEntry, values: Values): string | null {
  const field = scopeFieldOf(entry)
  if (field === undefined) return null
  const value = values[field]
  return typeof value === "string" ? value : null
}

/** A row slot of the store. */
export interface RowEntry {
  /** `undefined` — the values are erased (`removed`). */
  row: ServerRow | undefined
  scope: string | null
  version: number
  /** The largest read epoch of an accepted write. */
  writtenEpoch: number
  owners: number
  /** The row version each lazy field was read with. */
  lazyVersions: Map<string, number>
  /** `divergent` — the remove came from a read older than the last write (П15). */
  removed?: { epoch: number; divergent: boolean }
  /**
   * Three `stale` marks, each cleared by its own rule (spec §6.1). While
   * `seen` (the eviction horizon, §6.2 rule 1) is set, the values are hidden.
   */
  stale: {
    minVersion?: { v: number; epoch: number }
    disconnect?: { channel: string; epoch: number }
    seen?: { epoch: number }
  }
}

/**
 * The values a reader may show: `undefined` for a removed slot and for a row
 * hidden by the eviction horizon (`stale.seen`). Every reader of the store —
 * `RowView`, the local filter and comparator, `include` refs — goes through
 * it; reading `row.values` directly would show hidden values.
 */
export function visibleRow(e: RowEntry): Values | undefined {
  if (e.removed !== undefined || e.stale.seen !== undefined) return undefined
  return e.row?.values
}

export type PutResult = "written" | "rejected" | "stale-inserted"

/** The header rows of one object (P4-B spec §6.1, §6.2). */
export interface ObjectStore {
  put(
    scope: Scope,
    row: ServerRow,
    readEpoch: number,
    lazyRead: boolean
  ): PutResult
  /**
   * Always marks `removed` (П15); a no-op only for a key with a newer key or
   * pair tombstone and for a key without an entry.
   */
  remove(scope: Scope, key: Key, readEpoch: number): void
  /** Buries the keys and drops their entries; returns the dropped keys. */
  purgeKeys(scope: Scope, keys: readonly Key[]): Key[]
  /**
   * Buries the pair (through `Epochs.buryPair`) and every key with that stored
   * scope (removed slots too); returns the dropped keys.
   */
  purgeScope(scope: Scope, scopeId: string | null): Key[]
  markStale(scope: Scope, keys: readonly Key[], minVersion: number): void
  markDisconnected(
    scope: Scope,
    channelOf: (e: RowEntry) => string,
    channel?: string
  ): void
  /** Clears the marks recorded on `channel` (`stale.disconnect.channel`). */
  clearDisconnected(scope: Scope, channel: string): void
  /**
   * Adds an owner to an existing entry; a key without an entry gets nothing.
   * Callers own a key only after its `put` was accepted.
   */
  own(scope: Scope, key: Key): void
  /** At zero owners: the version goes to memory; a removed slot is also buried. */
  disown(scope: Scope, key: Key): void
  get(key: Key): RowEntry | undefined
  /** The number of entries, removed slots included. */
  readonly size: number
  /** The keys of every entry, removed slots included. */
  keys(): IterableIterator<Key>
  /**
   * Keys that need a tail re-read, collected since the last call: a
   * `stale-inserted` put, a first write without the scope column, a divergent
   * remove. The caller re-reads them after the `commit`.
   */
  drainTail(): Key[]
}

export function createObjectStore(options: {
  object: ObjectName
  entry: CatalogEntry
  session: Pick<Session, "epochs" | "onFlush" | "onClose">
  log: (entry: CoreLogEntry) => void
}): ObjectStore {
  const { object, entry, session, log } = options
  const { epochs } = session
  const scopeField = scopeFieldOf(entry)
  if (entry.scopeColumn !== undefined && scopeField === undefined) {
    throw new TypeError(
      `${object}: the scope column ${entry.scopeColumn} has no attribute`
    )
  }
  const lazyFields = entry.attributes
    .filter((a) => a.load === "lazy")
    .map((a) => a.name)

  const rows = new Map<Key, RowEntry>()
  const tail = new Set<Key>()
  // Лічильники метрик одного commit: журнал отримує кількість без ключів.
  let restored = 0
  let hidden = 0

  session.onFlush(() => {
    if (restored > 0) log({ kind: "removed-restored", object, count: restored })
    if (hidden > 0) log({ kind: "horizon-hidden", object, count: hidden })
    restored = 0
    hidden = 0
  })
  // Службові мапи живуть у замиканні: без хука вони пережили б закриття,
  // якби хтось тримав посилання на сховище.
  session.onClose(() => {
    rows.clear()
    tail.clear()
    restored = 0
    hidden = 0
  })

  const buried = (key: Key, scopeId: string | null, readEpoch: number) =>
    epochs.buriedSince(keyId(object, key), readEpoch) ||
    epochs.buriedSince(pairId(object, scopeId), readEpoch)

  function setLazy(e: RowEntry, row: ServerRow, lazyRead: boolean) {
    if (!lazyRead) return
    for (const field of lazyFields) {
      if (Object.hasOwn(row.values, field))
        e.lazyVersions.set(field, row.version)
    }
  }

  function clearMarks(e: RowEntry, readEpoch: number) {
    const { minVersion, seen } = e.stale
    if (
      minVersion !== undefined &&
      e.version >= minVersion.v &&
      readEpoch >= minVersion.epoch
    )
      delete e.stale.minVersion
    if (seen !== undefined && readEpoch >= seen.epoch) delete e.stale.seen
  }

  function hide(e: RowEntry, key: Key) {
    e.stale.seen = { epoch: epochs.next() }
    hidden++
    tail.add(key)
  }

  function insert(
    row: ServerRow,
    scopeId: string | null,
    readEpoch: number,
    lazyRead: boolean
  ): PutResult {
    const id = keyId(object, row.key)
    const known = epochs.seen(id)?.version
    const e: RowEntry = {
      row,
      scope: scopeId,
      version: row.version,
      writtenEpoch: readEpoch,
      owners: 0,
      lazyVersions: new Map(),
      stale: {},
    }
    setLazy(e, row, lazyRead)
    const lower = known !== undefined && row.version < known
    if (lower) e.stale.minVersion = { v: known, epoch: epochs.next() }
    // Читання старше за горизонт кошика ключа чи пари: витіснений надгробок
    // міг належати видаленому чи прибраному рядку, тож значення ховаємо до
    // перечитування — навіть коли пам'ять версій ключ ще знає.
    const horizon =
      epochs.evictedSince(id, readEpoch) ||
      epochs.evictedSince(pairId(object, scopeId), readEpoch)
    if (horizon) hide(e, row.key)
    rows.set(row.key, e)
    if (!lower && !horizon) return "written"
    tail.add(row.key)
    return "stale-inserted"
  }

  return {
    put(scope, row, readEpoch, lazyRead) {
      scope.assert()
      const e = rows.get(row.key)
      const hasScope =
        scopeField === undefined || Object.hasOwn(row.values, scopeField)
      if (e === undefined && !hasScope) {
        // Без колонки скоупу першого запису не перевірити надгробком пари.
        tail.add(row.key)
        return "rejected"
      }
      const incomingScope = hasScope ? scopeOf(entry, row.values) : undefined
      // Обидва скоупи: рядок міг переїхати, а надгробок стоїть на будь-якому.
      if (
        incomingScope !== undefined &&
        buried(row.key, incomingScope, readEpoch)
      )
        return "rejected"
      if (e !== undefined && buried(row.key, e.scope, readEpoch))
        return "rejected"
      if (e === undefined)
        return insert(row, incomingScope ?? null, readEpoch, lazyRead)
      // `removed` знімає лише читання після позначки — будь-якої версії.
      if (e.removed !== undefined && readEpoch < e.removed.epoch)
        return "rejected"

      // Рядок переїжджає в інший скоуп: витіснений надгробок нової пари міг
      // належати purge, який цей рядок мав би прибрати. Лише на зміні скоупу,
      // щоб витіснення під час прокрутки не робило stale кожну відповідь.
      const moved =
        incomingScope !== undefined &&
        incomingScope !== e.scope &&
        epochs.evictedSince(pairId(object, incomingScope), readEpoch)

      let result: PutResult = "written"
      if (e.removed !== undefined) {
        // Значення стерто, тож зливати нема з чим; версію рядка після позначки
        // меншою за пам'ятну все одно не показуємо підтвердженою.
        if (row.version < e.version) {
          e.stale.minVersion = { v: e.version, epoch: epochs.next() }
          tail.add(row.key)
          result = "stale-inserted"
        }
        if (e.removed.divergent) restored++
        delete e.removed
        e.row = row
      } else {
        const merged = mergeVersioned(e.row, row)
        if (merged === undefined) return "rejected"
        e.row = merged
      }
      e.version = e.row.version
      if (incomingScope !== undefined) e.scope = incomingScope
      e.writtenEpoch = Math.max(e.writtenEpoch, readEpoch)
      setLazy(e, row, lazyRead)
      clearMarks(e, readEpoch)
      if (!moved) return result
      hide(e, row.key)
      return "stale-inserted"
    },

    remove(scope, key, readEpoch) {
      scope.assert()
      const e = rows.get(key)
      if (e === undefined || buried(key, e.scope, readEpoch)) return
      // Епоха старту не впорядковує серверних знімків: відсутній рядок ховає
      // значення завжди, а розбіжність вирішує одне хвостове перечитування.
      const divergent = readEpoch < e.writtenEpoch
      if (divergent) tail.add(key)
      // Повторний remove лишає ранню епоху: зсув уперед відкидав би відповіді
      // читань, що почались після першої позначки й уже мають право відновити.
      if (e.removed !== undefined) {
        e.removed.divergent = divergent
        return
      }
      e.row = undefined
      e.lazyVersions.clear()
      e.removed = { epoch: epochs.next(), divergent }
    },

    purgeKeys(scope, keys) {
      scope.assert()
      const dropped: Key[] = []
      for (const key of keys) {
        epochs.bury(keyId(object, key))
        tail.delete(key)
        if (rows.delete(key)) dropped.push(key)
      }
      return dropped
    },

    purgeScope(scope, scopeId) {
      scope.assert()
      epochs.buryPair(object, scopeId)
      const dropped: Key[] = []
      for (const [key, e] of rows) {
        if (e.scope !== scopeId) continue
        epochs.bury(keyId(object, key))
        rows.delete(key)
        tail.delete(key)
        dropped.push(key)
      }
      return dropped
    },

    markStale(scope, keys, minVersion) {
      scope.assert()
      for (const key of keys) {
        const e = rows.get(key)
        if (e === undefined || e.version >= minVersion) continue
        const v = Math.max(e.stale.minVersion?.v ?? minVersion, minVersion)
        e.stale.minVersion = { v, epoch: epochs.next() }
      }
    },

    markDisconnected(scope, channelOf, channel) {
      scope.assert()
      for (const e of rows.values()) {
        const own = channelOf(e)
        if (channel !== undefined && own !== channel) continue
        e.stale.disconnect = { channel: own, epoch: epochs.next() }
      }
    },

    clearDisconnected(scope, channel) {
      scope.assert()
      // Розрив знімає канал, на якому його поставлено: відновлення сигналів
      // нового каналу не покриває пропущеного в старому.
      for (const e of rows.values()) {
        if (e.stale.disconnect?.channel === channel) delete e.stale.disconnect
      }
    },

    own(scope, key) {
      scope.assert()
      const e = rows.get(key)
      if (e !== undefined) e.owners++
    },

    disown(scope, key) {
      scope.assert()
      const e = rows.get(key)
      if (e === undefined) return
      e.owners = Math.max(0, e.owners - 1)
      if (e.owners > 0) return
      const id = keyId(object, key)
      // Пам'ятна версія не менша за очікувану: інакше stale-вставка після
      // повернення ключа втратила б свою мінімальну версію.
      epochs.remember(
        id,
        Math.max(e.version, e.stale.minVersion?.v ?? e.version)
      )
      // Слот removed без надгробка дав би старій відповіді повернути значення.
      if (e.removed !== undefined) epochs.bury(id)
      rows.delete(key)
      tail.delete(key)
    },

    get: (key) => rows.get(key),

    get size() {
      return rows.size
    },

    keys: () => rows.keys(),

    drainTail() {
      const keys = [...tail]
      tail.clear()
      return keys
    },
  }
}
