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
  type ReadOptions,
} from "../source"
import type { ReadEvent } from "../source"
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
 * `close()` синхронний (І7); частина об'єкта, який пізня відмова шлюзу
 * (`staleObject`) називає на скиданні, на сервер не йде (І8); значення `version` застосовується до видачі частин даних (Р3).
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
  const options: ReadOptions[] = []
  let closed = 0
  const source: CoreSource = {
    read: (parts, readOptions) => {
      calls.push(parts)
      options.push(readOptions)
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
    close: () => {
      closed++
    },
  }
  return { source, calls, options, closed: () => closed }
}

/** Пізня відмова шлюзу, якою тест позначає об'єкти несумісними. */
function staleGate() {
  const stale = new Set<string>()
  const asked: string[] = []
  return {
    stale,
    asked,
    staleObject: (object: string) => {
      asked.push(object)
      return stale.has(object)
    },
  }
}

const SLEEP = () => Promise.resolve()

describe("createBatcher: the window", () => {
  it("gives the parts of three views of one tick to the source as one call, in order", async () => {
    const r = recording()
    const batcher = createBatcher(r.source, { sleep: SLEEP })
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
    const batcher = createBatcher(r.source, { sleep: SLEEP })
    const first = batcher.read([query(TASK_REF, 1)])
    await first
    const second = batcher.read([query(TASK_REF, 2)])
    await second
    expect(r.calls).toHaveLength(2)
  })

  it("has no timer: the parts go out without the fake timers advancing", async () => {
    const r = recording()
    const batcher = createBatcher(r.source, { sleep: SLEEP })
    const read = batcher.read([query(TASK_REF, 1)])
    expect(vi.getTimerCount()).toBe(0)
    await read
    expect(r.calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("asks the late refusal of the gate synchronously at the flush, not at queueing, and passes it to the source", async () => {
    const r = recording()
    const g = staleGate()
    const batcher = createBatcher(r.source, {
      sleep: SLEEP,
      staleObject: g.staleObject,
    })
    const read = batcher.read([query(TASK_REF, 1), VERSION])
    expect(g.asked).toEqual([])
    expect(r.calls).toHaveLength(0)
    await Promise.resolve()
    // Скидання — мікрозадача: предикат питано до відправки, один раз на
    // частину з об'єктом.
    expect(g.asked).toEqual(["Catalog.Task"])
    await read
    expect(r.calls).toHaveLength(1)
    expect(r.options[0]!.staleObject).toBe(g.staleObject)
  })

  it("tells whether a version part waits in the queue", async () => {
    const r = recording()
    const batcher = createBatcher(r.source, { sleep: SLEEP })
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
    const batcher = createBatcher(r.source, { sleep: SLEEP })
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
    const batcher = createBatcher(r.source, { sleep: SLEEP })
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
    const g = staleGate()
    const batcher = createBatcher(r.source, {
      sleep: SLEEP,
      staleObject: g.staleObject,
    })
    const read = batcher.read([query(TASK_REF, 1), query(ORG_REF, 2)])
    g.stale.add("Catalog.Task")
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
    const g = staleGate()
    const batcher = createBatcher(r.source, {
      sleep: SLEEP,
      staleObject: g.staleObject,
    })
    const read = batcher.read([query(TASK_REF, 1)])
    g.stale.add("Catalog.Task")
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
      sleep: SLEEP,
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
    const batcher = createBatcher(r.source, { sleep: SLEEP, onVersion })
    const { items } = await batcher.read([VERSION])
    expect(items).toEqual([{ ok: false, error }])
    expect(onVersion).not.toHaveBeenCalled()
  })
})

describe("createBatcher: the rights barrier", () => {
  const RIGHTS: CorePart = { type: "rights" }
  const rightsItem: CoreReadItem = {
    ok: true,
    type: "rights",
    value: { rightsVersion: "1".repeat(64) },
  }
  const answerRights = () =>
    Promise.resolve({ items: [rightsItem, rowsItem(1)] })

  it("hands the rights outcome over before any caller of the answer resumes", async () => {
    const order: string[] = []
    const r = recording(answerRights)
    const batcher = createBatcher(r.source, {
      sleep: SLEEP,
      onRights: (item) => order.push(item === rightsItem ? "rights" : "other"),
    })
    const rights = batcher.read([RIGHTS]).then(() => {
      order.push("rights caller")
    })
    const data = batcher.read([query(TASK_REF, 1)]).then(() => {
      order.push("data caller")
    })
    await Promise.all([rights, data])
    expect(order[0]).toBe("rights")
    expect(order).toHaveLength(3)
  })

  it("hands the rights outcome over before the version of the same answer, whatever the queue order", async () => {
    const order: string[] = []
    const r = recording(() =>
      Promise.resolve({
        items: [
          { ok: true, type: "version", version: versionValue } as const,
          rightsItem,
        ],
      })
    )
    const batcher = createBatcher(r.source, {
      sleep: SLEEP,
      onVersion: () => order.push("version"),
      onRights: () => order.push("rights"),
    })
    await Promise.all([batcher.read([VERSION]), batcher.read([RIGHTS])])
    expect(order).toEqual(["rights", "version"])
  })

  it("hands over a failed rights part as it is, and nothing for other parts", async () => {
    const error: CommandError = { code: "command.unavailable" }
    const onRights = vi.fn()
    const r = recording(() =>
      Promise.resolve({ items: [{ ok: false as const, error }, rowsItem(1)] })
    )
    const batcher = createBatcher(r.source, { sleep: SLEEP, onRights })
    await batcher.read([RIGHTS, query(TASK_REF, 1)])
    expect(onRights).toHaveBeenCalledTimes(1)
    expect(onRights).toHaveBeenCalledWith({ ok: false, error })
  })

  it("knows a rights part waits in the queue until the window flushes", async () => {
    const r = recording(answerRights)
    const batcher = createBatcher(r.source, { sleep: SLEEP })
    expect(batcher.hasQueuedRights()).toBe(false)
    const read = batcher.read([RIGHTS, query(TASK_REF, 1)])
    expect(batcher.hasQueuedRights()).toBe(true)
    await read
    expect(batcher.hasQueuedRights()).toBe(false)
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
    const batcher = createBatcher(r.source, { sleep: SLEEP })
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
    const batcher = createBatcher(r.source, { sleep: SLEEP })
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

  // Пізня відмова (Р-SK1-6): шлюз дав дозвіл, частина пішла з `dispatch`, а
  // об'єкт став несумісним до відправки — той самий предикат шлюзу на
  // скиданні збирача відмовляє їй без запиту.
  it("a part admitted before its object turns stale-client, still in the batcher: refused at the flush without a request", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 1)
    const attempts: unknown[] = []
    inspect.watchAttempts((event) => attempts.push(event))
    const handle = core.view(list)
    watch(handle)
    expect(attempts).toMatchObject([{ phase: "started", site: "M1" }])
    core.staleClient(TASK)
    await settle()
    expect(readsOf(fake, TASK)).toHaveLength(0)
    expect(attempts).toMatchObject([
      { phase: "started", site: "M1" },
      { phase: "settled", error: "command.stale-client" },
    ])
    expect(handle.getSnapshot()).toMatchObject({ isStale: true })
  })

  // Липкість відмови — лише позначка ядра: частину, що стоїть у черзі
  // збирача, відмовляє скидання, а частину в черзі обмежувача — старт її
  // задачі; задача без живих частин бере номер запиту без відправки.
  it("parts queued in the batcher and in the limiter before markStale: both refused, the limiter task takes a request number", async () => {
    const { core, fake, inspect } = setup({ limits: { readParallel: 1 } })
    seed(fake, 1, 2)
    fake.insert(ORG, { ref: S })
    const events: ReadEvent[] = []
    inspect.watchReads((event) => events.push(event))
    fake.hold = () => true
    // Перший запит займає єдиний слот обмежувача, доки не відповімо.
    watch(core.view({ kind: "keys", object: ORG, keys: [S] }))
    await settle()
    // Частина задач минула скидання й чекає слота обмежувача.
    const inLimiter = core.view(list)
    watch(inLimiter)
    await settle()
    // Частина задач у черзі збирача: скидання — наступна мікрозадача.
    const inBatcher = core.view({ kind: "keys", object: TASK, keys: [key(2)] })
    watch(inBatcher)
    core.staleClient(TASK)
    fake.hold = undefined
    fake.deliverAll()
    await settle()
    fake.deliverAll()
    await settle()
    expect(readsOf(fake, TASK)).toHaveLength(0)
    expect(inLimiter.getSnapshot()).toMatchObject({ isStale: true })
    expect(inBatcher.getSnapshot()).toMatchObject({ isStale: true })
    // Подій задач немає; задача обмежувача взяла номер між запитами ORG і
    // `version`, яку просить позначка.
    expect(
      events.map((e) => [
        "object" in e.target ? e.target.object : e.target.service,
        e.request,
      ])
    ).toEqual([
      [ORG, 1],
      ["version", 3],
    ])
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
