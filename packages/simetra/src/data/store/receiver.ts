import {
  ZERO_UUID,
  channelTopic,
  parseTopic,
  receivedChangeSchema,
  receivedInvalidateSchema,
  type CatalogEntry,
  type CatalogIndex,
  type SignalError,
  type SignalTransport,
  type Unsubscribe,
} from "simetra/model"
import { differentEpochs, keyId, pairId } from "./epoch"
import { evaluateFilter, fieldInfoOf } from "./filter"
import type { ObjectState } from "./forms"
import { scopeOf, visibleRow, type RowEntry } from "./object-store"
import { canSubscribe } from "./rights"
import { ReadLimiterClosed, readKeys, tracked } from "./source"
import type {
  CoreLogEntry,
  GenerationToken,
  Key,
  ObjectName,
  RightsState,
  ServerRow,
  Values,
  ViewSpec,
  Writer,
} from "./types"
import {
  activeViews,
  revalidate,
  singleFlight,
  type WriterContext,
} from "./writer"

/*
 * Приймач сигналів (спека П4-B §8.4): модуль ядра, не рантайму. Життєвий
 * цикл і підписки — які канали змін тримати за знімком прав і активними
 * виглядами; розбір повідомлень, пачка й кроки 1–7 обробки пачки об'єкта.
 * Приєднання (хвиля — стан ядра; `recovered` для свіжості не береться, Рд37),
 * розрив і відмови каналів.
 */

/** Тиша, після якої пачка сигналів закривається. */
export const QUIET_MS = 50
/** Найдовша пачка: безперервний потік закривається не пізніше. */
export const MAX_BATCH_MS = 2000
/** Скільки разів дочитується ключ з очікуваною мінімальною версією. */
export const MIN_VERSION_RETRIES = 3
/** Джитер приєднання: одна хвиля перечитує свої об'єкти за строком у цьому вікні. */
export const REJOIN_JITTER_MS = 2000
/** Вікно дедуплікації: стільки останніх `id` повідомлень. */
export const SEEN_SIGNALS_MAX = 4096

// Пауза перед n-м дочитуванням — `500 × 2^(n−1)` мс.
const MIN_VERSION_PAUSE_MS = 500

/** What the receiver needs from the core. */
export interface ReceiverContext {
  /** The transport of the runtime's subject; the runtime owns and closes it. */
  readonly transport: SignalTransport
  readonly index: CatalogIndex
  readonly writer: WriterContext
  rights(): RightsState | undefined
  /** Whether the host shows the application: a hidden tab reads nothing. */
  visible(): boolean
  /** The core's `commit`: the only way the receiver writes. */
  commit(fn: (writer: Writer) => void, token: GenerationToken): boolean
  /** The collator of the runtime's filter tests (one per runtime). */
  readonly filterCollator: Intl.Collator
  /** A channel joined (with or without `recovered`): its object joins the rejoin wave. */
  joinWave(object: ObjectName): void
  /** The core's `requestVersion` (a refusal without a channel, §10). */
  requestVersion(): void
  /** The transport refused the connection for good: the runtime closes. */
  connectionRefused(): void
}

export interface Receiver {
  /** The set of active views or the rows they show may have changed. */
  touch(): void
  /** A rights snapshot (the first one too) replaced the current one. */
  snapshotReplaced(): void
  /**
   * A pair (scope, object) or keys were purged: their unclosed signals and
   * min-version re-reads are dropped, so nothing of them is read or written
   * afterwards. One hook for every purge (a rights snapshot, a refused channel).
   */
  purged(
    object: ObjectName,
    target: { keys: readonly Key[] } | { scope: string | null }
  ): void
  /** A core tick: writes `stale-age` while an own mark exists. */
  tick(): void
  /** Drops every subscription; the receiver sees nothing afterwards. */
  stop(): void
}

// Підписка каналу: `off` з'являється після повернення `subscribe`, а відмова
// `auth` може прийти раніше (фейк кличе її синхронно, справжній транспорт —
// пізніше), тож приймач не залежить від порядку.
interface Held {
  off: Unsubscribe | undefined
}

// Що пачка знає про ключ: найбільша версія серед сигналів не `delete`
// (`-1` — були лише `delete`), чи був `delete` і яке це дочитування
// мінімальної версії (0 — сигнал).
interface KeySignal {
  version: number
  deleted: boolean
  attempt: number
  // Пари (скоупи каналів), з яких прийшли сигнали ключа: `purge` пари скидає
  // лише їх (`null` — нескоуплений об'єкт).
  readonly scopes: Set<string | null>
}

interface ObjectBatch {
  readonly keys: Map<Key, KeySignal>
  // Скоупи, з яких прийшов `invalidate`; порожньо — не було.
  readonly invalidate: Set<string | null>
}

type Batch = Map<ObjectName, ObjectBatch>

const objectBatch = (batch: Batch, object: ObjectName): ObjectBatch => {
  let found = batch.get(object)
  if (found === undefined) {
    found = { keys: new Map(), invalidate: new Set() }
    batch.set(object, found)
  }
  return found
}

const addKey = (into: ObjectBatch, key: Key, signal: KeySignal) => {
  const prev = into.keys.get(key)
  into.keys.set(
    key,
    prev === undefined
      ? { ...signal, scopes: new Set(signal.scopes) }
      : {
          scopes: new Set([...prev.scopes, ...signal.scopes]),
          version: Math.max(prev.version, signal.version),
          deleted: prev.deleted || signal.deleted,
          // Свіжий сигнал знову дає ключу всі дочитування.
          attempt: Math.min(prev.attempt, signal.attempt),
        }
  )
}

const mergeBatch = (into: Batch, from: Batch) => {
  for (const [object, source] of from) {
    const target = objectBatch(into, object)
    for (const scope of source.invalidate) target.invalidate.add(scope)
    for (const [key, signal] of source.keys) addKey(target, key, signal)
  }
}

// Одна пачка, що збирається: тиша й найдовший строк — сни сесії, тож
// закриття сесії таймерів не лишає.
interface Open {
  readonly batch: Batch
  quiet: AbortController | undefined
  readonly max: AbortController
}

// Що робити з об'єктом пачки: ключі у сховищі (кроки 1–3), нові ключі
// (крок 5) і чи читати об'єкт цілим (кроки 6–7).
interface Plan {
  readonly stored: Key[]
  readonly fresh: Key[]
  readonly whole: boolean
}

// Читання ключів одного об'єкта в польоті.
interface Job {
  readonly object: ObjectName
  readonly o: ObjectState
  readonly plan: Plan
  readonly signals: ObjectBatch
  readonly readEpoch: number
  readonly epochs: Set<string | null>
  readonly rows: Promise<ServerRow[] | undefined>
}

// Час власних позначок приймача (`minVersion` і «розрив»): рядок моделі часу
// не має, а метриці (Р13) потрібен вік найстарішої. Окремо від життєвого
// циклу позначок: запис живий, лише поки позначка ще є в сховищі.
interface MarkTimes {
  noteMinVersion(object: ObjectName, key: Key): void
  noteDisconnect(channel: string | undefined): void
  /** Найстаріша жива позначка; мертві записи прибираються тут. */
  oldest(): { at: number; object?: ObjectName } | undefined
  clear(): void
}

function createMarkTimes(
  writer: WriterContext,
  pairOf: (channel: string) => { object: ObjectName } | undefined
): MarkTimes {
  // Ключ `object\0key` чи канал; `*` — розрив усього з'єднання.
  const minVersion = new Map<
    string,
    { at: number; object: ObjectName; key: Key }
  >()
  const gaps = new Map<string, number>()
  const hasMinVersion = (object: ObjectName, key: Key) =>
    writer.objectOf(object).rows.get(key)?.stale.minVersion !== undefined
  const hasGap = (channel: string) => {
    for (const o of writer.objects.values())
      for (const key of o.rows.keys()) {
        const marks = o.rows.get(key)?.stale.disconnect
        if (marks !== undefined && (channel === "*" || marks.has(channel)))
          return true
      }
    return false
  }
  return {
    noteMinVersion(object, key) {
      const id = `${object}\u0000${key}`
      const prev = minVersion.get(id)
      // Позначка, що вже була, зберігає свій час.
      if (prev !== undefined && hasMinVersion(object, key)) return
      if (hasMinVersion(object, key))
        minVersion.set(id, { at: writer.now(), object, key })
    },
    noteDisconnect(channel) {
      const id = channel ?? "*"
      if (gaps.has(id) && hasGap(id)) return
      if (hasGap(id)) gaps.set(id, writer.now())
    },
    clear() {
      minVersion.clear()
      gaps.clear()
    },
    oldest() {
      let found: { at: number; object?: ObjectName } | undefined
      const take = (at: number, object?: ObjectName) => {
        if (found === undefined || at < found.at) found = { at, object }
      }
      for (const [id, m] of [...minVersion]) {
        if (!hasMinVersion(m.object, m.key)) minVersion.delete(id)
        else take(m.at, m.object)
      }
      for (const [id, at] of [...gaps]) {
        if (!hasGap(id)) gaps.delete(id)
        else take(at, id === "*" ? undefined : pairOf(id)?.object)
      }
      return found
    },
  }
}

export function createReceiver(ctx: ReceiverContext): Receiver {
  const { transport, writer } = ctx
  const entries = [...ctx.index.byId.values()].filter((e) => e.signal)
  const catalog = { objects: entries }
  const held = new Map<string, Held>()
  // Канал, відхилений `auth`, не повторюється до наступної заміни знімка.
  const refused = new Set<string>()
  let stopped = false
  let planned = false
  const { session, limits } = writer
  // Запис і відповіді дійсні, поки приймач живий: `stop()` гасить їх разом.
  const token = session.childToken(() => !stopped)
  const collator = ctx.filterCollator

  const scopesOfRows = (entry: CatalogEntry): string[] => {
    const o = writer.objectOf(`${entry.kind}.${entry.name}`)
    const scopes = new Set<string>()
    for (const view of activeViews(writer, o.name)) {
      for (const key of view.keys) {
        const row = o.rows.get(key)
        const values = row === undefined ? undefined : visibleRow(row)
        if (row?.scope != null && values !== undefined) scopes.add(row.scope)
      }
    }
    return [...scopes]
  }

  // Канали за знімком прав (§8.4): скоупи `scopeSets` виду об'єкта, нескоуплений
  // — `ZERO_UUID`; скоуплений `publicRead` — ще скоупи рядків активних
  // виглядів. Кожен канал — через `canSubscribe`, дзеркало SQL.
  const wanted = (): Set<string> => {
    const channels = new Set<string>()
    const state = ctx.rights()
    if (state === undefined) return channels
    const { snapshot } = state
    const withViews = new Set<CatalogEntry>()
    for (const s of writer.registry.subsets())
      if (s.alive && !s.purged) withViews.add(s.form.object.entry)
    for (const entry of entries) {
      if (!withViews.has(entry)) continue
      const kind = entry.scopeKindId
      const scopes = new Set<string>(
        kind === undefined
          ? [ZERO_UUID]
          : snapshot.scopeSets
              .filter((s) => s.scopeKind === kind)
              .map((s) => s.scope)
      )
      if (kind !== undefined && entry.publicRead !== undefined)
        for (const scope of scopesOfRows(entry)) scopes.add(scope)
      for (const scope of scopes) {
        const channel = channelTopic({
          kind: "changes",
          scopeKindId: kind ?? ZERO_UUID,
          scope,
          object: entry.id,
        })
        if (canSubscribe(snapshot, channel, catalog)) channels.add(channel)
      }
    }
    return channels
  }

  // Об'єкт і скоуп пари каналу змін; `null` — нескоуплений об'єкт (`ZERO_UUID`).
  const pairOf = (channel: string) => {
    const parsed = parseTopic(channel)
    if (parsed?.kind !== "changes") return undefined
    const entry = ctx.index.byId.get(parsed.object)
    if (entry === undefined) return undefined
    return {
      object: `${entry.kind}.${entry.name}` as ObjectName,
      scope: entry.scopeColumn === undefined ? null : parsed.scope,
    }
  }

  const marks = createMarkTimes(writer, pairOf)

  const onError = (error: SignalError) => {
    if (stopped || !token.valid) return
    // Розрив: рядки каналу (чи всі) не знають, що пропустили (§8.4).
    if (error.kind === "transport") {
      if (error.channel !== undefined && !held.has(error.channel)) return
      ctx.commit((w) => w.markDisconnected(error.channel), token)
      marks.noteDisconnect(error.channel)
      return
    }
    // Друга відмова токена з'єднання поспіль: транспорт не відновиться.
    if (error.final === true) return ctx.connectionRefused()
    // Відмова без каналу — токен з'єднання: `version` звіряє користувача (§10),
    // N відмов однієї мікрозадачі — один запит.
    if (error.channel === undefined) return ctx.requestVersion()
    const slot = held.get(error.channel)
    if (slot === undefined) return
    held.delete(error.channel)
    refused.add(error.channel)
    slot.off?.()
    // Дані пари, на які права зникли, не лишаються в пам'яті (Р12); `purge`
    // скидає й незакриту пачку пари через `purged`. Рядки розриву каналу
    // прибирає той самий `purge`: окремого зняття позначок немає, тож і кадру
    // з ними як свіжими.
    const channel = error.channel
    const pair = pairOf(channel)
    ctx.commit((w) => {
      if (pair !== undefined) w.purge(pair.object, { scope: pair.scope })
      w.releaseChannel(channel)
    }, token)
  }

  // Канал (пере)підписано — з `recovered` чи без, зокрема тихе повторне
  // приєднання: `joinAt` каналу — нова епоха (Рд37: `recovered` для свіжості не
  // береться), а його об'єкт іде в хвилю приєднання ядра. Знімає позначки
  // лише читання, що почалось після цієї епохи.
  const offSubscribed = transport.onSubscribed(({ channel }) => {
    if (stopped || !token.valid || !held.has(channel)) return
    const pair = pairOf(channel)
    if (pair === undefined) return
    session.epochs.join(channel)
    ctx.joinWave(pair.object)
  })

  // ------------------------------------------------------------ пачка

  const seen = new Set<string>()
  // Дублікат за `id` відкидається; вікно — останні `SEEN_SIGNALS_MAX`.
  const isDuplicate = (id: string): boolean => {
    if (seen.has(id)) return true
    seen.add(id)
    if (seen.size > SEEN_SIGNALS_MAX) {
      const [oldest] = seen
      if (oldest !== undefined) seen.delete(oldest)
    }
    return false
  }

  let open: Open | undefined
  // Закриті пачки, що чекають осідання читання в польоті, зливаються в одну:
  // «один запит на вигляд за пачку» тримається і під зворотним тиском.
  let waiting: Batch | undefined
  let flying = false

  const closeOpen = (batch: Open) => {
    if (open !== batch) return
    open = undefined
    batch.quiet?.abort()
    batch.max.abort()
    if (stopped || !token.valid) return
    enqueue(batch.batch)
  }

  const startOpen = (): Open => {
    const max = new AbortController()
    const batch: Open = { batch: new Map(), quiet: undefined, max }
    void session.sleep(MAX_BATCH_MS, max.signal).then(() => {
      if (!max.signal.aborted) closeOpen(batch)
    })
    return batch
  }

  // Кожен сигнал відсуває закриття на `QUIET_MS`, але не далі за `MAX_BATCH_MS`
  // від першого.
  const collect = (fill: (batch: Batch) => void) => {
    if (stopped || !token.valid) return
    open ??= startOpen()
    const batch = open
    fill(batch.batch)
    batch.quiet?.abort()
    const quiet = new AbortController()
    batch.quiet = quiet
    void session.sleep(QUIET_MS, quiet.signal).then(() => {
      if (!quiet.signal.aborted) closeOpen(batch)
    })
  }

  function enqueue(batch: Batch) {
    waiting ??= new Map()
    mergeBatch(waiting, batch)
    pump()
  }

  function pump() {
    if (flying || waiting === undefined || stopped || !token.valid) return
    const batch = waiting
    waiting = undefined
    flying = true
    run(batch)
      .catch((error: unknown) => writer.log({ kind: "listener-failed", error }))
      .finally(() => {
        flying = false
        pump()
      })
  }

  // ------------------------------------------------------------ розбір

  // Повідомлення каналу змін (§8.1): розібране схемою прийнятого повідомлення
  // — схема відправки `id` не несе й не пропустила б жодного.
  const onSignal = (topic: string, payload: unknown) => {
    if (stopped || !token.valid) return
    const channel = parseTopic(topic)
    // Топік поза моїми підписками (знятий канал, чужий формат) і канали прав
    // (їх бере блок прав) запиту не дають.
    if (channel?.kind !== "changes" || !held.has(topic)) return
    const entry = ctx.index.byId.get(channel.object)
    if (entry === undefined) return
    const object: ObjectName = `${entry.kind}.${entry.name}`
    // Пара сигналу — скоуп каналу; нескоуплений об'єкт скоупу не має.
    const scope = entry.scopeColumn === undefined ? null : channel.scope
    // Нерозібране — `invalidate` об'єкта топіка: сумісність уперед (§8.1).
    const invalidate = () =>
      collect((batch) => {
        objectBatch(batch, object).invalidate.add(scope)
      })
    const change = receivedChangeSchema.safeParse(payload)
    const parsed = change.success
      ? change
      : receivedInvalidateSchema.safeParse(payload)
    if (!parsed.success) return invalidate()
    if (isDuplicate(parsed.data.id)) return
    // Об'єкт повідомлення — не об'єкт топіка: довіряємо топіку (його
    // авторизував сервер), а не тілу, і читаємо весь об'єкт топіка.
    if (parsed.data.object.toLowerCase() !== channel.object) return invalidate()
    if (!change.success || parsed.data.op === "invalidate") return invalidate()
    const { op, keys, row_ver: version } = change.data
    const [column, value] = Object.entries(keys)[0] ?? []
    // Колонка, якої каталог не знає як ключ, — нерозібране.
    if (column !== entry.key || value === undefined) return invalidate()
    collect((batch) =>
      addKey(objectBatch(batch, object), value.toLowerCase(), {
        version: op === "delete" ? -1 : version,
        deleted: op === "delete",
        attempt: 0,
        scopes: new Set([scope]),
      })
    )
  }

  // ------------------------------------------------------------ кроки 1–7

  // Крок 2: ключ у сховищі (чи в пам'яті версій) з підтвердженою версією не
  // меншою за `row_ver` — відлуння. Версії різних епох не впорядковані, а
  // рядок з позначкою перемикання епохи чекає перечитування і так.
  const isEcho = (
    o: ObjectState,
    key: Key,
    e: RowEntry | undefined,
    version: number
  ): boolean => {
    if (e?.stale.epoch !== undefined) return false
    const known =
      e === undefined
        ? session.epochs.seen(keyId(o.name, key))
        : { version: e.version, versionEpoch: e.versionEpoch }
    if (known === undefined) return false
    if (differentEpochs(known.versionEpoch, session.versions.current()))
      return false
    return known.version >= version
  }

  const classify = (
    o: ObjectState,
    batch: ObjectBatch,
    hasViews: boolean
  ): Plan | undefined => {
    const stored: Key[] = []
    const fresh: Key[] = []
    for (const [key, signal] of batch.keys) {
      const e = o.rows.get(key)
      const live = e !== undefined && e.owners > 0 && e.removed === undefined
      // Крок 1: `delete` першим, до перевірки версії — він несе версію стану
      // «до». Ключа немає (зокрема власне відлуння) — нічого; ключ є —
      // перечитування, а `removed` лише за порожньою відповіддю.
      if (signal.deleted) {
        if (live) stored.push(key)
        else if (signal.version >= 0 && !isEcho(o, key, e, signal.version))
          fresh.push(key)
        continue
      }
      if (isEcho(o, key, e, signal.version)) continue
      // Кроки 3 і 5: ключ у сховищі з меншою версією і ключ, якого там немає.
      if (e !== undefined && e.owners > 0) stored.push(key)
      else fresh.push(key)
    }
    // Без вигляду новому ключу нікому підказувати `hasNewRows`.
    if (!hasViews) fresh.length = 0
    const count = stored.length + fresh.length
    // Кроки 6–7: `invalidate` чи пачка понад межу ключів читає об'єкт цілим.
    const whole = batch.invalidate.size > 0 || count > limits.keysPerRequest
    if (count === 0 && batch.invalidate.size === 0) return undefined
    return { stored, fresh, whole }
  }

  const startJob = (
    object: ObjectName,
    o: ObjectState,
    plan: Plan,
    signals: ObjectBatch
  ): Job => {
    const read = tracked(writer.source)
    const owned = new Set(plan.stored)
    return {
      object,
      o,
      plan,
      signals,
      readEpoch: session.epochs.now(),
      epochs: read.epochs,
      rows: readKeys(read.source, o.entry, [...plan.stored, ...plan.fresh], {
        keysPerRequest: limits.keysPerRequest,
        known: (keys) => o.rows.knownFor(keys, { owned, form: "list" }),
      }).catch((error: unknown) => {
        // Збій читання не губить сигнал мовчки: вигляди об'єкта позначено, а
        // журнал знає (як `reread` ключа після власного запису). Закриття
        // обмежувача — не збій: так закривається рантайм.
        if (!(error instanceof ReadLimiterClosed))
          writer.log({ kind: "listener-failed", error })
        return undefined
      }),
    }
  }

  // Крок 5: новий рядок у сховище не пишеться; `hasNewRows` лише тим виглядам
  // `full` і вікна, чий фільтр він проходить (§6.4).
  const markNewRow = (w: Writer, job: Job, row: ServerRow) => {
    const { object, o } = job
    // Пара, похована з початку читання, не «нова»: `hasNewRows` виказав би,
    // що заборонений рядок існує.
    if (
      session.epochs.buriedSince(
        pairId(object, scopeOf(o.entry, row.values)),
        job.readEpoch
      )
    )
      return
    for (const view of activeViews(writer, object)) {
      const spec = view.spec
      if (spec.kind !== "full" && spec.kind !== "window") continue
      if (!admits(o, spec, row.values)) continue
      w.markViews(object, { hasNewRows: true }, spec)
    }
  }

  const admits = (
    o: ObjectState,
    spec: Extract<ViewSpec, { kind: "full" | "window" }>,
    values: Values
  ) =>
    spec.where === undefined ||
    evaluateFilter(spec.where, values, fieldInfoOf(o.entry), collator)

  const retries = new Map<
    string,
    { chain: object; object: ObjectName; key: Key; scope: string | null }
  >()
  // Дочитування мінімальної версії: після паузи ключ іде в ту саму чергу
  // зведених пачок, а не окремим шляхом.
  const scheduleRetry = (
    object: ObjectName,
    key: Key,
    version: number,
    attempt: number
  ) => {
    const id = `${object}\u0000${key}`
    const chain = {}
    const scope = writer.objectOf(object).rows.get(key)?.scope ?? null
    retries.set(id, { chain, object, key, scope })
    void session.sleep(MIN_VERSION_PAUSE_MS * 2 ** (attempt - 1)).then(() => {
      if (retries.get(id)?.chain !== chain) return
      retries.delete(id)
      if (stopped || !token.valid) return
      // Позначку вже зняло інше читання — дочитувати нічого.
      const mark = writer.objectOf(object).rows.get(key)?.stale.minVersion
      if (mark === undefined || mark.v < version) return
      const batch: Batch = new Map()
      addKey(objectBatch(batch, object), key, {
        version,
        deleted: false,
        attempt,
        scopes: new Set([scope]),
      })
      enqueue(batch)
    })
  }

  // Відповідь читання ключів одного об'єкта: один шлюз епох на всю відповідь
  // (епохи частин і рядків), далі один `apply` з єдиною прийнятою епохою. Другий
  // шлюз усередині `Writer.apply` на вже прийнятих епохах нічого не змінює
  // (`acceptEpoch` — `apply` без побічних ефектів), тож відповідь без рядків
  // теж проходить шлюз за епохою частин.
  const settleJob = (
    w: Writer,
    job: Job,
    rows: readonly ServerRow[],
    retry: (object: ObjectName, key: Key, version: number, at: number) => void
  ) => {
    const { object, o, plan, signals } = job
    const epochs = new Set(job.epochs)
    for (const row of rows) epochs.add(row.versionEpoch ?? null)
    if (session.acceptEpochs(epochs, job.readEpoch) === "discard") return
    const versionEpoch = [...epochs].find((epoch) => epoch !== null) ?? null
    const isHeld = (key: Key) => (o.rows.get(key)?.owners ?? 0) > 0
    const returned = new Map(rows.map((row) => [row.key.toLowerCase(), row]))
    const absent = plan.stored.filter(
      (key) => isHeld(key) && !returned.has(key)
    )
    if (
      w.apply(object, { rows, absent }, job.readEpoch, versionEpoch) ===
      "discarded"
    )
      return
    for (const key of plan.stored) {
      const row = returned.get(key)
      const signal = signals.keys.get(key)
      if (row === undefined || signal === undefined || !isHeld(key)) continue
      // Крок 4: повернулась версія, менша за `row_ver` сигналу (репліка,
      // затримка) — ключ чекає мінімальну версію й дочитується. Звичайне
      // перечитування `stale` не ставить.
      if (row.version >= signal.version) continue
      w.markStale(object, [key], signal.version)
      marks.noteMinVersion(object, key)
      const mark = o.rows.get(key)?.stale.minVersion
      if (
        mark !== undefined &&
        mark.v >= signal.version &&
        signal.attempt < MIN_VERSION_RETRIES
      )
        retry(object, key, signal.version, signal.attempt + 1)
    }
    const fresh = new Set(plan.fresh)
    for (const row of rows) {
      if (fresh.has(row.key.toLowerCase()) && !isHeld(row.key))
        markNewRow(w, job, row)
    }
  }

  const run = async (batch: Batch): Promise<void> => {
    const jobs: Job[] = []
    const flights: Promise<void>[] = []
    // `needsRefresh` невидимим виглядам (`spec` немає — усім виглядам об'єкта).
    const refresh: { object: ObjectName; spec?: ViewSpec }[] = []
    const requested: ObjectName[] = []
    const burstObjects: ObjectName[] = []
    for (const [object, signals] of batch) {
      if (writer.isStale(object)) continue
      const o = writer.objectOf(object)
      const views = activeViews(writer, object)
      const plan = classify(o, signals, views.length > 0)
      if (plan === undefined) continue
      // Прихована вкладка нічого не шле (Р8): вигляди чекають `resume()`.
      if (!ctx.visible()) {
        requested.push(object)
        refresh.push({ object })
        continue
      }
      if (plan.whole) {
        burstObjects.push(object)
        for (const view of views)
          if (!view.visible) refresh.push({ object, spec: view.spec })
        flights.push(
          revalidate(writer, object, { visibleOnly: true }).catch(
            (error: unknown) => writer.log({ kind: "listener-failed", error })
          )
        )
        continue
      }
      jobs.push(startJob(object, o, plan, signals))
      // Нова версія шапки власника з видимою ТЧ веде до перечитування ТЧ
      // (§6.2, правило 2): її читання йде в тому самому пакеті, що й шапка, а
      // не окремим запитом після неї. Відповідь ТЧ несе `ownerVersion`, тож
      // після запису шапки вигляд ТЧ уже не застарілий.
      const owners = new Set(plan.stored)
      const sections = views.flatMap((view) => {
        const spec = view.spec
        if (!view.visible || spec.kind !== "section" || !owners.has(spec.owner))
          return []
        const subset = writer.registry.find(spec)
        return subset?.loaded === true ? [subset] : []
      })
      if (sections.length > 0)
        flights.push(
          singleFlight(writer, o, sections, { visibleOnly: false }).done.catch(
            (error: unknown) => writer.log({ kind: "listener-failed", error })
          )
        )
    }
    // Сплеск (Р13): об'єкти, що справді перечитуються, і їхні вигляди.
    const reading = new Set([...jobs.map((job) => job.object), ...burstObjects])
    if (reading.size > 0) {
      let views = 0
      for (const object of reading) views += activeViews(writer, object).length
      writer.log({ kind: "revalidate-burst", objects: reading.size, views })
    }
    if (refresh.length > 0)
      ctx.commit((w) => {
        for (const { object, spec } of refresh)
          w.markViews(object, { needsRefresh: true }, spec)
      }, token)
    // Строк на `resume()`: планувальник на прихованій вкладці нічого не шле.
    for (const object of requested) writer.schedule(object, 0)
    const answers = await Promise.all(jobs.map((job) => job.rows))
    await Promise.all(flights)
    if (stopped || !token.valid) return
    const failed = jobs.filter((_, at) => answers[at] === undefined)
    if (failed.length > 0)
      ctx.commit((w) => {
        for (const { object } of failed)
          w.markViews(object, { needsRefresh: true })
      }, token)
    const settled = jobs.flatMap((job, at) =>
      answers[at] === undefined ? [] : [{ job, rows: answers[at] }]
    )
    const again: Parameters<typeof scheduleRetry>[] = []
    if (settled.length > 0)
      ctx.commit((w) => {
        for (const { job, rows } of settled)
          settleJob(w, job, rows, (...args) => again.push(args))
      }, token)
    for (const args of again) scheduleRetry(...args)
  }

  // Відпущений канал тримає епоху відпускання, лише поки в сховищі є його
  // рядки: без них забувається, і регістри не ростуть (перевірка — на такті,
  // а не на кожному `commit`).
  const forgetReleased = () => {
    if (session.epochs.released().next().done === true) return
    ctx.commit((w) => w.forgetReleased(), token)
  }

  const join = (channel: string) => {
    const slot: Held = { off: undefined }
    held.set(channel, slot)
    // Утримання — до підписки: розрив з'єднання до першого `onSubscribed`
    // уже стосується каналу.
    ctx.commit((w) => w.holdChannel(channel), token)
    const off = transport.subscribe([channel], onSignal, onError)
    if (held.get(channel) === slot) slot.off = off
    else off()
  }

  const sync = () => {
    planned = false
    if (stopped || !writer.session.token().valid) return
    const next = wanted()
    for (const [channel, slot] of [...held]) {
      if (next.has(channel)) continue
      held.delete(channel)
      // Позначок відпускання не знімає: рядок, що лишився ціллю `include`,
      // доводить читання після відпускання.
      ctx.commit((w) => w.releaseChannel(channel), token)
      slot.off?.()
    }
    for (const channel of next)
      if (!held.has(channel) && !refused.has(channel)) join(channel)
  }

  const touch = () => {
    if (stopped || planned) return
    planned = true
    queueMicrotask(sync)
  }

  return {
    touch,
    tick() {
      if (stopped || !token.valid) return
      forgetReleased()
      const oldest = marks.oldest()
      if (oldest === undefined) return
      const entry: CoreLogEntry = {
        kind: "stale-age",
        ageMs: writer.now() - oldest.at,
        ...(oldest.object === undefined ? {} : { object: oldest.object }),
      }
      writer.log(entry)
    },
    snapshotReplaced() {
      refused.clear()
      touch()
    },
    purged(object, target) {
      const drop = (batch: Batch) => {
        const found = batch.get(object)
        if (found === undefined) return
        if ("keys" in target)
          for (const key of target.keys) found.keys.delete(key.toLowerCase())
        else {
          found.invalidate.delete(target.scope)
          for (const [key, signal] of found.keys) {
            signal.scopes.delete(target.scope)
            if (signal.scopes.size === 0) found.keys.delete(key)
          }
        }
        if (found.keys.size === 0 && found.invalidate.size === 0)
          batch.delete(object)
      }
      if (open !== undefined) drop(open.batch)
      if (waiting !== undefined) drop(waiting)
      for (const [id, retry] of retries) {
        if (retry.object !== object) continue
        if (
          "keys" in target
            ? target.keys.some((k) => k.toLowerCase() === retry.key)
            : retry.scope === target.scope
        )
          retries.delete(id)
      }
    },
    stop() {
      stopped = true
      open?.quiet?.abort()
      open?.max.abort()
      open = undefined
      waiting = undefined
      retries.clear()
      offSubscribed()
      for (const slot of held.values()) slot.off?.()
      held.clear()
      // Службові мапи не переживають приймача.
      seen.clear()
      refused.clear()
      marks.clear()
    },
  }
}
