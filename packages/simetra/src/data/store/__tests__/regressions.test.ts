import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { catalogEntry } from "../../../model/runtime/__tests__/entries"
import type { CoreSession } from "../core"
import type { DefectFlag } from "../defects"
import { createObjectStore, visibleRow } from "../object-store"
import { createSession } from "../session"
import {
  DEFAULT_CORE_LIMITS,
  type ViewHandle,
  type ViewSpec,
  type Writer,
} from "../types"
import {
  ORG,
  TASK,
  isKeys,
  key,
  seed,
  settle,
  setup,
  watch,
} from "./core-support"
import { K1, K3, OBJECT, S, row } from "./store-support"

/*
 * Регресії спайку 4 (звіт вікна §7, п. 1, 5, 6, 7; план П4-B3-2, задача 10,
 * крок 3а). Кожен тест падає без свого виправлення; де виправлення має
 * прапорець навмисного дефекту, тест показує це сам: з прапорцем
 * очікуваний наслідок дефекту.
 */

const RELEASE = DEFAULT_CORE_LIMITS.releaseDelayMs

const keys = (...ns: number[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys: ns.map(key),
})

const write = (core: CoreSession, fn: (w: Writer) => void) =>
  core.commit(fn, core.token())

const rowOf = (handle: ViewHandle, n: number) =>
  handle.getSnapshot().rows.find((r) => r.key === key(n))

describe("eviction from seen and tombstones", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    [undefined, "stale"],
    ["no-horizon-tombstones", "synced"],
  ] as const)(
    "a late answer read before the deletion does not resurrect the row after its tombstone is evicted (defect %s)",
    async (defect, shown) => {
      const { core, fake, inspect } = setup({
        limits: { tombstonesMax: 1 },
        mode: "manual",
      })
      if (defect !== undefined) inspect.defects.add(defect)
      seed(fake, 1, 2)
      const owner = core.view(keys(1))
      const ownerSub = watch(owner)
      await settle()
      fake.take().answer()
      await settle()
      // Давнє читання іншого вигляду — до видалення.
      const late = core.view(keys(1, 2))
      watch(late)
      await settle()
      const old = fake.take()
      fake.remove(TASK, key(1))
      owner.refresh()
      await settle()
      fake.take().answer()
      await settle()
      expect(rowOf(owner, 1)?.state).toBe("removed")
      // Звільнення слота `removed` ставить надгробок; запис `seen` лишається.
      ownerSub.unsubscribe()
      vi.advanceTimersByTime(RELEASE)
      expect(inspect.serviceSizes().seen).toBe(1)
      // Надгробок чужого ключа витісняє надгробок K1.
      write(core, (w) => w.purge(ORG, { keys: [key(99_999)] }))
      expect(inspect.serviceSizes().tombstones).toBe(1)
      old.answer(old.issuedAt)
      await settle()
      expect(rowOf(late, 1)?.state).toBe(shown)
      if (defect !== undefined) return
      // Значення сховано до перечитування; хвіст бачить видалення.
      expect(rowOf(late, 1)).toMatchObject({ values: {} })
      fake.take((r) => isKeys(r)).answer()
      await settle()
      expect(rowOf(late, 1)?.state).toBe("removed")
    }
  )

  it.each([
    [undefined, "stale"],
    ["no-horizon-seen", "synced"],
  ] as const)(
    "a late answer does not return an older version as synced after its seen entry is evicted (defect %s)",
    async (defect, shown) => {
      const { core, fake, inspect } = setup({
        limits: { seenMax: 1 },
        mode: "manual",
      })
      if (defect !== undefined) inspect.defects.add(defect)
      seed(fake, 1, 2)
      const late = core.view(keys(1))
      watch(late)
      await settle()
      const old = fake.take()
      const v2 = fake.edit(TASK, key(1), { title: "v2" })
      const scroll = core.view(keys(1, 2))
      const scrollSub = watch(scroll)
      await settle()
      fake.take().answer()
      await settle()
      expect(rowOf(scroll, 1)).toMatchObject({ version: v2 })
      // Звільнення пам'ятає K1 і K2: K1 витіснено з пам'яті версій.
      scrollSub.unsubscribe()
      vi.advanceTimersByTime(RELEASE)
      expect(inspect.rowCount()).toBe(0)
      old.answer(old.issuedAt)
      await settle()
      expect(rowOf(late, 1)?.state).toBe(shown)
      if (defect !== undefined) return
      expect(rowOf(late, 1)).toMatchObject({ values: {} })
      fake.take((r) => isKeys(r)).answer()
      await settle()
      expect(rowOf(late, 1)).toMatchObject({ state: "synced", version: v2 })
    }
  )

  // Завантаження в польоті `purge` робить недійсними (П12), тож надгробок
  // пари перевіряється на рівні сховища: його обходить лише прямий запис.
  it.each([
    [undefined, true],
    ["no-horizon-tombstones", false],
  ] as const)(
    "a read older than an evicted pair tombstone does not return a row of the purged scope (defect %s)",
    (defect, hidden) => {
      const defects = new Set<DefectFlag>(defect === undefined ? [] : [defect])
      const session = createSession({
        subject: "u1",
        limits: { ...DEFAULT_CORE_LIMITS, tombstonesMax: 1 },
        log: () => {},
        defects,
      })
      const store = createObjectStore({
        object: OBJECT,
        entry: catalogEntry(),
        session,
        log: () => {},
        defects,
      })
      const now = () => session.epochs.now()
      const run = (fn: Parameters<typeof session.commit>[0]) =>
        session.commit(fn, session.token())
      const early = now()
      run((s) => store.purgeScope(s, S))
      // Надгробок ключа витісняє надгробок пари.
      run((s) => store.purgeKeys(s, [K3]))
      let result: string | undefined
      run((s) => (result = store.put(s, row(K1, 1), early, false)))
      expect(result).toBe(hidden ? "stale-inserted" : "written")
      expect(visibleRow(store.get(K1)!) === undefined).toBe(hidden)
      if (hidden) expect(store.drainTail()).toEqual([K1])
    }
  )
})

describe("row revisions", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    [undefined, true],
    ["revision-survives-row", false],
  ] as const)(
    "scrolling 1 000 keys through keys views keeps the revision map within the store (defect %s)",
    async (defect, bounded) => {
      const { core, fake, inspect } = setup()
      if (defect !== undefined) inspect.defects.add(defect)
      seed(fake, 1, 1_000)
      let within = true
      for (let page = 0; page < 100; page++) {
        const ns = Array.from({ length: 10 }, (_, i) => page * 10 + i + 1)
        const sub = watch(core.view(keys(...ns)))
        await settle()
        sub.unsubscribe()
        vi.advanceTimersByTime(RELEASE)
        const sizes = inspect.serviceSizes()
        const rows = inspect.rowCount()
        within &&= sizes.revisions <= rows && sizes.rowViews <= rows
      }
      expect(within).toBe(bounded)
      if (bounded) {
        expect(inspect.rowCount()).toBe(0)
        expect(inspect.serviceSizes()).toMatchObject({
          revisions: 0,
          rowViews: 0,
        })
      }
    }
  )
})

describe("abort listeners", () => {
  it("10 000 reads leave no abort listener behind", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    // Шпигуни пропускають виклик далі: рахуємо, не підміняючи сигналів.
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener")
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener")
    const net = () =>
      add.mock.calls.filter(([type]) => type === "abort").length -
      remove.mock.calls.filter(([type]) => type === "abort").length
    try {
      const view = core.view(keys(1))
      watch(view)
      await settle()
      const reads = fake.log.length
      for (let i = 1; i < 10_000; i++) {
        view.refresh()
        await settle(20)
      }
      expect(fake.log.length - reads).toBe(9_999)
      expect(net()).toBe(0)
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
  })
})

describe("close clears the service maps", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("leaves no version memory, tombstone, horizon, revision or row view after close()", async () => {
    const { core, fake, inspect } = setup({
      limits: { seenMax: 2, tombstonesMax: 2, horizonBuckets: 16 },
    })
    seed(fake, 1, 6)
    const all = watch(core.view(keys(1, 2, 3, 4, 5, 6)))
    const two = watch(core.view(keys(1, 2)))
    await settle()
    fake.remove(TASK, key(1))
    core.view(keys(1, 2)).refresh()
    await settle()
    all.unsubscribe()
    vi.advanceTimersByTime(RELEASE)
    write(core, (w) => w.purge(TASK, { keys: [key(2)] }))
    write(core, (w) => w.purge(TASK, { scope: S }))
    write(core, (w) => w.purge(ORG, { keys: [key(99_999)] }))
    await settle()
    const busy = inspect.serviceSizes()
    expect(busy.seen + busy.tombstones + busy.horizon).toBeGreaterThan(0)
    expect(busy.pairBurials).toBeGreaterThan(0)
    core.close("disposed")
    two.unsubscribe()
    expect(inspect.serviceSizes()).toEqual({
      seen: 0,
      tombstones: 0,
      horizon: 0,
      pairBurials: 0,
      revisions: 0,
      rowViews: 0,
      tails: 0,
      purges: 0,
      controllers: 0,
      releaseTimers: 0,
      preloadTimers: 0,
      sectionOwners: 0,
      sectionOwnerVersions: 0,
    })
    expect(inspect.rowCount()).toBe(0)
  })
})
