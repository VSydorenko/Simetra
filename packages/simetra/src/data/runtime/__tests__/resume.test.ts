import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  DataRequest,
  DataResponse,
  DataTransport,
  SourceAdapter,
} from "simetra/model"
import {
  OBJECTS,
  TASK,
  key,
  seed,
  settle,
} from "../../store/__tests__/core-support"
import {
  createFakeSource,
  type FakeSource,
} from "../../store/testing/fake-source"
import { limitsOf } from "../../store/core"
import type { ViewSpec } from "../../store/types"
import { clientCatalog, ok, SERVER_HASH } from "../../__tests__/support"
import { runtimeHandleOf } from "../handle"
import { createDataRuntime, type DataRuntimeOptions } from "../runtime"

/*
 * `resume()`, `suspend()` і відмітка свіжості вигляду (спека П4-B §6.3
 * «Частота», §6.1; план B3-6a, задача 3). Час — підроблений годинник vitest:
 * `performance.now()` рухається разом із ним.
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const isVersion = (b: DataRequest) =>
  b.request.type === "read" &&
  (b.request.items[0] as { type: string }).type === "version"

/** The runtime over a fake server; `fail` makes the next reads fail. */
function setup(options: Partial<DataRuntimeOptions> = {}) {
  const fake: FakeSource = createFakeSource({ objects: OBJECTS })
  seed(fake, 1, 3)
  const calls: DataRequest[] = []
  const wire = { fail: false, delayMs: 0 }
  const transport: DataTransport = async (body) => {
    calls.push(body)
    const answer = (value: DataResponse): DataResponse => ({
      ...value,
      serverHash: SERVER_HASH,
    })
    const { request } = body
    if (request.type !== "read") return answer(ok(null))
    const parts = request.items as { type: string }[]
    if (parts[0]?.type === "version")
      return answer(
        ok({
          items: [
            {
              ok: true,
              value: {
                snapshotHash: SERVER_HASH,
                objects: Object.fromEntries(
                  OBJECTS.map((o) => [o.id, o.kernelHash])
                ),
              },
            },
          ],
          epoch: null,
        })
      )
    if (wire.fail) throw new Error("network down")
    if (wire.delayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, wire.delayMs))
    const read = await fake.adapter.read(
      parts as unknown as Parameters<SourceAdapter["read"]>[0]
    )
    return answer(ok({ ...read, epoch: null }))
  }
  const runtime = createDataRuntime({
    catalog: { ...clientCatalog(), objects: [...OBJECTS] },
    transport,
    subject: "user-a",
    log: () => {},
    limits: { readParallel: 8 },
    ...options,
  })
  const core = runtimeHandleOf(runtime).core
  const reads = () => calls.filter((c) => !isVersion(c)).length
  const versions = () => calls.filter(isVersion).length
  return { runtime, core, calls, wire, reads, versions }
}

const card = (n: number): ViewSpec => ({
  kind: "card",
  object: TASK,
  key: key(n),
})
const list: ViewSpec = { kind: "keys", object: TASK, keys: [key(1), key(2)] }

/** A runtime with one list view loaded and visible; counters start at zero. */
async function loaded(options: Partial<DataRuntimeOptions> = {}) {
  const t = setup(options)
  t.core.view(list).subscribe(() => {})
  await settle()
  expect(t.reads()).toBe(1)
  t.calls.length = 0
  return t
}

describe("resume()", () => {
  it("sends nothing before the coalescing limit after an accepted resume", async () => {
    const t = await loaded()
    vi.advanceTimersByTime(20_000)
    t.runtime.resume()
    await settle()
    expect(t.versions()).toBe(1)
    t.calls.length = 0
    vi.advanceTimersByTime(999)
    t.runtime.resume()
    await settle()
    expect(t.calls).toHaveLength(0)
  })

  it("is accepted as a part `version` and a re-read of overdue visible views", async () => {
    const t = await loaded()
    t.core.view(card(3)).subscribe(() => {})
    await settle()
    t.calls.length = 0
    vi.advanceTimersByTime(20_000)
    t.runtime.resume()
    await settle()
    expect(t.versions()).toBe(1)
    expect(t.reads()).toBe(2)
  })

  it("counts the coalescing from the accepted call: 1st, 3rd and 5th of five at 600 ms", async () => {
    // Межа частоти 1 мс: перечитування тут не заважає лічити прийняті виклики.
    const t = await loaded({
      limits: { readParallel: 8, resumeMinIntervalMs: 1 },
    })
    for (let i = 0; i < 5; i++) {
      if (i > 0) vi.advanceTimersByTime(600)
      t.runtime.resume()
      await settle()
    }
    expect(t.versions()).toBe(3)
  })

  it("does not re-read a view refreshed a moment ago, and still asks for the version", async () => {
    const t = await loaded()
    vi.advanceTimersByTime(20_000)
    t.runtime.resume()
    await settle()
    t.calls.length = 0
    vi.advanceTimersByTime(2_000)
    t.runtime.resume()
    await settle()
    expect(t.versions()).toBe(1)
    expect(t.reads()).toBe(0)
  })

  it("re-reads a view whose mark reaches the limit, and one with no mark", async () => {
    const t = await loaded()
    vi.advanceTimersByTime(14_999)
    t.runtime.resume()
    await settle()
    expect(t.reads()).toBe(0)
    t.calls.length = 0
    vi.advanceTimersByTime(1_000)
    t.runtime.resume()
    await settle()
    expect(t.reads()).toBe(1)
  })

  it("does not re-read an invisible view", async () => {
    const t = await loaded()
    t.core.setVisible(list, false)
    vi.advanceTimersByTime(20_000)
    t.runtime.resume()
    await settle()
    expect(t.versions()).toBe(1)
    expect(t.reads()).toBe(0)
  })

  it("sets no mark on a failed read: the next resume re-reads again", async () => {
    const t = await loaded()
    vi.advanceTimersByTime(20_000)
    t.wire.fail = true
    t.runtime.resume()
    await settle()
    expect(t.reads()).toBe(1)
    t.wire.fail = false
    t.calls.length = 0
    vi.advanceTimersByTime(1_500)
    t.runtime.resume()
    await settle()
    expect(t.reads()).toBe(1)
  })

  it("takes the mark at the start of the read, not at its settling", async () => {
    // Запис, що з'явився під час читання, міг не потрапити в нього: свіжість
    // рахується від старту, тож межа не обіцяє більшого.
    const t = await loaded()
    vi.advanceTimersByTime(20_000)
    t.wire.delayMs = 10_000
    t.runtime.resume()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.reads()).toBe(1)
    t.wire.delayMs = 0
    t.calls.length = 0
    await vi.advanceTimersByTimeAsync(5_000)
    t.runtime.resume()
    await settle()
    expect(t.reads()).toBe(1)
  })

  it("sends no read of a stale-client object", async () => {
    const t = await loaded()
    t.core.staleClient(TASK)
    await settle()
    t.calls.length = 0
    vi.advanceTimersByTime(20_000)
    t.runtime.resume()
    await settle()
    expect(t.reads()).toBe(0)
  })

  it("does nothing after dispose()", async () => {
    const t = await loaded()
    t.runtime.dispose()
    vi.advanceTimersByTime(20_000)
    t.runtime.resume()
    t.runtime.suspend()
    await settle()
    expect(t.calls).toHaveLength(0)
  })
})

describe("suspend() and the visible option", () => {
  it("are idempotent and add no timer", async () => {
    const t = await loaded()
    const timers = vi.getTimerCount()
    t.runtime.suspend()
    t.runtime.suspend()
    expect(t.runtime.visible).toBe(false)
    t.runtime.resume()
    t.runtime.resume()
    await settle()
    expect(t.runtime.visible).toBe(true)
    expect(vi.getTimerCount()).toBe(timers)
    expect(t.calls.filter(isVersion)).toHaveLength(1)
  })

  it("starts as options.visible says and sends nothing by itself", async () => {
    const t = setup({ visible: false })
    expect(t.runtime.visible).toBe(false)
    t.runtime.suspend()
    await settle()
    expect(t.calls).toHaveLength(0)
  })

  it("does not quench the reconciliation after hydration when visible: false", async () => {
    const source = setup()
    source.core.view(list).subscribe(() => {})
    await settle()
    const snapshot = source.runtime.dehydrate()
    const t = setup({ visible: false })
    t.runtime.hydrate(snapshot)
    t.core.view(list).subscribe(() => {})
    t.runtime.endHydration()
    await settle()
    expect(t.versions()).toBe(1)
    expect(t.reads()).toBe(1)
  })
})

describe("limits.resumeMinIntervalMs", () => {
  it("defaults to 15 s but not above revalidateIntervalMs", () => {
    expect(limitsOf(undefined).resumeMinIntervalMs).toBe(15_000)
    expect(limitsOf({ revalidateIntervalMs: 5_000 }).resumeMinIntervalMs).toBe(
      5_000
    )
    expect(limitsOf({ revalidateIntervalMs: 1 }).resumeMinIntervalMs).toBe(1)
  })

  it.each([
    ["zero", { resumeMinIntervalMs: 0 }],
    ["negative", { resumeMinIntervalMs: -1 }],
    ["a fraction", { resumeMinIntervalMs: 1.5 }],
    [
      "above revalidateIntervalMs",
      { resumeMinIntervalMs: 2_000, revalidateIntervalMs: 1_000 },
    ],
    ["above the default interval", { resumeMinIntervalMs: 60_001 }],
  ])("refuses %s with a TypeError", (_, limits) => {
    expect(() => limitsOf(limits)).toThrow(TypeError)
  })

  it("takes an explicit value up to the interval", () => {
    expect(
      limitsOf({ resumeMinIntervalMs: 1_000, revalidateIntervalMs: 1_000 })
        .resumeMinIntervalMs
    ).toBe(1_000)
  })
})
