import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  READ_BATCH_MAX,
  jsonBytes,
  readPartToWire,
  type CatalogEntry,
  type ReadQuery,
} from "simetra/model"
import { catalogEntry } from "../../../model/runtime/__tests__/entries"
import { createCore, type CoreSession } from "../core"
import { createCoreSource, createReadLimiter } from "../source"
import type { FakeReadLog, FakeSource } from "../testing/fake-source"
import { DEFAULT_CORE_LIMITS, type Key, type ViewSpec } from "../types"
import {
  ORG,
  TASK,
  isPage,
  key,
  keysOf,
  org,
  settle,
  setup,
  task,
  taskValues,
  watch,
} from "./core-support"

const EA = "a".repeat(64)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/*
 * Бюджети «1 запит» (спека П4-B §12, Р10): сценарії читання над фейковим
 * транспортом, що рахує запити, частини й байти. Кожен запит перевіряється
 * за обома стовпцями: відповідь (у кожного сценарію своя) і тіло
 * (≤ 64 Б × ключів `known` + 2 КіБ).
 */

const orgKey = (n: number) => key(10_000 + n)
const ROWS = 12
const INCLUDE = { include: ["org"] }
const LIST: ViewSpec = { kind: "window", object: TASK, ...INCLUDE }

// Об'єкт з копією носія: маркер несе її значення, тож і ця відповідь більша.
const withCopy = (entry: CatalogEntry): CatalogEntry => ({
  ...entry,
  attributes: entry.attributes.map((a) =>
    a.name === "title" ? { ...a, copy: true as const } : a
  ),
})

const OBJECT_SETS: readonly {
  name: string
  copies: boolean
  objects: readonly CatalogEntry[]
}[] = [
  { name: "without copies", copies: false, objects: [task, org] },
  {
    name: "with copies of a carrier",
    copies: true,
    objects: [withCopy(catalogEntry()), org],
  },
]

/** Задачі `1..count`, кожна зі своєю організацією; повні рядки списку. */
function seedWithOrgs(fake: FakeSource, count: number) {
  fake.epoch = EA
  for (let n = 1; n <= count; n++) {
    fake.insert(ORG, { ref: orgKey(n) })
    fake.insert(
      TASK,
      taskValues(n, { org: orgKey(n), status: null, subject: null })
    )
  }
}

interface Counted {
  /** Parts of the request, the `version` part included. */
  parts: number
  hasVersion: boolean
  /** Bytes of the body: every part with its `known`. */
  body: number
  /** The bound of the body derived from the codec, see {@link bodyBound}. */
  bound: number
  /** Bytes of the answer, the `version` value included. */
  response: number
}

/** The wire part of a query with the list of its keys emptied. */
function partWithoutKeys(fake: FakeSource, query: ReadQuery): number {
  const where = "where" in query ? query.where : undefined
  const emptied: ReadQuery =
    where !== undefined && "op" in where && where.op === "in"
      ? ({ ...query, where: { ...where, value: [] } } as ReadQuery)
      : query
  const wire = readPartToWire(fake.index, { type: "query", query: emptied })
  if (!wire.ok) throw new Error("the part does not encode")
  return jsonBytes(wire.value)
}

// Верхня оцінка тіла запиту за кодеком, а не за виміром (джерела:
// `readPartToWire` / `readQueryMap` у `model/runtime/mapping.ts` і
// `knownSchema` у `model/runtime/read.ts`):
//  - стала частини (об'єкт, форма): `{"type":"query","query":{...}}` з об'єктом
//    як UUID, колонками фізичних імен і порожнім списком ключів — її кодує
//    сам `readPartToWire`, тож число не вгадане;
//  - ключ частини без `known`: 36 символів UUID, дві лапки й кома — 39 Б;
//  - ключ `known`: 64 Б (ключ 39 Б + версія текстом до 16 цифр + лапки й кома
//    — межа `knownVersionSchema`, не більше 64 Б);
//  - частина `version`: `{"type":"version"}`;
//  - 2 КіБ — запас §12.
const KEY_BYTES = 39
const KNOWN_KEY_BYTES = 64
const VERSION_PART_BYTES = jsonBytes({ type: "version" })
const SLACK = 2048

function bodyBound(
  fake: FakeSource,
  reads: readonly FakeReadLog[],
  hasVersion: boolean
): number {
  let bound = SLACK + (hasVersion ? VERSION_PART_BYTES : 0)
  for (const read of reads) {
    bound += partWithoutKeys(fake, read.query!)
    // Ключи читання за ключами несе й `where`; частина з `known` має їх у
    // `known` (їхні 64 Б покривають і ключ `where`, бо це ті самі ключі).
    const known = read.known?.keys.length ?? 0
    bound += known * KNOWN_KEY_BYTES
    if (known === 0) bound += keysOf(read.query).length * KEY_BYTES
  }
  return bound
}

/** The requests the fake received from `from` on, each with its budgets. */
function counted(fake: FakeSource, from: number): Counted[] {
  const versionBytes = jsonBytes({
    snapshotHash: fake.snapshotHash,
    objects: fake.kernelHashes,
  })
  return fake.requests.slice(from).map((parts, i) => {
    const reads = fake.log.filter((r) => r.request === from + i)
    const hasVersion = parts > reads.length
    return {
      parts,
      hasVersion,
      body:
        (hasVersion ? VERSION_PART_BYTES : 0) +
        reads.reduce(
          (sum, r) => sum + jsonBytes({ ...r.wire, known: r.known }),
          0
        ),
      bound: bodyBound(fake, reads, hasVersion),
      response:
        (hasVersion ? versionBytes : 0) +
        reads.reduce((sum, r) => sum + jsonBytes(r.response), 0),
    }
  })
}

/** The body column of §12, held by every request of every scenario. */
const expectBodyBudget = (requests: readonly Counted[]) => {
  for (const request of requests)
    expect(request.body).toBeLessThanOrEqual(request.bound)
}

/** A second core over the same fake server, as the browser after SSR. */
function coreOver(fake: FakeSource): CoreSession {
  const source = createCoreSource(
    () => fake.adapter,
    fake.index,
    createReadLimiter(DEFAULT_CORE_LIMITS.readParallel),
    fake.server
  )
  return createCore({ subject: "u1", source, index: fake.index })
}

/** Bytes of the rows and the targets the way they are stored: the useful part. */
const usefulBytes = (fake: FakeSource, count: number) => {
  let sum = 0
  for (let n = 1; n <= count; n++)
    sum +=
      jsonBytes(fake.row(TASK, key(n))!.values) +
      jsonBytes(fake.row(ORG, orgKey(n))!.values)
  return sum
}

describe.each(OBJECT_SETS)("read budgets, $name", (set) => {
  const open = () => {
    const h = setup({ objects: set.objects })
    seedWithOrgs(h.fake, ROWS)
    return h
  }
  const copiesOf = (fake: FakeSource) =>
    set.copies
      ? Array.from({ length: ROWS }, (_, i) =>
          jsonBytes({
            key: key(i + 1),
            version: fake.row(TASK, key(i + 1))!.version,
            copies: { title: fake.row(TASK, key(i + 1))!.values.title },
          })
        ).reduce((a, b) => a + b, 0)
      : 0

  it("opens a list with include in one request within 1.1 x useful + 2 KiB", async () => {
    const { core, fake } = open()
    watch(core.view(LIST))
    await settle()
    const requests = counted(fake, 0)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.hasVersion).toBe(false)
    expect(requests[0]!.response).toBeLessThanOrEqual(
      1.1 * usefulBytes(fake, ROWS) + 2048
    )
    expectBodyBudget(requests)
  })

  it("opens a card with a section and include after the list in one request", async () => {
    const { core, fake } = open()
    watch(core.view(LIST))
    await settle()
    const from = fake.requests.length
    watch(core.view({ kind: "card", object: TASK, key: key(1), ...INCLUDE }))
    await settle()
    const requests = counted(fake, from)
    expect(requests).toHaveLength(1)
    expectBodyBudget(requests)
  })

  it("re-reads two views of one object and two objects in one request", async () => {
    const { core, fake } = open()
    watch(core.view(LIST))
    watch(core.view({ kind: "full", object: TASK }))
    watch(core.view({ kind: "keys", object: ORG, keys: [orgKey(1)] }))
    await settle()
    const from = fake.requests.length
    await Promise.all([
      core.revalidate(TASK, { visibleOnly: false }),
      core.revalidate(ORG, { visibleOnly: false }),
    ])
    await settle()
    const requests = counted(fake, from)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.parts).toBeGreaterThanOrEqual(3)
    expectBodyBudget(requests)
  })

  it("hydration of an SSR snapshot reconciles in one request: version and the views", async () => {
    const { core, fake } = open()
    watch(core.view(LIST))
    watch(core.view({ kind: "card", object: TASK, key: key(1), ...INCLUDE }))
    await settle()
    const snapshot = JSON.parse(JSON.stringify(core.dehydrate()))

    const next = coreOver(fake)
    next.hydrate(snapshot)
    watch(next.view(LIST))
    watch(next.view({ kind: "card", object: TASK, key: key(1), ...INCLUDE }))
    const from = fake.requests.length
    next.endHydration()
    await settle()
    const requests = counted(fake, from)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.hasVersion).toBe(true)
    // Знімок несе епоху версій рядків, тож перечитування йде з `known` і
    // приходить маркерами: 8 Б на ключ вигляду, копії носіїв, версія й 2 КіБ.
    expect(
      fake.log.filter((r) => r.request === from).some((r) => r.known)
    ).toBe(true)
    expect(requests[0]!.response).toBeLessThanOrEqual(
      8 * 2 * ROWS +
        2048 +
        copiesOf(fake) +
        jsonBytes({
          snapshotHash: fake.snapshotHash,
          objects: fake.kernelHashes,
        })
    )
    expectBodyBudget(requests)
  })

  describe("resume()", () => {
    const MIN = DEFAULT_CORE_LIMITS.resumeMinIntervalMs
    const arm = async () => {
      const h = setup({ objects: set.objects })
      seedWithOrgs(h.fake, ROWS)
      watch(h.core.view(LIST))
      await settle()
      return h
    }

    it("after the minimum interval with nothing changed is one request: version and markers", async () => {
      const { core, fake } = await arm()
      vi.advanceTimersByTime(MIN + 1)
      const from = fake.requests.length
      core.resume()
      await settle()
      const requests = counted(fake, from)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.hasVersion).toBe(true)
      expect(requests[0]!.parts).toBeGreaterThan(1)
      expect(requests[0]!.response).toBeLessThanOrEqual(
        8 * ROWS +
          2048 +
          copiesOf(fake) +
          jsonBytes({
            snapshotHash: fake.snapshotHash,
            objects: fake.kernelHashes,
          })
      )
      expectBodyBudget(requests)
    })

    it("before the minimum interval is one request with the version only", async () => {
      const { core, fake } = await arm()
      vi.advanceTimersByTime(1000)
      const from = fake.requests.length
      core.resume()
      await settle()
      const requests = counted(fake, from)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.parts).toBe(1)
      expect(requests[0]!.hasVersion).toBe(true)
      expect(requests[0]!.response).toBeLessThanOrEqual(
        2048 + 128 * set.objects.length
      )
      expectBodyBudget(requests)
    })
  })
})

describe("a flood of views", () => {
  it("20 views opened in one tick are ceil(20 / READ_BATCH_MAX) requests", async () => {
    const { core, fake } = setup()
    fake.epoch = EA
    for (let n = 1; n <= 20; n++) fake.insert(TASK, taskValues(n))
    for (let n = 1; n <= 20; n++)
      watch(core.view({ kind: "keys", object: TASK, keys: [key(n)] as Key[] }))
    await settle()
    expect(fake.log.filter((r) => !isPage(r)).length).toBe(20)
    const requests = counted(fake, 0)
    expect(requests).toHaveLength(Math.ceil(20 / READ_BATCH_MAX))
    expect(requests.map((r) => r.parts)).toEqual([READ_BATCH_MAX, 4])
    expectBodyBudget(requests)
  })
})
