import type { CatalogEntry } from "simetra/model"
import { NO_DEFECTS, type Defects } from "./defects"
import { keyId, pairId } from "./epoch"
import type { Scope, Session } from "./session"
import type { CoreLogEntry, Key, ObjectName, ServerRow, Values } from "./types"

/**
 * Two version epochs that cannot be ordered: both non-empty and different
 * (P4-B plan B1c, Р5, Р6). `null` or absent — a replica or a database without
 * an epoch — compares with any epoch by version as usual.
 */
export function differentEpochs(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  return a != null && b != null && a !== b
}

/**
 * The epoch a write keeps in store state (P4-B plan B1c, Р5, Р6): the incoming
 * one, and for a `null` answer (a replica, a database without an epoch) the
 * epoch already held. Every write of an epoch into the store goes through it
 * (guarded by `__tests__/epoch-write-guard.test.ts`).
 */
export function effectiveEpoch(
  incoming: string | null | undefined,
  held: string | null | undefined
): string | null {
  return incoming ?? held ?? null
}

/**
 * The version rule (P4-B spec §6.2 rule 1, Рд24) — one function for every
 * write path. Returns `undefined` when `incoming` is older; an equal or newer
 * version merges partially: a missing (lazy) field stays, an explicit `null`
 * is written. A row of another non-empty epoch replaces the current one
 * whatever its version; a `null` epoch keeps the epoch of the current row.
 */
export function mergeVersioned(
  current: ServerRow | undefined,
  incoming: ServerRow
): ServerRow | undefined {
  if (current === undefined) return incoming
  const switched = differentEpochs(current.versionEpoch, incoming.versionEpoch)
  if (!switched && incoming.version < current.version) return undefined
  return {
    key: current.key,
    version: incoming.version,
    versionEpoch: effectiveEpoch(incoming.versionEpoch, current.versionEpoch),
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
  /** The epoch `version` belongs to; `null` — the database has none. */
  versionEpoch: string | null
  /** The largest read epoch of an accepted write. */
  writtenEpoch: number
  owners: number
  /** The row version each lazy field was read with. */
  lazyVersions: Map<string, number>
  /** The version epoch each lazy field was read in; not listed — `null`. */
  lazyEpochs: Map<string, string | null>
  /** `divergent` — the remove came from a read older than the last write (П15). */
  removed?: { epoch: number; divergent: boolean }
  /**
   * Three `stale` marks, each cleared by its own rule (spec §6.1). While
   * `seen` (the eviction horizon, §6.2 rule 1) is set, the values are hidden.
   */
  stale: {
    minVersion?: { v: number; epoch: number }
    /**
     * Channel → mark epoch. Per channel: a row that moved keeps the mark of
     * its old channel until that channel clears it, so marking and clearing
     * the new channel never drops a gap of the old one.
     */
    disconnect?: Map<string, number>
    seen?: { epoch: number }
  }
}

/**
 * A lazy field read with an older row version, or in another version epoch
 * (versions of different epochs are not ordered); a field never read counts
 * as older.
 */
export function lazyFieldStale(e: RowEntry, field: string): boolean {
  return (
    differentEpochs(e.lazyEpochs.get(field), e.versionEpoch) ||
    (e.lazyVersions.get(field) ?? -Infinity) < e.version
  )
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
   * Always marks `removed` (П15); a repeated non-divergent remove from a read
   * started after the mark is a new mark and moves its epoch. A no-op only for
   * a key with a newer key or pair tombstone and for a key without an entry.
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
  /** Clears the mark recorded on `channel`; marks of other channels stay. */
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
  defects?: Defects
  /** Inspection only: a fresh "row absent" answer re-marked a `removed` slot. */
  onRemark?: (key: Key) => void
}): ObjectStore {
  const { object, entry, session, log, onRemark } = options
  const { epochs } = session
  const defects = options.defects ?? NO_DEFECTS
  const bury = (id: string) => {
    if (!defects.has("no-tombstone")) epochs.bury(id)
  }
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
      if (!Object.hasOwn(row.values, field)) continue
      e.lazyVersions.set(field, row.version)
      // Поле прочитано з версією рядка, тож і епоху бере рядка: `null`
      // відповідь лишає епоху слота, а не стирає її.
      e.lazyEpochs.set(field, effectiveEpoch(row.versionEpoch, e.versionEpoch))
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
      // Нового ключа слот не тримає — епоха лише з відповіді.
      versionEpoch: effectiveEpoch(row.versionEpoch, null),
      writtenEpoch: readEpoch,
      owners: 0,
      lazyVersions: new Map(),
      lazyEpochs: new Map(),
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
      if (e !== undefined && buried(row.key, e.scope, readEpoch))
        return "rejected"
      if (
        incomingScope !== undefined &&
        buried(row.key, incomingScope, readEpoch)
      ) {
        if (e === undefined || e.removed !== undefined) return "rejected"
        // Рядок у сховищі переїхав у скоуп, прибраний після старту читання:
        // його збережені значення вже не підтверджені, а цей рядок писати не
        // можна. Ховаємо значення, як горизонт (§6.2, правило 1), і
        // перечитуємо: доступ втрачено — `removed`, інакше — нові значення.
        if (e.stale.seen === undefined) hide(e, row.key)
        else tail.add(row.key)
        return "stale-inserted"
      }
      if (e === undefined)
        return insert(row, incomingScope ?? null, readEpoch, lazyRead)
      // `removed` знімає лише читання після позначки — будь-якої версії.
      if (
        e.removed !== undefined &&
        readEpoch < e.removed.epoch &&
        !(defects.has("removed-by-older-read") && row.version > e.version)
      )
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
        if (
          row.version < e.version &&
          !differentEpochs(e.versionEpoch, row.versionEpoch)
        ) {
          e.stale.minVersion = { v: e.version, epoch: epochs.next() }
          tail.add(row.key)
          result = "stale-inserted"
        }
        if (e.removed.divergent) restored++
        delete e.removed
        // Репліка без епохи не стирає епохи слота (Р6).
        e.row = {
          ...row,
          versionEpoch: effectiveEpoch(row.versionEpoch, e.versionEpoch),
        }
      } else {
        const merged =
          mergeVersioned(e.row, row) ??
          (defects.has("version-decrease")
            ? { ...row, values: { ...e.row?.values, ...row.values } }
            : undefined)
        if (merged === undefined) return "rejected"
        e.row = merged
      }
      e.version = e.row.version
      e.versionEpoch = effectiveEpoch(e.row.versionEpoch, e.versionEpoch)
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
      if (e.removed !== undefined) {
        e.removed.divergent = divergent
        // Свіже «рядка немає» з читання після позначки — нова позначка: інакше
        // паралельне читання з тією самою епохою старту, що каже «є», зняло б
        // слот без хвоста (П15). Старіший повторний remove лишає ранню епоху:
        // зсув уперед відкидав би відповіді читань, що почались після першої
        // позначки й уже мають право відновити.
        if (!divergent && readEpoch >= e.removed.epoch) {
          onRemark?.(key)
          if (!defects.has("repeated-remove-keeps-epoch"))
            e.removed.epoch = epochs.next()
        }
        return
      }
      e.row = undefined
      e.lazyVersions.clear()
      e.lazyEpochs.clear()
      e.removed = { epoch: epochs.next(), divergent }
    },

    purgeKeys(scope, keys) {
      scope.assert()
      const dropped: Key[] = []
      for (const key of keys) {
        bury(keyId(object, key))
        tail.delete(key)
        if (rows.delete(key)) dropped.push(key)
      }
      return dropped
    },

    purgeScope(scope, scopeId) {
      scope.assert()
      if (!defects.has("no-tombstone")) epochs.buryPair(object, scopeId)
      const dropped: Key[] = []
      for (const [key, e] of rows) {
        const stored = defects.has("purge-by-values")
          ? e.row === undefined
            ? undefined
            : scopeOf(entry, e.row.values)
          : e.scope
        if (stored !== scopeId) continue
        bury(keyId(object, key))
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
        const marks = e.stale.disconnect ?? new Map<string, number>()
        marks.set(own, epochs.next())
        e.stale.disconnect = marks
      }
    },

    clearDisconnected(scope, channel) {
      scope.assert()
      // Розрив знімає канал, на якому його поставлено: відновлення сигналів
      // нового каналу не покриває пропущеного в старому.
      for (const e of rows.values()) {
        const marks = e.stale.disconnect
        if (marks === undefined || !marks.delete(channel)) continue
        if (marks.size === 0) delete e.stale.disconnect
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
      if (e.owners > 0 || defects.has("row-without-owner")) return
      const id = keyId(object, key)
      // Пам'ятна версія не менша за очікувану: інакше stale-вставка після
      // повернення ключа втратила б свою мінімальну версію.
      epochs.remember(
        id,
        Math.max(e.version, e.stale.minVersion?.v ?? e.version)
      )
      // Слот removed без надгробка дав би старій відповіді повернути значення.
      if (e.removed !== undefined) bury(id)
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
