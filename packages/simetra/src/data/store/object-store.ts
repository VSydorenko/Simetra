import {
  READ_LIMIT_MAX,
  ZERO_UUID,
  channelTopic,
  parseTopic,
  type CatalogEntry,
} from "simetra/model"
import { NO_DEFECTS, type Defects } from "./defects"
import {
  differentEpochs,
  effectiveEpoch,
  heldEpoch,
  keyId,
  pairId,
} from "./epoch"
import type { Scope, Session } from "./session"
import type {
  CoreLogEntry,
  Key,
  KnownSnapshot,
  ObjectName,
  ServerRow,
  Values,
} from "./types"

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
   * The epoch of the last `hide` of the key while this entry lives. Unlike `stale.hidden`, no read lifts it, and unlike the
   * `Epochs` mark it is not evicted: the owner's sections read before it
   * stay stale (`sectionStale`), and a horizon mark is never taken for it.
   */
  hiddenAt?: number
  /**
   * Four `stale` marks, each cleared by its own rule (spec §6.1). While
   * `hidden` is set, the values are hidden: by the eviction horizon (§6.2
   * rule 1) or by `hideKeys` (rights). Only a read that
   * started after the mark clears it; a write-back does not.
   */
  stale: {
    /** `versionEpoch` — the version epoch `v` belongs to. */
    minVersion?: { v: number; epoch: number; versionEpoch: string | null }
    /**
     * Channel → mark epoch (P4-B spec §8.4). Per channel: a row that moved
     * keeps the mark of its old channel, so a read proving the new channel
     * never drops a gap of the old one. Only an applied read lifts an entry
     * `g`: the channel joined after it (`joinAt > g`) and the read started at
     * or after that join (`readEpoch >= joinAt`).
     */
    disconnect?: Map<string, number>
    hidden?: { epoch: number }
    /**
     * The version epoch switched and no answer proved the row since (P4-B
     * spec §6.2): only an answer of the current epoch whose read
     * started after the switch clears it.
     */
    epoch?: true
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
 * The change channel of a row (§8.3): `channelTopic` of the scope kind, the
 * row's stored scope and the object id; an unscoped object takes
 * `ZERO_UUID` for both the kind and the scope.
 */
export function channelOf(entry: CatalogEntry): (e: RowEntry) => string {
  const scoped = entry.scopeColumn !== undefined
  const scopeKindId = scoped ? (entry.scopeKindId ?? ZERO_UUID) : ZERO_UUID
  return (e) =>
    channelTopic({
      kind: "changes",
      scopeKindId,
      scope: scoped ? (e.scope ?? ZERO_UUID) : ZERO_UUID,
      object: entry.id,
    })
}

/** The object id of a change channel; `undefined` for another topic. */
export function changesObjectOf(channel: string): string | undefined {
  const parsed = parseTopic(channel)
  return parsed?.kind === "changes" ? parsed.object : undefined
}

/**
 * The values a reader may show: `undefined` for a removed slot and for a row
 * hidden by a mark (`stale.hidden`: the horizon or `hideKeys`). Every reader of the store —
 * `RowView`, the local filter and comparator, `include` refs — goes through
 * it; reading `row.values` directly would show hidden values.
 */
export function visibleRow(e: RowEntry): Values | undefined {
  if (e.removed !== undefined || e.stale.hidden !== undefined) return undefined
  return e.row?.values
}

export type PutResult = "written" | "rejected" | "stale-inserted"

/** A row of a core snapshot, parsed and ready to be put into the store. */
export interface RestoredRow {
  readonly key: Key
  /** `hidden` and `removed` slots keep no values: `row` is `undefined`. */
  readonly state: "row" | "hidden" | "removed"
  readonly row: ServerRow | undefined
  readonly scope: string | null
  readonly version: number
  readonly versionEpoch: string | null
  readonly lazyVersions: ReadonlyMap<string, number>
  readonly lazyIn: ReadonlyMap<string, string | null>
  /** One mark: the row is not proved since the hydration. */
  readonly stale: boolean
}

/** The header rows of one object (P4-B spec §6.1, §6.2). */
export interface ObjectStore {
  put(
    scope: Scope,
    row: ServerRow,
    readEpoch: number,
    lazyRead: boolean
  ): PutResult
  /**
   * The `known` of a read of `keys` (P4-B spec §6.7): the keys the store may
   * answer with a marker. A key goes in only when its row shows values (not
   * `removed`, not hidden), has no unconfirmed version mark, was read in the
   * current version epoch, is complete for `form` (a list: every column of
   * the list read; a card: also every lazy field read with the row version)
   * and is owned by the reading view (`owned`). `undefined` — no key
   * qualifies, or the session has no version epoch yet. At most
   * `READ_LIMIT_MAX` keys.
   */
  knownFor(
    keys: readonly Key[],
    options: { owned: ReadonlySet<Key>; form: "list" | "card" }
  ): KnownSnapshot | undefined
  /**
   * Applies a marked row (`row.marker`: the held row the request was built
   * from) as a row of that version, by the path of `put` (P4-B spec §6.7).
   * It writes only while the store still holds that version with the same
   * values and no mark newer than the start of the read hides them;
   * otherwise it writes nothing, returns `"rejected"` and queues the key for
   * a re-read without `known`. `put` routes a marked row here.
   */
  applyMarker(
    scope: Scope,
    row: ServerRow,
    readEpoch: number,
    lazyRead: boolean
  ): PutResult
  /**
   * Writes a row of an own command result (P4-B spec §7.2 step 3) by the version rule, without the read path's lifting of marks:
   * `hidden`, `removed`, `stale` marks and tombstones stay. `"unowned"` — no
   * entry or no owner: nothing to write, the row of the answer stands
   * (§7.2 step 5). `"skipped"` — not written, the caller re-reads the key:
   * `removed` or `hidden`, a key or pair tombstone newer than `readEpoch`, a
   * scope move, or a row epoch other than the session's (for an unowned key
   * too, once the session has one) and the stored row's. `"older"` — the
   * store holds a newer version.
   */
  writeBack(
    scope: Scope,
    row: ServerRow,
    readEpoch: number
  ): "written" | "older" | "unowned" | "skipped"
  /**
   * Marks the key `stale` after an own write of `version` in `epoch` that the
   * store did not take and no read confirmed (P4-B spec §7.2 step 4): the
   * minimal version mark when `epoch` is the session's and the stored row's
   * (a later read of that version clears it), the epoch mark otherwise —
   * versions of different epochs do not compare, and a read of the current
   * epoch clears it.
   */
  markUnconfirmed(scope: Scope, key: Key, version: number, epoch: string): void
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
  /**
   * The horizon reaction of the store (§6.2 rule 1) for keys that have an
   * entry: hides the values and queues the tail re-read, counted as
   * `horizon-hidden`. Returns the keys that have an entry.
   */
  hideByHorizon(scope: Scope, keys: readonly Key[]): Key[]
  /**
   * Marks rows of held channels — of `channel` only when given — with a gap
   * at a fresh epoch each (P4-B spec §8.4).
   */
  markDisconnected(
    scope: Scope,
    channelOf: (e: RowEntry) => string,
    channel?: string
  ): void
  /**
   * Marks the rows of `channel` with the gap `at` of a released channel that
   * is held again (never lowering a newer mark).
   */
  markChannel(
    scope: Scope,
    channelOf: (e: RowEntry) => string,
    channel: string,
    at: number
  ): void
  /** The store holds a row (a removed slot too) of `channel`. */
  holdsChannel(channelOf: (e: RowEntry) => string, channel: string): boolean
  /**
   * Adds an owner to an existing entry; a key without an entry gets nothing.
   * Callers own a key only after its `put` was accepted.
   */
  own(scope: Scope, key: Key): void
  /** At zero owners: the version goes to memory; a removed slot is also buried. */
  disown(scope: Scope, key: Key): void
  /**
   * Hides the values of the keys until a read that starts after this call:
   * a fresh epoch even over an existing mark (a read that
   * started between the two would otherwise lift the newer one), and a
   * `Epochs.hiddenSince` mark for every key, entry or not — the entry may go
   * away (`disown`) before the old read arrives. Keys with an entry go to the
   * tail re-read; no `horizon-hidden` is logged. Returns the keys that have an
   * entry.
   */
  hideKeys(scope: Scope, keys: readonly Key[]): Key[]
  /**
   * Puts a row of a core snapshot (the hydration): the slot is new, so no
   * version rule applies. A `removed` or `hidden` state is marked with the
   * epoch `at` of the hydration, which only a read that started after it
   * lifts; a stale row gets the one mark "not proved since the hydration"
   * (the version it was served with, cleared by a read of that version
   * started after `at`). The slot has no owner yet and joins no tail re-read:
   * the check after the hydration re-reads the visible views.
   */
  restore(scope: Scope, init: RestoredRow, at: number): void
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
  session: Pick<
    Session,
    "epochs" | "versions" | "onFlush" | "onClose" | "onSwitch"
  >
  log: (entry: CoreLogEntry) => void
  defects?: Defects
  /** Inspection only: a fresh "row absent" answer re-marked a `removed` slot. */
  onRemark?: (key: Key) => void
}): ObjectStore {
  const { object, entry, session, log, onRemark } = options
  const { epochs, versions } = session
  const defects = options.defects ?? NO_DEFECTS
  const bury = (id: string, at?: number) => {
    if (!defects.has("no-tombstone")) epochs.bury(id, at)
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
  const rowChannel = channelOf(entry)

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

  // Перемикання епохи: рядки без епохи читались до нього, тож
  // належать покинутій; позначки мінімальної версії старої епохи скидаються,
  // а кожен рядок — `stale`, доки його не підтвердить читання нової.
  session.onSwitch((previous) => {
    for (const e of rows.values()) {
      e.versionEpoch = effectiveEpoch(e.versionEpoch, previous)
      if (e.row !== undefined)
        e.row = {
          ...e.row,
          versionEpoch: effectiveEpoch(e.row.versionEpoch, previous),
        }
      for (const field of lazyFields) {
        if (e.lazyVersions.has(field))
          e.lazyEpochs.set(
            field,
            effectiveEpoch(e.lazyEpochs.get(field), previous)
          )
      }
      delete e.stale.minVersion
      e.stale.epoch = true
    }
  })

  // Епоха, яку тримає новий слот: до перемикання — епоха пам'яті версій; після
  // — покинута, бо `null`-відповідь не доводить, що рядок з поточної.
  const freshHeld = (id: string) =>
    versions.previous() ?? epochs.seen(id)?.versionEpoch ?? null

  // Позначка `epoch` після запису: підтвердження знімає, інше після
  // перемикання ставить.
  function markEpoch(e: RowEntry, row: ServerRow, readEpoch: number) {
    if (versions.proves(row.versionEpoch, readEpoch)) delete e.stale.epoch
    else if (versions.previous() !== null) e.stale.epoch = true
  }

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
    const { minVersion, hidden: mark } = e.stale
    // Позначка іншої епохи версій не порівнюється з версією рядка.
    if (
      minVersion !== undefined &&
      (differentEpochs(minVersion.versionEpoch, e.versionEpoch) ||
        (e.version >= minVersion.v && readEpoch >= minVersion.epoch))
    )
      delete e.stale.minVersion
    if (
      mark !== undefined &&
      (readEpoch >= mark.epoch || defects.has("hide-lifted-by-older-read"))
    )
      delete e.stale.hidden
    markChannels(e, readEpoch)
  }

  // «Розрив» за відповіддю (§8.4): запис утримуваного каналу знімає лише
  // читання, що почалось не раніше приєднання після позначки, запис
  // відпущеного — читання після відпускання (сигналів він не чекає). Рядок,
  // записаний читанням, якого власний канал не доводить (утримуваний у
  // розриві чи читання до приєднання; відпущений із записом — читання, що
  // почалось до відпускання в недоведеному розриві), дістає позначку: її
  // зніме перше читання після наступного приєднання чи після відпускання.
  function markChannels(e: RowEntry, readEpoch: number) {
    // Об'єкт без сигналів каналу не має: розриву в нього не буває.
    if (!entry.signal) return
    const marks = e.stale.disconnect
    if (marks === undefined && !epochs.gapped()) return
    if (marks !== undefined)
      for (const [channel, at] of marks)
        if (epochs.liftsMark(channel, at, readEpoch)) marks.delete(channel)
    const own = rowChannel(e)
    if (!epochs.channelProven(own, readEpoch)) {
      const held = marks ?? new Map<string, number>()
      // Відпущений канал із записом: позначка — епоха відпускання; її знімає
      // читання після неї, а повторне утримання стає розривом тієї ж епохи.
      const g = epochs.held(own) ? epochs.gapAt(own) : epochs.releasedAt(own)
      held.set(own, Math.max(held.get(own) ?? 0, g))
      e.stale.disconnect = held
    } else if (marks !== undefined && marks.size === 0)
      delete e.stale.disconnect
  }

  // Горизонт, а не `hideKeys`: рахується в метриці `horizon-hidden`.
  function hideByHorizon(e: RowEntry, key: Key) {
    e.stale.hidden = { epoch: epochs.next() }
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
    const memory = epochs.seen(id)
    // Пам'ять іншої непорожньої епохи відповіді не стосується; `null`
    // порівнюється з пам'яттю будь-якої епохи.
    const known =
      memory === undefined ||
      differentEpochs(memory.versionEpoch, row.versionEpoch)
        ? undefined
        : memory
    const held = freshHeld(id)
    const e: RowEntry = {
      row: { ...row, versionEpoch: effectiveEpoch(row.versionEpoch, held) },
      scope: scopeId,
      version: row.version,
      versionEpoch: effectiveEpoch(row.versionEpoch, held),
      writtenEpoch: readEpoch,
      owners: 0,
      lazyVersions: new Map(),
      lazyEpochs: new Map(),
      stale: {},
    }
    setLazy(e, row, lazyRead)
    markEpoch(e, row, readEpoch)
    markChannels(e, readEpoch)
    const lower = known !== undefined && row.version < known.version
    if (lower)
      e.stale.minVersion = {
        v: known.version,
        epoch: epochs.next(),
        versionEpoch: heldEpoch(known.versionEpoch),
      }
    // Читання старше за горизонт кошика ключа чи пари: витіснений надгробок
    // міг належати видаленому чи прибраному рядку, тож значення ховаємо до
    // перечитування — навіть коли пам'ять версій ключ ще знає.
    const horizon =
      epochs.evictedSince(id, readEpoch) ||
      epochs.evictedSince(pairId(object, scopeId), readEpoch)
    if (horizon) hideByHorizon(e, row.key)
    // `hide` ключа новіший за читання: запис сховища міг зникнути після нього
    // (`disown`), але права не повертаються з читання, що почалось раніше.
    const rights = epochs.hiddenSince(id, readEpoch)
    if (rights && !horizon) {
      e.stale.hidden = { epoch: epochs.next() }
      tail.add(row.key)
    }
    // Епоха самої позначки `Epochs` тут невідома: новіша за неї — з запасом.
    if (rights) e.hiddenAt = epochs.now()
    rows.set(row.key, e)
    if (!lower && !horizon && !rights) return "written"
    tail.add(row.key)
    return "stale-inserted"
  }

  const listColumns = [
    entry.keyName,
    entry.versionName,
    ...entry.attributes.filter((a) => a.load !== "lazy").map((a) => a.name),
  ]

  const copyNames = new Set(
    entry.attributes.filter((a) => a.copy === true).map((a) => a.name)
  )

  // Копія повна для форми читання: усі колонки переліку, а для картки ще
  // кожне ліниве поле, прочитане з версією рядка.
  function complete(e: RowEntry, form: "list" | "card"): boolean {
    const values = e.row?.values
    if (values === undefined) return false
    if (!listColumns.every((name) => Object.hasOwn(values, name))) return false
    return (
      form === "list" ||
      lazyFields.every((f) => Object.hasOwn(values, f) && !lazyFieldStale(e, f))
    )
  }

  // Сховище досі тримає рядок, з якого збудовано `known`: та сама версія й
  // епоха, ті самі значення колонок.
  function holdsMarked(e: RowEntry, row: ServerRow, held: ServerRow): boolean {
    if (e.removed !== undefined || e.row === undefined) return false
    if (e.version !== held.version || e.versionEpoch !== row.versionEpoch)
      return false
    const values = e.row.values
    // Копії носія змінюються без підвищення версії й їх несе сам маркер: два
    // вигляди одного ключа читають за один такт, і другий маркер бачив би вже
    // записану першим копію.
    return Object.keys(held.values).every(
      (name) =>
        copyNames.has(name) ||
        (Object.hasOwn(values, name) &&
          Object.is(values[name], held.values[name]))
    )
  }

  function markerPut(
    scope: Scope,
    row: ServerRow,
    readEpoch: number,
    lazyRead: boolean
  ): PutResult {
    scope.assert()
    const held = row.marker!
    const e = rows.get(row.key)
    // Без запису значень немає: прибраний `purge` ключ відновлює лише
    // читання за ключем, яке почалось після нього.
    if (e === undefined) return "rejected"
    const mark = e.stale.hidden
    const newer = mark !== undefined && mark.epoch > readEpoch
    const lifts = newer && defects.has("marker-lifts-newer-mark")
    if (!holdsMarked(e, row, held) || (newer && !lifts)) {
      tail.add(row.key)
      return "rejected"
    }
    // Дефект самотесту: маркер знімає позначку, новішу за старт читання.
    if (lifts) delete e.stale.hidden
    return store.put(
      scope,
      {
        key: row.key,
        version: row.version,
        versionEpoch: effectiveEpoch(row.versionEpoch, e.versionEpoch),
        values: row.values,
      },
      readEpoch,
      lazyRead
    )
  }

  const store: ObjectStore = {
    knownFor(keys, options) {
      const epoch = versions.current()
      if (epoch === null) return undefined
      const known = { epoch, keys: [] as string[], versions: [] as string[] }
      const held: ServerRow[] = []
      const seen = new Set<string>()
      for (const key of keys) {
        if (held.length >= READ_LIMIT_MAX) break
        const e = rows.get(key)
        if (
          !options.owned.has(key) ||
          e === undefined ||
          e.row === undefined ||
          e.removed !== undefined ||
          e.stale.hidden !== undefined ||
          e.stale.minVersion !== undefined ||
          e.stale.epoch !== undefined ||
          e.versionEpoch !== epoch ||
          seen.has(key.toLowerCase()) ||
          !complete(e, options.form)
        )
          continue
        seen.add(key.toLowerCase())
        known.keys.push(key)
        known.versions.push(String(e.version))
        held.push(e.row)
      }
      return held.length === 0 ? undefined : { known, held }
    },

    applyMarker: markerPut,

    put(scope, row, readEpoch, lazyRead) {
      if (row.marker !== undefined)
        return markerPut(scope, row, readEpoch, lazyRead)
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
        if (e.stale.hidden === undefined) hideByHorizon(e, row.key)
        else tail.add(row.key)
        return "stale-inserted"
      }
      if (e === undefined)
        return insert(row, incomingScope ?? null, readEpoch, lazyRead)
      // Після перемикання `null`-відповідь не впорядкована з рядком поточної
      // епохи: не заміняє його, а ключ стає `stale`. Перечитування —
      // одне на позначку: репліка знову відповіла б `null`.
      if (
        row.versionEpoch == null &&
        versions.previous() !== null &&
        e.versionEpoch === versions.current()
      ) {
        if (e.stale.epoch !== undefined) return "rejected"
        e.stale.epoch = true
        tail.add(row.key)
        return "stale-inserted"
      }
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
          e.stale.minVersion = {
            v: e.version,
            epoch: epochs.next(),
            versionEpoch: heldEpoch(e.versionEpoch),
          }
          tail.add(row.key)
          result = "stale-inserted"
        }
        if (e.removed.divergent) restored++
        delete e.removed
        // Репліка без епохи не стирає епохи слота.
        e.row = {
          ...row,
          versionEpoch: effectiveEpoch(row.versionEpoch, e.versionEpoch),
        }
      } else {
        const merged =
          mergeVersioned(e.row, row) ??
          (defects.has("version-decrease")
            ? {
                ...row,
                versionEpoch: effectiveEpoch(
                  row.versionEpoch,
                  e.row?.versionEpoch
                ),
                values: { ...e.row?.values, ...row.values },
              }
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
      markEpoch(e, row, readEpoch)
      if (!moved) return result
      hideByHorizon(e, row.key)
      return "stale-inserted"
    },

    writeBack(scope, row, readEpoch) {
      scope.assert()
      const e = rows.get(row.key)
      const epoch = row.versionEpoch
      if (e === undefined || e.owners === 0) {
        // Без власника писати нікуди; відповідь іншої епохи, ніж поточна
        // епоха сесії, перевіряє лише перечитування за ключем.
        const current = versions.current()
        return epoch == null || (current !== null && epoch !== current)
          ? "skipped"
          : "unowned"
      }
      // Позначки знімає лише читання, що почалось після них:
      // результат запису читанням не є, тож ключ іде на перечитування.
      const liftsHidden = defects.has("write-back-lifts-hidden")
      if (
        e.removed !== undefined ||
        (e.stale.hidden !== undefined && !liftsHidden)
      )
        return "skipped"
      if (buried(row.key, e.scope, readEpoch)) return "skipped"
      // Витіснений надгробок ключа чи пари, новіший за старт спроби, міг
      // належати purge чи надгробку знову відкритої пари (§6.2, правило 1 і 4):
      // горизонт його кошика заступає надгробок, тож рядок результату не
      // пишеться, а ключ перечитується — як і `marked` журналу.
      if (
        epochs.evictedSince(keyId(object, row.key), readEpoch) ||
        epochs.evictedSince(pairId(object, e.scope), readEpoch)
      )
        return "skipped"
      const incoming =
        scopeField !== undefined && Object.hasOwn(row.values, scopeField)
          ? scopeOf(entry, row.values)
          : e.scope
      // Переїзд скоупу перевіряє надгробок нової пари й горизонт — це шлях
      // читання, а не запису результату.
      if (incoming !== e.scope) return "skipped"
      // Версії порівнянні лише в одній епосі (Рд24): епоха результату мусить
      // бути і поточною епохою сесії, і епохою збереженого рядка.
      if (
        epoch == null ||
        epoch !== versions.current() ||
        e.versionEpoch !== epoch
      )
        return "skipped"
      const merged = mergeVersioned(e.row, row)
      if (merged === undefined) return "older"
      e.row = merged
      e.version = merged.version
      e.writtenEpoch = Math.max(e.writtenEpoch, readEpoch)
      // Дефект самотесту: запис результату знімає позначку `hide`.
      if (liftsHidden) delete e.stale.hidden
      return "written"
    },

    markUnconfirmed(scope, key, version, epoch) {
      scope.assert()
      const e = rows.get(key)
      if (e === undefined) return
      if (epoch === versions.current() && e.versionEpoch === epoch) {
        if (e.version >= version) return
        const prior = e.stale.minVersion
        e.stale.minVersion = {
          v:
            prior !== undefined && prior.versionEpoch === epoch
              ? Math.max(prior.v, version)
              : version,
          epoch: epochs.next(),
          // Гілка лише за рівності: епоха позначки — власна епоха запису.
          versionEpoch: heldEpoch(e.versionEpoch),
        }
        return
      }
      e.stale.epoch = true
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

    hideByHorizon(scope, keys) {
      scope.assert()
      const hiddenKeys: Key[] = []
      for (const key of keys) {
        const e = rows.get(key)
        if (e === undefined) continue
        if (e.stale.hidden === undefined) hideByHorizon(e, key)
        else tail.add(key)
        hiddenKeys.push(key)
      }
      return hiddenKeys
    },

    markStale(scope, keys, minVersion) {
      scope.assert()
      for (const key of keys) {
        const e = rows.get(key)
        if (e === undefined || e.version >= minVersion) continue
        const v = Math.max(e.stale.minVersion?.v ?? minVersion, minVersion)
        // Версія сигналу — версія поточної епохи.
        e.stale.minVersion = {
          v,
          epoch: epochs.next(),
          versionEpoch: effectiveEpoch(versions.current(), e.versionEpoch),
        }
      }
    },

    markDisconnected(scope, channelOf, channel) {
      scope.assert()
      for (const e of rows.values()) {
        const own = channelOf(e)
        if (channel !== undefined && own !== channel) continue
        // Канал, якого приймач не тримає, сигналів не чекає: розриву в нього
        // немає (рядок — ціль `include` об'єкта без власного вигляду).
        if (!epochs.held(own)) continue
        const marks = e.stale.disconnect ?? new Map<string, number>()
        marks.set(own, epochs.next())
        e.stale.disconnect = marks
      }
    },

    markChannel(scope, channelOf, channel, at) {
      scope.assert()
      for (const e of rows.values()) {
        if (channelOf(e) !== channel) continue
        const marks = e.stale.disconnect ?? new Map<string, number>()
        marks.set(channel, Math.max(marks.get(channel) ?? 0, at))
        e.stale.disconnect = marks
      }
    },

    holdsChannel(channelOf, channel) {
      for (const e of rows.values()) if (channelOf(e) === channel) return true
      return false
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
      // повернення ключа втратила б свою мінімальну версію. Пам'ять — лише
      // поточної епохи: версія покинутої не впорядкована з відповідями нової,
      // а пам'ять поточної вона б витіснила.
      const min = e.stale.minVersion
      if (!differentEpochs(e.versionEpoch, versions.current()))
        epochs.remember(
          id,
          min === undefined || differentEpochs(min.versionEpoch, e.versionEpoch)
            ? e.version
            : Math.max(e.version, min.v),
          e.versionEpoch
        )
      // Слот removed без надгробка дав би старій відповіді повернути значення.
      // Епоха — позначки `removed`, а не поточна: позначка доводить відсутність
      // лише для читань, що почались до неї; читання між позначкою і
      // поховання, що повернуло рядок, — новіший доказ і мусить його відновити.
      if (e.removed !== undefined)
        bury(
          id,
          defects.has("bury-removed-current-epoch")
            ? undefined
            : e.removed.epoch
        )
      rows.delete(key)
      tail.delete(key)
    },

    hideKeys(scope, keys) {
      scope.assert()
      const hiddenKeys: Key[] = []
      for (const key of keys) {
        const at = epochs.hide(keyId(object, key))
        const e = rows.get(key)
        if (e === undefined) continue
        e.stale.hidden = { epoch: at }
        e.hiddenAt = at
        tail.add(key)
        hiddenKeys.push(key)
      }
      return hiddenKeys
    },

    restore(scope, init, at) {
      scope.assert()
      const e: RowEntry = {
        row:
          init.row === undefined
            ? undefined
            : {
                ...init.row,
                versionEpoch: effectiveEpoch(
                  init.row.versionEpoch,
                  init.versionEpoch
                ),
              },
        scope: init.scope,
        version: init.version,
        versionEpoch: heldEpoch(init.versionEpoch),
        writtenEpoch: at,
        owners: 0,
        lazyVersions: new Map(init.lazyVersions),
        lazyEpochs: new Map(),
        stale: {},
      }
      for (const [field, epoch] of init.lazyIn)
        e.lazyEpochs.set(field, effectiveEpoch(epoch, e.versionEpoch))
      if (init.state === "removed") e.removed = { epoch: at, divergent: false }
      if (init.state === "hidden") {
        e.stale.hidden = { epoch: at }
        e.hiddenAt = at
      }
      if (init.stale)
        e.stale.minVersion = {
          v: init.version,
          epoch: at,
          versionEpoch: heldEpoch(init.versionEpoch),
        }
      rows.set(init.key, e)
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
  return store
}
