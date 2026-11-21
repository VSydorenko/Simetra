import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { READ_BATCH_MAX, jsonBytes, type CatalogEntry } from "simetra/model"
import { catalogEntry } from "../../../model/runtime/__tests__/entries"
import { createCore, type CoreSession } from "../core"
import { createCoreSource, createReadLimiter } from "../source"
import type { FakeSource } from "../testing/fake-source"
import {
  DEFAULT_CORE_LIMITS,
  type CoreSnapshot,
  type Key,
  type ViewSpec,
} from "../types"
import {
  RIGHTS_CONFIRMED_BYTES,
  RIGHTS_PART_BYTES,
  RIGHTS_KNOWN_PART_BYTES,
  VERSION_BOUND,
  VERSION_PART_BYTES,
  bodyBound,
} from "./body-bound"
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
const EB = "b".repeat(64)

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
 * (межа за кодеком §12: стала частини, 39 Б на ключ `where`, 58 Б на ключ
 * `known` з конвертом, 2 КіБ — `bodyBound` у `body-bound.ts`).
 */

const orgKey = (n: number) => key(10_000 + n)
const ROWS = 12
const INCLUDE = { include: ["org"] }
const LINES = [{ ref: key(900), qty: 1, lineNumber: 1 }]
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

/** The requests the fake received from `from` on, each with its budgets. */
function counted(fake: FakeSource, from: number): Counted[] {
  const versionBytes = jsonBytes({
    snapshotHash: fake.snapshotHash,
    objects: fake.kernelHashes,
  })
  return fake.requests.slice(from).map((parts, i) => {
    const reads = fake.log.filter((r) => r.request === from + i)
    const rights = fake.rightsLog.filter((r) => r.request === from + i)
    const hasVersion = parts > reads.length + rights.length
    return {
      parts,
      hasVersion,
      body:
        (hasVersion ? VERSION_PART_BYTES : 0) +
        rights.reduce(
          (sum, r) =>
            sum +
            (r.known === undefined
              ? RIGHTS_PART_BYTES
              : RIGHTS_KNOWN_PART_BYTES),
          0
        ) +
        reads.reduce(
          (sum, r) => sum + jsonBytes({ ...r.wire, known: r.known }),
          0
        ),
      bound: bodyBound(fake, reads, hasVersion, rights),
      response:
        (hasVersion ? versionBytes : 0) +
        rights.reduce((sum, r) => sum + jsonBytes(r.response), 0) +
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
    h.fake.setLines(TASK, key(1), "lines", LINES)
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
    // Корисне: рядок картки, його ТЧ і ціль `include`.
    const useful =
      jsonBytes(fake.row(TASK, key(1))!.values) +
      jsonBytes(LINES) +
      jsonBytes(fake.row(ORG, orgKey(1))!.values)
    expect(requests[0]!.response).toBeLessThanOrEqual(1.1 * useful + 2048)
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
      8 * 2 * ROWS + 2048 + copiesOf(fake) + VERSION_BOUND(set.objects.length)
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
        8 * ROWS + 2048 + copiesOf(fake) + VERSION_BOUND(set.objects.length)
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
        VERSION_BOUND(set.objects.length)
      )
      expectBodyBudget(requests)
    })
  })
})

describe("a 300-row list with include", () => {
  it("re-reads on resume() with known keys in where and in known: the body within the codec bound", async () => {
    const { core, fake } = setup()
    seedWithOrgs(fake, 300)
    watch(core.view({ kind: "full", object: TASK, ...INCLUDE }))
    await settle()
    vi.advanceTimersByTime(DEFAULT_CORE_LIMITS.resumeMinIntervalMs + 1)
    const from = fake.requests.length
    core.resume()
    await settle()
    const requests = counted(fake, from)
    expect(requests.length).toBeGreaterThan(0)
    // Частини `keys` з `known` несуть кожен ключ двічі.
    expect(
      fake.log
        .filter((r) => r.request >= from)
        .some((r) => r.known !== undefined && keysOf(r.query).length > 0)
    ).toBe(true)
    expectBodyBudget(requests)
  })
})

/** The snapshot of rows 1..2 of one epoch, as the HTML carries it. */
async function twoRowSnapshot() {
  const { core, fake } = setup()
  fake.epoch = EA
  for (let n = 1; n <= 2; n++)
    fake.insert(TASK, taskValues(n, { status: null, subject: null }))
  watch(core.view({ kind: "window", object: TASK }))
  await settle()
  const snapshot = JSON.parse(JSON.stringify(core.dehydrate())) as CoreSnapshot
  return { fake, snapshot }
}

/** Hydrates `snapshot` over the fake and returns the `known` of the reconcile. */
async function knownAfterHydration(fake: FakeSource, snapshot: CoreSnapshot) {
  const next = coreOver(fake)
  next.hydrate(snapshot)
  watch(next.view({ kind: "window", object: TASK }))
  const from = fake.log.length
  next.endHydration()
  await settle()
  return fake.log.slice(from).flatMap((r) => (r.known ? [r.known] : []))
}

describe("the version epoch of an SSR snapshot", () => {
  it("one epoch of every row becomes the epoch of the session: the re-read carries known of it", async () => {
    const { fake, snapshot } = await twoRowSnapshot()
    const known = await knownAfterHydration(fake, snapshot)
    expect(known.map((k) => k.epoch)).toEqual([EA])
    expect(known[0]!.keys).toHaveLength(2)
  })

  it("rows of two epochs: the session guesses none, no part carries known", async () => {
    const { fake, snapshot } = await twoRowSnapshot()
    const slots = snapshot.objects[TASK]!.slots as unknown as [
      Record<string, unknown>,
      Record<string, unknown>?,
    ][]
    slots[1] = [slots[1]![0], { ...slots[1]![1], epoch: EB }]
    expect(await knownAfterHydration(fake, snapshot)).toEqual([])
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

/*
 * Такт інтервалу (спека П4-B §6.7, §12, Р8): ядро з годинником `Date.now()`,
 * щоб фейкові таймери вели і строки, і таймер планувальника. Такт частини
 * `version` не шле; відповідь — маркери (8 Б на ключ) і 2 КіБ, тіло — за
 * кодеком (`bodyBound`); це дві окремі межі, і кожна перевіряється.
 */
describe("the interval tick", () => {
  const I = DEFAULT_CORE_LIMITS.revalidateIntervalMs
  const THIRD = "Catalog.Third"
  const third = catalogEntry({
    ...org,
    id: "00000000-0000-4000-8000-000000000199",
    name: "Third",
    kindLabel: "third",
    table: { schema: "public", name: "third" },
  })
  const thirdKey = (n: number) => key(20_000 + n)
  // Більше за `fullPageSize`: `full` читається кількома сторінками.
  const FULL_ROWS = DEFAULT_CORE_LIMITS.fullPageSize + 50

  const open = (limits: Partial<typeof DEFAULT_CORE_LIMITS> = {}) => {
    const h = setup({
      objects: [task, org, third],
      now: () => Date.now(),
      limits,
    })
    seedWithOrgs(h.fake, ROWS)
    for (let n = 1; n <= FULL_ROWS; n++)
      h.fake.insert(THIRD, { ref: thirdKey(n) })
    return h
  }

  /** Вікно з `include`, `full` на кількох сторінках і картка без ТЧ. */
  const watchThree = async (h: ReturnType<typeof open>) => {
    const window = h.core.view(LIST)
    watch(window)
    watch(h.core.view({ kind: "full", object: THIRD }))
    watch(h.core.view({ kind: "card", object: ORG, key: orgKey(1) }))
    await settle()
    expect(window.getSnapshot().status).toBe("ready")
  }

  /** Ключі, які такт звіряє: стільки маркерів повертає сервер. */
  const markerRows = (fake: FakeSource, from: number) =>
    fake.log
      .filter((r) => r.request >= from)
      .reduce((sum, r) => sum + (r.known?.keys.length ?? 0), 0)

  const tick = async (h: ReturnType<typeof open>, intervals = 1) => {
    const from = h.fake.requests.length
    await vi.advanceTimersByTimeAsync(I * intervals)
    await settle()
    return from
  }

  it("with nothing changed over three views of three objects is 1 request: no version part, the answer within 8 B x rows + 2 KiB", async () => {
    const h = open()
    h.fake.epoch = EA
    await watchThree(h)
    // Епоха сервера відома лише після першого читання: тут вона вже є, але
    // сторінки `full` читалися без `known`, тож рядки — зі збережених ключів.
    const from = await tick(h)
    const requests = counted(h.fake, from)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.hasVersion).toBe(false)
    const rows = markerRows(h.fake, from)
    // Рядки вікна, цілі `include` (по одній на рядок), `full` і картка.
    expect(rows).toBe(ROWS + ROWS + FULL_ROWS + 1)
    expect(requests[0]!.response).toBeLessThanOrEqual(8 * rows + 2048)
    expectBodyBudget(requests)
  })

  it("more views than a batch holds is ceil(parts / READ_BATCH_MAX) requests", async () => {
    const h = open()
    h.fake.epoch = EA
    for (let n = 1; n <= 20; n++)
      watch(h.core.view({ kind: "keys", object: TASK, keys: [key(n)] }))
    await settle()
    const from = await tick(h)
    const requests = counted(h.fake, from)
    const parts = h.fake.log.filter((r) => r.request >= from).length
    expect(parts).toBe(20)
    expect(requests).toHaveLength(Math.ceil(parts / READ_BATCH_MAX))
    expect(requests.every((r) => !r.hasVersion)).toBe(true)
    expectBodyBudget(requests)
  })

  it("one changed row (not a reference) is 1 request of the tick and nothing more", async () => {
    const h = open()
    h.fake.epoch = EA
    await watchThree(h)
    h.fake.edit(TASK, key(1), { title: "changed" })
    const from = await tick(h)
    const requests = counted(h.fake, from)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.hasVersion).toBe(false)
    expectBodyBudget(requests)
  })

  it("a reference changed to a target missing from the store is 1 request of the tick + ceil(new keys / keysPerRequest) include reads", async () => {
    const PER_REQUEST = 2
    const CHANGED = 5
    const h = open({ keysPerRequest: PER_REQUEST })
    h.fake.epoch = EA
    await watchThree(h)
    for (let n = 1; n <= CHANGED; n++) {
      h.fake.insert(ORG, { ref: orgKey(100 + n) })
      h.fake.edit(TASK, key(n), { org: orgKey(100 + n) })
    }
    const from = await tick(h)
    const reads = h.fake.log.filter((r) => r.request >= from)
    // Запит такту — перший; усе після нього — читання `include` нових цілей.
    const includeReads = reads.filter((r) => r.request > from)
    expect(includeReads.flatMap((r) => keysOf(r.query))).toHaveLength(CHANGED)
    expect(includeReads).toHaveLength(Math.ceil(CHANGED / PER_REQUEST))
    // Читання `include` одного ходу рушать пакетом: ⌈читань / READ_BATCH_MAX⌉.
    const requests = counted(h.fake, from)
    expect(requests).toHaveLength(
      1 + Math.ceil(includeReads.length / READ_BATCH_MAX)
    )
    expect(requests.every((r) => !r.hasVersion)).toBe(true)
    expectBodyBudget(requests)
  })

  it("a hidden tab for 10 intervals is 0 requests", async () => {
    const h = open()
    h.fake.epoch = EA
    await watchThree(h)
    h.core.suspend()
    const from = await tick(h, 10)
    expect(h.fake.requests.length - from).toBe(0)
  })
})

describe("the rights part of the service points", () => {
  const I = DEFAULT_CORE_LIMITS.revalidateIntervalMs
  const MIN = DEFAULT_CORE_LIMITS.resumeMinIntervalMs
  const V1 = "1".repeat(64)

  const open = async () => {
    const h = setup({
      objects: [task, org],
      now: () => Date.now(),
      rightsSnapshot: true,
    })
    seedWithOrgs(h.fake, ROWS)
    h.fake.epoch = EA
    h.fake.rightsVersion = V1
    watch(h.core.view(LIST))
    await settle()
    return h
  }

  /** The `rights` parts of the requests from `from` on: Р11, no snapshot back. */
  const expectConfirmed = (fake: FakeSource, from: number) => {
    const parts = fake.rightsLog.filter((r) => r.request >= from)
    expect(parts).toHaveLength(1)
    expect(parts[0]!.known).toBe(V1)
    expect(parts[0]!.response).toEqual({ rightsVersion: V1 })
    expect(jsonBytes(parts[0]!.response)).toBeLessThanOrEqual(
      RIGHTS_CONFIRMED_BYTES
    )
  }

  it("the first packet is one request with the rights part without known", async () => {
    const h = await open()
    const requests = counted(h.fake, 0)
    expect(requests).toHaveLength(1)
    expect(h.fake.rightsLog.map((r) => r.known)).toEqual([undefined])
    expectBodyBudget(requests)
  })

  it("resume() before the minimum interval is one request: version and rights with known, no jsonBytes of the snapshot", async () => {
    const h = await open()
    vi.advanceTimersByTime(1000)
    const from = h.fake.requests.length
    h.core.resume()
    await settle()
    const requests = counted(h.fake, from)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.parts).toBe(2)
    expect(requests[0]!.hasVersion).toBe(true)
    expectConfirmed(h.fake, from)
    // Версія каталогу (§12) і відповідь `rights` без знімка: 128 Б.
    expect(requests[0]!.response).toBeLessThanOrEqual(
      VERSION_BOUND(2) + RIGHTS_CONFIRMED_BYTES
    )
    expectBodyBudget(requests)
  })

  it("resume() after the minimum interval with nothing changed is one request within 8 B x rows + 2 KiB + 128 B", async () => {
    const h = await open()
    vi.advanceTimersByTime(MIN + 1)
    const from = h.fake.requests.length
    h.core.resume()
    await settle()
    const requests = counted(h.fake, from)
    expect(requests).toHaveLength(1)
    expectConfirmed(h.fake, from)
    expect(requests[0]!.response).toBeLessThanOrEqual(
      8 * 2 * ROWS + 2048 + VERSION_BOUND(2) + RIGHTS_CONFIRMED_BYTES
    )
    expectBodyBudget(requests)
  })

  it("the interval tick with nothing changed is one request within 8 B x rows + 2 KiB, the rights marker included", async () => {
    const h = await open()
    const from = h.fake.requests.length
    await vi.advanceTimersByTimeAsync(I)
    await settle()
    const requests = counted(h.fake, from)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.hasVersion).toBe(false)
    expectConfirmed(h.fake, from)
    expect(requests[0]!.response).toBeLessThanOrEqual(8 * 2 * ROWS + 2048)
    expectBodyBudget(requests)
  })

  it("the body formula counts the rights part with and without known", () => {
    expect(RIGHTS_PART_BYTES).toBe(jsonBytes({ type: "rights" }))
    expect(RIGHTS_KNOWN_PART_BYTES).toBe(RIGHTS_PART_BYTES + 1 + 8 + 66)
  })
})
