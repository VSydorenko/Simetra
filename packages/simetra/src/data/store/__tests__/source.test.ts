import { describe, expect, it } from "vitest"
import {
  CommandFailure,
  catalogIndex,
  type CatalogEntry,
  type MetadataRef,
  type SourceAdapter,
  type WireRowsQuery,
} from "simetra/model"
import {
  OBJECT_ID,
  ORGANIZATION_ID,
  catalogEntry,
} from "../../../model/runtime/__tests__/entries"
import { DataError } from "../../errors"
import {
  createCoreSource,
  createReadLimiter,
  readKeys,
  type CoreSource,
} from "../source"
import { createFakeSource, type FakeSource } from "../testing/fake-source"

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
const keysOf = (wire: WireRowsQuery): unknown[] => {
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
    const rows = await readKeys(source, task, TASK, keys, {
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
    const rows = await readKeys(source, task, TASK, keys, {
      keysPerRequest: 200,
    })
    expect(fake.log.map((r) => keysOf(r.wire).length)).toEqual([200, 100, 100])
    expect(rows).toHaveLength(200)
  })

  it("passes response-too-large on for a single key over the budget", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 2)
    fake.oversize(TASK, key(2))
    const failure = await readKeys(source, task, TASK, [key(1), key(2)], {
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
    const [row] = await readKeys(source, task, TASK, [key(1)], {
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
    const rows = await readKeys(source, task, TASK, [key(1), key(9)], {
      keysPerRequest: 200,
    })
    expect(rows.map((r) => r.key)).toEqual([key(1)])
    expect(
      await readKeys(source, task, TASK, [], { keysPerRequest: 200 })
    ).toEqual([])
    expect(fake.log).toHaveLength(1)
  })

  it("reads each key by the card form with lazy fields when asked", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 2)
    const rows = await readKeys(source, task, TASK, [key(1), key(2)], {
      keysPerRequest: 200,
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
    const result = await source.read({
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
    expect(fake.log[0]?.response?.rows[0]).toMatchObject({
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
          rows: [{ id: key(1), version: "3", title: "a", zzz: 1 }],
        }),
    }
    const source = createCoreSource(
      () => adapter,
      catalogIndex(OBJECTS),
      createReadLimiter(4)
    )
    const { rows } = await source.read({ object: TASK, limit: 1 })
    expect(rows).toEqual([{ ref: key(1), version: 3, title: "a" }])
  })

  it("refuses an unknown attribute with data.unsupported-predicate before any request", async () => {
    const { fake, source } = setup()
    const failure = await source
      .read({
        object: TASK,
        where: { attribute: "nope", op: "eq", value: 1 },
        limit: 1,
      })
      .catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(DataError)
    expect((failure as DataError).code).toBe("data.unsupported-predicate")
    expect(fake.log).toHaveLength(0)
  })

  it("refuses an untranslatable value with command.invalid and its path before any request", async () => {
    const { fake, source } = setup()
    const failure = await source
      .read({
        object: TASK,
        where: { attribute: "status", op: "eq", value: "Bogus" },
        limit: 1,
      })
      .catch((e: unknown) => e)
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
    const tasks = await source.read({ object: TASK, limit: 5 })
    const orgs = await source.read({ object: ORG, limit: 5 })
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
      source.read({ object: TASK, limit: 1 })
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
    const before = source.read({ object: TASK, id: key(1) })
    const now = source.read({ object: TASK, id: key(1) })
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
    const list = await source.read({ object: TASK, limit: 1 })
    const card = await source.read({ object: TASK, id: key(1) })
    expect(list.rows[0]).not.toHaveProperty("notes")
    expect(card.rows[0]?.notes).toBe("body")
  })

  it("answers owner lines with the owner version; a line change raises it", async () => {
    const { fake, source } = setup()
    seedTasks(fake, 1)
    const line = { ref: key(50), lineNumber: 1, qty: 2 }
    const version = fake.setLines(TASK, key(1), "lines", [line])
    const result = await source.read({
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
    const rows = await readKeys(source, task, TASK, [key(1), key(2)], {
      keysPerRequest: 200,
    })
    expect(rows.map((r) => r.key)).toEqual([key(1)])
  })

  it("fails a held read with the given error and still delivers after any caller is gone", async () => {
    const fake = createFakeSource({ objects: OBJECTS, mode: "manual" })
    const { source } = setup({ fake })
    seedTasks(fake, 1)
    const refused = source.read({ object: TASK, limit: 1 }).catch((e) => e)
    const late = source.read({ object: TASK, limit: 1 })
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
    const result = await source.read({
      object: TASK,
      limit: 5,
      include: ["org"],
    })
    expect(
      result.included?.["Catalog.Organization"]?.map((r) => r.ref)
    ).toEqual([S])
  })
})
