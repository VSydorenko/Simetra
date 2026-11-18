import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CommandFailure,
  type CommandError,
  type MetadataRef,
  type VersionValue,
} from "simetra/model"
import { createBatcher } from "../batcher"
import {
  ReadLimiterClosed,
  type CorePart,
  type CoreReadItem,
  type CoreSource,
} from "../source"
import type { ViewSpec } from "../types"
import {
  ORG,
  S,
  TASK,
  key,
  readsOf,
  seed,
  settle,
  setup,
  watch,
} from "./core-support"
import { task } from "./core-support"

/*
 * Збирач читань (спека П4-B §6.7): вікно — одна мікрозадача, таймера немає;
 * `close()` синхронний (І7); частина об'єкта, закритого `refuse`, на сервер
 * не йде (І8); значення `version` застосовується до видачі частин даних (Р3).
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const TASK_REF: MetadataRef = { kind: "Catalog", name: "Task" }
const ORG_REF: MetadataRef = { kind: "Catalog", name: "Organization" }

const query = (object: MetadataRef, n: number): CorePart => ({
  type: "query",
  query: { object, id: key(n) },
})
const VERSION: CorePart = { type: "version" }

const rowsItem = (n: number): CoreReadItem => ({
  ok: true,
  rows: { rows: [{ ref: key(n) }] },
  epoch: null,
})
const versionValue: VersionValue = { snapshotHash: "h", objects: {} }

/** Джерело-журнал: відповідає рядком `n` на кожну частину запиту `n`-го ключа. */
function recording(
  answer?: (parts: readonly CorePart[]) => Promise<{ items: CoreReadItem[] }>
) {
  const calls: (readonly CorePart[])[] = []
  const refused: string[] = []
  let closed = 0
  const source: CoreSource = {
    read: (parts) => {
      calls.push(parts)
      return (
        answer?.(parts) ??
        Promise.resolve({
          items: parts.map((part, i) =>
            part.type === "version"
              ? ({ ok: true, type: "version", version: versionValue } as const)
              : rowsItem(i)
          ),
        })
      )
    },
    run: () => Promise.reject(new Error("unexpected run")),
    refuse: (object) => {
      refused.push(object)
    },
    close: () => {
      closed++
    },
  }
  return { source, calls, refused, closed: () => closed }
}

describe("createBatcher: the window", () => {
  it("gives the parts of three views of one tick to the source as one call, in order", async () => {
    const r = recording()
    const batcher = createBatcher(r.source)
    const first = batcher.read([query(TASK_REF, 1), query(TASK_REF, 2)])
    const second = batcher.read([query(ORG_REF, 3)])
    const third = batcher.read([query(TASK_REF, 4)])
    expect(r.calls).toHaveLength(0)
    const answers = await Promise.all([first, second, third])
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]).toEqual([
      query(TASK_REF, 1),
      query(TASK_REF, 2),
      query(ORG_REF, 3),
      query(TASK_REF, 4),
    ])
    // Результати — тим самим порядком, кожному викликачу свої.
    expect(answers.map((a) => a.items.length)).toEqual([2, 1, 1])
    expect(
      answers.map((a) =>
        a.items.map((item) => "rows" in item && item.rows.rows[0]!.ref)
      )
    ).toEqual([[key(0), key(1)], [key(2)], [key(3)]])
  })

  it("sends the part of the next tick in a second call", async () => {
    const r = recording()
    const batcher = createBatcher(r.source)
    const first = batcher.read([query(TASK_REF, 1)])
    await first
    const second = batcher.read([query(TASK_REF, 2)])
    await second
    expect(r.calls).toHaveLength(2)
  })

  it("has no timer: the parts go out without the fake timers advancing", async () => {
    const r = recording()
    const batcher = createBatcher(r.source)
    const read = batcher.read([query(TASK_REF, 1)])
    expect(vi.getTimerCount()).toBe(0)
    await read
    expect(r.calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("passes run and refuse past the queue, without a delay", () => {
    const r = recording()
    const batcher = createBatcher(r.source)
    void batcher.read([query(TASK_REF, 1)])
    batcher.refuse?.("Catalog.Task")
    expect(r.refused).toEqual(["Catalog.Task"])
    expect(r.calls).toHaveLength(0)
  })

  it("tells whether a version part waits in the queue", async () => {
    const r = recording()
    const batcher = createBatcher(r.source)
    expect(batcher.hasQueuedVersion()).toBe(false)
    const read = batcher.read([VERSION])
    expect(batcher.hasQueuedVersion()).toBe(true)
    await read
    expect(batcher.hasQueuedVersion()).toBe(false)
  })
})

describe("createBatcher: close() with parts queued (I7)", () => {
  it("sends no request and rejects every queued call without a write", async () => {
    const r = recording()
    const batcher = createBatcher(r.source)
    const first = batcher.read([query(TASK_REF, 1)]).catch((e: unknown) => e)
    const second = batcher.read([query(ORG_REF, 2)]).catch((e: unknown) => e)
    batcher.close()
    expect(await first).toBeInstanceOf(ReadLimiterClosed)
    expect(await second).toBeInstanceOf(ReadLimiterClosed)
    await settle()
    expect(r.calls).toHaveLength(0)
    expect(r.closed()).toBe(1)
  })

  it("rejects a read asked for after close without a request", async () => {
    const r = recording()
    const batcher = createBatcher(r.source)
    batcher.close()
    await expect(batcher.read([query(TASK_REF, 1)])).rejects.toBeInstanceOf(
      ReadLimiterClosed
    )
    expect(r.calls).toHaveLength(0)
  })
})

describe("createBatcher: an object refused while its part queued (I8)", () => {
  it("does not send the part, answers it stale-client, and sends the others", async () => {
    const r = recording()
    const batcher = createBatcher(r.source)
    const read = batcher.read([query(TASK_REF, 1), query(ORG_REF, 2)])
    batcher.refuse?.("Catalog.Task")
    const { items } = await read
    expect(r.calls).toEqual([[query(ORG_REF, 2)]])
    expect(items[0]).toEqual({
      ok: false,
      error: { code: "command.stale-client", object: TASK_REF },
    })
    expect(items[1]).toMatchObject({ ok: true })
  })

  it("sends nothing at all when every queued part is refused", async () => {
    const r = recording()
    const batcher = createBatcher(r.source)
    const read = batcher.read([query(TASK_REF, 1)])
    batcher.refuse?.("Catalog.Task")
    const { items } = await read
    expect(r.calls).toHaveLength(0)
    expect(items).toHaveLength(1)
  })
})

describe("createBatcher: the version barrier", () => {
  it("applies the version before any caller of the answer resumes", async () => {
    const order: string[] = []
    const r = recording()
    const batcher = createBatcher(r.source, {
      onVersion: () => order.push("version applied"),
    })
    const data = batcher.read([query(TASK_REF, 1)]).then(() => {
      order.push("data caller")
    })
    const version = batcher.read([VERSION]).then(() => {
      order.push("version caller")
    })
    await Promise.all([data, version])
    expect(order[0]).toBe("version applied")
  })

  it("lets a failed version part stay its own item", async () => {
    const error: CommandError = { code: "command.unavailable" }
    const onVersion = vi.fn()
    const r = recording(() =>
      Promise.resolve({ items: [{ ok: false as const, error }] })
    )
    const batcher = createBatcher(r.source, { onVersion })
    const { items } = await batcher.read([VERSION])
    expect(items).toEqual([{ ok: false, error }])
    expect(onVersion).not.toHaveBeenCalled()
  })
})

describe("createBatcher: failures of the call", () => {
  it("keeps the other reads of the tick when one query is refused by the mapping", async () => {
    const invalid = new CommandFailure({ code: "command.invalid", path: "x" })
    const r = recording((parts) =>
      parts.some((p) => p.type === "query" && p.query.object === TASK_REF)
        ? Promise.reject(invalid)
        : Promise.resolve({ items: [rowsItem(7)] })
    )
    const batcher = createBatcher(r.source)
    const bad = batcher.read([query(TASK_REF, 1)])
    const good = batcher.read([query(ORG_REF, 2)])
    const results = await Promise.allSettled([bad, good])
    expect(results.map((x) => x.status)).toEqual(["rejected", "fulfilled"])
    expect((results[0] as PromiseRejectedResult).reason).toBe(invalid)
    // Спільний виклик відмовлено до запиту: кожен викликач перечитано окремо.
    expect(r.calls.map((c) => c.length)).toEqual([2, 1, 1])
  })

  it("rejects every caller of the call with a failure that is not a mapping refusal", async () => {
    const r = recording(() => Promise.reject(new Error("boom")))
    const batcher = createBatcher(r.source)
    const first = batcher.read([query(TASK_REF, 1)]).catch((e: unknown) => e)
    const second = batcher.read([query(ORG_REF, 2)]).catch((e: unknown) => e)
    expect(((await first) as Error).message).toBe("boom")
    expect(((await second) as Error).message).toBe("boom")
    expect(r.calls).toHaveLength(1)
  })
})

describe("the core over the batcher", () => {
  const list: ViewSpec = { kind: "keys", object: TASK, keys: [key(1)] }

  it("sends the views of one tick and the version in one request, version first", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    const requests = fake.requests.length
    watch(core.view(list))
    watch(core.view({ kind: "keys", object: TASK, keys: [key(2)] }))
    core.requestVersion()
    await settle()
    expect(fake.requests.slice(requests)).toEqual([3])
  })

  it("merges the version asks of one tick into one part: no tail for a part not sent yet", async () => {
    const { core, fake } = setup()
    core.requestVersion()
    core.requestVersion()
    await settle()
    expect(fake.requests).toEqual([1])
  })

  it("barrier: a version that makes the object incompatible stops the rows of its successful read part", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 1)
    const handle = core.view(list)
    const { seen } = watch(handle)
    fake.kernelHashes[task.id] = "1".repeat(64)
    core.requestVersion()
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ isStale: true })
    expect(handle.getSnapshot().rows).toEqual([])
    expect(inspect.rowCount()).toBe(0)
    // Ні в одному кадрі підписника рядка з цього читання не було.
    expect(seen.flatMap((snapshot) => snapshot.rows)).toEqual([])
  })

  it("I8: a part queued in the batcher of an object marked stale-client never reaches the server", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    const handle = core.view(list)
    watch(handle)
    core.staleClient(TASK)
    await settle()
    expect(readsOf(fake, TASK)).toHaveLength(0)
    expect(handle.getSnapshot()).toMatchObject({ isStale: true })
  })

  it("I7: dispose with parts queued sends no request and writes nothing", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 1)
    watch(core.view(list))
    watch(core.view({ kind: "keys", object: ORG, keys: [S] }))
    core.close("disposed")
    await settle()
    expect(fake.requests).toHaveLength(0)
    expect(inspect.rowCount()).toBe(0)
  })
})
