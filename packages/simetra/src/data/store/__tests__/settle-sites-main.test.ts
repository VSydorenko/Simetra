import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { coreInternals } from "../core"
import { DISCARDS_MAX, DISCARD_PAUSE_MS } from "../session"
import { QUIET_MS } from "../receiver"
import { REREAD_TIMEOUT_MS } from "../writer"
import type { ViewHandle, ViewSpec } from "../types"
import type { FakeRead } from "../testing/fake-source"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import { channelTopic } from "simetra/model"
import { SCOPE_KIND_ID } from "../../../model/runtime/__tests__/entries"
import {
  S,
  TASK,
  key,
  keysOf,
  seed,
  settle,
  setup,
  task,
  type CoreHarness,
} from "./core-support"
import { record, type Recorder } from "./settle-record"
import { EXPECTED } from "./settle-sites-main.expected"
import {
  FLIGHT_KIND_RULES,
  KEYS_FAILURE,
  SITE_OVERRIDES,
  keysDiscarded,
  keysFailureOf,
  type FlightKind,
} from "../sync/flight-kinds"
import {
  READ_REASONS,
  SETTLE_OUTCOMES,
  type SettleOutcome,
} from "../sync/vocabulary"

/*
 * Характеристика `main` (план SK-2, задача 2): для кожної точки осідання
 * Р-SK2-1 і кожного наслідку, якого точка досягає, — записана послідовність
 * ефектів з порядком відносно області запису (`flush` — кінець `commit`):
 * записи сховищ, зміни полів і позначок, `sweep`, сповіщення, наслідок
 * спроби, зняття оренди, повтор чи строк. Тест написано на коді точок до
 * міграції; задачі 3–5 очікувань не змінюють — відмінність, якої Р-SK2-5 не
 * назвав, червонить його. Що саме записується й що ні — `settle-record.ts`.
 *
 * Клітинки «точка × наслідок», яких `main` не досягає, названо в кінці файлу
 * (`UNREACHABLE`) з причиною.
 */

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const EA = "a".repeat(64)
const EB = "b".repeat(64)
const FULL: ViewSpec = { kind: "full", object: TASK }
const WINDOW: ViewSpec = { kind: "window", object: TASK }
const KEYS12: ViewSpec = { kind: "keys", object: TASK, keys: [key(1), key(2)] }

const passOf = (h: CoreHarness, epoch: string) =>
  h.core.commit(
    (w) =>
      void w.apply(TASK, { rows: [], absent: [] }, h.core.readEpoch(), epoch),
    h.core.token()
  )
/** Покинута епоха EA: наступні її відповіді відкидаються. */
const abandonEpoch = (h: CoreHarness) => {
  passOf(h, EA)
  passOf(h, EB)
}
/** `count` відкинутих проходів поспіль: межа відкинутих — на один менше `DISCARDS_MAX`. */
const discardsBelowBound = (h: CoreHarness) => {
  for (let i = 0; i < DISCARDS_MAX - 1; i++) passOf(h, EA)
}
const makeUnavailable = (h: CoreHarness) => {
  for (let i = 0; i < DISCARDS_MAX; i++) passOf(h, EA)
  expect(h.inspect.versionEpochs().unavailable).toBe(true)
}
const raiseRequirement = (h: CoreHarness) =>
  h.core.commit(
    (w) =>
      w.markViews(TASK, {
        unconfirmedSince: coreInternals(h.core).epochs.next(),
      }),
    h.core.token()
  )

type Options = Parameters<typeof setup>[0]
interface Rig {
  readonly h: CoreHarness
  readonly rec: Recorder
  readonly view: ViewHandle
  readonly unsubscribe: () => void
}

/** Готове ядро з завантаженим видом; запис починається після підготовки. */
async function loadedRig(
  spec: ViewSpec = FULL,
  rows = 3,
  options: Options = {},
  beforeRecord?: (h: CoreHarness) => void
): Promise<Rig> {
  const h = setup({ now: () => Date.now(), ...options })
  seed(h.fake, 1, rows)
  const view = h.core.view(spec)
  const sub = view.subscribe(() => {})
  await settle()
  if (options.mode === "manual") {
    h.fake.deliverAll()
    await settle()
  }
  beforeRecord?.(h)
  const rec = record(h)
  const watched = rec.watch(view, spec.kind)
  rec.mark()
  return {
    h,
    rec,
    view,
    unsubscribe: () => {
      sub()
      watched.unsubscribe()
    },
  }
}

/** Вид, який ще не читався: запис стартує до його створення. */
function freshRig(
  spec: ViewSpec,
  rows: number,
  options: Options = {},
  beforeRecord?: (h: CoreHarness) => void
) {
  const h = setup({ now: () => Date.now(), ...options })
  seed(h.fake, 1, rows)
  beforeRecord?.(h)
  const rec = record(h)
  const view = h.core.view(spec)
  const watched = rec.watch(view, spec.kind)
  return { h, rec, view, release: watched.unsubscribe }
}

const fail = (h: CoreHarness) => {
  h.fake.hold = undefined
  h.fake.take().fail("command.unavailable")
}

const throwOnPut = (h: CoreHarness) =>
  vi.spyOn(coreInternals(h.core).ops, "put").mockImplementationOnce(() => {
    throw new Error("apply failed")
  })

const log = (rec: Recorder) => rec.done()

type Scenario = () => Promise<string[]>

/** Завантаження (`subsets.ts::load`, M1/M7/M8). */
const LOAD: Record<string, Scenario> = {
  "load applied": async () => {
    const { h, rec } = freshRig(FULL, 3)
    await settle()
    void h
    return log(rec)
  },
  "load applied, then M7 again (requirement raised in flight)": async () => {
    const { h, rec, view } = freshRig(FULL, 3)
    h.fake.hold = () => true
    void view
    await settle()
    const flying = h.fake.take()
    raiseRequirement(h)
    rec.mark()
    h.fake.hold = undefined
    flying.answer()
    await settle()
    return log(rec)
  },
  "load discarded by epoch, pause, then M8": async () => {
    const { h, rec, view } = await loadedRig()
    h.fake.epoch = EA
    view.refresh()
    await settle()
    abandonEpoch(h)
    rec.mark()
    view.refresh()
    await settle()
    h.fake.epoch = EB
    await vi.advanceTimersByTimeAsync(DISCARD_PAUSE_MS * 2)
    await settle()
    return log(rec)
  },
  "load discarded, the bound reached by this answer (second commit)":
    async () => {
      const { h, rec, view } = await loadedRig()
      h.fake.epoch = EA
      view.refresh()
      await settle()
      abandonEpoch(h)
      discardsBelowBound(h)
      rec.mark()
      view.refresh()
      await settle()
      return log(rec)
    },
  "load discarded, the bound already reached inside the region": async () => {
    const { h, rec, view } = await loadedRig()
    h.fake.epoch = EA
    view.refresh()
    await settle()
    abandonEpoch(h)
    h.fake.hold = () => true
    view.refresh()
    await settle()
    const flying = h.fake.take()
    makeUnavailable(h)
    rec.mark()
    h.fake.hold = undefined
    flying.answer()
    await settle()
    return log(rec)
  },
  "load failed: apply throws": async () => {
    const { h, rec } = freshRig(FULL, 3, {}, (h) => void throwOnPut(h))
    await settle()
    void h
    return log(rec)
  },
  "load failed: read refused, view never loaded": async () => {
    const { h, rec } = freshRig(FULL, 3, { mode: "manual" })
    await settle()
    fail(h)
    await settle()
    return log(rec)
  },
  "load failed: read refused, view loaded": async () => {
    const { h, rec, view } = await loadedRig(FULL, 3, { mode: "manual" })
    view.refresh()
    await settle()
    fail(h)
    await settle()
    return log(rec)
  },
  "load closed: the limiter refuses a queued read": async () => {
    const h = setup({ mode: "manual", limits: { readParallel: 1 } })
    seed(h.fake, 1, 3)
    const rec = record(h)
    rec.watch(h.core.view(FULL), "full")
    await settle()
    rec.watch(h.core.view(KEYS12), "keys")
    await settle()
    h.core.close("disposed")
    await settle()
    return log(rec)
  },
  "load closed: the answer arrives after close": async () => {
    const { h, rec } = freshRig(FULL, 3, { mode: "manual" })
    await settle()
    h.core.close("disposed")
    h.fake.deliverAll()
    await settle()
    return log(rec)
  },
  "load with the token invalidated by a purge while the view lives":
    async () => {
      const { h, rec, view } = await loadedRig()
      h.fake.hold = () => true
      view.refresh()
      await settle()
      const flying = h.fake.take()
      h.core.commit((w) => w.purge(TASK, { keys: [key(1)] }), h.core.token())
      rec.mark()
      h.fake.hold = undefined
      flying.answer()
      await settle()
      return log(rec)
    },
  "load evicted: the view was released in flight": async () => {
    const { h, rec, release } = freshRig(FULL, 3, { mode: "manual" })
    await settle()
    release()
    vi.advanceTimersByTime(2_000)
    h.fake.deliverAll()
    await settle()
    return log(rec)
  },
}

const isKeysRead = (read: FakeRead) => keysOf(read.query).length > 0

/**
 * Розбіжне «рядка немає» для `k` (П15): старе читання за ключем тримається,
 * новіше пише рядок, а відповідь старого лягає після нього.
 */
async function divergence(h: CoreHarness, k: string) {
  const { core, fake } = h
  const handle = core.view({ kind: "keys", object: TASK, keys: [k] })
  const own = handle.subscribe(() => {})
  await settle()
  const before = fake.hold
  fake.hold = (read) =>
    keysOf(read.query).includes(k) || (before?.(read) ?? false)
  handle.refresh()
  await settle()
  const older = fake.take((read) => keysOf(read.query).includes(k))
  fake.hold = before
  const newer = core
    .view({ kind: "keys", object: TASK, keys: [key(1), k] })
    .subscribe(() => {})
  await settle()
  return async () => {
    const held = fake.hold
    fake.hold = (read) => isKeysRead(read) || (held?.(read) ?? false)
    fake.setVisibleScopes([])
    older.answer()
    fake.setVisibleScopes(undefined)
    await settle()
    own()
    newer()
    vi.advanceTimersByTime(2_000)
    await settle()
    fake.hold = held
  }
}

const isPage = (read: FakeRead) =>
  read.query !== undefined &&
  "limit" in read.query &&
  !("tabularSection" in read.query) &&
  keysOf(read.query).length === 0

/** Сторінка вікна (`subsets.ts::loadMore`, P1/P2/P3). */
const PAGE: Record<string, Scenario> = {
  "page applied": async () => {
    const { rec, view } = await loadedRig(WINDOW, 250)
    view.loadAfter()
    await settle()
    return log(rec)
  },
  "page applied, a standing requirement read after it (readRequirement)":
    async () => {
      const { h, rec, view } = await loadedRig(WINDOW, 250)
      h.fake.hold = isPage
      view.loadAfter()
      await settle()
      const page = h.fake.take(isPage)
      raiseRequirement(h)
      rec.mark()
      h.fake.hold = undefined
      page.answer()
      await settle()
      return log(rec)
    },
  "page discarded by epoch, pause, then P2": async () => {
    const { h, rec, view } = await loadedRig(WINDOW, 250)
    h.fake.epoch = EA
    view.refresh()
    await settle()
    h.fake.epoch = EB
    view.refresh()
    await settle()
    h.fake.epoch = EA
    rec.mark()
    view.loadAfter()
    await settle()
    h.fake.epoch = EB
    await vi.advanceTimersByTimeAsync(DISCARD_PAUSE_MS * 2)
    await settle()
    return log(rec)
  },
  "page discarded, the bound already reached inside the region": async () => {
    const { h, rec, view } = await loadedRig(WINDOW, 250)
    h.fake.epoch = EA
    view.refresh()
    await settle()
    abandonEpoch(h)
    h.fake.hold = isPage
    view.loadAfter()
    await settle()
    const page = h.fake.take(isPage)
    makeUnavailable(h)
    rec.mark()
    h.fake.hold = undefined
    page.answer()
    await settle()
    return log(rec)
  },
  "page discarded, the bound reached by this answer": async () => {
    const { h, rec, view } = await loadedRig(WINDOW, 250)
    h.fake.epoch = EA
    view.refresh()
    await settle()
    abandonEpoch(h)
    discardsBelowBound(h)
    rec.mark()
    view.loadAfter()
    await settle()
    return log(rec)
  },
  "page failed: apply throws": async () => {
    const { h, rec, view } = await loadedRig(WINDOW, 250)
    throwOnPut(h)
    view.loadAfter()
    await settle()
    return log(rec)
  },
  "page failed: read refused": async () => {
    const { h, rec, view } = await loadedRig(WINDOW, 250)
    h.fake.hold = isPage
    view.loadAfter()
    await settle()
    h.fake.hold = undefined
    h.fake.take(isPage).fail("command.unavailable")
    await settle()
    return log(rec)
  },
  "page closed: the answer arrives after close": async () => {
    const { h, rec, view } = await loadedRig(WINDOW, 250)
    h.fake.hold = isPage
    view.loadAfter()
    await settle()
    const page = h.fake.take(isPage)
    h.core.close("disposed")
    page.answer()
    await settle()
    return log(rec)
  },
  "page evicted: the view was released in flight": async () => {
    const { h, rec, view, unsubscribe } = await loadedRig(WINDOW, 250)
    h.fake.hold = isPage
    view.loadAfter()
    await settle()
    const page = h.fake.take(isPage)
    unsubscribe()
    vi.advanceTimersByTime(2_000)
    rec.mark()
    h.fake.hold = undefined
    page.answer()
    await settle()
    return log(rec)
  },
  "page closed: the limiter refuses a queued read": async () => {
    const { h, rec, view } = await loadedRig(WINDOW, 250, {
      mode: "manual",
      limits: { readParallel: 1 },
    })
    h.fake.hold = undefined
    view.refresh()
    await settle()
    view.loadAfter()
    await settle()
    h.core.close("disposed")
    await settle()
    return log(rec)
  },
  "page repeated by its own answer (P3, divergent remove)": async () => {
    const { h, rec, view } = await loadedRig(WINDOW, 5, {
      limits: { windowPage: 2, revalidateIntervalMs: 10_000_000 },
    })
    const bury = await divergence(h, key(3))
    h.fake.hold = isPage
    view.loadAfter()
    await settle()
    const page = h.fake.take(isPage)
    await bury()
    rec.mark()
    h.fake.hold = undefined
    page.answer()
    await settle()
    return log(rec)
  },
  "page with the token invalidated by a purge while the view lives":
    async () => {
      const { h, rec, view } = await loadedRig(WINDOW, 250)
      h.fake.hold = isPage
      view.loadAfter()
      await settle()
      const page = h.fake.take(isPage)
      h.core.commit((w) => w.purge(TASK, { keys: [key(1)] }), h.core.token())
      rec.mark()
      h.fake.hold = undefined
      page.answer()
      await settle()
      return log(rec)
    },
}

const raiseBanners = (h: CoreHarness) =>
  h.core.commit(
    (w) => w.markViews(TASK, { hasNewRows: true, needsRefresh: true }),
    h.core.token()
  )

/** Банери вигляду: хто їх знімає, а хто лишає (колонка «знімає банери»). */
const BANNERS: Record<string, Scenario> = {
  "load applied lifts the banners": async () => {
    const { h, rec, view } = await loadedRig()
    raiseBanners(h)
    rec.mark()
    view.refresh()
    await settle()
    return log(rec)
  },
  "page applied leaves the banners": async () => {
    const { h, rec, view } = await loadedRig(WINDOW, 250)
    raiseBanners(h)
    rec.mark()
    view.loadAfter()
    await settle()
    return log(rec)
  },
  "reread applied leaves the banners": async () => {
    const { h, rec } = await loadedRig()
    raiseBanners(h)
    rec.mark()
    await h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    return log(rec)
  },
}

/** Системне перечитування (`writer.ts::revalidateViews`, R3/R16/R17/R18). */
const REREAD: Record<string, Scenario> = {
  "reread applied": async () => {
    const { h, rec } = await loadedRig()
    await h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    return log(rec)
  },
  "reread applied, requirement raised in flight: R18 again": async () => {
    const { h, rec } = await loadedRig()
    h.fake.hold = () => true
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const flying = h.fake.take()
    raiseRequirement(h)
    rec.mark()
    h.fake.hold = undefined
    flying.answer()
    await settle()
    return log(rec)
  },
  "reread discarded by epoch: pause in the object deadline, then retry":
    async () => {
      const { h, rec } = await loadedRig(FULL, 3, {
        limits: { revalidateIntervalMs: 60_000 },
      })
      const act = () => void h.core.revalidate(TASK, { visibleOnly: false })
      h.fake.epoch = EA
      act()
      await settle()
      abandonEpoch(h)
      rec.mark()
      act()
      await settle()
      rec.due()
      h.fake.epoch = EB
      await vi.advanceTimersByTimeAsync(DISCARD_PAUSE_MS * 4)
      await settle()
      return log(rec)
    },
  "reread discarded, the bound reached by this answer": async () => {
    const { h, rec } = await loadedRig()
    h.fake.epoch = EA
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    abandonEpoch(h)
    discardsBelowBound(h)
    rec.mark()
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    rec.due()
    return log(rec)
  },
  "reread discarded, the bound already reached inside the region": async () => {
    const { h, rec } = await loadedRig()
    h.fake.epoch = EA
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    abandonEpoch(h)
    h.fake.hold = () => true
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const flying = h.fake.take()
    makeUnavailable(h)
    rec.mark()
    h.fake.hold = undefined
    flying.answer()
    await settle()
    rec.due()
    return log(rec)
  },
  "reread failed: read refused (the pause counts for a loaded view)":
    async () => {
      const { h, rec } = await loadedRig()
      h.fake.hold = () => true
      void h.core.revalidate(TASK, { visibleOnly: false })
      await settle()
      h.fake.hold = undefined
      h.fake.take().fail("command.unavailable")
      await settle()
      return log(rec)
    },
  "reread failed: apply throws": async () => {
    const { h, rec } = await loadedRig()
    throwOnPut(h)
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    return log(rec)
  },
  "reread closed: the answer arrives after close": async () => {
    const { h, rec } = await loadedRig()
    h.fake.hold = () => true
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const flying = h.fake.take()
    h.core.close("disposed")
    flying.answer()
    await settle()
    return log(rec)
  },
  "reread evicted: the view was released in flight": async () => {
    const { h, rec, unsubscribe } = await loadedRig()
    h.fake.hold = () => true
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const flying = h.fake.take()
    unsubscribe()
    vi.advanceTimersByTime(2_000)
    rec.mark()
    h.fake.hold = undefined
    flying.answer()
    await settle()
    return log(rec)
  },
  "reread skipped: the view's own load settled first, then readRequirement":
    async () => {
      const { h, rec, view } = await loadedRig()
      h.fake.hold = () => true
      void h.core.revalidate(TASK, { visibleOnly: false })
      await settle()
      const flying = h.fake.take()
      h.fake.hold = undefined
      view.refresh()
      await settle()
      raiseRequirement(h)
      rec.mark()
      flying.answer()
      await settle()
      return log(rec)
    },
  "reread after a purge of the object: barrier, R16 again": async () => {
    const { h, rec } = await loadedRig()
    h.fake.hold = () => true
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const flying = h.fake.take()
    h.core.commit((w) => w.purge(TASK, { keys: [key(1)] }), h.core.token())
    rec.mark()
    h.fake.hold = undefined
    flying.answer()
    await settle()
    return log(rec)
  },
  "reread whose window page a purge dropped: R17 again": async () => {
    const { h, rec } = await loadedRig(WINDOW, 250)
    h.fake.hold = () => true
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const flying = h.fake.take()
    h.core.commit(
      (w) => w.purge(TASK, { scope: S }, { rights: true }),
      h.core.token()
    )
    rec.mark()
    h.fake.hold = undefined
    flying.answer()
    await settle()
    return log(rec)
  },
  "reread of two views in one pass: one answered, one refused": async () => {
    const { h, rec } = await loadedRig(FULL)
    const second = h.core.view(WINDOW)
    rec.watch(second, "window")
    second.subscribe(() => {})
    await settle()
    h.fake.hold = () => true
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const first = h.fake.take()
    const other = h.fake.take()
    rec.mark()
    h.fake.hold = undefined
    first.answer()
    other.fail("command.unavailable")
    await settle()
    return log(rec)
  },
}

const update = (h: CoreHarness) =>
  void h.core.update(TASK, key(1), { title: "x" }, { expectedVersion: 1 })

/** Читання ключа після власного запису (`writer.ts::rereadKey`, K4). */
const WRITE_CONFIRM: Record<string, Scenario> = {
  "write-confirm read": async () => {
    const { h, rec } = await loadedRig()
    update(h)
    await settle()
    return log(rec)
  },
  "write-confirm failed: read refused (the key is marked unconfirmed)":
    async () => {
      const { h, rec } = await loadedRig()
      h.fake.hold = () => true
      update(h)
      await settle()
      h.fake.hold = undefined
      h.fake.take().fail("command.unavailable")
      await settle()
      return log(rec)
    },
  "write-confirm discarded by epoch (the key is marked unconfirmed)":
    async () => {
      const { h, rec } = await loadedRig()
      h.fake.epoch = EA
      void h.core.revalidate(TASK, { visibleOnly: false })
      await settle()
      abandonEpoch(h)
      rec.mark()
      update(h)
      await settle()
      return log(rec)
    },
  "write-confirm timeout, then the late answer is still written": async () => {
    const { h, rec } = await loadedRig()
    h.fake.hold = () => true
    update(h)
    await settle()
    const late = h.fake.take()
    await vi.advanceTimersByTimeAsync(REREAD_TIMEOUT_MS)
    await settle()
    h.fake.hold = undefined
    late.answer()
    await settle()
    return log(rec)
  },
  "write-confirm closed: the answer arrives after close": async () => {
    const { h, rec } = await loadedRig()
    h.fake.hold = () => true
    update(h)
    await settle()
    const late = h.fake.take()
    h.core.close("disposed")
    late.answer()
    await settle()
    return log(rec)
  },
}

/** Хвіст ключів (`core.ts::runTail`, K3). */
const hide = (h: CoreHarness) =>
  void h.core.commit((w) => w.hideByHorizon(TASK, [key(1)]), h.core.token())
const TAIL: Record<string, Scenario> = {
  "tail read": async () => {
    const { h, rec } = await loadedRig()
    hide(h)
    await settle()
    return log(rec)
  },
  "tail discarded by epoch": async () => {
    const { h, rec } = await loadedRig()
    h.fake.epoch = EA
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    abandonEpoch(h)
    rec.mark()
    hide(h)
    await settle()
    return log(rec)
  },
  "tail failed: read refused (no retry)": async () => {
    const { h, rec } = await loadedRig()
    h.fake.hold = () => true
    hide(h)
    await settle()
    h.fake.hold = undefined
    h.fake.take().fail("command.unavailable")
    await settle()
    return log(rec)
  },
  "tail closed: the answer arrives after close": async () => {
    const { h, rec } = await loadedRig()
    h.fake.hold = () => true
    hide(h)
    await settle()
    const flying = h.fake.take()
    h.core.close("disposed")
    flying.answer()
    await settle()
    return log(rec)
  },
  "tail with its generation invalidated by a purge": async () => {
    const { h, rec } = await loadedRig()
    h.fake.hold = () => true
    hide(h)
    await settle()
    const flying = h.fake.take()
    h.core.commit((w) => w.purge(TASK, { keys: [key(1)] }), h.core.token())
    rec.mark()
    h.fake.hold = undefined
    flying.answer()
    await settle()
    return log(rec)
  },
}

/** Приймач сигналів (`receiver.ts::land`/`settleJob`, K1/K2). */
const USER = "00000000-0000-4000-8000-0000000000a1"
const CHANNEL = channelTopic({
  kind: "changes",
  scopeKindId: SCOPE_KIND_ID,
  scope: S,
  object: task.id,
})
let signalId = 0
const change = (k: string, version: number, op = "update") => ({
  id: String(++signalId),
  object: task.id,
  op,
  keys: { id: k },
  row_ver: version,
})

const grantRead = (h: CoreHarness) => {
  h.fake.rightsSnapshot = {
    userId: USER,
    scopeSets: [{ scopeKind: SCOPE_KIND_ID, scope: S }],
    rights: [
      {
        level: "scope",
        levelId: null,
        scope: S,
        container: null,
        object: "task",
        action: "read",
        extent: "any",
        dimensionId: null,
      },
    ],
    members: [],
    dimensionValues: [],
  }
  h.fake.rightsVersion = "1".repeat(64)
}

async function signalCore(
  spec: ViewSpec,
  rows: number,
  options: Options = {}
): Promise<{
  h: CoreHarness
  rec: Recorder
  transport: ReturnType<typeof createFakeSignalTransport>
}> {
  const transport = createFakeSignalTransport()
  const h = setup({
    now: () => Date.now(),
    limits: { revalidateIntervalMs: 10_000_000 },
    signals: transport,
    rightsSnapshot: true,
    ...options,
  })
  grantRead(h)
  seed(h.fake, 1, rows)
  const view = h.core.view(spec)
  view.subscribe(() => {})
  await settle()
  const rec = record(h)
  rec.watch(view, spec.kind)
  rec.mark()
  return { h, rec, transport }
}

const RECEIVER: Record<string, Scenario> = {
  "signal read applied": async () => {
    const { h, rec, transport } = await signalCore(KEYS12, 3)
    const version = h.fake.edit(TASK, key(1), { title: "new" })
    transport.emit(CHANNEL, change(key(1), version))
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    return log(rec)
  },
  "signal read failed: refused (needsRefresh and the composition mark)":
    async () => {
      const { h, rec, transport } = await signalCore(KEYS12, 3)
      const version = h.fake.edit(TASK, key(1), { title: "new" })
      h.fake.hold = () => true
      transport.emit(CHANNEL, change(key(1), version))
      await vi.advanceTimersByTimeAsync(QUIET_MS)
      await settle()
      h.fake.hold = undefined
      h.fake.take().fail("command.unavailable")
      await settle()
      return log(rec)
    },
  "signal read discarded by epoch": async () => {
    const { h, rec, transport } = await signalCore(KEYS12, 3)
    h.fake.epoch = EA
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    abandonEpoch(h)
    rec.mark()
    const version = h.fake.edit(TASK, key(1), { title: "new" })
    transport.emit(CHANNEL, change(key(1), version))
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    return log(rec)
  },
  "signal read with a version below the promised one: min-version retry after the region":
    async () => {
      const { h, rec, transport } = await signalCore(KEYS12, 3)
      const ahead = h.fake.row(TASK, key(1))!.version + 5
      transport.emit(CHANNEL, change(key(1), ahead))
      await vi.advanceTimersByTimeAsync(QUIET_MS)
      await settle()
      await vi.advanceTimersByTimeAsync(30_000)
      await settle()
      return log(rec)
    },
  "min-version retry read refused (K2 fails like K1)": async () => {
    const { h, rec, transport } = await signalCore(KEYS12, 3)
    const ahead = h.fake.row(TASK, key(1))!.version + 5
    transport.emit(CHANNEL, change(key(1), ahead))
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    h.fake.hold = () => true
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    rec.mark()
    h.fake.hold = undefined
    h.fake.take().fail("command.unavailable")
    await settle()
    return log(rec)
  },
  "signal read of a new row: the new-rows hint, nothing written": async () => {
    const { h, rec, transport } = await signalCore(FULL, 3)
    h.fake.insert(TASK, {
      ref: key(4),
      org: S,
      title: "t4",
      notes: "body 4",
    })
    const row = h.fake.row(TASK, key(4))!
    transport.emit(CHANNEL, change(key(4), row.version, "insert"))
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    return log(rec)
  },
  "signal read stopped: the receiver stops before the answer": async () => {
    const { h, rec, transport } = await signalCore(KEYS12, 3)
    const version = h.fake.edit(TASK, key(1), { title: "new" })
    h.fake.hold = () => true
    transport.emit(CHANNEL, change(key(1), version))
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    const flying = h.fake.take()
    h.core.stopSignals()
    rec.mark()
    h.fake.hold = undefined
    flying.answer()
    await settle()
    return log(rec)
  },
  "signal read of the owner after the sections of the owner (dependency)":
    async () => {
      const transport = createFakeSignalTransport()
      const h = setup({
        now: () => Date.now(),
        limits: { revalidateIntervalMs: 10_000_000 },
        signals: transport,
        rightsSnapshot: true,
      })
      grantRead(h)
      seed(h.fake, 1, 3)
      h.fake.setLines(TASK, key(1), "lines", [
        { ref: key(901), qty: 1, lineNumber: 1 },
      ])
      const keysView = h.core.view(KEYS12)
      keysView.subscribe(() => {})
      await settle()
      const section = h.core.view({
        kind: "section",
        object: TASK,
        owner: key(1),
        section: "lines",
      })
      section.subscribe(() => {})
      await settle()
      const rec = record(h)
      rec.watch(keysView, "keys")
      rec.watch(section, "section")
      rec.mark()
      const version = h.fake.edit(TASK, key(1), { title: "new" })
      transport.emit(CHANNEL, change(key(1), version))
      await vi.advanceTimersByTimeAsync(QUIET_MS)
      await settle()
      return log(rec)
    },
}

const ALL: Record<string, Scenario> = {
  ...LOAD,
  ...PAGE,
  ...REREAD,
  ...BANNERS,
  ...WRITE_CONFIRM,
  ...TAIL,
  ...RECEIVER,
}

describe("settle points on main: sequence of effects", () => {
  for (const [name, run] of Object.entries(ALL)) {
    it(name, async () => {
      expect(await run()).toEqual(EXPECTED[name])
    })
  }
})

/*
 * Точка × наслідок. Клітинка — назва сценарію вище або причина, чому `main`
 * наслідку не досягає. Точки без події `watchAttempts` (ключі, хвіст,
 * приймач) дістають наслідок з поведінки: `read` — applied, `discarded` —
 * discarded-by-epoch, відмова читання — failed, недійсний токен — closed,
 * evicted чи after-purge.
 */
const MATRIX: Record<string, Record<SettleOutcome, string>> = {
  load: {
    applied: "load applied",
    "discarded-by-epoch": "load discarded by epoch, pause, then M8",
    failed: "load failed: apply throws",
    evicted: "load evicted: the view was released in flight",
    "after-purge":
      "load with the token invalidated by a purge while the view lives",
    closed: "load closed: the answer arrives after close",
  },
  page: {
    applied: "page applied",
    "discarded-by-epoch": "page discarded by epoch, pause, then P2",
    failed: "page failed: apply throws",
    evicted: "page evicted: the view was released in flight",
    "after-purge":
      "page with the token invalidated by a purge while the view lives",
    closed: "page closed: the answer arrives after close",
  },
  reread: {
    applied: "reread applied",
    "discarded-by-epoch":
      "reread discarded by epoch: pause in the object deadline, then retry",
    failed: "reread failed: read refused (the pause counts for a loaded view)",
    evicted: "reread evicted: the view was released in flight",
    "after-purge": "reread after a purge of the object: barrier, R16 again",
    closed: "reread closed: the answer arrives after close",
  },
  "write-confirm": {
    applied: "write-confirm read",
    "discarded-by-epoch":
      "write-confirm discarded by epoch (the key is marked unconfirmed)",
    failed:
      "write-confirm failed: read refused (the key is marked unconfirmed)",
    evicted: "unreachable: the point has no target token, only the session one",
    "after-purge":
      "unreachable: the point has no target token, only the session one",
    closed: "write-confirm closed: the answer arrives after close",
  },
  tail: {
    applied: "tail read",
    "discarded-by-epoch": "tail discarded by epoch",
    failed: "tail failed: read refused (no retry)",
    evicted:
      "unreachable: the tail has one generation token and no view that could be released; its invalidation is the after-purge cell",
    "after-purge": "tail with its generation invalidated by a purge",
    closed: "tail closed: the answer arrives after close",
  },
  receiver: {
    applied: "signal read applied",
    "discarded-by-epoch": "signal read discarded by epoch",
    failed:
      "signal read failed: refused (needsRefresh and the composition mark)",
    evicted:
      "unreachable: no target token; a purged pair leaves the batch (`purged()`) and `buriedSinceRead` only skips the write inside an applied answer",
    "after-purge":
      "unreachable: no target token; a purged pair leaves the batch (`purged()`) and `buriedSinceRead` only skips the write inside an applied answer",
    closed: "signal read stopped: the receiver stops before the answer",
  },
}

describe("settle points on main: the point × outcome table", () => {
  it("has a cell for every point and every outcome of the closed list", () => {
    for (const [point, cells] of Object.entries(MATRIX))
      expect(Object.keys(cells).sort(), point).toEqual(
        [...SETTLE_OUTCOMES].sort()
      )
  })

  it("every cell names a recorded scenario or says why it is unreachable", () => {
    for (const [point, cells] of Object.entries(MATRIX))
      for (const [outcome, cell] of Object.entries(cells))
        expect(
          cell.startsWith("unreachable: ") || cell in ALL,
          `${point} × ${outcome}: ${cell}`
        ).toBe(true)
  })

  it("a cell of a point with attempt events records that very outcome", () => {
    for (const point of ["load", "page", "reread"])
      for (const [outcome, cell] of Object.entries(MATRIX[point]!))
        expect(
          EXPECTED[cell]!.some((line) =>
            line.startsWith(`attempt.settled ${point} ${outcome}`)
          ),
          `${point} × ${outcome}`
        ).toBe(true)
  })
})

/*
 * Таблиця видів польоту (§5.5, Р-SK2-4) проти записаної поведінки `main`:
 * кожна клітинка, яку запис бачить, прив'язана до сценарію; зміна клітинки
 * червонить цей тест, а не лише копію таблиці. Клітинки, яких запис не бачить,
 * названо в `UNTIED` з причиною.
 */
describe("the kind table against the recorded behaviour of main", () => {
  const lines = (name: string) => EXPECTED[name]!
  const has = (name: string, pattern: RegExp) =>
    lines(name).some((line) => pattern.test(line))
  const R = FLIGHT_KIND_RULES

  it("failureCounts: the cells of load and page say what main recorded, reread says always", () => {
    // Клітинки, які читають точки завантаження й сторінки, — з клітинки, а не
    // з копії: запис `main` незмінний, тож зміна клітинки червонить і тест.
    const countsFor = (cell: typeof R.load.failureCounts, loaded: boolean) =>
      cell === "always" || (cell === "if-loaded" && loaded)
    expect(has("load failed: read refused, view loaded", /failures=1/)).toBe(
      countsFor(R.load.failureCounts, true)
    )
    expect(
      has("load failed: read refused, view never loaded", /failures=/)
    ).toBe(countsFor(R.load.failureCounts, false))
    expect(has("page failed: read refused", /failures=/)).toBe(
      countsFor(R.page.failureCounts, true)
    )
    expect(R.reread.failureCounts).toBe("always")
    expect(
      has(
        "reread failed: read refused (the pause counts for a loaded view)",
        /failures=1/
      )
    ).toBe(true)
  })

  it("liftsBanners and setsBanners: load lifts, page and reread leave, only reread sets", () => {
    expect(has("load applied lifts the banners", /hasNewRows=false/)).toBe(
      R.load.liftsBanners
    )
    expect(has("page applied leaves the banners", /hasNewRows=false/)).toBe(
      R.page.liftsBanners
    )
    expect(R.reread.liftsBanners).toBe(false)
    expect(has("reread applied leaves the banners", /hasNewRows=false/)).toBe(
      false
    )
    expect([
      R.load.setsBanners,
      R.page.setsBanners,
      R.reread.setsBanners,
    ]).toEqual([false, false, true])
    expect(
      has(
        "reread after a purge of the object: barrier, R16 again",
        /hasNewRows=true/
      )
    ).toBe(true)
    for (const name of Object.keys(EXPECTED))
      if (name.startsWith("load ") || name.startsWith("page "))
        expect(has(name, /hasNewRows=true/), name).toBe(false)
  })

  it("confirms: load and page write their composition, reread does not; a page keeps the requirement", () => {
    expect(has("load applied", /^ops\.own/)).toBe(
      R.load.confirms === "view-with-composition"
    )
    // Сторінка теж пише рядки (`ops.own`), але лише власні.
    expect(has("page applied", /^ops\.own/)).toBe(
      R.page.confirms === "own-page"
    )
    expect([R.reread.confirms, R.keys.confirms]).toEqual([
      "view-stable",
      "rows",
    ])
    expect(has("reread applied", /^ops\.own/)).toBe(false)
    expect(has("tail read", /^ops\.own/)).toBe(false)
    // Завантаження знімає вимогу власним польотом, сторінка — лише читанням,
    // яке вона викликає після себе.
    const own = lines(
      "load applied, then M7 again (requirement raised in flight)"
    )
    expect(own.findIndex((l) => /unconfirmedSince=-/.test(l))).toBeGreaterThan(
      own.findIndex((l) => l.startsWith("attempt.start load M7"))
    )
    const page = lines(
      "page applied, a standing requirement read after it (readRequirement)"
    )
    expect(page.findIndex((l) => /unconfirmedSince=-/.test(l))).toBeGreaterThan(
      page.findIndex((l) => l.startsWith("attempt.start reread"))
    )
  })

  it("discarded: load and page pause then retry, reread moves the object deadline, keys do nothing", () => {
    expect([R.reread.discarded, R.keys.discarded]).toEqual([
      "pause-then-deadline",
      "nothing",
    ])
    expect(
      has("load discarded by epoch, pause, then M8", /^attempt\.start load M8/)
    ).toBe(R.load.discarded === "pause-then-retry")
    expect(
      has("page discarded by epoch, pause, then P2", /^attempt\.start page P2/)
    ).toBe(R.page.discarded === "pause-then-retry")
    const reread = lines(
      "reread discarded by epoch: pause in the object deadline, then retry"
    )
    expect(reread).toContain("scheduled Catalog.Task")
    expect(reread.some((l) => l.startsWith("attempt.start reread R3"))).toBe(
      true
    )
    // Одне читання хвоста й жодного повтору після відкинутої відповіді.
    expect(
      lines("tail discarded by epoch").filter((l) => l.startsWith("read "))
    ).toHaveLength(1)
    expect(keysDiscarded("signal")).toBe("nothing")
    expect(keysDiscarded("requirement")).toBe("nothing")
  })

  it("keys failure by reason: signal and K2 mark the views, the tail marks nothing", () => {
    expect(KEYS_FAILURE.signal).toBe("composition-unconfirmed")
    expect(KEYS_FAILURE.requirement).toBe("requirement-budget")
    expect(
      has(
        "signal read failed: refused (needsRefresh and the composition mark)",
        /needsRefresh=true/
      )
    ).toBe(true)
    expect(
      has(
        "tail failed: read refused (no retry)",
        /needsRefresh|unconfirmedSince/
      )
    ).toBe(false)
    // K2 — перевизначення: збій як K1, а повтор іде після області запису.
    expect(Object.keys(SITE_OVERRIDES)).toEqual(["K2"])
    expect(keysFailureOf("K2", "requirement")).toBe("composition-unconfirmed")
    expect(keysFailureOf("K3", "requirement")).toBe("requirement-budget")
    expect(
      has(
        "min-version retry read refused (K2 fails like K1)",
        /needsRefresh=true/
      )
    ).toBe(true)
    expect(SITE_OVERRIDES.K2?.schedulesRetryAfterCommit).toBe(true)
    const retry = lines(
      "signal read with a version below the promised one: min-version retry after the region"
    )
    expect(
      retry.findIndex((l) => l.startsWith("read keys K2"))
    ).toBeGreaterThan(retry.indexOf("flush"))
  })

  it("reasons: every read of the recordings carries a reason of its kind", () => {
    const kindOfSite: Record<string, FlightKind> = {
      M: "load",
      P: "page",
      R: "reread",
      K: "keys",
      S: "service",
    }
    const seen = new Set<string>()
    for (const log of Object.values(EXPECTED))
      for (const line of log) {
        const m = /^read \w+ ([MPRKS])\d+\/(.+)$/.exec(line)
        if (m === null) continue
        const kind = kindOfSite[m[1]!]!
        const reason = (READ_REASONS as readonly string[]).includes(m[2]!)
          ? m[2]!
          : "requirement"
        seen.add(`${kind}:${reason}`)
        expect(
          (R[kind].reasons as readonly string[]).includes(reason),
          line
        ).toBe(true)
      }
    expect(seen.size).toBeGreaterThan(0)
  })

  /*
   * Клітинки, яких запис `main` не бачить, — без вигаданого зв'язку:
   * - `successMovesDeadline` (reread, service): `refreshedAt` і `okReadEpoch`
   *   у записі нормалізовано до «задано», рух значення між двома успіхами не
   *   видно; сторінка й завантаження прив'язані (page не задає, load задає);
   * - `failureCounts` (service, by-reason для ключів), `liftsBanners` (service),
   *   `discarded` (service, `reply-discarded` для write-confirm), `confirms`
   *   (service): служби читає лише ядро (S1–S3) без подій спроби, а запитувач
   *   `write-confirm` і `markUnconfirmed` не мають спостережуваного ефекту в
   *   сценаріях (рядок уже має версію чи позначку епохи);
   * - `reasons` ключів `requirement`/службових: видно лише ті, що пускають
   *   сценарії.
   */
  it("moves of the deadline: load moves it, page does not", () => {
    expect(has("load applied", /refreshedAt=set/)).toBe(
      R.load.successMovesDeadline
    )
    expect(has("page applied", /refreshedAt=set/)).toBe(
      R.page.successMovesDeadline
    )
  })
})
