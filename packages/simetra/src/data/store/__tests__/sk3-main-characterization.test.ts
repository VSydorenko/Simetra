import { isDeepStrictEqual } from "node:util"
import { channelTopic, type RightsRow } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SCOPE_KIND_ID } from "../../../model/runtime/__tests__/entries"
import { coreInternals, type SyncState, type SyncTarget } from "../core"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import type { ViewSnapshot, ViewSpec } from "../types"
import {
  S,
  TASK,
  key,
  seed,
  isCard,
  isSection,
  settle,
  setup,
  task,
  watch,
  type CoreHarness,
} from "./core-support"

/*
 * Характеризація `main` для SK-3 (план задача 1): знімки виглядів, число
 * побудов знімка й сповіщень, діагностика `sync()` у місцях, де частина Б
 * переносить свіжість у запис цілі. Поведінка `main` не змінюється, тож до
 * кінця частини В цей файл не міняється. У частині Г змінюються лише блоки
 * «ROW 20» і «ROW 22» — вони описують те, що §5.14 рядків 20 і 22 міняє.
 */

// Число побудов знімка — виклики `shareSnapshot` (одна побудова = один виклик):
// ідентичність знімка їх не рахує, бо `shareSnapshot` повертає попередній.
const built = vi.hoisted(() => ({ count: 0 }))
vi.mock("../snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../snapshot")>()
  return {
    ...actual,
    shareSnapshot: (...args: Parameters<typeof actual.shareSnapshot>) => {
      built.count++
      return actual.shareSnapshot(...args)
    },
  }
})

const USER = "00000000-0000-4000-8000-0000000000a1"
const INTERVAL = 60_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const keysView: ViewSpec = {
  kind: "keys",
  object: TASK,
  keys: [key(1), key(2)],
}
const cardView: ViewSpec = { kind: "card", object: TASK, key: key(1) }
const sectionView: ViewSpec = {
  kind: "section",
  object: TASK,
  owner: key(1),
  section: "lines",
}
const pageView: ViewSpec = { kind: "window", object: TASK }
const LINES = [{ ref: key(901), qty: 1, lineNumber: 1 }]

const write = (
  h: CoreHarness,
  fn: Parameters<CoreHarness["core"]["commit"]>[0]
) => h.core.commit(fn, h.core.token())

const stateOf = (h: CoreHarness, spec: ViewSpec): SyncState | undefined =>
  h.inspect.sync().find((s) => {
    const target = s.target as SyncTarget
    return target.kind === "view" && isDeepStrictEqual(target.spec, spec)
  })
const requirementsOf = (h: CoreHarness, spec: ViewSpec) =>
  stateOf(h, spec)?.requirements.map((r) => r.kind)

/** Те, що знімок показує споживачеві, без посилань на внутрішні структури. */
const shown = (s: ViewSnapshot) => ({
  status: s.status,
  keys: s.rows.map((r) => r.key),
  states: s.rows.map((r) => r.state),
  needsRefresh: s.needsRefresh,
  staleComposition: s.staleComposition,
  hasNewRows: s.hasNewRows,
  section:
    s.section === undefined
      ? undefined
      : {
          complete: s.section.complete,
          ownerState: s.section.ownerState,
          ownerVersionKnown: s.section.ownerVersion !== undefined,
          lines: s.section.lines.length,
        },
  atEnd: s.atEnd,
})

/** Ядро з видимим завантаженим виглядом; годинник — тиктаючий. */
async function loaded(
  spec: ViewSpec,
  options: Parameters<typeof setup>[0] = {},
  lines = false
) {
  const h = setup({
    now: () => Date.now(),
    limits: { revalidateIntervalMs: INTERVAL },
    ...options,
  })
  seed(h.fake, 1, 3)
  if (lines) h.fake.setLines(TASK, key(1), "lines", LINES)
  const handle = h.core.view(spec)
  const watched = watch(handle)
  await settle()
  if (h.fake.mode === "manual") {
    h.fake.deliverAll()
    await settle()
  }
  return { ...h, handle, watched, spec }
}
type Loaded = Awaited<ReturnType<typeof loaded>>

/** Побудови знімка, сповіщення й запити сервера за дію (разом із її хвостом). */
async function counted(h: Loaded, act: () => void | Promise<void>) {
  const builds = built.count
  const notes = h.watched.seen.length
  const requests = h.fake.requests.length
  await act()
  await settle()
  // Знімок будується ліниво: читання після дії показує, чи він залишився
  // «брудним» для наступного читача.
  h.handle.getSnapshot()
  return {
    builds: built.count - builds,
    notes: h.watched.seen.length - notes,
    requests: h.fake.requests.length - requests,
  }
}

const unconfirm = (h: CoreHarness) =>
  write(h, (w) => w.markViews(TASK, { unconfirmedSince: h.core.readEpoch() }))

describe("snapshots of the views at the start of part A", () => {
  it("keys", async () => {
    const h = await loaded(keysView)
    expect(shown(h.handle.getSnapshot())).toEqual({
      status: "ready",
      keys: [key(1), key(2)],
      states: ["synced", "synced"],
      needsRefresh: false,
      staleComposition: undefined,
      hasNewRows: false,
      section: undefined,
      atEnd: undefined,
    })
  })

  it("card", async () => {
    const h = await loaded(cardView)
    expect(shown(h.handle.getSnapshot())).toEqual({
      status: "ready",
      keys: [key(1)],
      states: ["synced"],
      needsRefresh: false,
      staleComposition: undefined,
      hasNewRows: false,
      section: undefined,
      atEnd: undefined,
    })
  })

  it("section", async () => {
    const h = await loaded(sectionView, {}, true)
    expect(shown(h.handle.getSnapshot())).toEqual({
      status: "ready",
      keys: [],
      states: [],
      needsRefresh: false,
      staleComposition: undefined,
      hasNewRows: false,
      section: {
        complete: true,
        // Шапки власника в сховищі немає: стан власника невідомий.
        ownerState: "unknown",
        ownerVersionKnown: true,
        lines: 1,
      },
      atEnd: undefined,
    })
  })

  it("page (window)", async () => {
    const h = await loaded(pageView)
    expect(shown(h.handle.getSnapshot())).toEqual({
      status: "ready",
      keys: [key(1), key(2), key(3)],
      states: ["synced", "synced", "synced"],
      needsRefresh: false,
      staleComposition: undefined,
      hasNewRows: false,
      section: undefined,
      atEnd: true,
    })
  })

  it("a view with the requirement «composition unconfirmed»: stale composition, needsRefresh only while invisible", async () => {
    const h = await loaded(keysView)
    unconfirm(h)
    expect(h.handle.getSnapshot()).toMatchObject({
      staleComposition: true,
      needsRefresh: false,
    })
    h.core.setVisible(keysView, false)
    expect(h.handle.getSnapshot()).toMatchObject({
      staleComposition: true,
      needsRefresh: true,
    })
  })
})

describe("counts of snapshot builds and notifications on main", () => {
  it("suspend() then resume() without a requirement", async () => {
    const h = await loaded(keysView)
    expect({
      suspend: await counted(h, () => h.core.suspend()),
      resume: await counted(h, () => h.core.resume()),
    }).toEqual({
      suspend: { builds: 0, notes: 0, requests: 0 },
      // `resume()` читає вигляд без вимоги: це системне перечитування.
      resume: { builds: 0, notes: 0, requests: 1 },
    })
  })

  it("suspend() then resume() with the requirement «composition unconfirmed»", async () => {
    const h = await loaded(keysView)
    unconfirm(h)
    expect({
      suspend: await counted(h, () => h.core.suspend()),
      resume: await counted(h, () => h.core.resume()),
    }).toEqual({
      // Вимога на прихованій вкладці міняє `needsRefresh`: побудова без сповіщення.
      suspend: { builds: 1, notes: 0, requests: 0 },
      resume: { builds: 2, notes: 2, requests: 1 },
    })
  })

  it("setVisible(false) then setVisible(true) without a requirement", async () => {
    const h = await loaded(keysView)
    expect({
      hide: await counted(h, () => h.core.setVisible(keysView, false)),
      show: await counted(h, () => h.core.setVisible(keysView, true)),
    }).toEqual({
      hide: { builds: 0, notes: 0, requests: 0 },
      show: { builds: 0, notes: 0, requests: 0 },
    })
  })

  it("setVisible(false) then setVisible(true) with the requirement «composition unconfirmed»", async () => {
    const h = await loaded(keysView)
    unconfirm(h)
    expect({
      hide: await counted(h, () => h.core.setVisible(keysView, false)),
      show: await counted(h, () => h.core.setVisible(keysView, true)),
    }).toEqual({
      // Без вимоги склад не підтверджено, тож видимість ревізії не рухає;
      // з вимогою — рухає, а перехід у видимість читає вигляд.
      hide: { builds: 1, notes: 0, requests: 0 },
      show: { builds: 1, notes: 1, requests: 1 },
    })
  })

  describe("a channel", () => {
    const rightsRow: RightsRow = {
      level: "scope",
      levelId: null,
      scope: S,
      container: null,
      object: "task",
      action: "read",
      extent: "any",
      dimensionId: null,
    }
    const channel = channelTopic({
      kind: "changes",
      scopeKindId: SCOPE_KIND_ID,
      scope: S,
      object: task.id,
    })
    async function withSignals() {
      const transport = createFakeSignalTransport()
      const h = setup({
        now: () => Date.now(),
        rightsSnapshot: true,
        signals: transport,
        limits: { revalidateIntervalMs: INTERVAL },
      })
      h.fake.rightsSnapshot = {
        userId: USER,
        scopeSets: [{ scopeKind: SCOPE_KIND_ID, scope: S }],
        rights: [rightsRow],
        members: [],
        dimensionValues: [],
      }
      h.fake.rightsVersion = "1".repeat(64)
      seed(h.fake, 1, 3)
      const handle = h.core.view(keysView)
      const watched = watch(handle)
      await settle()
      return { ...h, handle, watched, spec: keysView, transport }
    }

    it("a break of the connection, then the join of the channel recovering the stream", async () => {
      const h = await withSignals()
      expect({
        break: await counted(h, () =>
          h.transport.fail({ kind: "transport", channel })
        ),
        join: await counted(h, async () => {
          h.transport.join(channel, false)
          await vi.advanceTimersByTimeAsync(5_000)
        }),
      }).toEqual({
        break: { builds: 1, notes: 1, requests: 0 },
        join: { builds: 2, notes: 1, requests: 1 },
      })
    })

    it("a join of the channel without a break: the wave of re-reads", async () => {
      const h = await withSignals()
      expect(
        await counted(h, async () => {
          h.transport.join(channel, false)
          await vi.advanceTimersByTimeAsync(5_000)
        })
      ).toEqual({ builds: 2, notes: 2, requests: 1 })
    })
  })

  it("a failed re-read, then the retry by the failure pause", async () => {
    const h = await loaded(keysView, { mode: "manual" })
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const failed = await counted(h, () =>
      h.fake.take().fail("command.unavailable")
    )
    const status = h.handle.getSnapshot().status
    const retried = await counted(h, async () => {
      await vi.advanceTimersByTimeAsync(INTERVAL)
      h.fake.deliverAll()
    })
    expect({ failed, status, retried }).toEqual({
      failed: { builds: 1, notes: 1, requests: 0 },
      status: "error",
      retried: { builds: 1, notes: 1, requests: 1 },
    })
  })

  it("a re-read discarded by the epoch of versions", async () => {
    const h = await loaded(keysView, { mode: "manual" })
    for (const epoch of ["a", "b"]) {
      h.fake.epoch = epoch.repeat(64)
      h.handle.refresh()
      await settle()
      h.fake.deliverAll()
      await settle()
    }
    h.handle.refresh()
    await settle()
    expect(
      await counted(h, () => {
        h.fake.epoch = "a".repeat(64)
        h.fake.deliverAll()
      })
    ).toEqual({ builds: 1, notes: 0, requests: 0 })
  })
})

/*
 * ROW 20 (§5.14): «ціль відстала від шапки». На `main` вимога живе в
 * предикаті, що порівнює ревізію шапки з `readRevision`, а той рухається на
 * СТАРТІ спроби: збій чи відкинуте читання знімають вимогу без застосованого
 * завантаження. Ці блоки змінює частина Г (вимога збережена).
 */
describe("ROW 20 on main: the requirement «target behind header» after a failed or discarded attempt", () => {
  /** Зміна шапки, яка лишає ціль неповною за `cardStale` / `sectionStale`. */
  const headerChange: Record<string, (h: Loaded) => Promise<void>> = {
    // Новіше читання списком піднімає версію рядка: ліниве поле картки старе.
    card: async (h) => {
      const list = h.core.view(keysView)
      watch(list)
      await settle()
      h.fake.deliverAll()
      await settle()
      h.fake.edit(TASK, key(1), { title: "newer" })
      list.refresh()
      await settle()
      h.fake.take().answer()
    },
    section: (h) => {
      write(h, (w) => w.hide(TASK, [key(1)]))
      return Promise.resolve()
    },
  }
  const target = { card: isCard, section: isSection }
  const specs: Record<string, [ViewSpec, boolean]> = {
    card: [cardView, false],
    section: [sectionView, true],
  }

  const REQUESTS: Record<string, number> = { card: 4, section: 2 }
  const probe = (h: Loaded) => ({
    requirements: requirementsOf(h, h.spec),
    flights: stateOf(h, h.spec)?.flights.map((f) => f.kind),
    requests: h.fake.requests.length,
  })
  it("ROW 20 section: right after the hide of the owner the requirement stands and nothing flies", async () => {
    const h = await loaded(sectionView, { mode: "manual" }, true)
    expect(probe(h)).toEqual({ requirements: [], flights: [], requests: 1 })
    write(h, (w) => w.hide(TASK, [key(1)]))
    expect(probe(h)).toEqual({
      requirements: ["target-behind-header"],
      flights: [],
      requests: 1,
    })
  })

  for (const name of ["card", "section"]) {
    const [spec, lines] = specs[name]!
    it(`ROW 20 ${name}: the failure of the load drops the requirement`, async () => {
      const h = await loaded(spec, { mode: "manual" }, lines)
      await headerChange[name]!(h)
      await settle()
      const flying = probe(h)
      h.fake.take(target[name as "card"]).fail("command.unavailable")
      await settle()
      expect({
        flying,
        failed: probe(h),
        status: h.handle.getSnapshot().status,
      }).toEqual({
        // Спроба стартом уже зсунула `readRevision`: вимоги немає й до збою.
        flying: {
          requirements: [],
          flights: ["load"],
          requests: REQUESTS[name],
        },
        failed: { requirements: [], flights: [], requests: REQUESTS[name] },
        status: "error",
      })
    })

    it(`ROW 20 ${name}: the load discarded by the epoch of versions drops the requirement`, async () => {
      const h = await loaded(spec, { mode: "manual" }, lines)
      await headerChange[name]!(h)
      await settle()
      const flying = probe(h)
      h.fake.epoch = "a".repeat(64)
      h.fake.deliverAll()
      await settle()
      expect({ flying, discarded: probe(h) }).toEqual({
        flying: {
          requirements: [],
          flights: ["load"],
          requests: REQUESTS[name],
        },
        discarded: { requirements: [], flights: [], requests: REQUESTS[name] },
      })
    })
  }
})

/*
 * ROW 22 (§5.14): ТЧ над власником `removed`. На `main` `sectionStale` для
 * такого власника хибне: ТЧ шапки не читає й вимоги не ставить.
 */
describe("ROW 22 on main: a section over an owner marked removed", () => {
  /** Власника тримає ще й вигляд-ключ: шапка в сховищі, а потім `removed`. */
  async function removedOwner() {
    const h = await loaded(sectionView, { mode: "manual" }, true)
    watch(h.core.view(keysView))
    await settle()
    h.fake.deliverAll()
    await settle()
    const before = h.fake.requests.length
    const { epochs } = coreInternals(h.core)
    write(h, (w) =>
      w.apply(TASK, { rows: [], absent: [key(1)] }, epochs.next(), null)
    )
    await settle()
    return { h, before }
  }

  it("ROW 22 section: no requirement, no read of the header, the section is shown hidden", async () => {
    const { h, before } = await removedOwner()
    expect({
      requirements: requirementsOf(h, sectionView),
      flights: stateOf(h, sectionView)?.flights.map((f) => f.kind),
      requests: h.fake.requests.length - before,
      snapshot: shown(h.handle.getSnapshot()),
    }).toEqual({
      requirements: [],
      flights: [],
      requests: 0,
      snapshot: {
        status: "ready",
        keys: [],
        states: [],
        needsRefresh: false,
        staleComposition: undefined,
        hasNewRows: false,
        section: {
          complete: false,
          ownerState: "removed",
          ownerVersionKnown: false,
          lines: 0,
        },
        atEnd: undefined,
      },
    })
  })

  it("ROW 22 section: the interval re-read of the keys view restores the owner, the section follows it", async () => {
    const { h, before } = await removedOwner()
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    for (let round = 0; round < 3; round++) {
      h.fake.deliverAll()
      await settle()
    }
    expect({
      requirements: requirementsOf(h, sectionView),
      requests: h.fake.requests.length - before,
      snapshot: shown(h.handle.getSnapshot()),
    }).toEqual({
      requests: 2,
      requirements: [],
      snapshot: {
        status: "ready",
        keys: [],
        states: [],
        needsRefresh: false,
        staleComposition: undefined,
        hasNewRows: false,
        section: {
          complete: true,
          ownerState: "synced",
          ownerVersionKnown: true,
          lines: 1,
        },
        atEnd: undefined,
      },
    })
  })
})
