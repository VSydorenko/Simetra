import { describe, expect, it, vi } from "vitest"
import {
  CommandFailure,
  catalogIndex,
  readPartToWire,
  type CatalogEntry,
  type CommandErrorCode,
  type MetadataRef,
  type SourceAdapter,
  type WireQueryPart,
  type WireReadParts,
} from "simetra/model"
import {
  OBJECT_ID,
  ORGANIZATION_ID,
  catalogEntry,
  catalogEntryAttribute,
} from "../../../model/runtime/__tests__/entries"
import { DataError } from "../../errors"
import {
  createCoreSource,
  createReadLimiter,
  readKeys,
  readOne,
  ReadLimiterClosed,
  rowFromMarker,
  BATCH_RETRY_PAUSE_MS,
  type CoreSource,
  type ReadLimiter,
} from "../source"
import {
  createFakeSource,
  type FakeReadLog,
  type FakeSource,
} from "../testing/fake-source"

const TASK: MetadataRef = { kind: "Catalog", name: "Task" }
const ORG: MetadataRef = { kind: "Catalog", name: "Organization" }
const S = "00000000-0000-4000-8000-0000000000b1"
const T = "00000000-0000-4000-8000-0000000000b2"

const task = catalogEntry()
const org: CatalogEntry = catalogEntry({
  id: ORGANIZATION_ID,
  name: "Organization",
  kindLabel: "organization",
  table: { schema: "public", name: "organization" },
  scopeColumn: "id",
  attributes: [],
  tabularSections: [],
})
const OBJECTS = [task, org]

const key = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

/** Ядро над фейковим сервером: одне джерело на всі об'єкти. */
function setup(options: { parallel?: number; fake?: FakeSource } = {}): {
  fake: FakeSource
  source: CoreSource
} {
  const fake = options.fake ?? createFakeSource({ objects: OBJECTS })
  const source = createCoreSource(
    () => fake.adapter,
    catalogIndex(OBJECTS),
    createReadLimiter(options.parallel ?? 4)
  )
  return { fake, source }
}

const seedTasks = (fake: FakeSource, count: number) => {
  for (let n = 1; n <= count; n++) {
    fake.insert(TASK, { ref: key(n), org: S, title: `t${n}`, notes: "body" })
  }
}

/** Ключі запиту за ключами у формі передачі (`in` за фізичним ключем). */
const keysOf = (wire: FakeReadLog["wire"]): unknown[] => {
  const where = "where" in wire ? wire.where : undefined
  return where !== undefined && "op" in where && where.op === "in"
    ? (where.value as unknown[])
    : []
}

const tooLarge = (e: unknown) =>
  e instanceof CommandFailure &&
  e.error.code === "command.invalid" &&
  e.error.reason === "response-too-large"

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe("readKeys", () => {
  it("splits 450 keys into requests of 200, 200 and 50", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 450)
    const keys = Array.from({ length: 450 }, (_, i) => key(i + 1))
    const rows = await readKeys(source, task, keys, {
      keysPerRequest: 200,
    })
    expect(fake.log.map((r) => keysOf(r.wire).length)).toEqual([200, 200, 50])
    expect(rows.map((r) => r.key)).toEqual(keys)
  })

  it("halves a chunk on response-too-large: 200 becomes 100 + 100", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 200)
    fake.responseRows = 150
    const keys = Array.from({ length: 200 }, (_, i) => key(i + 1))
    const rows = await readKeys(source, task, keys, {
      keysPerRequest: 200,
    })
    expect(fake.log.map((r) => keysOf(r.wire).length)).toEqual([200, 100, 100])
    expect(rows).toHaveLength(200)
  })

  it("passes response-too-large on for a single key over the budget", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 2)
    fake.oversize(TASK, key(2))
    const failure = await readKeys(source, task, [key(1), key(2)], {
      keysPerRequest: 200,
    }).catch((e: unknown) => e)
    expect(tooLarge(failure)).toBe(true)
    expect(fake.log.map((r) => keysOf(r.wire))).toEqual([
      [key(1), key(2)],
      [key(1)],
      [key(2)],
    ])
  })

  it("takes key and version of a ServerRow from the decoded values", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 1)
    const version = fake.edit(TASK, key(1), { title: "x" })
    const [row] = await readKeys(source, task, [key(1)], {
      keysPerRequest: 200,
    })
    expect(row).toEqual({
      key: key(1),
      version,
      values: { ref: key(1), version, org: S, title: "x" },
    })
  })

  it("returns no row for an absent key and sends nothing for no keys", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 1)
    const rows = await readKeys(source, task, [key(1), key(9)], {
      keysPerRequest: 200,
    })
    expect(rows.map((r) => r.key)).toEqual([key(1)])
    expect(await readKeys(source, task, [], { keysPerRequest: 200 })).toEqual(
      []
    )
    expect(fake.log).toHaveLength(1)
  })

  it("refuses keysPerRequest outside 1..READ_LIMIT_MAX before any request", async () => {
    const { fake, source } = setup()
    for (const keysPerRequest of [0, 201, 1.5]) {
      await expect(
        readKeys(source, task, [key(1)], { keysPerRequest })
      ).rejects.toBeInstanceOf(RangeError)
    }
    expect(fake.log).toHaveLength(0)
  })

  it("reads each key by the card form with lazy fields when asked", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 2)
    const rows = await readKeys(source, task, [key(1), key(2)], {
      form: "card",
    })
    expect(fake.log.map((r) => r.query)).toEqual([
      { object: TASK, id: key(1) },
      { object: TASK, id: key(2) },
    ])
    expect(rows.map((r) => r.values.notes)).toEqual(["body", "body"])
  })
})

describe("createCoreSource", () => {
  it("sends the wire form with physical names and decodes the answer", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 1)
    const result = await readOne(source, {
      object: TASK,
      where: { attribute: "org", op: "eq", value: S },
      orderBy: [{ attribute: "title", direction: "asc" }],
      limit: 10,
    })
    expect(fake.log[0]?.wire).toEqual({
      object: OBJECT_ID,
      where: { attribute: "org_id", op: "eq", value: S },
      orderBy: [{ attribute: "title", direction: "asc" }],
      limit: 10,
    })
    expect(
      (fake.log[0]?.response as { rows: unknown[] }).rows[0]
    ).toMatchObject({
      id: key(1),
      org_id: S,
    })
    expect(result.rows).toEqual([
      { ref: key(1), version: expect.any(Number), org: S, title: "t1" },
    ])
  })

  it("ignores an unknown physical column of the answer", async () => {
    const adapter: SourceAdapter = {
      capabilities: { include: true },
      read: () =>
        Promise.resolve({
          epoch: null,
          items: [
            {
              ok: true,
              value: {
                rows: [{ id: key(1), version: "3", title: "a", zzz: 1 }],
              },
            },
          ],
        }),
    }
    const source = createCoreSource(
      () => adapter,
      catalogIndex(OBJECTS),
      createReadLimiter(4)
    )
    const { rows } = await readOne(source, { object: TASK, limit: 1 })
    expect(rows).toEqual([{ ref: key(1), version: 3, title: "a" }])
  })

  it("refuses an unknown attribute with data.unsupported-predicate before any request", async () => {
    const { fake, source } = setup()
    const failure = await readOne(source, {
      object: TASK,
      where: { attribute: "nope", op: "eq", value: 1 },
      limit: 1,
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(DataError)
    expect((failure as DataError).code).toBe("data.unsupported-predicate")
    expect(fake.log).toHaveLength(0)
  })

  it("refuses an untranslatable value with command.invalid and its path before any request", async () => {
    const { fake, source } = setup()
    const failure = await readOne(source, {
      object: TASK,
      where: { attribute: "status", op: "eq", value: "Bogus" },
      limit: 1,
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(CommandFailure)
    expect((failure as CommandFailure).error).toEqual({
      code: "command.invalid",
      path: "where.value",
    })
    expect(fake.log).toHaveLength(0)
  })

  it("reads each object through its own adapter", async () => {
    const a = createFakeSource({ objects: OBJECTS })
    const b = createFakeSource({ objects: OBJECTS })
    a.insert(TASK, { ref: key(1), org: S, title: "task" })
    b.insert(ORG, { ref: S })
    const source = createCoreSource(
      (object) => (object.name === "Task" ? a.adapter : b.adapter),
      catalogIndex(OBJECTS),
      createReadLimiter(4)
    )
    const tasks = await readOne(source, { object: TASK, limit: 5 })
    const orgs = await readOne(source, { object: ORG, limit: 5 })
    expect(tasks.rows.map((r) => r.ref)).toEqual([key(1)])
    expect(orgs.rows.map((r) => r.ref)).toEqual([S])
    expect(a.log.map((r) => r.wire.object)).toEqual([OBJECT_ID])
    expect(b.log.map((r) => r.wire.object)).toEqual([ORGANIZATION_ID])
  })

  it("keeps at most readParallel reads in flight: 9 reads, 4 at a time", async () => {
    const fake = createFakeSource({ objects: OBJECTS, mode: "manual" })
    const { source } = setup({ fake, parallel: 4 })
    seedTasks(fake, 1)
    const reads = Array.from({ length: 9 }, () =>
      readOne(source, { object: TASK, limit: 1 })
    )
    await settle()
    expect(fake.pending).toHaveLength(4)
    while (fake.pending.length > 0) {
      fake.take().answer()
      await settle()
      expect(fake.inFlight).toBeLessThanOrEqual(4)
    }
    expect(await Promise.all(reads)).toHaveLength(9)
    expect(fake.log).toHaveLength(9)
    expect(fake.maxInFlight).toBe(4)
  })
})

describe("createReadLimiter", () => {
  it("starts queued tasks in FIFO order and frees the slot of a rejected task", async () => {
    const limiter = createReadLimiter(1)
    const started: string[] = []
    const gates: Record<string, () => void> = {}
    const task = (name: string, fail = false) =>
      limiter.run(
        () =>
          new Promise<string>((resolve, reject) => {
            started.push(name)
            gates[name] = () => (fail ? reject(new Error(name)) : resolve(name))
          })
      )
    const a = task("a", true)
    const b = task("b")
    const c = task("c")
    await settle()
    expect(started).toEqual(["a"])
    gates.a!()
    await expect(a).rejects.toThrow("a")
    await settle()
    expect(started).toEqual(["a", "b"])
    gates.b!()
    await settle()
    gates.c!()
    expect(await Promise.all([b, c])).toEqual(["b", "c"])
  })

  it("on close drops queued reads and refuses later ones; reads in flight finish", async () => {
    const fake = createFakeSource({ objects: OBJECTS, mode: "manual" })
    const limiter = createReadLimiter(4)
    const source = createCoreSource(
      () => fake.adapter,
      catalogIndex(OBJECTS),
      limiter
    )
    seedTasks(fake, 1)
    // Кожна відмова зловлена тут: необроблених відхилень немає.
    const reads = Array.from({ length: 9 }, () =>
      readOne(source, { object: TASK, limit: 1 }).then(
        (r) => r.rows.length,
        (e: unknown) => e
      )
    )
    await settle()
    limiter.close()
    const later = readOne(source, { object: TASK, limit: 1 }).catch((e) => e)
    fake.deliverAll()
    const outcomes = await Promise.all(reads)
    expect(outcomes.slice(0, 4)).toEqual([1, 1, 1, 1])
    expect(outcomes.slice(4).every((e) => e instanceof ReadLimiterClosed)).toBe(
      true
    )
    expect(await later).toBeInstanceOf(ReadLimiterClosed)
    await settle()
    expect(fake.log).toHaveLength(4)
  })

  it("frees the slot of a task that throws synchronously", async () => {
    const limiter = createReadLimiter(1)
    const failed = limiter.run((): Promise<number> => {
      throw new Error("sync")
    })
    await expect(failed).rejects.toThrow("sync")
    expect(await limiter.run(() => Promise.resolve(1))).toBe(1)
  })
})

describe("createFakeSource", () => {
  it("answers a read from the server state at the chosen moment", async () => {
    const fake = createFakeSource({ objects: OBJECTS, mode: "manual" })
    const { source } = setup({ fake })
    fake.insert(TASK, { ref: key(1), org: S, title: "old" })
    const before = readOne(source, { object: TASK, id: key(1) })
    const now = readOne(source, { object: TASK, id: key(1) })
    await settle()
    const [first, second] = [fake.take(), fake.take()]
    fake.edit(TASK, key(1), { title: "new" })
    first!.answer(first!.issuedAt)
    second!.answer()
    expect((await before).rows[0]?.title).toBe("old")
    expect((await now).rows[0]?.title).toBe("new")
  })

  it("leaves lazy fields out of the list form and keeps them in the card form", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 1)
    const list = await readOne(source, { object: TASK, limit: 1 })
    const card = await readOne(source, { object: TASK, id: key(1) })
    expect(list.rows[0]).not.toHaveProperty("notes")
    expect(card.rows[0]?.notes).toBe("body")
  })

  it("answers owner lines with the owner version; a line change raises it", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 1)
    const line = { ref: key(50), lineNumber: 1, qty: 2 }
    const version = fake.setLines(TASK, key(1), "lines", [line])
    const result = await readOne(source, {
      object: TASK,
      tabularSection: "lines",
      owner: key(1),
    })
    expect(result.ownerVersion).toBe(version)
    expect(result.rows).toEqual([line])
    expect(fake.row(TASK, key(1))?.version).toBe(version)
  })

  it("hides rows outside the visible scopes and follows a row moved between scopes", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 2)
    fake.edit(TASK, key(2), { org: T })
    fake.setVisibleScopes([S])
    const rows = await readKeys(source, task, [key(1), key(2)], {
      keysPerRequest: 200,
    })
    expect(rows.map((r) => r.key)).toEqual([key(1)])
  })

  it("answers with the visibility of the chosen moment", async () => {
    const fake = createFakeSource({ objects: OBJECTS, mode: "manual" })
    const { source } = setup({ fake })
    seedTasks(fake, 1)
    const old = readOne(source, { object: TASK, id: key(1) })
    const current = readOne(source, { object: TASK, id: key(1) })
    await settle()
    const [first, second] = [fake.take(), fake.take()]
    // Доступ до скоупу рядка відкликано після читання (t1 > t0).
    fake.setVisibleScopes([T])
    first.answer(first.issuedAt)
    second.answer()
    expect((await old).rows.map((r) => r.ref)).toEqual([key(1)])
    expect((await current).rows).toEqual([])
  })

  it("refuses owner lines of an oversized owner and drops lines with a removed owner", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 1)
    fake.setLines(TASK, key(1), "lines", [
      { ref: key(50), lineNumber: 1, qty: 1 },
    ])
    const before = fake.clock
    fake.oversize(TASK, key(1))
    const lines = { object: TASK, tabularSection: "lines", owner: key(1) }
    expect(
      tooLarge(await readOne(source, lines).catch((e: unknown) => e))
    ).toBe(true)
    fake.oversize(TASK, key(1), false)
    fake.remove(TASK, key(1))
    fake.insert(TASK, { ref: key(1), org: S, title: "again" })
    expect((await readOne(source, lines)).rows).toEqual([])
    expect(fake.row(TASK, key(1), before)?.values.title).toBe("t1")
  })

  it("counts included rows in the response budget", async () => {
    const { fake, source } = setup()
    fake.insert(ORG, { ref: S })
    seedTasks(fake, 2)
    fake.responseRows = 2
    const page = await readOne(source, {
      object: TASK,
      limit: 5,
      include: ["org"],
    })
    expect(page.rows).toHaveLength(1)
    expect(page.more).toBe(true)
    // Без `include` ті самі два рядки вміщуються.
    expect(
      await readKeys(source, task, [key(1), key(2)], { keysPerRequest: 200 })
    ).toHaveLength(2)
  })

  it("fails a held read with the given error and still delivers after any caller is gone", async () => {
    const fake = createFakeSource({ objects: OBJECTS, mode: "manual" })
    const { source } = setup({ fake })
    seedTasks(fake, 1)
    const refused = readOne(source, { object: TASK, limit: 1 }).catch((e) => e)
    const late = readOne(source, { object: TASK, limit: 1 })
    await settle()
    fake.take().fail("command.forbidden")
    expect(((await refused) as CommandFailure).error.code).toBe(
      "command.forbidden"
    )
    fake.remove(TASK, key(1))
    fake.take().answer()
    expect((await late).rows).toEqual([])
  })

  it("brings included target rows keyed by the target object", async () => {
    const { fake, source } = setup()
    fake.insert(ORG, { ref: S })
    seedTasks(fake, 1)
    const result = await readOne(source, {
      object: TASK,
      limit: 5,
      include: ["org"],
    })
    expect(
      result.included?.["Catalog.Organization"]?.map((r) => r.ref)
    ).toEqual([S])
  })
})

const EPOCH_A = "a".repeat(64)
const EPOCH_B = "b".repeat(64)

/** Обмежувач, що рахує слоти: один запит — один `run`. */
function countingLimiter(parallel = 4): ReadLimiter & { runs: number } {
  const inner = createReadLimiter(parallel)
  const limiter = {
    runs: 0,
    close: () => inner.close(),
    run: <T>(task: () => Promise<T>) => {
      limiter.runs++
      return inner.run(task)
    },
  }
  return limiter
}

const rowFor = (n: number) => ({
  rows: [{ id: key(n), version: "1", title: `t${n}` }],
})
const okPart = (n: number) => ({ ok: true as const, value: rowFor(n) })
const refusal = (code: CommandErrorCode, reason?: string) => ({
  ok: false as const,
  error: { code, ...(reason === undefined ? {} : { reason }) },
})

/** Адаптер за сценарієм: кожен виклик бере наступну відповідь. */
function scripted(replies: Array<(size: number) => WireReadParts>) {
  const calls: number[] = []
  const adapter: SourceAdapter = {
    capabilities: { include: true },
    read: (items) => {
      calls.push(items.length)
      return Promise.resolve(replies[calls.length - 1]!(items.length))
    },
  }
  return { adapter, calls }
}

const taskQueries = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ object: TASK, id: key(i + 1) }))

describe("CoreSource on read parts", () => {
  it("keeps 1000 keys as 5 parts of one request and one limiter slot", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    const limiter = countingLimiter()
    const source = createCoreSource(
      () => fake.adapter,
      catalogIndex(OBJECTS),
      limiter
    )
    seedTasks(fake, 1000)
    const keys = Array.from({ length: 1000 }, (_, i) => key(i + 1))
    const rows = await readKeys(source, task, keys, { keysPerRequest: 200 })
    expect(rows).toHaveLength(1000)
    expect(fake.requests).toEqual([5])
    expect(limiter.runs).toBe(1)
  })

  it("splits 4000 keys into two requests of 16 and 4 parts", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    const limiter = countingLimiter()
    const source = createCoreSource(
      () => fake.adapter,
      catalogIndex(OBJECTS),
      limiter
    )
    const keys = Array.from({ length: 4000 }, (_, i) => key(i + 1))
    await readKeys(source, task, keys, { keysPerRequest: 200 })
    expect(fake.requests).toEqual([16, 4])
    expect(limiter.runs).toBe(2)
  })

  it("reads card forms as one part per key in one request", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 3)
    await readKeys(source, task, [key(1), key(2), key(3)], { form: "card" })
    expect(fake.requests).toEqual([3])
  })

  it("groups parts by adapter: one request each, order and epoch per part kept", async () => {
    const a = createFakeSource({ objects: OBJECTS, epoch: EPOCH_A })
    const b = createFakeSource({ objects: OBJECTS, epoch: null })
    a.insert(TASK, { ref: key(1), org: S, title: "task" })
    b.insert(ORG, { ref: S })
    const source = createCoreSource(
      (object) => (object.name === "Task" ? a.adapter : b.adapter),
      catalogIndex(OBJECTS),
      createReadLimiter(4)
    )
    const { items } = await source.read([
      { object: ORG, limit: 5 },
      { object: TASK, limit: 5 },
      { object: ORG, limit: 5 },
    ])
    expect(a.requests).toEqual([1])
    expect(b.requests).toEqual([2])
    expect(
      items.map((i) =>
        i.ok ? [i.rows.rows.map((r) => r.ref), i.epoch] : "failed"
      )
    ).toEqual([
      [[S], null],
      [[key(1)], EPOCH_A],
      [[S], null],
    ])
  })

  it("fails a part with its error and keeps the others", async () => {
    const { adapter } = scripted([
      () => ({
        epoch: null,
        items: [
          okPart(1),
          {
            ok: false,
            error: {
              code: "command.forbidden",
              object: OBJECT_ID,
              path: "org_id",
            },
          },
        ],
      }),
    ])
    const source = createCoreSource(
      () => adapter,
      catalogIndex(OBJECTS),
      createReadLimiter(4)
    )
    const { items } = await source.read(taskQueries(2))
    expect(items[0]?.ok).toBe(true)
    expect(items[1]).toEqual({
      ok: false,
      error: {
        code: "command.forbidden",
        object: TASK,
        path: "org",
      },
    })
  })

  it("fails every part of a request the adapter rejects, other requests go on", async () => {
    const down: SourceAdapter = {
      capabilities: { include: true },
      read: () =>
        Promise.reject(new CommandFailure({ code: "command.unavailable" })),
    }
    const fake = createFakeSource({ objects: OBJECTS })
    fake.insert(ORG, { ref: S })
    const source = createCoreSource(
      (object) => (object.name === "Task" ? down : fake.adapter),
      catalogIndex(OBJECTS),
      createReadLimiter(4)
    )
    const { items } = await source.read([
      { object: TASK, limit: 1 },
      { object: ORG, limit: 1 },
      { object: TASK, id: key(1) },
    ])
    expect(items.map((i) => (i.ok ? "ok" : i.error.code))).toEqual([
      "command.unavailable",
      "ok",
      "command.unavailable",
    ])
  })

  it("lets a failure that is not a CommandFailure reject the whole read", async () => {
    const broken: SourceAdapter = {
      capabilities: { include: true },
      read: () => Promise.reject(new Error("boom")),
    }
    const source = createCoreSource(
      () => broken,
      catalogIndex(OBJECTS),
      createReadLimiter(4)
    )
    await expect(source.read(taskQueries(1))).rejects.toThrow("boom")
  })

  it("answers command.internal for a count, a version value and a short answer", async () => {
    const { adapter } = scripted([
      () => ({
        epoch: null,
        items: [
          { ok: true, value: { count: 3 } },
          { ok: true, value: { snapshotHash: "h", objects: {} } },
        ],
      }),
      () => ({ epoch: null, items: [okPart(1)] }),
    ])
    const source = createCoreSource(
      () => adapter,
      catalogIndex(OBJECTS),
      createReadLimiter(4)
    )
    const first = await source.read(taskQueries(2))
    expect(first.items.map((i) => !i.ok && i.error.code)).toEqual([
      "command.internal",
      "command.internal",
    ])
    // Відповідь з меншим числом частин, ніж запитано, — дефект сервера.
    const second = await source.read(taskQueries(2))
    expect(second.items.map((i) => !i.ok && i.error.code)).toEqual([
      "command.internal",
      "command.internal",
    ])
  })

  it("answers command.internal for a marker in a part that sent no known", async () => {
    const { adapter } = scripted([
      () => ({ epoch: EPOCH_A, items: [{ ok: true, value: { rows: [0] } }] }),
    ])
    const source = createCoreSource(
      () => adapter,
      catalogIndex(OBJECTS),
      createReadLimiter(4)
    )
    const { items } = await source.read(taskQueries(1))
    expect(items[0]).toEqual({
      ok: false,
      error: { code: "command.internal" },
    })
  })

  it("answers command.internal for a partial marker too", async () => {
    const { adapter } = scripted([
      () => ({
        epoch: EPOCH_A,
        items: [{ ok: true, value: { rows: [{ $known: 0 }] } }],
      }),
    ])
    const source = createCoreSource(
      () => adapter,
      catalogIndex(OBJECTS),
      createReadLimiter(4)
    )
    const { items } = await source.read(taskQueries(1))
    expect(items[0]).toEqual({
      ok: false,
      error: { code: "command.internal" },
    })
  })

  describe("retries", () => {
    it("re-sends the parts after the failed one on batch-aborted, with a pause, through the limiter", async () => {
      vi.useFakeTimers()
      try {
        const limiter = countingLimiter()
        const { adapter, calls } = scripted([
          () => ({
            epoch: null,
            items: [
              okPart(1),
              okPart(2),
              refusal("command.timeout"),
              refusal("command.unavailable", "batch-aborted"),
              refusal("command.unavailable", "batch-aborted"),
            ],
          }),
          () => ({ epoch: null, items: [okPart(4), okPart(5)] }),
        ])
        const source = createCoreSource(
          () => adapter,
          catalogIndex(OBJECTS),
          limiter
        )
        const read = source.read(taskQueries(5))
        await vi.advanceTimersByTimeAsync(BATCH_RETRY_PAUSE_MS - 1)
        expect(calls).toEqual([5])
        await vi.advanceTimersByTimeAsync(1)
        const { items } = await read
        expect(calls).toEqual([5, 2])
        expect(limiter.runs).toBe(2)
        expect(
          items.map((i) => (i.ok ? i.rows.rows[0]!.ref : i.error.code))
        ).toEqual([key(1), key(2), "command.timeout", key(4), key(5)])
      } finally {
        vi.useRealTimers()
      }
    })

    it("lengthens the pause on every batch-aborted round", async () => {
      vi.useFakeTimers()
      try {
        // Збій у першій частині кожного повтору: прогрес є, але пауза зростає.
        const round = (size: number): WireReadParts => ({
          epoch: null,
          items: [
            refusal("command.internal"),
            ...Array.from({ length: size - 1 }, () =>
              refusal("command.unavailable", "batch-aborted")
            ),
          ],
        })
        const { adapter, calls } = scripted(
          Array.from({ length: 12 }, () => round)
        )
        const source = createCoreSource(
          () => adapter,
          catalogIndex(OBJECTS),
          createReadLimiter(4)
        )
        const read = source.read(taskQueries(4))
        await vi.advanceTimersByTimeAsync(BATCH_RETRY_PAUSE_MS)
        expect(calls).toEqual([4, 3])
        // Друга пауза довша за першу.
        await vi.advanceTimersByTimeAsync(BATCH_RETRY_PAUSE_MS)
        expect(calls).toEqual([4, 3])
        await vi.advanceTimersByTimeAsync(BATCH_RETRY_PAUSE_MS)
        expect(calls).toEqual([4, 3, 2])
        await vi.advanceTimersByTimeAsync(60_000)
        const { items } = await read
        expect(items).toHaveLength(4)
        expect(items.every((i) => !i.ok)).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it("re-sends a batch-budget part with the next request", async () => {
      const { adapter, calls } = scripted([
        () => ({
          epoch: EPOCH_A,
          items: [okPart(1), refusal("command.unavailable", "batch-budget")],
        }),
        () => ({ epoch: EPOCH_B, items: [okPart(2)] }),
      ])
      const source = createCoreSource(
        () => adapter,
        catalogIndex(OBJECTS),
        createReadLimiter(4)
      )
      const { items } = await source.read(taskQueries(2))
      expect(calls).toEqual([2, 1])
      expect(items.map((i) => i.ok && i.epoch)).toEqual([EPOCH_A, EPOCH_B])
    })

    it("does not re-send a part refused response-too-large: the view gets the error", async () => {
      const fake = createFakeSource({ objects: OBJECTS })
      seedTasks(fake, 3)
      fake.oversize(TASK, key(2))
      const source = createCoreSource(
        () => fake.adapter,
        catalogIndex(OBJECTS),
        createReadLimiter(4)
      )
      const { items } = await source.read(taskQueries(3))
      expect(fake.requests).toEqual([3])
      expect(fake.log).toHaveLength(3)
      expect(items[0]?.ok).toBe(true)
      expect(items[1]).toEqual({
        ok: false,
        error: { code: "command.invalid", reason: "response-too-large" },
      })
      expect(items[2]?.ok).toBe(true)
    })
  })
})

describe("createFakeSource: known markers", () => {
  const EPOCH = "a".repeat(64)
  const OTHER = "b".repeat(64)
  const copyEntry = catalogEntry({
    attributes: [
      ...task.attributes,
      catalogEntryAttribute({
        name: "ownerOrg",
        column: "owner_org_id",
        insert: false,
        update: false,
        copy: true,
      }),
    ],
  })

  /** Читає картку з `known` і повертає сирі рядки відповіді. */
  const readKnown = async (
    objects: CatalogEntry[],
    options: { epoch: string | null; known: string; version?: number }
  ) => {
    const fake = createFakeSource({ objects, epoch: options.epoch })
    fake.insert(TASK, { ref: key(1), org: S, title: "t", ownerOrg: S })
    const version = options.version ?? fake.row(TASK, key(1))!.version
    const part = readPartToWire(catalogIndex(objects), {
      type: "query",
      query: { object: TASK, id: key(1) },
      known: {
        epoch: options.known,
        keys: [key(1)],
        versions: [String(version)],
      },
    })
    if (!part.ok) throw new Error("fake: mapping failed")
    const answer = await fake.adapter.read([part.value as WireQueryPart])
    const item = answer.items[0]!
    if (!item.ok || !("rows" in item.value)) throw new Error("fake: not rows")
    return item.value.rows as unknown[]
  }

  it("answers a marker for an equal epoch and a matching version", async () => {
    expect(
      await readKnown([task, org], { epoch: EPOCH, known: EPOCH })
    ).toEqual([0])
  })

  it.each([
    ["another epoch", { epoch: EPOCH, known: OTHER }],
    ["a database without an epoch", { epoch: null, known: EPOCH }],
    ["another version", { epoch: EPOCH, known: EPOCH, version: 999 }],
  ])("answers the full row for %s", async (_name, options) => {
    const rows = await readKnown([task, org], options)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveProperty("title", "t")
  })

  it("answers a partial marker with the copy columns", async () => {
    const [row] = await readKnown([copyEntry, org], {
      epoch: EPOCH,
      known: EPOCH,
    })
    expect(row).toMatchObject({ $known: 0 })
    expect(row).not.toHaveProperty("title")
    expect(Object.keys(row as object)).toHaveLength(2)
  })
})

describe("rowFromMarker", () => {
  const entry = catalogEntry({
    attributes: [
      ...task.attributes,
      catalogEntryAttribute({
        name: "ownerOrg",
        column: "owner_org_id",
        insert: false,
        update: false,
        copy: true,
      }),
    ],
  })

  it("keeps the held row and takes only the copy attributes of a partial marker", () => {
    const held = {
      key: key(1),
      version: 3,
      values: { ref: key(1), version: 3, title: "kept", ownerOrg: "old" },
    }
    const row = rowFromMarker(entry, held, {
      known: 0,
      // Дефектний сервер: версія, ключ і зайві реквізити в копіях.
      copies: { ownerOrg: "new", version: 99, ref: "x", title: "evil" },
    })
    expect(row).toEqual({
      key: key(1),
      version: 3,
      values: { ref: key(1), version: 3, title: "kept", ownerOrg: "new" },
    })
    expect(held.values.ownerOrg).toBe("old")
  })

  it("returns the held row for a marker without copies", () => {
    const held = {
      key: key(1),
      version: 3,
      values: { ref: key(1), version: 3 },
    }
    expect(rowFromMarker(entry, held, { known: 0 })).toEqual(held)
  })
})
