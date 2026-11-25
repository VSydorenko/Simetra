import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  coreInternals,
  createCore,
  inspectCore,
  type CoreSession,
} from "../core"
import { DISCARD_PAUSE_MS, DISCARDS_MAX } from "../session"
import { QUIET_MS, REJOIN_JITTER_MS } from "../receiver"
import type { FakeRead } from "../testing/fake-source"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import {
  channelTopic,
  type CatalogEntry,
  type RightsRow,
  type RightsSnapshot,
} from "simetra/model"
import {
  SCOPE_KIND_ID,
  catalogEntrySection,
  catalogRights,
} from "../../../model/runtime/__tests__/entries"
import { createCoreSource, createReadLimiter, type ReadEvent } from "../source"
import { DEFAULT_CORE_LIMITS, type CoreSnapshot } from "../types"
import { collectCore } from "./oracles"
import type { SiteCode } from "../sync/vocabulary"
import { SITE_CODES } from "../sync/vocabulary"
import type { ObjectName, ViewHandle, ViewSpec } from "../types"
import {
  ORG,
  S,
  TASK,
  key,
  org,
  keysOf,
  seed,
  settle,
  setup,
  watch,
  task,
  type CoreHarness,
} from "./core-support"

/*
 * Характеристика `main` (план SK-1, задача 2): для кожної пари «код Додатка Б,
 * умова з чотирьох, які судить SK-1» — чи йде запит і що з цього шляхом.
 * Тест пишуть на коді до перенесення умов у шлюз і задачі 3–6 його очікувань
 * не змінюють: так таблиця шлюзу звіряється з поведінкою `main`, а не сама з
 * собою.
 */

beforeEach(() => {
  vi.useFakeTimers()
  // Розкид строків ядра — випадковий: фіксуємо його, щоб прогін був відтворюваний.
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const CONDITIONS = [
  "closed",
  "stale-object",
  "discard-bound",
  "tab-hidden",
  "closing",
] as const
type Condition = (typeof CONDITIONS)[number]

/** Клітинка: запит був чи ні й наслідок шляху (стан вигляду). */
type Cell =
  | {
      request: boolean
      then: string
      /** Запит не пішов не через умову: шлях до рішення не дійшов (причина названа). */
      unreached?: string
      /** Лише вікно закриття: шлях звернувся до `read` джерела. */
      attempted?: boolean
    }
  | { unreachable: string }

interface Rig {
  readonly h: CoreHarness
  readonly transport: ReturnType<typeof createFakeSignalTransport>
  /** Ядро, на яке ставлять умову й чиї читання рахують; за замовчуванням ядро `h`. */
  core?: CoreSession
  /** Вигляд, чий стан показує наслідок шляху. */
  main?: ViewHandle
}

interface Recipe {
  /** Готує стан і повертає дію, що пускає шлях; умову ставлять між ними. */
  arm(rig: Rig): Promise<() => unknown>
  /** Об'єкт, який читає шлях: на нього ставлять `stale-object`; за замовчуванням задачі. */
  readonly object?: ObjectName
  /** Підготовка сама перемикає епохи й покидає EA: наперед її не покидають. */
  readonly ownEpochs?: boolean
  /** Ядро зі знімком прав і каналом сигналів (приймач). */
  readonly signals?: boolean
  /** Ядро зі знімком прав без каналу. */
  readonly rights?: boolean
  /** Нестандартні опції `setup`. */
  readonly options?: Parameters<typeof setup>[0]
}

const EA = "a".repeat(64)
const EB = "b".repeat(64)
const BIG = 10_000_000

const FULL: ViewSpec = { kind: "full", object: TASK }
const WINDOW: ViewSpec = { kind: "window", object: TASK }

const outcome = (v: ViewHandle | undefined): string => {
  if (v === undefined) return "no-view"
  const s = v.getSnapshot()
  return `${s.status}${s.error === undefined ? "" : `:${s.error.code}`}${s.isStale ? "+stale" : ""}`
}

/**
 * Межа відкинутих: восьмеро проходів поспіль із покинутої епохи (`abandonEpoch`),
 * кожен — своїм `commit`. Читань не робить й епохи не перемикає, тож стан шляху
 * (політ, пауза, очікування приймача) лишається таким, яким його підготовлено.
 */
function makeUnavailable(core: CoreSession) {
  for (let i = 0; i < DISCARDS_MAX; i++) passOf(core, EA)
  expect(inspectCore(core).versionEpochs().unavailable).toBe(true)
}

const passOf = (core: CoreSession, epoch: string) =>
  core.commit(
    (w) =>
      void w.apply(TASK, { rows: [], absent: [] }, core.readEpoch(), epoch),
    core.token()
  )

/**
 * Перемикання епохи до підготовки шляху: покинута епоха EA — умова межі потім
 * лише відкидає її відповіді. Перемикання під час умови стерло б очікування
 * шляху (повтор приймача, пауза), тож його роблять наперед, однаково для
 * контролю й для кожної умови.
 */
function abandonEpoch(core: CoreSession) {
  passOf(core, EA)
  passOf(core, EB)
}

const APPLY: Record<
  Exclude<Condition, "closing">,
  (core: CoreSession, object: ObjectName) => void
> = {
  closed: (core) => core.close("disposed"),
  "stale-object": (core, object) => core.staleClient(object),
  "discard-bound": makeUnavailable,
  "tab-hidden": (core) => core.suspend(),
}

const loaded = async (rig: Rig, spec: ViewSpec = FULL) => {
  const v = rig.h.core.view(spec)
  watch(v)
  await settle()
  rig.main = v
  return v
}

const SECTION1: ViewSpec = {
  kind: "section",
  object: TASK,
  owner: key(1),
  section: "lines",
}
const LINES = [{ ref: key(901), qty: 1, lineNumber: 1 }]
const KEYS12: ViewSpec = { kind: "keys", object: TASK, keys: [key(1), key(2)] }
const CARD1: ViewSpec = { kind: "card", object: TASK, key: key(1) }

/** Вимога «склад не підтверджено» з епохи, новішої за старт будь-якого читання. */
const raiseRequirement = (h: CoreHarness) =>
  h.core.commit(
    (w) =>
      w.markViews(TASK, {
        unconfirmedSince: coreInternals(h.core).epochs.next(),
      }),
    h.core.token()
  )

/** Завантаження, що тримається в польоті: `fake.hold` лишається, поки не знято. */
async function holdFlight(rig: Rig, spec: ViewSpec = FULL) {
  const { h } = rig
  const v = h.core.view(spec)
  rig.main = v
  h.fake.hold = () => true
  watch(v)
  await settle()
  return h.fake.take()
}

/** Відкинуте за епохою читання: епоха фейка не збігається з прийнятою сесією. */
async function discardNext(h: CoreHarness, act: () => void) {
  h.fake.epoch = EB
  act()
  await settle()
  h.fake.epoch = EA
  act()
  await settle()
}

const USER = "00000000-0000-4000-8000-0000000000a1"
const READ_TASK: RightsRow = {
  level: "scope",
  levelId: null,
  scope: S,
  container: null,
  object: "task",
  action: "read",
  extent: "any",
  dimensionId: null,
}
const CHANNEL = channelTopic({
  kind: "changes",
  scopeKindId: SCOPE_KIND_ID,
  scope: S,
  object: task.id,
})

/** Знімок прав на читання задач у скоупі `S` для всіх рядків фейка. */
function grant(h: CoreHarness) {
  h.fake.rightsSnapshot = {
    userId: USER,
    scopeSets: [{ scopeKind: SCOPE_KIND_ID, scope: S }],
    rights: [READ_TASK],
    members: [],
    dimensionValues: [],
  }
  h.fake.rightsVersion = "1".repeat(64)
}

const T_SCOPE = "00000000-0000-4000-8000-0000000000b2"
const WITH_NOTES: CatalogEntry = {
  ...task,
  rights: catalogRights(),
  tabularSections: [
    ...task.tabularSections,
    catalogEntrySection({
      id: "notes",
      name: "notes",
      table: { schema: "public", name: "task_notes" },
    }),
  ],
}
const BOTH: RightsSnapshot = {
  userId: USER,
  scopeSets: [S, T_SCOPE].map((scope) => ({ scopeKind: SCOPE_KIND_ID, scope })),
  rights: [S, T_SCOPE].map((scope) => ({ ...READ_TASK, scope })),
  members: [],
  dimensionValues: [],
}

let signalId = 0
const change = (k: string, version: number) => ({
  id: String(++signalId),
  object: task.id,
  op: "update",
  keys: { id: k },
  row_ver: version,
})

/** Друге ядро над тим самим фейком, гідроване знімком першого (через JSON, як через HTML). */
function hydrated(h: CoreHarness, specs: readonly ViewSpec[]): CoreSession {
  for (const spec of specs) h.core.view(spec)
  const snapshot = JSON.parse(
    JSON.stringify(h.core.dehydrate())
  ) as CoreSnapshot
  const source = createCoreSource(
    () => h.fake.adapter,
    h.fake.index,
    createReadLimiter(DEFAULT_CORE_LIMITS.readParallel),
    h.fake.server
  )
  const next = createCore({ subject: "u1", source, index: h.fake.index })
  collectCore(next, h.fake)
  abandonEpoch(next)
  next.hydrate(snapshot)
  return next
}

const isKeysRead = (read: FakeRead) => keysOf(read.query).length > 0
const isPage = (read: FakeRead) =>
  read.query !== undefined &&
  "limit" in read.query &&
  !("tabularSection" in read.query) &&
  keysOf(read.query).length === 0

/**
 * Розбіжне «рядка немає» для `k` (П15): старе читання за ключем тримається,
 * новіше пише рядок, а відповідь старого лягає після нього. Повертає дію, що
 * відповідає старому й звільняє обидва вигляди.
 */
async function divergence(h: CoreHarness, k: string) {
  const { core, fake } = h
  const handle = core.view({ kind: "keys", object: TASK, keys: [k] })
  const own = watch(handle)
  await settle()
  const before = fake.hold
  fake.hold = (read) =>
    keysOf(read.query).includes(k) || (before?.(read) ?? false)
  handle.refresh()
  await settle()
  const older = fake.take((read) => keysOf(read.query).includes(k))
  fake.hold = before
  const newer = watch(
    core.view({ kind: "keys", object: TASK, keys: [key(1), k] })
  )
  await settle()
  return async () => {
    const held = fake.hold
    fake.hold = (read) => isKeysRead(read) || (held?.(read) ?? false)
    fake.setVisibleScopes([])
    older.answer()
    fake.setVisibleScopes(undefined)
    await settle()
    for (const w of [own, newer]) w.unsubscribe()
    vi.advanceTimersByTime(DEFAULT_CORE_LIMITS.releaseDelayMs)
    await settle()
    fake.hold = held
  }
}

const RECIPES: Partial<Record<SiteCode, Recipe>> = {
  M1: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      return async () => {
        const v = rig.h.core.view(FULL)
        watch(v)
        rig.main = v
      }
    },
  },
  M2: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      return async () => {
        rig.main = rig.h.core.view(FULL)
        void rig.h.core.preload(FULL)
      }
    },
  },
  M3: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      return async () => {
        const card = rig.h.core.view(CARD1)
        watch(card)
        rig.main = card
      }
    },
  },
  M5: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      const v = await loaded(rig)
      return () => v.refresh()
    },
  },
  M6: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      const v = await loaded(rig)
      rig.h.fake.hold = () => true
      v.refresh()
      await settle()
      const flying = rig.h.fake.take()
      v.refresh()
      return async () => {
        rig.h.fake.hold = undefined
        flying.answer()
      }
    },
  },
  M7: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      const flying = await holdFlight(rig)
      raiseRequirement(rig.h)
      return async () => {
        rig.h.fake.hold = undefined
        flying.answer()
      }
    },
  },
  M8: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      const v = await loaded(rig)
      rig.h.fake.epoch = EA
      v.refresh()
      await settle()
      await discardNext(rig.h, () => v.refresh())
      return () => vi.advanceTimersByTimeAsync(DISCARD_PAUSE_MS * 2)
    },
  },
  P1: {
    async arm(rig) {
      seed(rig.h.fake, 1, 250)
      const v = await loaded(rig, WINDOW)
      return () => v.loadAfter()
    },
  },
  P2: {
    ownEpochs: true,
    async arm(rig) {
      seed(rig.h.fake, 1, 250)
      const v = await loaded(rig, WINDOW)
      rig.h.fake.epoch = EA
      v.refresh()
      await settle()
      rig.h.fake.epoch = EB
      v.refresh()
      await settle()
      rig.h.fake.epoch = EA
      v.loadAfter()
      await settle()
      return () => vi.advanceTimersByTimeAsync(DISCARD_PAUSE_MS * 2)
    },
  },
  R7: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      return () => rig.h.core.revalidate(TASK, { visibleOnly: false })
    },
  },
  R13: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      rig.h.core.setVisible(FULL, false)
      raiseRequirement(rig.h)
      return () => rig.h.core.setVisible(FULL, true)
    },
  },
  R15: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      const v = await loaded(rig)
      rig.h.fake.hold = () => true
      v.refresh()
      await settle()
      const flying = rig.h.fake.take()
      void rig.h.core.revalidate(TASK, { visibleOnly: false })
      await settle()
      return async () => {
        rig.h.fake.hold = undefined
        flying.answer()
      }
    },
  },
  R18: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      rig.h.fake.hold = () => true
      void rig.h.core.revalidate(TASK, { visibleOnly: true })
      await settle()
      const flying = rig.h.fake.take()
      raiseRequirement(rig.h)
      return async () => {
        rig.h.fake.hold = undefined
        flying.answer()
      }
    },
  },
  R6: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      return () => rig.h.core.resume()
    },
  },
  R2: {
    options: { limits: { revalidateIntervalMs: 60_000 } },
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      return () => vi.advanceTimersByTimeAsync(2 * 60_000)
    },
  },
  R10: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      return () =>
        void rig.h.core.commit(
          (w) => w.hide(TASK, [key(1)]),
          rig.h.core.token()
        )
    },
  },
  M4: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      rig.h.fake.setLines(TASK, key(1), "lines", LINES)
      await loaded(rig)
      const section = rig.h.core.view(SECTION1)
      watch(section)
      await settle()
      rig.main = section
      // `hide` власника — зміна шапки, що не залежить від прийняття епохи.
      return () =>
        void rig.h.core.commit(
          (w) => w.hide(TASK, [key(1)]),
          rig.h.core.token()
        )
    },
  },
  R1: {
    options: { limits: { revalidateIntervalMs: 60_000 } },
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      return async () => {
        rig.h.core.freshness.requestReread([TASK], { jitterMs: 0 })
        await vi.advanceTimersByTimeAsync(1_000)
      }
    },
  },
  R5: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      const next = hydrated(rig.h, [FULL])
      rig.core = next
      rig.main = next.view(FULL)
      watch(rig.main)
      return () => next.endHydration()
    },
  },
  R14: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      const next = hydrated(rig.h, [FULL])
      rig.core = next
      rig.main = next.view(FULL)
      watch(rig.main)
      next.setVisible(FULL, false)
      next.endHydration()
      await settle()
      return () => next.setVisible(FULL, true)
    },
  },
  R16: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      rig.h.fake.hold = () => true
      void rig.h.core.revalidate(TASK, { visibleOnly: true })
      await settle()
      const flying = rig.h.fake.take()
      rig.h.core.commit(
        (w) => w.purge(TASK, { keys: [key(1)] }),
        rig.h.core.token()
      )
      return async () => {
        rig.h.fake.hold = undefined
        flying.answer()
      }
    },
  },
  K3: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      return () =>
        void rig.h.core.commit(
          (w) => w.hideByHorizon(TASK, [key(1)]),
          rig.h.core.token()
        )
    },
  },
  S1: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      return () => rig.h.core.requestVersion()
    },
  },
  R4: {
    signals: true,
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      return async () => {
        rig.transport.join(CHANNEL, false)
        await vi.advanceTimersByTimeAsync(REJOIN_JITTER_MS)
      }
    },
  },
  R8: {
    signals: true,
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      return async () => {
        rig.transport.emit(CHANNEL, {
          id: "9401",
          object: task.id,
          op: "invalidate",
        })
        await vi.advanceTimersByTimeAsync(QUIET_MS)
      }
    },
  },
  K1: {
    signals: true,
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig, KEYS12)
      return async () => {
        const version = rig.h.fake.edit(TASK, key(1), { title: "new" })
        rig.transport.emit(CHANNEL, change(key(1), version))
        await vi.advanceTimersByTimeAsync(QUIET_MS)
      }
    },
  },
  K2: {
    signals: true,
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig, KEYS12)
      // Сигнал обіцяє версію, якої сервер ще не має: відповідь замала, повтор
      // чекає паузу (вимога «мінімальна версія»).
      const ahead = rig.h.fake.row(TASK, key(1))!.version + 5
      rig.transport.emit(CHANNEL, change(key(1), ahead))
      await vi.advanceTimersByTimeAsync(QUIET_MS)
      return () => vi.advanceTimersByTimeAsync(30_000)
    },
  },
  R9: {
    signals: true,
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      rig.h.fake.setLines(TASK, key(1), "lines", LINES)
      await loaded(rig, KEYS12)
      watch(rig.h.core.view(SECTION1))
      await settle()
      return async () => {
        const version = rig.h.fake.edit(TASK, key(1), { title: "new" })
        rig.transport.emit(CHANNEL, change(key(1), version))
        await vi.advanceTimersByTimeAsync(QUIET_MS)
      }
    },
  },
  S2: {
    rights: true,
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      return () => rig.h.core.requestRights()
    },
  },
  S3: {
    rights: true,
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      return async () => {
        rig.main = rig.h.core.view(FULL)
        watch(rig.main)
      }
    },
  },
  R11: {
    rights: true,
    object: ORG,
    async arm(rig) {
      const { h } = rig
      h.fake.holdRights = true
      seed(h.fake, 1, 2)
      h.fake.insert(ORG, { ref: S })
      watch(h.core.view(KEYS12))
      await settle()
      rig.main = h.core.view({ kind: "keys", object: ORG, keys: [S] })
      watch(rig.main)
      await settle()
      return async () => h.fake.releaseRights()
    },
  },
  R3: {
    options: { limits: { revalidateIntervalMs: 60_000 } },
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      const act = () => void rig.h.core.revalidate(TASK, { visibleOnly: false })
      rig.h.fake.epoch = EA
      act()
      await settle()
      await discardNext(rig.h, act)
      return () => vi.advanceTimersByTimeAsync(DISCARD_PAUSE_MS * 4)
    },
  },
  R17: {
    async arm(rig) {
      seed(rig.h.fake, 1, 250)
      await loaded(rig, WINDOW)
      rig.h.fake.hold = () => true
      void rig.h.core.revalidate(TASK, { visibleOnly: true })
      await settle()
      const flying = rig.h.fake.take()
      rig.h.core.commit(
        (w) => w.purge(TASK, { scope: S }, { rights: true }),
        rig.h.core.token()
      )
      return async () => {
        rig.h.fake.hold = undefined
        flying.answer()
      }
    },
  },
  P3: {
    options: { limits: { windowPage: 2, revalidateIntervalMs: BIG } },
    async arm(rig) {
      const { h } = rig
      seed(h.fake, 1, 5)
      const v = await loaded(rig, WINDOW)
      const bury = await divergence(h, key(3))
      h.fake.hold = isPage
      v.loadAfter()
      await settle()
      const page = h.fake.take(isPage)
      await bury()
      return async () => {
        h.fake.hold = undefined
        page.answer()
        await settle()
      }
    },
  },
  R12: {
    rights: true,
    options: {
      objects: [WITH_NOTES, org],
      mode: "manual",
      limits: { revalidateIntervalMs: BIG },
    },
    async arm(rig) {
      const { h } = rig
      h.fake.rightsSnapshot = BOTH
      h.fake.rightsVersion = "1".padStart(64, "0")
      h.core.requestRights()
      await settle()
      seed(h.fake, 1, 1)
      h.fake.setLines(TASK, key(1), "lines", LINES)
      h.fake.setLines(TASK, key(1), "notes", LINES)
      const lines: ViewSpec = {
        kind: "section",
        object: TASK,
        owner: key(1),
        section: "lines",
      }
      const notes: ViewSpec = { ...lines, section: "notes" }
      watch(h.core.view(lines))
      await settle()
      h.fake.deliverAll()
      await settle()
      // Читання `notes` стартує до нового знімка й осідає після нього, а
      // власника без шапки в сховищі немає: бар'єр відкидає ТЧ.
      rig.main = h.core.view(notes)
      watch(rig.main)
      await settle()
      h.fake.rightsVersion = "2".padStart(64, "0")
      h.core.requestRights()
      await settle()
      const named = (name: string) => (read: FakeRead) =>
        (read.query as { tabularSection?: string } | undefined)
          ?.tabularSection === name
      h.fake.take(named("lines")).answer()
      await settle()
      const late = h.fake.take(named("notes"))
      return async () => {
        late.answer()
        await settle()
      }
    },
  },
  K4: {
    async arm(rig) {
      seed(rig.h.fake, 1, 3)
      await loaded(rig)
      rig.h.fake.epoch = EA
      return async () => {
        rig.h.core.update(TASK, key(1), { title: "x" }, { expectedVersion: 1 })
      }
    },
  },
}

/** Один прогін: готуємо, ставимо умову, пускаємо шлях; повертаємо клітинку. */
async function run(
  code: SiteCode,
  condition: Condition | undefined
): Promise<{ request: boolean; then: string; attempted: boolean }> {
  const recipe = RECIPES[code]!
  const transport = createFakeSignalTransport()
  const h = setup({
    limits: { revalidateIntervalMs: BIG },
    ...(recipe.signals === true ? { signals: transport } : {}),
    ...(recipe.signals === true || recipe.rights === true
      ? { rightsSnapshot: true }
      : {}),
    ...recipe.options,
  })
  if (recipe.signals === true || recipe.rights === true) grant(h)
  if (recipe.ownEpochs !== true) abandonEpoch(h.core)
  const rig: Rig = { h, transport }
  const fire = await recipe.arm(rig)
  const core = rig.core ?? h.core
  // Вікно закриття (`closing`): токен сесії вже недійсний, `close()` ще не
  // скінчив. Рішення читати стоїть усередині слухача purge-пачки: кроку,
  // який виконується синхронно в `close()`, інакше вікна немає.
  let inClose = false
  let inside: unknown
  let fired = false
  let validAtFire: boolean | undefined
  if (condition === "closing") {
    core
      .view({ kind: "keys", object: ORG, keys: [key(9100)] })
      .subscribe(() => {
        if (!inClose || fired) return
        fired = true
        validAtFire = core.token().valid
        inside = fire()
      })
    await settle()
  }
  const events: ReadEvent[] = []
  const stop = inspectCore(core).watchReads((e) => events.push(e))
  // Спроби читання: виклики `read` джерела ядра, до обмежувача й збирача. У
  // вікні закриття запит на дріт не йде вже через `source.close()`, тож лише
  // спроба показує, чи рішення шляху було «читати».
  const attempts: string[] = []
  const source = coreInternals(core).source
  const sourceRead = source.read.bind(source)
  source.read = (parts, flight) => {
    attempts.push(flight.site)
    return sourceRead(parts, flight)
  }
  if (condition === "closing") {
    inClose = true
    core.close("disposed")
    await inside
    // Без цього клітинки вікна проходили б, навіть якби слухач не спрацював.
    expect(fired, `${code} fired in the purge listener`).toBe(true)
    expect(validAtFire, `${code} token inside the listener`).toBe(false)
  } else {
    if (condition !== undefined) APPLY[condition](core, recipe.object ?? TASK)
    await fire()
  }
  await settle()
  stop()
  const mine = events.filter((e) => e.site === code)
  return {
    request: mine.length > 0,
    then: outcome(rig.main),
    attempted: attempts.includes(code),
  }
}

/*
 * Очікування — поведінка `main`, знята прогоном кожного шляху над справжнім
 * ядром і фейковим сервером; Додаток Б (колонка «Умови») звірено з ними вручну.
 * `closed` — повністю закрите ядро (`close()` відпрацювало); `closing` — вікно
 * закриття (токен недійсний, `close()` ще не вернувся): рішення шляху стоїть у
 * слухачі purge-пачки. Це «до» рядка 15 §5.14: задача 3 міняє лише клітинки
 * `closing`. `attempted` — шлях звернувся до `read` джерела (запит на дріт у
 * вікні однаково не йде: `source.close()` стоїть одразу після `session.close`).
 * `unreachable` — пару не запускають: причина структурна.
 * Кожну пару запущено. `unreached` — клітинка, де `request: false` не є
 * рішенням шляху чи шлюзу щодо умови: шлях до рішення не дійшов. Причину
 * названо й перевірено мутацією на копії (її вимкнення дає запит); решта
 * `request: false` — наслідок перевірки умови самим шляхом. Для `closed` це
 * не так у R1–R4, R8, R9, K1, K2: `close()` знімає таймери й приймач, тож шлях
 * не досягнуто (`unreached`; це читання коду, а не мутація).
 * `closing` у M1, M2, M3 і S3 вимірює закриту перевірку `core.view`
 * (`closedHandle`), а не рішення самого шляху; `attempted` для S3 не
 * вимірюється: S3 — частина, яку ядро додає всередині `dispatch`, а не політ
 * `read`. Причини `unreachable` у вікні закриття (M4, R10, K3, K4) — теж
 * читання коду: вимкнення відповідних перевірок тест не червонить.
 */
const TABLE: Record<SiteCode, Record<Condition, Cell>> = {
  M1: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  M2: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  M3: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  M4: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: {
      unreachable:
        "the purge flush of `close()` runs, but the check of M4 is deferred by `queueCheck` to a microtask that runs after `close()` and sees `isClosed()` (code reading: guard-off stays green)",
    },
  },
  M5: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  M6: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken when an answer settles (a microtask after the transport answers); that is after close() has returned",
    },
  },
  M7: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: false, then: "error:command.unavailable" },
    "tab-hidden": { request: false, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken when an answer settles (a microtask after the transport answers); that is after close() has returned",
    },
  },
  M8: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "refreshing" },
    closing: {
      unreachable:
        "the decision is taken in a timer (scheduler tick, retry pause, signal batch); a timer runs after close() has returned, and the closing window exists only inside it",
    },
  },
  P1: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  P2: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken in a timer (scheduler tick, retry pause, signal batch); a timer runs after close() has returned, and the closing window exists only inside it",
    },
  },
  P3: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": {
      request: false,
      then: "error:command.unavailable",
      unreached:
        "session: acceptEpoch discards every answer after the bound, so the pass never reaches the decision of the path",
    },
    "tab-hidden": { request: false, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken when an answer settles (a microtask after the transport answers); that is after close() has returned",
    },
  },
  R1: {
    closed: {
      request: false,
      then: "purged",
      unreached:
        "core onClose clears scheduled/wave and stops the scheduler and the receiver, so the path is never reached (code reading: guard-off of scheduler.stop() or of the scheduler `closed` option stays green because scheduled.clear() is a third layer)",
    },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": {
      request: false,
      then: "ready",
      unreached:
        "scheduler: schedulerDue and tick stop and dropDeferredWhenUnavailable clears the deferred terms after the bound; the path is never reached",
    },
    "tab-hidden": {
      request: false,
      then: "ready",
      unreached:
        "scheduler: suspend() stops the timer and the tick does not run on a hidden tab; the path is never reached",
    },
    closing: {
      unreachable:
        "the decision is taken in a timer (scheduler tick, retry pause, signal batch); a timer runs after close() has returned, and the closing window exists only inside it",
    },
  },
  R2: {
    closed: {
      request: false,
      then: "purged",
      unreached:
        "core onClose clears scheduled/wave and stops the scheduler and the receiver, so the path is never reached (code reading: guard-off of scheduler.stop() or of the scheduler `closed` option stays green because scheduled.clear() is a third layer)",
    },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": {
      request: false,
      then: "ready",
      unreached:
        "scheduler: schedulerDue and tick stop and dropDeferredWhenUnavailable clears the deferred terms after the bound; the path is never reached",
    },
    "tab-hidden": {
      request: false,
      then: "ready",
      unreached:
        "scheduler: suspend() stops the timer and the tick does not run on a hidden tab; the path is never reached",
    },
    closing: {
      unreachable:
        "the decision is taken in a timer (scheduler tick, retry pause, signal batch); a timer runs after close() has returned, and the closing window exists only inside it",
    },
  },
  R3: {
    closed: {
      request: false,
      then: "purged",
      unreached:
        "core onClose clears scheduled/wave and stops the scheduler and the receiver, so the path is never reached (code reading: guard-off of scheduler.stop() or of the scheduler `closed` option stays green because scheduled.clear() is a third layer)",
    },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": {
      request: false,
      then: "ready",
      unreached:
        "scheduler: schedulerDue and tick stop and dropDeferredWhenUnavailable clears the deferred terms after the bound; the path is never reached",
    },
    "tab-hidden": {
      request: false,
      then: "ready",
      unreached:
        "scheduler: suspend() stops the timer and the tick does not run on a hidden tab; the path is never reached",
    },
    closing: {
      unreachable:
        "the decision is taken in a timer (scheduler tick, retry pause, signal batch); a timer runs after close() has returned, and the closing window exists only inside it",
    },
  },
  R4: {
    closed: {
      request: false,
      then: "purged",
      unreached:
        "core onClose clears scheduled/wave and stops the scheduler and the receiver, so the path is never reached (code reading: guard-off of scheduler.stop() or of the scheduler `closed` option stays green because scheduled.clear() is a third layer)",
    },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": {
      request: false,
      then: "ready",
      unreached:
        "scheduler: schedulerDue and tick stop and dropDeferredWhenUnavailable clears the deferred terms after the bound; the path is never reached",
    },
    "tab-hidden": {
      request: false,
      then: "ready",
      unreached:
        "scheduler: suspend() stops the timer and the tick does not run on a hidden tab; the path is never reached",
    },
    closing: {
      unreachable:
        "the decision is taken in a timer (scheduler tick, retry pause, signal batch); a timer runs after close() has returned, and the closing window exists only inside it",
    },
  },
  R5: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  R6: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  R7: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  R8: {
    closed: {
      request: false,
      then: "purged",
      unreached:
        "core onClose clears scheduled/wave and stops the scheduler and the receiver, so the path is never reached (code reading: guard-off of scheduler.stop() or of the scheduler `closed` option stays green because scheduled.clear() is a third layer)",
    },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": {
      request: false,
      then: "ready",
      unreached:
        "receiver: halted() stops the collection of signals after the bound, before any admit",
    },
    "tab-hidden": { request: false, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken in a timer (scheduler tick, retry pause, signal batch); a timer runs after close() has returned, and the closing window exists only inside it",
    },
  },
  R9: {
    closed: {
      request: false,
      then: "purged",
      unreached:
        "core onClose clears scheduled/wave and stops the scheduler and the receiver, so the path is never reached (code reading: guard-off of scheduler.stop() or of the scheduler `closed` option stays green because scheduled.clear() is a third layer)",
    },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": {
      request: false,
      then: "ready",
      unreached:
        "receiver: halted() stops the collection of signals after the bound, before any admit",
    },
    "tab-hidden": { request: false, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken in a timer (scheduler tick, retry pause, signal batch); a timer runs after close() has returned, and the closing window exists only inside it",
    },
  },
  R10: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: {
      unreachable:
        "the purge flush of `close()` reaches the core `onFlush`, which skips the decision under `if (!closing && session.token().valid)` (code reading: guard-off stays green)",
    },
  },
  R11: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken when an answer settles (a microtask after the transport answers); that is after close() has returned",
    },
  },
  R12: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": {
      request: false,
      then: "loading:command.unavailable",
      unreached:
        "session: acceptEpoch discards every answer after the bound, so the pass never reaches the decision of the path",
    },
    "tab-hidden": { request: true, then: "refreshing" },
    closing: {
      unreachable:
        "the decision is taken when an answer settles (a microtask after the transport answers); that is after close() has returned",
    },
  },
  R13: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": { request: false, then: "ready" },
    "tab-hidden": { request: false, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  R14: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  R15: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: false, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken when an answer settles (a microtask after the transport answers); that is after close() has returned",
    },
  },
  R16: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken when an answer settles (a microtask after the transport answers); that is after close() has returned",
    },
  },
  R17: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": {
      request: false,
      then: "error:command.unavailable",
      unreached:
        "session: acceptEpoch discards every answer after the bound, so the pass never reaches the decision of the path",
    },
    "tab-hidden": { request: true, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken when an answer settles (a microtask after the transport answers); that is after close() has returned",
    },
  },
  R18: {
    closed: { request: false, then: "purged" },
    "stale-object": {
      request: false,
      then: "error:command.stale-client+stale",
    },
    "discard-bound": { request: false, then: "error:command.unavailable" },
    "tab-hidden": { request: false, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken when an answer settles (a microtask after the transport answers); that is after close() has returned",
    },
  },
  K1: {
    closed: {
      request: false,
      then: "purged",
      unreached:
        "core onClose clears scheduled/wave and stops the scheduler and the receiver, so the path is never reached (code reading: guard-off of scheduler.stop() or of the scheduler `closed` option stays green because scheduled.clear() is a third layer)",
    },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": {
      request: false,
      then: "ready",
      unreached:
        "receiver: halted() stops the collection of signals after the bound, before any admit",
    },
    "tab-hidden": { request: false, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken in a timer (scheduler tick, retry pause, signal batch); a timer runs after close() has returned, and the closing window exists only inside it",
    },
  },
  K2: {
    closed: {
      request: false,
      then: "purged",
      unreached:
        "core onClose clears scheduled/wave and stops the scheduler and the receiver, so the path is never reached (code reading: guard-off of scheduler.stop() or of the scheduler `closed` option stays green because scheduled.clear() is a third layer)",
    },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": {
      request: false,
      then: "ready",
      unreached:
        "receiver: halted() stops the collection of signals after the bound, before any admit",
    },
    "tab-hidden": { request: false, then: "ready" },
    closing: {
      unreachable:
        "the decision is taken in a timer (scheduler tick, retry pause, signal batch); a timer runs after close() has returned, and the closing window exists only inside it",
    },
  },
  K3: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": { request: true, then: "ready" },
    "tab-hidden": { request: true, then: "ready" },
    closing: {
      unreachable:
        "the purge flush of `close()` reaches the core `onFlush`, which skips the decision under `if (!closing && session.token().valid)` (code reading: guard-off stays green)",
    },
  },
  K4: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: false, then: "ready+stale" },
    "discard-bound": { request: true, then: "ready" },
    "tab-hidden": { request: true, then: "ready" },
    closing: {
      unreachable:
        "the update is refused on an invalid token before any write answer (overlay returns closedMutation), so the reread decision of K4 is never reached; the cell would only measure the refused mutation",
    },
  },
  S1: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: true, then: "ready+stale" },
    "discard-bound": { request: true, then: "ready" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  S2: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: true, then: "ready+stale" },
    "discard-bound": { request: true, then: "ready" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged", attempted: false },
  },
  S3: {
    closed: { request: false, then: "purged" },
    "stale-object": { request: true, then: "error:command.stale-client+stale" },
    "discard-bound": { request: true, then: "error:command.unavailable" },
    "tab-hidden": { request: true, then: "ready" },
    closing: { request: false, then: "purged" },
  },
}

describe("the paths of Appendix Б on main: request and consequence per condition", () => {
  it.each(SITE_CODES)("%s", async (code) => {
    // Контроль: без умови шлях запит дає. Інакше «запиту немає» нічого не доводить.
    const control = await run(code, undefined)
    expect(control.request, `${code} control`).toBe(true)
    // Контроль `attempted`: шлях, чию спробу міряє клітина, у контролі її робить.
    if (
      CONDITIONS.some((c) => {
        const cell = TABLE[code][c]
        return "attempted" in cell && cell.attempted !== undefined
      })
    )
      expect(control.attempted, `${code} control attempted`).toBe(true)
    for (const condition of CONDITIONS) {
      const cell = TABLE[code][condition]
      // Недосяжна пара: причина структурна, прогону немає.
      if ("unreachable" in cell) continue
      const { request, then, attempted } = await run(code, condition)
      const { unreached, attempted: wanted, ...expected } = cell
      const label = `${code} × ${condition}`
      expect({ request, then }, label).toEqual(expected)
      if (wanted !== undefined)
        expect(attempted, `${label} attempted`).toBe(wanted)
      // `unreached` пояснює лише «запиту немає».
      if (unreached !== undefined) expect(expected.request).toBe(false)
    }
  })
})
