import {
  parseTopic,
  receivedChangeSchema,
  receivedInvalidateSchema,
  type SignalTransport,
} from "simetra/model"
import type { ReceiverCore, Row, SubsetSpec } from "./core"

/**
 * Приймач сигналів над ядром (спайк 3 рушія T4, спека П4-B §8.4).
 *
 * Сигнал даних не несе: приймач лише вирішує, що перечитати під RLS, і пише
 * результат через єдину точку ядра `apply` з поколінням. Тому порядок
 * сигналів і відповідей `run` не важить: показане значення рухає лише версія.
 */

/** Звідки приймач перечитує (адаптер джерела T4 у продукті). */
export interface ReceiverSource {
  /** Рядки за ключами під RLS; ключів — до `keyBudget`. */
  readByKeys(object: string, ids: readonly string[]): Promise<readonly Row[]>
  /** Перечитати підмножину цілком: сторінку вікна (новий порядок ключів) чи `full`. */
  readSubset(
    spec: SubsetSpec
  ): Promise<{ rows: readonly Row[]; keys?: readonly string[] }>
}

export interface ReceiverOptions {
  core: ReceiverCore
  transport: SignalTransport
  source: ReceiverSource
  /** Топіки каналів змін (обчислює кеш прав, §8.4 «Підписки»). */
  topics: readonly string[]
  /** Тиша, після якої пачка закривається. */
  quietMs?: number
  /** Найдовше очікування пачки під безперервним потоком сигналів. */
  maxWaitMs?: number
  /** Скільки ключів один запит перечитування; більше — оновлення підмножин. */
  keyBudget?: number
  /** Затримка перечитування після `SUBSCRIBED` (джитер проти лавини). */
  resyncDelayMs?: () => number
  /** Скільки разів дочитувати ключ, якщо репліка віддала версію, старшу за сигнал. */
  lagRetries?: number
  log?: (entry: ReceiverLogEntry) => void
}

export type ReceiverLogEntry =
  | { kind: "read-failed"; object: string; error: unknown }
  | { kind: "signal-dropped"; topic: string; reason: string }

/** Лічильники для вимірів звіту (критерій 3). */
export interface ReceiverStats {
  signals: number
  duplicates: number
  batches: number
  keyReads: number
  subsetReads: number
  resyncs: number
}

interface Pending {
  /** Найбільша версія з сигналів пачки для ключа. */
  version: number
  deleted: boolean
  attempts: number
}

interface ObjectBatch {
  keys: Map<string, Pending>
  invalidate: boolean
}

export interface SignalReceiver {
  readonly stats: ReceiverStats
  /** Чекає, поки осядуть пачки й перечитування (для тестів). */
  idle(): Promise<void>
  dispose(): void
}

const DEDUPE_MAX = 10_000

export function createSignalReceiver(options: ReceiverOptions): SignalReceiver {
  const { core, transport, source } = options
  const quietMs = options.quietMs ?? 50
  const maxWaitMs = options.maxWaitMs ?? 2_000
  const keyBudget = options.keyBudget ?? 200
  const lagRetries = options.lagRetries ?? 3
  const resyncDelay = options.resyncDelayMs ?? (() => Math.random() * 1_000)
  const log = options.log ?? (() => {})
  const stats: ReceiverStats = {
    signals: 0,
    duplicates: 0,
    batches: 0,
    keyReads: 0,
    subsetReads: 0,
    resyncs: 0,
  }

  let disposed = false
  const seen = new Set<string>()
  let batch = new Map<string, ObjectBatch>()
  let quietTimer: ReturnType<typeof setTimeout> | undefined
  let maxTimer: ReturnType<typeof setTimeout> | undefined
  let resyncTimer: ReturnType<typeof setTimeout> | undefined
  /** Обробка пачки в польоті: нова пачка чекає її (single-flight). */
  let flight: Promise<void> = Promise.resolve()
  let busy = 0
  const idleWaiters: Array<() => void> = []

  const track = async (work: () => Promise<void>) => {
    busy += 1
    try {
      await work()
    } finally {
      busy -= 1
      if (busy === 0 && quietTimer === undefined && resyncTimer === undefined)
        for (const resolve of idleWaiters.splice(0)) resolve()
    }
  }

  const objectBatch = (object: string) => {
    let b = batch.get(object)
    if (b === undefined) {
      b = { keys: new Map(), invalidate: false }
      batch.set(object, b)
    }
    return b
  }

  const schedule = () => {
    if (disposed) return
    clearTimeout(quietTimer)
    quietTimer = setTimeout(flush, quietMs)
    maxTimer ??= setTimeout(flush, maxWaitMs)
  }

  const onSignal = (topic: string, payload: unknown) => {
    if (disposed) return
    const channel = parseTopic(topic)
    if (channel?.kind !== "changes") {
      log({ kind: "signal-dropped", topic, reason: "not a changes channel" })
      return
    }
    stats.signals += 1
    const id =
      typeof payload === "object" && payload !== null && "id" in payload
        ? String((payload as { id: unknown }).id)
        : undefined
    if (id !== undefined) {
      if (seen.has(id)) {
        stats.duplicates += 1
        return
      }
      seen.add(id)
      if (seen.size > DEDUPE_MAX)
        seen.delete(seen.values().next().value as string)
    }
    const change = receivedChangeSchema.safeParse(payload)
    const b = objectBatch(channel.object)
    // Сумісність уперед (§8.1): нерозібране чи чужий `object` — `invalidate`.
    if (!change.success || change.data.object !== channel.object) {
      b.invalidate = true
      if (!receivedInvalidateSchema.safeParse(payload).success)
        log({
          kind: "signal-dropped",
          topic,
          reason: "unparsed, as invalidate",
        })
      schedule()
      return
    }
    const rowId = Object.values(change.data.keys)[0] as string
    const prev = b.keys.get(rowId)
    b.keys.set(rowId, {
      version: Math.max(prev?.version ?? 0, change.data.row_ver),
      deleted: (prev?.deleted ?? false) || change.data.op === "delete",
      attempts: prev?.attempts ?? 0,
    })
    schedule()
  }

  function flush() {
    clearTimeout(quietTimer)
    clearTimeout(maxTimer)
    quietTimer = undefined
    maxTimer = undefined
    if (disposed || batch.size === 0) {
      void track(async () => {})
      return
    }
    const taken = batch
    batch = new Map()
    const prev = flight
    flight = track(async () => {
      await prev
      if (disposed) return
      stats.batches += 1
      await Promise.all(
        [...taken].map(([object, b]) => processObject(object, b))
      )
    })
  }

  async function processObject(object: string, b: ObjectBatch) {
    const token = core.generation()
    const subsets = core.activeSubsets(object)
    // Кроки 1–2 (§8.4): відлуння (версія вже є) відкидається; видалення —
    // лише перечитуванням, бо сигнал `delete` несе версію «до».
    const known: string[] = []
    const unknown: string[] = []
    for (const [id, p] of b.keys) {
      const have = core.versionOf(object, id)
      if (have === undefined) {
        if (!p.deleted) unknown.push(id)
      } else if (p.deleted || have < p.version) {
        known.push(id)
      }
    }
    // Новий ключ цікавий лише тоді, коли є список, якому він міг би підійти.
    const lists = subsets.filter((s) => s.spec.kind !== "card")
    const probe = lists.length > 0 ? unknown : []
    const total = known.length + probe.length
    if (total === 0 && !b.invalidate) return
    // Сплеск понад бюджет одного запиту чи `invalidate`: оновлення підмножин —
    // не більше запитів, ніж активних підмножин (критерій 3).
    if (b.invalidate || total > keyBudget) {
      await refreshSubsets(object, "signal", token)
      return
    }
    let rows: readonly Row[]
    try {
      stats.keyReads += 1
      rows = await source.readByKeys(object, [...known, ...probe])
    } catch (error) {
      if (disposed) return
      log({ kind: "read-failed", object, error })
      // Перечитування не вдалося: позначка «може бути застарілим» на місці.
      for (const s of subsets)
        core.flag(s.viewId, { needsRefresh: true }, token)
      return
    }
    if (disposed) return
    const byId = new Map(rows.map((r) => [r.id, r]))
    const lagging: Array<[string, Pending]> = []
    for (const id of known) {
      const row = byId.get(id)
      const p = b.keys.get(id) as Pending
      // Репліка може відставати: рядок старший за сигнал — дочитати пізніше.
      if (row !== undefined && !p.deleted && row.version < p.version)
        lagging.push([id, p])
    }
    const absent = known.filter((id) => !byId.has(id))
    core.apply(
      {
        object,
        rows: known.flatMap((id) => byId.get(id) ?? []),
        absent,
        origin: "signal",
      },
      token
    )
    // Крок 4: новий рядок не пишеться — лише позначка списку, якому він підходить.
    for (const id of probe) {
      const row = byId.get(id)
      if (row === undefined) continue
      for (const s of lists)
        if ("predicate" in s.spec && s.spec.predicate(row))
          core.flag(s.viewId, { hasNewRows: true }, token)
    }
    for (const [id, p] of lagging) {
      // Ключ `stale`, доки підтверджене не досягне версії сигналу. Позначка —
      // лише після відставання, а не на час звичайного перечитування: інакше
      // кожен сигнал блимав би `stale` на мілісекунди.
      core.expectVersion(object, id, p.version, token)
      if (p.attempts >= lagRetries) continue
      const nb = objectBatch(object)
      nb.keys.set(id, { ...p, attempts: p.attempts + 1 })
      schedule()
    }
  }

  /**
   * Перечитати підмножини об'єкта: видимі — одним запитом кожна; невидимі —
   * лише `needsRefresh`. Дві фази: спершу всі читання, потім усі записи в
   * ядро одним синхронним кроком (`after` — у тому самому кроці), тож UI
   * отримує один кадр замість кадру на підмножину.
   */
  async function refreshSubsets(
    object: string | undefined,
    cause: "signal" | "resync",
    token = core.generation(),
    after?: () => void
  ) {
    const subsets = core.activeSubsets(object)
    const writes = await Promise.all(
      subsets.map(async (s): Promise<(() => void) | undefined> => {
        if (!s.visible)
          return () =>
            core.flag(s.viewId, { needsRefresh: true, stale: true }, token)
        try {
          if (s.spec.kind === "card") {
            const object = s.spec.object
            const id = s.spec.id
            stats.keyReads += 1
            const rows = await source.readByKeys(object, [id])
            return () =>
              core.apply(
                {
                  object,
                  rows,
                  absent: rows.length === 0 ? [id] : [],
                  origin: "resync",
                  subset: { viewId: s.viewId },
                },
                token
              )
          }
          if (cause === "signal" && s.spec.kind === "window") {
            // Сплеск над вікном: значення наявних рядків на місці; склад
            // сторінки міг змінитися — `needsRefresh`, перебудову робить користувач.
            const object = s.spec.object
            stats.keyReads += 1
            const rows = await source.readByKeys(object, s.keys)
            const got = new Set(rows.map((r) => r.id))
            return () => {
              core.apply(
                {
                  object,
                  rows,
                  absent: s.keys.filter((k) => !got.has(k)),
                  origin: "signal",
                },
                token
              )
              core.flag(s.viewId, { needsRefresh: true }, token)
            }
          }
          const spec = s.spec
          stats.subsetReads += 1
          const result = await source.readSubset(spec)
          let rows = result.rows
          let absent: string[] = []
          const got = new Set(rows.map((r) => r.id))
          const missing = s.keys.filter((k) => !got.has(k))
          if (missing.length > 0 && spec.kind === "window") {
            // Рядок, що випав зі сторінки: живий (на місці, нове значення) чи
            // видалений (`removed`). Обидва читання — одна заміна в ядрі.
            stats.keyReads += 1
            const extra = await source.readByKeys(spec.object, missing)
            const extraIds = new Set(extra.map((r) => r.id))
            rows = [...rows, ...extra]
            absent = missing.filter((k) => !extraIds.has(k))
          } else absent = missing
          return () =>
            core.apply(
              {
                object: spec.object,
                rows,
                absent,
                origin: "resync",
                subset: {
                  viewId: s.viewId,
                  ...(result.keys !== undefined ? { keys: result.keys } : {}),
                },
              },
              token
            )
        } catch (error) {
          if (disposed) return undefined
          log({ kind: "read-failed", object: s.spec.object, error })
          return () => core.flag(s.viewId, { needsRefresh: true }, token)
        }
      })
    )
    // Після `dispose()` чи зміни покоління нічого не пишеться: ядро й саме
    // відхилить старий токен, але приймач не кличе його взагалі.
    if (disposed) return
    for (const write of writes) write?.()
    after?.()
  }

  const onSubscribed = () => {
    if (disposed) return
    // Сигнали з проміжку без підписки втрачено (Realtime їх не буферизує, а
    // слот реплікації створюється ліниво на перший join): кожен `SUBSCRIBED`
    // — перечитування активних підмножин, сигнал його не заміняє.
    clearTimeout(resyncTimer)
    resyncTimer = setTimeout(() => {
      resyncTimer = undefined
      if (disposed) return
      stats.resyncs += 1
      const token = core.generation()
      const prev = flight
      flight = track(async () => {
        await prev
        if (disposed) return
        await refreshSubsets(undefined, "resync", token, () => {
          core.markAllStale(false, token)
          for (const s of core.activeSubsets())
            if (!s.visible) core.flag(s.viewId, { stale: true }, token)
        })
      })
    }, resyncDelay())
  }

  const onError = () => {
    if (disposed) return
    // Розрив: дані лишаються видимими, лише з позначкою `stale`.
    core.markAllStale(true, core.generation())
  }

  const unsubscribe = transport.subscribe(options.topics, onSignal, onError)
  const offSubscribed = transport.onSubscribed(onSubscribed)

  return {
    stats,
    idle: () =>
      busy === 0 && quietTimer === undefined && resyncTimer === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve) => idleWaiters.push(resolve)),
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(quietTimer)
      clearTimeout(maxTimer)
      clearTimeout(resyncTimer)
      quietTimer = maxTimer = resyncTimer = undefined
      batch.clear()
      unsubscribe()
      offSubscribed()
      for (const resolve of idleWaiters.splice(0)) resolve()
    },
  }
}
