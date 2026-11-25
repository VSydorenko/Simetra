import { CommandFailure, LIMIT_REASONS, type CommandError } from "simetra/model"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DataError } from "../../errors"
import { createCore, inspectCore, type CoreSession } from "../core"
import { JOURNAL_MAX } from "../overlay"
import { createCoreSource, createReadLimiter, type ServerPort } from "../source"
import { createFakeSource, type FakeSource } from "../testing/fake-source"
import {
  DEFAULT_CORE_LIMITS,
  type CoreLimits,
  type Mutation,
  type RowView,
  type ViewHandle,
} from "../types"
import {
  OBJECTS,
  TASK,
  isCard,
  isKeys,
  key,
  keysOf,
  readsOf,
  S,
  seed,
  settle,
  taskValues,
  watch,
} from "./core-support"
import { collectCore } from "./oracles"

/*
 * Журнал мутацій і write-back (спека П4-B §6.5, §7.1,
 * §7.2): справжнє ядро над фейковим сервером. Порт запису керований: тест
 * тримає відповідь `run`, підміняє її форму чи відмовляє, а сервер виконує
 * запис лише на мить відповіді.
 */

const EPOCH = "e".repeat(64)
const OTHER_EPOCH = "f".repeat(64)
const K = key(1)

interface Port {
  /** Holds each `run` until {@link release}; the server writes on release. */
  hold: boolean
  /** Rewrites the raw value of a `run` answer (drop `rows`, another epoch). */
  transform: ((value: Record<string, unknown>) => unknown) | undefined
  /** Refuses each `run` with this error instead of serving it. */
  refuse: CommandError | undefined
  runs: number
  /** The `version` requests the server received. */
  versions: number
  /** The wire requests of every `run`, in order. */
  readonly requests: Parameters<ServerPort["run"]>[0][]
  release(): void
}

function harness(limits?: Partial<CoreLimits>) {
  const fake = createFakeSource({ objects: OBJECTS, epoch: EPOCH })
  const queue: (() => void)[] = []
  const port: Port = {
    hold: false,
    transform: undefined,
    refuse: undefined,
    runs: 0,
    versions: 0,
    requests: [],
    release() {
      for (const go of queue.splice(0)) go()
    },
  }
  const serve: ServerPort["run"] = async (request) => {
    if (port.refuse !== undefined) throw new CommandFailure(port.refuse)
    const value = (await fake.server.run(request)) as Record<string, unknown>
    return port.transform === undefined ? value : port.transform(value)
  }
  const server: ServerPort = {
    run(request) {
      port.runs++
      port.requests.push(request)
      if (!port.hold) return serve(request)
      return new Promise((resolve, reject) =>
        queue.push(() => void serve(request).then(resolve, reject))
      )
    },
    read(items) {
      port.versions += items.filter((item) => item.type === "version").length
      return fake.server.read(items)
    },
  }
  const source = createCoreSource(
    () => fake.adapter,
    fake.index,
    createReadLimiter(DEFAULT_CORE_LIMITS.readParallel),
    server
  )
  const onStaleClient = vi.fn<(object: string) => void>()
  const core = createCore({
    subject: "u1",
    source,
    index: fake.index,
    log: () => {},
    onStaleClient,
    ...(limits === undefined ? {} : { limits }),
  })
  collectCore(core, fake)
  return { fake, core, port, onStaleClient, inspect: inspectCore(core) }
}

type Harness = ReturnType<typeof harness>

const cardOf = (core: CoreSession, k = K): ViewHandle =>
  core.view({ kind: "card", object: TASK, key: k })

const rowOf = (handle: ViewHandle): RowView => handle.getSnapshot().rows[0]!

const shown = (view: RowView) => {
  if (view.state === "removed") throw new Error("removed")
  return view
}

/** A mounted card of a seeded task, loaded. */
async function mounted(h: Harness) {
  seed(h.fake, 1, 1)
  const card = cardOf(h.core)
  const seen = watch(card)
  await settle()
  return { card, seen, version: shown(rowOf(card)).version }
}

const keyReads = (fake: FakeSource) =>
  readsOf(fake, TASK).filter((r) => isKeys(r) || isCard(r))

// Відповідь понад бюджет приходить без `rows` (Рд26).
const withoutRows = (value: Record<string, unknown>) => {
  const rest = { ...value }
  delete rest.rows
  return rest
}

const holdReads = (fake: FakeSource) => {
  fake.hold = () => true
}

afterEach(() => {
  vi.useRealTimers()
})

describe("DataWriter.update — the await policy", () => {
  it("shows the confirmed values with the state pending until the answer", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.hold = true
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    const view = shown(rowOf(card))
    expect(view).toMatchObject({
      state: "pending",
      version,
      values: { title: "t1" },
      mutation: { id: m.id, state: "pending" },
    })
    expect(view.mutation).not.toHaveProperty("retry")
    expect(view.mutation).not.toHaveProperty("cancel")
    expect(h.port.runs).toBe(1)
  })

  it("writes the confirmed row and drops the mutation in one notification", async () => {
    const h = harness()
    const { card, seen, version } = await mounted(h)
    h.port.hold = true
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    const before = seen.seen.length
    h.port.release()
    await settle()
    const result = await m.settled
    expect(result.ok).toBe(true)
    const row = result.ok ? result.rows[0] : undefined
    expect(row).toMatchObject({ key: K, values: { title: "new" } })
    expect(row!.version).toBeGreaterThan(version)
    const after = seen.seen.slice(before).map((s) => shown(s.rows[0]!))
    // Жодного кадру з новим значенням і мутацією чи зі старим без мутації.
    expect(after[0]).toMatchObject({
      state: "synced",
      version: row!.version,
      values: { title: "new" },
    })
    expect(after[0]).not.toHaveProperty("mutation")
    for (const frame of after)
      expect(frame.values.title === "new" && frame.mutation === undefined).toBe(
        true
      )
    expect(shown(rowOf(card)).values.title).toBe("new")
    expect(h.inspect.serviceSizes().journal).toBe(0)
  })

  it("a new mutation carries the write mode await (the seam of #208)", async () => {
    const h = harness()
    const { version } = await mounted(h)
    h.port.hold = true
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    expect(h.inspect.mutations()).toEqual([
      {
        object: TASK,
        key: K,
        id: m.id,
        policy: "await",
        state: "pending",
        erased: false,
      },
    ])
  })

  it("sends one run of one update with the base and only the given fields", async () => {
    const h = harness()
    const { version } = await mounted(h)
    const m = h.core.update(
      TASK,
      K,
      { title: "x" },
      { expectedVersion: version }
    )
    await m.settled
    expect(h.port.requests).toEqual([
      {
        operation: {
          action: "update",
          object: h.fake.index.byRef.get(TASK)!.id,
          id: K,
          expectedVersion: version,
          values: { title: "x" },
        },
        kernels: {
          [h.fake.index.byRef.get(TASK)!.id]:
            h.fake.index.byRef.get(TASK)!.kernelHash,
        },
      },
    ])
  })
})

describe("DataWriter.update — developer errors before the journal (§6.1)", () => {
  it("refuses an update without expectedVersion with data.version-required", async () => {
    const h = harness()
    await mounted(h)
    for (const options of [
      undefined,
      {},
      { expectedVersion: 0 },
      { expectedVersion: 1.5 },
    ]) {
      expect(() =>
        h.core.update(TASK, K, { title: "x" }, options as never)
      ).toThrow(expect.objectContaining({ code: "data.version-required" }))
    }
    expect(h.port.runs).toBe(0)
    expect(h.inspect.serviceSizes().journal).toBe(0)
  })

  it("refuses a name outside the catalog synchronously, without the transport", async () => {
    const h = harness()
    const { version } = await mounted(h)
    expect(() =>
      h.core.update("Catalog.Nope", K, {}, { expectedVersion: version })
    ).toThrow(TypeError)
    expect(() =>
      h.core.update(TASK, K, { nope: 1 }, { expectedVersion: version })
    ).toThrow(TypeError)
    expect(h.port.runs).toBe(0)
  })

  it("an update of a failed key replaces its mutation", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.refuse = { code: "command.busy" }
    const first = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    expect(await first.settled).toEqual({
      ok: false,
      error: { code: "command.busy" },
    })
    expect(shown(rowOf(card)).mutation).toMatchObject({ state: "failed" })
    h.port.refuse = undefined
    const second = h.core.update(
      TASK,
      K,
      { title: "b" },
      { expectedVersion: version }
    )
    expect(second.id).not.toBe(first.id)
    const result = await second.settled
    expect(result).toMatchObject({
      ok: true,
      rows: [{ values: { title: "b" } }],
    })
    expect(h.port.runs).toBe(2)
    expect(shown(rowOf(card)).mutation).toBeUndefined()
  })
})

/*
 * Стан запису (ключ `pending`, повний журнал) — не помилка викликача, а
 * відмова запису: `update` не кидає, а повертає мутацію, що осідає `failed`
 * з кодом, — одна форма відмови для всього шляху запису (§7.1, #242).
 */
describe("DataWriter.update — a refusal by the write state settles failed (§7.1)", () => {
  /** The refusal of a mutation: a `DataError` with its code in `settled`. */
  async function refusedWith(mutation: Mutation, code: DataError["code"]) {
    const result = await mutation.settled
    expect(result).toMatchObject({ ok: false, error: { code } })
    expect(result.ok === false && result.error).toBeInstanceOf(DataError)
  }

  it("a second update of a pending key settles failed with data.mutation-pending", async () => {
    const h = harness()
    const { card, seen, version } = await mounted(h)
    h.port.hold = true
    const first = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    const journal = h.inspect.mutations()
    const row = rowOf(card)
    const notified = seen.seen.length
    const second = h.core.update(
      TASK,
      K,
      { title: "b" },
      { expectedVersion: version }
    )
    expect(second.id).not.toBe(first.id)
    await refusedWith(second, "data.mutation-pending")
    expect(h.port.runs).toBe(1)
    expect(h.inspect.mutations()).toEqual(journal)
    // Рядок показує ту саму мутацію `pending`: відмова його не чіпає.
    expect(rowOf(card)).toBe(row)
    expect(seen.seen.length).toBe(notified)
    h.port.release()
    expect(await first.settled).toMatchObject({
      ok: true,
      rows: [{ values: { title: "a" } }],
    })
  })

  it(`the journal holds ${JOURNAL_MAX} mutations: the next key settles failed with data.journal-full without the transport`, async () => {
    const h = harness()
    const { card, seen, version } = await mounted(h)
    h.port.hold = true
    for (let n = 2; n <= JOURNAL_MAX + 1; n++)
      h.core.update(TASK, key(n), { title: "x" }, { expectedVersion: 1 })
    expect(h.port.runs).toBe(JOURNAL_MAX)
    const journal = h.inspect.mutations()
    const size = h.inspect.serviceSizes().journal
    const row = rowOf(card)
    const notified = seen.seen.length
    const refused = h.core.update(
      TASK,
      K,
      { title: "x" },
      { expectedVersion: version }
    )
    await refusedWith(refused, "data.journal-full")
    expect(h.port.runs).toBe(JOURNAL_MAX)
    expect(h.inspect.mutations()).toEqual(journal)
    expect(h.inspect.serviceSizes().journal).toBe(size)
    expect(rowOf(card)).toBe(row)
    expect(row).not.toHaveProperty("mutation")
    expect(seen.seen.length).toBe(notified)
  })
})

describe("write-back without a full row", () => {
  it("an answer without rows re-reads the key before settling, in one notification", async () => {
    const h = harness()
    const { card, seen, version } = await mounted(h)
    h.port.transform = withoutRows
    holdReads(h.fake)
    const reads = keyReads(h.fake).length
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    // Відповідь прийшла, перечитування в дорозі: мутація ще `pending`.
    expect(keyReads(h.fake).length).toBe(reads + 1)
    expect(shown(rowOf(card))).toMatchObject({
      state: "pending",
      values: { title: "t1" },
    })
    const before = seen.seen.length
    h.fake.hold = undefined
    h.fake.deliverAll()
    await settle()
    const first = shown(seen.seen[before]!.rows[0]!)
    expect(first).toMatchObject({ state: "synced", values: { title: "new" } })
    expect(first.mutation).toBeUndefined()
    expect(await m.settled).toMatchObject({
      ok: true,
      rows: [{ key: K, values: { title: "new" } }],
    })
  })

  it("a changed lazy field settles only after the card form read of the key, with its value", async () => {
    const h = harness()
    const { card, seen, version } = await mounted(h)
    // Повний список над тим самим об'єктом: перечитування за ключем його не
    // перечитує (відповідь архітекторки, правила (a), (b)).
    const list = h.core.view({ kind: "full", object: TASK })
    watch(list)
    await settle()
    holdReads(h.fake)
    const reads = h.fake.log.length
    const m = h.core.update(
      TASK,
      K,
      { notes: "n2" },
      { expectedVersion: version }
    )
    await settle()
    expect(shown(rowOf(card))).toMatchObject({
      state: "pending",
      values: { notes: "body 1" },
    })
    const sent = h.fake.log.slice(reads)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.query).toEqual({
      object: { kind: "Catalog", name: "Task" },
      id: K,
    })
    const before = seen.seen.length
    h.fake.hold = undefined
    h.fake.deliverAll()
    await settle()
    expect(h.fake.log.length).toBe(reads + 1)
    const result = await m.settled
    expect(result).toMatchObject({
      ok: true,
      rows: [{ key: K, values: { notes: "n2" } }],
    })
    const first = shown(seen.seen[before]!.rows[0]!)
    expect(first).toMatchObject({
      state: "synced",
      values: { notes: "n2" },
      staleFields: [],
    })
    expect(first.mutation).toBeUndefined()
  })

  it("an answer without rows under a full list and a card is one read by key", async () => {
    const h = harness()
    const { version } = await mounted(h)
    const list = h.core.view({ kind: "full", object: TASK })
    watch(list)
    await settle()
    h.port.transform = withoutRows
    const reads = h.fake.log.length
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    expect(await m.settled).toMatchObject({
      ok: true,
      rows: [{ values: { title: "new" } }],
    })
    await settle()
    const sent = h.fake.log.slice(reads)
    // Після осідання картка дочитує ліниві поля своєю формою — це її
    // перевірка, не перечитування запису.
    expect(sent.filter((r) => !isCard(r))).toHaveLength(1)
    expect(keysOf(sent.find((r) => !isCard(r))!.query)).toEqual([K])
  })

  it("a key without an owner settles from the run row with no read", async () => {
    const h = harness()
    seed(h.fake, 1, 1)
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: h.fake.row(TASK, K)!.version }
    )
    expect(await m.settled).toMatchObject({
      ok: true,
      rows: [{ key: K, values: { title: "new" } }],
    })
    await settle()
    expect(h.fake.log).toHaveLength(0)
    expect(h.inspect.rowCount()).toBe(0)
    expect(h.inspect.serviceSizes().journal).toBe(0)
  })

  it("a key without an owner and a result of another epoch settles with rows [undefined] and no read", async () => {
    const h = harness()
    seed(h.fake, 1, 2)
    // Картка іншого ключа дає сесії поточну епоху; ключ K без власника.
    const other = cardOf(h.core, key(2))
    watch(other)
    await settle()
    const reads = h.fake.log.length
    h.port.transform = (value) => ({ ...value, epoch: OTHER_EPOCH })
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: h.fake.row(TASK, K)!.version }
    )
    // Значень іншої епохи немає, а перечитування ключа без власника нічого
    // не пише (спека П4-B §7.2): осідання без читання.
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
    await settle()
    expect(h.fake.log.slice(reads)).toHaveLength(0)
    expect(h.inspect.rowCount()).toBe(1)
    expect(h.inspect.serviceSizes().journal).toBe(0)
  })

  it("a key without an owner and an answer without rows settles with rows [undefined] and no read", async () => {
    const h = harness()
    seed(h.fake, 1, 1)
    h.port.transform = withoutRows
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: h.fake.row(TASK, K)!.version }
    )
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
    await settle()
    expect(h.fake.log).toHaveLength(0)
    expect(h.inspect.rowCount()).toBe(0)
    expect(h.inspect.serviceSizes().journal).toBe(0)
  })

  it("a failed re-read settles with rows [undefined] and leaves the row stale", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.transform = withoutRows
    holdReads(h.fake)
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    h.fake.take().fail("command.internal")
    await settle()
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
    expect(shown(rowOf(card))).toMatchObject({
      state: "stale",
      values: { title: "t1" },
    })
    expect(shown(rowOf(card)).mutation).toBeUndefined()
  })

  it("a core close while the re-read waits for its 5 s limit leaves no timer and the write settles", async () => {
    vi.useFakeTimers()
    const h = harness()
    const { version } = await mounted(h)
    h.port.transform = withoutRows
    holdReads(h.fake)
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    let settled = false
    void m.settled.then(() => (settled = true))
    await settle()
    expect(h.fake.pending).toHaveLength(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    h.core.close("disposed")
    // Годинник не рухається: таймер знято закриттям, а не добіг.
    expect(vi.getTimerCount()).toBe(0)
    await settle()
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("a re-read without an answer for 5 s settles with rows [undefined] and stale", async () => {
    vi.useFakeTimers()
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.transform = withoutRows
    holdReads(h.fake)
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    let result: unknown
    void m.settled.then((r) => (result = r))
    await settle()
    vi.advanceTimersByTime(4_999)
    await settle()
    expect(result).toBeUndefined()
    expect(shown(rowOf(card)).state).toBe("pending")
    vi.advanceTimersByTime(1)
    await settle()
    expect(result).toEqual({ ok: true, rows: [undefined] })
    expect(shown(rowOf(card))).toMatchObject({ state: "stale" })
    // Перечитування триває: пізня відповідь пише рядок, мутації вже немає.
    h.fake.hold = undefined
    h.fake.deliverAll()
    await settle()
    expect(shown(rowOf(card))).toMatchObject({
      state: "synced",
      values: { title: "new" },
    })
  })

  it("a result of another epoch writes no values and re-reads the key", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.transform = (value) => ({ ...value, epoch: OTHER_EPOCH })
    holdReads(h.fake)
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    expect(shown(rowOf(card))).toMatchObject({
      state: "pending",
      version,
      values: { title: "t1" },
    })
    h.fake.hold = undefined
    h.fake.deliverAll()
    await settle()
    expect(await m.settled).toMatchObject({
      ok: true,
      rows: [{ values: { title: "new" } }],
    })
    expect(shown(rowOf(card))).toMatchObject({ values: { title: "new" } })
  })

  it("a result of another epoch whose re-read fails leaves the row stale", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.transform = (value) => ({ ...value, epoch: OTHER_EPOCH })
    holdReads(h.fake)
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    h.fake.take().fail("command.internal")
    await settle()
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
    expect(shown(rowOf(card))).toMatchObject({
      state: "stale",
      values: { title: "t1" },
    })
  })

  it("a re-read answer of the epoch the session left writes nothing and settles with rows [undefined]", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.fake.insert(TASK, taskValues(2))
    const other = h.core.view({ kind: "keys", object: TASK, keys: [key(2)] })
    watch(other)
    await settle()
    h.port.transform = withoutRows
    holdReads(h.fake)
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    const reread = h.fake.take()
    h.fake.hold = undefined
    h.fake.epoch = OTHER_EPOCH
    other.refresh()
    await settle()
    expect(h.inspect.versionEpochs().current).toBe(OTHER_EPOCH)
    // Відповідь перечитування приходить з покинутої епохи.
    h.fake.epoch = EPOCH
    reread.answer()
    await settle()
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
    expect(shown(rowOf(card))).toMatchObject({ values: { title: "t1" } })
  })

  it("a result of the epoch the session left is not written, though the stored row is of it", async () => {
    const h = harness()
    const { version } = await mounted(h)
    h.fake.insert(TASK, taskValues(2))
    const other = h.core.view({ kind: "keys", object: TASK, keys: [key(2)] })
    watch(other)
    await settle()
    h.port.hold = true
    h.port.transform = (value) => ({ ...value, epoch: EPOCH })
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    // Інший вигляд читає вже нову епоху: сесія перемикається, а рядок `K`
    // лишається в старій.
    h.fake.epoch = OTHER_EPOCH
    other.refresh()
    await settle()
    expect(h.inspect.versionEpochs().current).toBe(OTHER_EPOCH)
    // Перечитування за ключем — списочною формою (картка дочитує ліниві поля
    // своєю формою й рахується окремо).
    const byKey = () => readsOf(h.fake, TASK).filter(isKeys).length
    const reads = byKey()
    h.port.release()
    await settle()
    expect(byKey()).toBe(reads + 1)
    expect(await m.settled).toMatchObject({
      ok: true,
      rows: [{ values: { title: "new" } }],
    })
  })

  it("a result of the current epoch is not written over a stored row of the epoch the session left", async () => {
    const h = harness()
    const { version } = await mounted(h)
    h.fake.insert(TASK, taskValues(2))
    const other = h.core.view({ kind: "keys", object: TASK, keys: [key(2)] })
    watch(other)
    await settle()
    h.port.hold = true
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    h.fake.epoch = OTHER_EPOCH
    other.refresh()
    await settle()
    expect(h.inspect.versionEpochs().current).toBe(OTHER_EPOCH)
    const byKey = () => readsOf(h.fake, TASK).filter(isKeys).length
    const reads = byKey()
    h.port.release()
    await settle()
    // Версії різних епох не порівнюються: рядок дає лише перечитування.
    expect(byKey()).toBe(reads + 1)
    expect(await m.settled).toMatchObject({
      ok: true,
      rows: [{ values: { title: "new" } }],
    })
  })

  it("a key with a newer tombstone and no owner settles without a write and without a re-read", async () => {
    const h = harness()
    const { version } = await mounted(h)
    h.port.hold = true
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    h.core.commit((w) => w.purge(TASK, { keys: [K] }), h.core.token())
    const reads = keyReads(h.fake).length
    h.port.release()
    await settle()
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
    // Ключ без власника осідає з відповіді `run` (відповідь архітекторки,
    // правило (c)): перечитувати нема для кого.
    expect(keyReads(h.fake).length).toBe(reads)
    expect(h.inspect.rowCount()).toBe(0)
    expect(h.inspect.serviceSizes().journal).toBe(0)
  })

  it("a purge whose tombstone was evicted in flight still settles without a row (the horizon)", async () => {
    const h = harness({ tombstonesMax: 1 })
    const { version } = await mounted(h)
    h.port.hold = true
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    h.core.commit((w) => w.purge(TASK, { keys: [K] }), h.core.token())
    // Надгробок K витісняє надгробок іншого ключа: лишається лише горизонт.
    h.core.commit((w) => w.purge(TASK, { keys: [key(2)] }), h.core.token())
    h.port.release()
    await settle()
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
  })

  it("a tombstone newer than the attempt refuses the write also when a later read brought the key back", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.hold = true
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    h.core.commit((w) => w.purge(TASK, { keys: [K] }), h.core.token())
    // Новий вигляд читає ключ після purge (картка прибраного ключа лишається
    // `purged`): слот є, але надгробок новіший за старт спроби.
    const again = h.core.view({ kind: "keys", object: TASK, keys: [K] })
    watch(again)
    await settle()
    expect(rowOf(again)).toMatchObject({ values: { title: "t1" } })
    const reads = keyReads(h.fake).length
    h.port.release()
    await settle()
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
    expect(keyReads(h.fake).length).toBe(reads + 1)
    expect(card.getSnapshot().status).toBe("purged")
  })

  it("write-back keeps hidden: the values return only with the re-read", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.hold = true
    holdReads(h.fake)
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    h.core.commit((w) => w.hide(TASK, [K]), h.core.token())
    h.port.release()
    await settle()
    expect(shown(rowOf(card))).toMatchObject({
      hidden: true,
      state: "stale",
      values: {},
      mutation: { state: "pending" },
    })
    h.fake.hold = undefined
    h.fake.deliverAll()
    await settle()
    const view = shown(rowOf(card))
    expect(view.hidden).toBeUndefined()
    expect(view).toMatchObject({ state: "synced", values: { title: "new" } })
    expect((await m.settled).ok).toBe(true)
  })

  it("a hide of the key in flight settles with rows [undefined] (a mark newer than the attempt)", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.hold = true
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    h.core.commit((w) => w.hide(TASK, [K]), h.core.token())
    h.port.release()
    await settle()
    // Перечитування після `hide` повертає рядок у сховище, але `settled`
    // рядка новішої за спробу позначки не віддає (§7.1).
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
    expect(shown(rowOf(card))).toMatchObject({
      state: "synced",
      values: { title: "new" },
    })
  })

  it("a hide of the key during the post-write re-read settles with rows [undefined]", async () => {
    const h = harness()
    const { version } = await mounted(h)
    h.port.transform = withoutRows
    holdReads(h.fake)
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    h.core.commit((w) => w.hide(TASK, [K]), h.core.token())
    h.fake.hold = undefined
    h.fake.deliverAll()
    await settle()
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
  })

  it("a hide of a key without an owner in flight settles with rows [undefined]", async () => {
    const h = harness()
    seed(h.fake, 1, 1)
    h.port.hold = true
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: h.fake.row(TASK, K)!.version }
    )
    await settle()
    h.core.commit((w) => w.hide(TASK, [K]), h.core.token())
    h.port.release()
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
    await settle()
    expect(h.fake.log).toHaveLength(0)
  })
})

describe("mutation actions", () => {
  it("failed offers retry and cancel; retry is a new attempt with a new Mutation", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.refuse = { code: "command.busy" }
    const first = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    await first.settled
    await settle()
    const failed = shown(rowOf(card))
    expect(failed).toMatchObject({
      state: "failed",
      values: { title: "t1" },
      mutation: { state: "failed", error: { code: "command.busy" } },
    })
    expect(Object.keys(failed.mutation!).sort()).toEqual([
      "cancel",
      "error",
      "id",
      "retry",
      "state",
    ])
    h.port.refuse = undefined
    h.port.hold = true
    const again = failed.mutation!.retry!()!
    expect(again.id).not.toBe(first.id)
    expect(shown(rowOf(card)).mutation).toMatchObject({
      id: again.id,
      state: "pending",
    })
    // Дія старого вигляду після повтору нічого не робить.
    expect(failed.mutation!.retry!()).toBeUndefined()
    failed.mutation!.cancel!()
    expect(shown(rowOf(card)).mutation).toMatchObject({ id: again.id })
    h.port.release()
    expect(await again.settled).toMatchObject({ ok: true })
    expect(await first.settled).toMatchObject({ ok: false })
    expect(h.port.runs).toBe(2)
  })

  it("conflict offers only cancel; cancel returns to the confirmed row in one notification", async () => {
    const h = harness()
    const { card, seen, version } = await mounted(h)
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version + 100 }
    )
    expect(await m.settled).toMatchObject({
      ok: false,
      error: { code: "command.conflict" },
    })
    await settle()
    const view = shown(rowOf(card))
    expect(view.state).toBe("conflict")
    expect(Object.keys(view.mutation!).sort()).toEqual([
      "cancel",
      "error",
      "id",
      "state",
    ])
    const before = seen.seen.length
    view.mutation!.cancel!()
    expect(seen.seen.length).toBe(before + 1)
    expect(shown(rowOf(card))).toMatchObject({
      state: "synced",
      values: { title: "t1" },
    })
    expect(shown(rowOf(card)).mutation).toBeUndefined()
  })

  it("a conflict row older than the known version carries stale: true until a read proves the current one", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    for (let i = 0; i < 3; i++) h.fake.edit(TASK, K, { title: `theirs ${i}` })
    const current = h.fake.row(TASK, K)!.version
    // Сигнал приніс новішу версію: рядок сховища — нижчий за відомий.
    h.core.commit((w) => w.markStale(TASK, [K], current), h.core.token())
    holdReads(h.fake)
    const m = h.core.update(
      TASK,
      K,
      { title: "mine" },
      { expectedVersion: version }
    )
    expect(await m.settled).toMatchObject({
      ok: false,
      error: { code: "command.conflict" },
    })
    await settle()
    // Стан мутації затуляє показ `stale` (§6.5), але факт лишається в рядку.
    expect(shown(rowOf(card))).toMatchObject({
      state: "conflict",
      version,
      stale: true,
    })
    h.fake.deliverAll()
    await settle()
    const after = shown(rowOf(card))
    expect(after).toMatchObject({ state: "conflict", version: current })
    expect(after.stale).toBeUndefined()
  })

  it("unavailable on run is unknown with dismiss only, and the key is re-read", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.refuse = { code: "command.unavailable" }
    const reads = keyReads(h.fake).length
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    expect(await m.settled).toMatchObject({ ok: false })
    await settle()
    const view = shown(rowOf(card))
    expect(view.state).toBe("unknown")
    expect(Object.keys(view.mutation!).sort()).toEqual([
      "dismiss",
      "error",
      "id",
      "state",
    ])
    expect(keyReads(h.fake).length).toBe(reads + 1)
    view.mutation!.dismiss!()
    expect(shown(rowOf(card)).mutation).toBeUndefined()
    expect(h.inspect.serviceSizes().journal).toBe(0)
  })

  it("command.internal on run is failed and re-reads the key without values of the answer", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.refuse = { code: "command.internal" }
    const reads = keyReads(h.fake).length
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    expect(await m.settled).toMatchObject({ ok: false })
    await settle()
    expect(shown(rowOf(card)).state).toBe("failed")
    expect(keyReads(h.fake).length).toBe(reads + 1)
  })

  it("a removed row carries a pending mutation with cancel; the answer after cancel writes nothing", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.hold = true
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    h.fake.setVisibleScopes([])
    card.refresh()
    await settle()
    const removed = rowOf(card)
    expect(removed).toMatchObject({
      state: "removed",
      mutation: { state: "pending" },
    })
    expect(removed.mutation).not.toHaveProperty("retry")
    removed.mutation!.cancel!()
    expect(rowOf(card)).toEqual({ key: K, state: "removed" })
    const reads = keyReads(h.fake).length
    h.port.release()
    await settle()
    expect(await m.settled).toEqual({ ok: true, rows: [undefined] })
    expect(rowOf(card)).toEqual({ key: K, state: "removed" })
    expect(keyReads(h.fake).length).toBe(reads)
    expect(h.inspect.serviceSizes().journal).toBe(0)
  })

  it("a failed mutation of a hidden key offers no retry", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    holdReads(h.fake)
    h.port.refuse = { code: "command.busy" }
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    await m.settled
    h.core.commit((w) => w.hide(TASK, [K]), h.core.token())
    await settle()
    const view = shown(rowOf(card))
    expect(view).toMatchObject({ hidden: true, mutation: { state: "failed" } })
    expect(view.mutation).not.toHaveProperty("retry")
    expect(view.mutation).toHaveProperty("cancel")
  })

  it("removed erases the fields of the mutation: no retry after the row returns", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.refuse = { code: "command.busy" }
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    await m.settled
    h.fake.setVisibleScopes([])
    card.refresh()
    await settle()
    expect(rowOf(card)).toMatchObject({
      state: "removed",
      mutation: { state: "failed" },
    })
    expect(rowOf(card).mutation).not.toHaveProperty("retry")
    h.fake.setVisibleScopes(undefined)
    card.refresh()
    await settle()
    const back = shown(rowOf(card))
    expect(back).toMatchObject({ state: "failed", values: { title: "t1" } })
    expect(back.mutation).not.toHaveProperty("retry")
    expect(back.mutation).toHaveProperty("cancel")
  })

  it("a purge erases the fields of the mutation: no retry, only cancel", async () => {
    const h = harness()
    const { version } = await mounted(h)
    const list = h.core.view({ kind: "keys", object: TASK, keys: [K] })
    watch(list)
    await settle()
    h.port.refuse = { code: "command.busy" }
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    await m.settled
    h.core.commit((w) => w.purge(TASK, { scope: null }), h.core.token())
    // Скоуп ключа — `S`: purge іншої пари полів не стирає.
    await settle()
    const kept = shown(rowOf(list)).mutation!
    expect(kept).toHaveProperty("retry")
    h.core.commit((w) => w.purge(TASK, { keys: [K] }), h.core.token())
    // Ключа в сховищі вже немає: мутація лишається в журналі без полів.
    expect(h.inspect.serviceSizes().journal).toBe(1)
    expect(kept.retry!()).toBeUndefined()
    expect(h.port.runs).toBe(1)
  })

  it("the purge of a pair erases the fields of a key that moved into it after the attempt", async () => {
    const h = harness()
    const S2 = "00000000-0000-4000-8000-0000000000b2"
    h.fake.insert(TASK, taskValues(1, { org: S2 }))
    const card = cardOf(h.core)
    watch(card)
    await settle()
    h.port.refuse = { code: "command.busy" }
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: shown(rowOf(card)).version }
    )
    await m.settled
    await settle()
    const kept = shown(rowOf(card)).mutation!
    // Рядок переїжджає в скоуп `S` уже після старту спроби.
    h.fake.edit(TASK, K, { org: S })
    card.refresh()
    await settle()
    expect(shown(rowOf(card)).values.org).toBe(S)
    h.core.commit((w) => w.purge(TASK, { scope: S }), h.core.token())
    expect(kept.retry!()).toBeUndefined()
    expect(h.port.runs).toBe(1)
  })

  it("the purge of the pair erases the fields of a mutation of that scope or of an unknown one", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.refuse = { code: "command.busy" }
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    await m.settled
    // Ключ без рядка в сховищі: скоуп спроби невідомий.
    const loose = h.core.update(
      TASK,
      key(9),
      { title: "b" },
      { expectedVersion: 1 }
    )
    await loose.settled
    await settle()
    const kept = shown(rowOf(card)).mutation!
    expect(kept).toHaveProperty("retry")
    h.core.commit((w) => w.purge(TASK, { scope: S }), h.core.token())
    expect(kept.retry!()).toBeUndefined()
    // Поля `key(9)` теж стерто: новий вигляд показує мутацію без `retry`.
    h.fake.insert(TASK, taskValues(9))
    const nine = cardOf(h.core, key(9))
    watch(nine)
    await settle()
    expect(rowOf(nine).mutation).toMatchObject({ state: "failed" })
    expect(rowOf(nine).mutation).not.toHaveProperty("retry")
    expect(h.port.runs).toBe(2)
  })
})

describe("close (§6.1)", () => {
  it("settles every live mutation with disposed; the late answer writes nothing", async () => {
    const h = harness()
    const { version } = await mounted(h)
    h.port.hold = true
    const m = h.core.update(
      TASK,
      K,
      { title: "new" },
      { expectedVersion: version }
    )
    await settle()
    h.core.close("disposed")
    const disposed = {
      ok: false,
      error: { code: "command.unavailable", reason: LIMIT_REASONS.disposed },
    }
    expect(await m.settled).toEqual(disposed)
    h.port.release()
    await settle()
    expect(await m.settled).toEqual(disposed)
    expect(h.inspect.rowCount()).toBe(0)
    expect(h.inspect.serviceSizes().journal).toBe(0)
  })

  it("an update after close settles with the close reason and is never sent", async () => {
    const h = harness()
    h.core.close("session-changed")
    const m = h.core.update(TASK, K, { title: "x" }, { expectedVersion: 1 })
    expect(await m.settled).toEqual({
      ok: false,
      error: {
        code: "command.unauthenticated",
        reason: LIMIT_REASONS.sessionChanged,
      },
    })
    expect(h.port.runs).toBe(0)
  })
})

describe("the table of refusals of a write (§7.3)", () => {
  const SESSION_CHANGED: CommandError = {
    code: "command.unauthenticated",
    reason: LIMIT_REASONS.sessionChanged,
  }
  interface Row {
    readonly name: string
    readonly error: CommandError
    readonly state: "conflict" | "failed" | "unknown"
    /**
     * The state the row shows when it differs from the mutation's: a
     * `stale-client` refusal marks the object (sticky, §10) and hides its
     * rows, and `hidden` outranks the mutation state in the row view.
     */
    readonly shown?: "stale"
    /** The key is re-read by key after the refusal. */
    readonly reread: boolean
    readonly actions: readonly string[]
  }
  const FAILED = ["cancel", "retry"]
  const rows: Row[] = [
    {
      name: "conflict",
      error: { code: "command.conflict", reason: "version" },
      state: "conflict",
      reread: true,
      actions: ["cancel"],
    },
    {
      name: "forbidden",
      error: { code: "command.forbidden" },
      state: "failed",
      reread: true,
      actions: FAILED,
    },
    {
      name: "invalid",
      error: { code: "command.invalid", path: "title" },
      state: "failed",
      reread: false,
      actions: FAILED,
    },
    {
      name: "stale-client",
      error: { code: "command.stale-client" },
      state: "failed",
      shown: "stale",
      reread: false,
      // Схований рядок не показує значень мутації, тож повтор не пропонується.
      actions: ["cancel"],
    },
    {
      name: "unavailable (transport broke or timed out)",
      error: { code: "command.unavailable" },
      state: "unknown",
      reread: true,
      actions: ["dismiss"],
    },
    {
      name: "busy",
      error: { code: "command.busy" },
      state: "failed",
      reread: false,
      actions: FAILED,
    },
    {
      name: "timeout",
      error: { code: "command.timeout" },
      state: "failed",
      reread: false,
      actions: FAILED,
    },
    {
      name: "internal",
      error: { code: "command.internal" },
      state: "failed",
      reread: true,
      actions: FAILED,
    },
    {
      name: "the rest (constraint)",
      error: { code: "command.constraint" },
      state: "failed",
      reread: false,
      actions: FAILED,
    },
  ]

  it.each(rows)(
    "$name: state $state, re-read $reread, actions $actions",
    async ({ error, state, shown: shownState, reread, actions }) => {
      const h = harness()
      const { card, version } = await mounted(h)
      h.port.refuse = error
      const reads = keyReads(h.fake).length
      const m = h.core.update(
        TASK,
        K,
        { title: "a" },
        { expectedVersion: version }
      )
      expect(await m.settled).toEqual({ ok: false, error })
      await settle()
      const view = shown(rowOf(card))
      expect(view.state).toBe(shownState ?? state)
      expect(view.mutation!.state).toBe(state)
      expect(view.mutation!.error).toEqual(error)
      expect(
        Object.keys(view.mutation!)
          .filter((k) => k !== "id" && k !== "state" && k !== "error")
          .sort()
      ).toEqual([...actions].sort())
      expect(keyReads(h.fake).length).toBe(reads + (reread ? 1 : 0))
      // Без автоповтору на жодному коді.
      expect(h.port.runs).toBe(1)
    }
  )

  it.each([
    ["conflict", { code: "command.conflict", reason: "version" } as const],
    ["forbidden", { code: "command.forbidden" } as const],
  ])("%s re-reads the card form for a lazy field", async (_, error) => {
    const h = harness()
    const { version } = await mounted(h)
    h.port.refuse = error
    const reads = readsOf(h.fake, TASK).filter(isCard).length
    const m = h.core.update(
      TASK,
      K,
      { notes: "lazy" },
      { expectedVersion: version }
    )
    await m.settled
    await settle()
    expect(readsOf(h.fake, TASK).filter(isCard).length).toBe(reads + 1)
  })

  it("conflict on an owner with a mounted section view: the section shows the lines of the new owner version", async () => {
    const h = harness()
    seed(h.fake, 1, 1)
    h.fake.setLines(TASK, K, "lines", [
      { ref: key(901), qty: 1, lineNumber: 1 },
    ])
    const card = cardOf(h.core)
    watch(card)
    const section = h.core.view({
      kind: "section",
      object: TASK,
      owner: K,
      section: "lines",
    })
    watch(section)
    await settle()
    const version = shown(rowOf(card)).version
    // Чужа зміна ТЧ підвищує версію власника; наш запис за старою базою — conflict.
    const next = h.fake.setLines(TASK, K, "lines", [
      { ref: key(902), qty: 2, lineNumber: 1 },
    ])
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    expect(await m.settled).toMatchObject({
      ok: false,
      error: { code: "command.conflict" },
    })
    await settle()
    expect(section.getSnapshot().section).toMatchObject({
      ownerVersion: next,
      complete: true,
      lines: [{ key: key(902) }],
    })
  })

  it("forbidden with the row gone from the server makes the row removed", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.refuse = { code: "command.forbidden" }
    h.fake.remove(TASK, K)
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    await m.settled
    await settle()
    const view = rowOf(card)
    expect(view.state).toBe("removed")
    expect(view.mutation).toMatchObject({ state: "failed" })
    expect(view.mutation!.cancel).toBeTypeOf("function")
  })

  it("invalid: a value that does not encode is failed with the logical path, never sent", async () => {
    const h = harness()
    const { card } = await mounted(h)
    const m = h.core.update(
      TASK,
      K,
      { title: { not: "encodable" } as never },
      { expectedVersion: 1 }
    )
    expect(await m.settled).toMatchObject({
      ok: false,
      error: { code: "command.invalid", path: "title" },
    })
    await settle()
    expect(h.port.runs).toBe(0)
    expect(shown(rowOf(card)).state).toBe("failed")
  })

  it("stale-client: failed, one version request, onStaleClient(object), no second run", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.refuse = { code: "command.stale-client" }
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    await m.settled
    await settle()
    expect(h.port.versions).toBe(1)
    expect(h.onStaleClient.mock.calls).toEqual([[TASK]])
    expect(h.port.runs).toBe(1)
    // Відмова ставить липку позначку: рядок схований, стан мутації — `failed`.
    expect(shown(rowOf(card)).state).toBe("stale")
    expect(shown(rowOf(card)).mutation!.state).toBe("failed")
    expect(shown(rowOf(card)).hidden).toBe(true)
  })

  it("unavailable disposed: nothing — no state, no re-read, no version request", async () => {
    const h = harness()
    const { version } = await mounted(h)
    h.port.refuse = {
      code: "command.unavailable",
      reason: LIMIT_REASONS.disposed,
    }
    const reads = keyReads(h.fake).length
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    expect(await m.settled).toMatchObject({ ok: false })
    await settle()
    expect(keyReads(h.fake).length).toBe(reads)
    expect(h.port.versions).toBe(0)
    expect(h.onStaleClient).not.toHaveBeenCalled()
  })

  it("session-changed: settles with the refusal, leaves no mutation, re-reads nothing", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    h.port.refuse = SESSION_CHANGED
    const reads = keyReads(h.fake).length
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    expect(await m.settled).toEqual({ ok: false, error: SESSION_CHANGED })
    await settle()
    expect(keyReads(h.fake).length).toBe(reads)
    expect(shown(rowOf(card)).mutation).toBeUndefined()
    expect(h.inspect.serviceSizes().journal).toBe(0)
  })

  it("a write to a marked object is stale-client without the transport and without onStaleClient", async () => {
    const h = harness()
    const { card, version } = await mounted(h)
    // Позначка — відповіддю `version` з чужим kernelHash.
    h.fake.kernelHashes[h.fake.index.byRef.get(TASK)!.id] = "1".repeat(64)
    h.core.requestVersion()
    await settle()
    expect(
      h.core.view({ kind: "card", object: TASK, key: K }).getSnapshot()
    ).toMatchObject({ isStale: true })
    expect(h.onStaleClient).toHaveBeenCalledTimes(1)
    const m = h.core.update(
      TASK,
      K,
      { title: "a" },
      { expectedVersion: version }
    )
    expect(await m.settled).toMatchObject({
      ok: false,
      error: { code: "command.stale-client" },
    })
    await settle()
    expect(h.port.runs).toBe(0)
    expect(h.onStaleClient).toHaveBeenCalledTimes(1)
    expect(shown(rowOf(card)).state).toBe("stale")
    expect(shown(rowOf(card)).mutation!.state).toBe("failed")
  })
})
