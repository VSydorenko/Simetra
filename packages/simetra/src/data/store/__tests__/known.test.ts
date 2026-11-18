import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { jsonBytes, type CatalogEntry } from "simetra/model"
import { catalogEntry } from "../../../model/runtime/__tests__/entries"
import { bodyBound } from "./body-bound"
import { visibleRow } from "../object-store"
import type { FakeReadLog, FakeSource } from "../testing/fake-source"
import type { Key, ServerRow, ViewSnapshot, ViewSpec } from "../types"
import {
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
import { K1, K2, S, harness, type Harness } from "./store-support"

const EA = "a".repeat(64)
const EB = "b".repeat(64)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/*
 * Умовне читання на клієнті (спека П4-B §6.7): правило «ключ іде в `known`»
 * (`ObjectStore.knownFor`) і застосування маркера (`applyMarker`) на сховищі;
 * системне перечитування власних сторінок і `full` над фейковим сервером.
 */

/** A row of the default test object with every column of the list read. */
const listRow = (
  k: Key,
  version: number,
  title = `t${version}`
): ServerRow => ({
  key: k,
  version,
  versionEpoch: EA,
  values: {
    ref: k,
    version,
    org: S,
    title,
    status: null,
    subject: null,
  },
})
/** The same row with its lazy field, as a card read brings it. */
const cardRow = (k: Key, version: number): ServerRow => ({
  ...listRow(k, version),
  values: { ...listRow(k, version).values, notes: `n${version}` },
})

/** A harness whose session is in the version epoch `EA`. */
function inEpoch(): Harness {
  const h = harness()
  h.write(() => h.session.acceptEpoch(EA, h.now()))
  return h
}

/** Puts `row`, owned; returns the start epoch a read of it could have had. */
function hold(h: Harness, row: ServerRow, lazyRead = false): number {
  const at = h.now()
  h.write((scope) => {
    h.store.put(scope, row, at, lazyRead)
    h.store.own(scope, row.key)
  })
  return at
}

const list = (k: Key) => ({ owned: new Set([k]), form: "list" as const })

/** What a marker of `held` is: the row it confirms, pointing at the held row. */
const markerOf = (held: ServerRow): ServerRow => ({
  key: held.key,
  version: held.version,
  versionEpoch: EA,
  values: held.values,
  marker: held,
})

describe("knownFor", () => {
  it("sends a held row of the current epoch, with its version", () => {
    const h = inEpoch()
    hold(h, listRow(K1, 3))
    const snapshot = h.store.knownFor([K1], list(K1))
    expect(snapshot?.known).toEqual({ epoch: EA, keys: [K1], versions: ["3"] })
    expect(snapshot?.held).toEqual([listRow(K1, 3)])
  })

  // П'ять умов правила (§6.7); кожен випадок ламає рівно одну.
  const BROKEN: readonly {
    name: string
    form?: "list" | "card"
    arrange: (h: Harness) => { owned?: ReadonlySet<Key> } | void
  }[] = [
    {
      name: "the row is removed",
      arrange(h) {
        hold(h, listRow(K1, 1))
        h.write((scope) => h.store.remove(scope, K1, h.now()))
      },
    },
    {
      name: "the key is purged",
      arrange(h) {
        hold(h, listRow(K1, 1))
        h.write((scope) => h.store.purgeKeys(scope, [K1]))
      },
    },
    {
      name: "the values are hidden",
      arrange(h) {
        hold(h, listRow(K1, 1))
        h.write((scope) => h.store.hideKeys(scope, [K1]))
      },
    },
    {
      name: "the version is not confirmed (a newer one is known to exist)",
      arrange(h) {
        hold(h, listRow(K1, 1))
        h.write((scope) => h.store.markStale(scope, [K1], 5))
      },
    },
    {
      name: "a column of the list read is missing",
      arrange(h) {
        const values = { ...listRow(K1, 1).values }
        delete values.status
        hold(h, { ...listRow(K1, 1), values })
      },
    },
    {
      name: "a lazy field of the card was never read",
      form: "card",
      arrange(h) {
        hold(h, listRow(K1, 1), true)
      },
    },
    {
      name: "a lazy field of the card was read with an older row version",
      form: "card",
      arrange(h) {
        hold(h, cardRow(K1, 1), true)
        // Версія зросла читанням без лінивих полів: `notes` лишилось від v1.
        h.write((scope) => h.store.put(scope, listRow(K1, 2), h.now(), false))
      },
    },
    {
      name: "the version epoch switched since the row was read",
      arrange(h) {
        hold(h, listRow(K1, 1))
        h.write(() => h.session.acceptEpoch(EB, h.now()))
      },
    },
    {
      name: "the row is of another epoch and carries no mark",
      arrange(h) {
        h.write(() => h.session.acceptEpoch(EB, h.now()))
        // Рядок знімка іншої епохи без позначки: лише власна епоха рядка
        // не пускає його в `known`.
        h.write((scope) =>
          h.store.restore(
            scope,
            {
              key: K1,
              state: "row",
              row: listRow(K1, 1),
              scope: S,
              version: 1,
              versionEpoch: EA,
              lazyVersions: new Map(),
              lazyIn: new Map(),
              stale: false,
            },
            h.now()
          )
        )
        h.write((scope) => h.store.own(scope, K1))
      },
    },
    {
      name: "the reading view does not own the key",
      arrange(h) {
        hold(h, listRow(K1, 1))
        return { owned: new Set() }
      },
    },
  ]

  it.each(BROKEN)("leaves the key out when $name", (broken) => {
    const h = inEpoch()
    const arranged = broken.arrange(h)
    const owned = (arranged === undefined ? undefined : arranged.owned) ?? [K1]
    expect(
      h.store.knownFor([K1], {
        owned: new Set(owned),
        form: broken.form ?? "list",
      })
    ).toBeUndefined()
  })

  it("leaves everything out while the session has no version epoch", () => {
    const h = harness()
    hold(h, { ...listRow(K1, 1), versionEpoch: null })
    expect(h.store.knownFor([K1], list(K1))).toBeUndefined()
  })

  it("takes a card key whose lazy field was read with the row version", () => {
    const h = inEpoch()
    hold(h, cardRow(K1, 4), true)
    const snapshot = h.store.knownFor([K1], {
      owned: new Set([K1]),
      form: "card",
    })
    expect(snapshot?.known.keys).toEqual([K1])
  })

  it("lists a key once and skips the ones that do not qualify", () => {
    const h = inEpoch()
    hold(h, listRow(K1, 1))
    const snapshot = h.store.knownFor([K1, K2, K1], {
      owned: new Set([K1, K2]),
      form: "list",
    })
    expect(snapshot?.known.keys).toEqual([K1])
  })
})

describe("applyMarker", () => {
  it("confirms the held row as a row of its version, not writing other values", () => {
    const h = inEpoch()
    const at = hold(h, listRow(K1, 2))
    const snapshot = h.store.knownFor([K1], list(K1))!
    const result = h.write((scope) =>
      h.store.put(scope, markerOf(snapshot.held[0]!), at, false)
    )
    expect(result).toBe("written")
    expect(h.store.get(K1)?.row?.values).toEqual(listRow(K1, 2).values)
    expect(h.store.get(K1)?.version).toBe(2)
    expect(h.store.drainTail()).toEqual([])
  })

  it("lifts the minimal version mark of its own version, as a row of that version does", () => {
    const h = inEpoch()
    hold(h, listRow(K1, 2))
    const snapshot = h.store.knownFor([K1], list(K1))!
    // Сигнал про ту саму версію ще не підтверджену: позначка знімається читанням
    // після неї.
    h.write((scope) => h.store.markStale(scope, [K1], 2))
    expect(h.store.get(K1)?.stale.minVersion).toBeUndefined()
    const at = h.now()
    h.write((scope) =>
      h.store.put(scope, markerOf(snapshot.held[0]!), at, false)
    )
    expect(h.store.get(K1)?.stale.minVersion).toBeUndefined()
  })

  // І2: маркер не підтверджує рядок, що не тримає версії `v`.
  describe("writes nothing and queues the key for a re-read when the store does not hold version v", () => {
    it("a newer version came meanwhile (an own write-back)", () => {
      const h = inEpoch()
      const at = hold(h, listRow(K1, 1))
      const snapshot = h.store.knownFor([K1], list(K1))!
      h.write((scope) =>
        h.store.put(scope, listRow(K1, 2, "own"), h.now(), false)
      )
      const result = h.write((scope) =>
        h.store.put(scope, markerOf(snapshot.held[0]!), at, false)
      )
      expect(result).toBe("rejected")
      expect(h.store.get(K1)?.version).toBe(2)
      expect(h.store.get(K1)?.row?.values.title).toBe("own")
      expect(h.store.drainTail()).toEqual([K1])
    })

    it("the values of the same version differ (a row of someone else)", () => {
      const h = inEpoch()
      const at = hold(h, listRow(K1, 1))
      const snapshot = h.store.knownFor([K1], list(K1))!
      h.write((scope) =>
        h.store.put(scope, listRow(K1, 1, "other"), h.now(), false)
      )
      const result = h.write((scope) =>
        h.store.put(scope, markerOf(snapshot.held[0]!), at, false)
      )
      expect(result).toBe("rejected")
      expect(h.store.get(K1)?.row?.values.title).toBe("other")
      expect(h.store.drainTail()).toEqual([K1])
    })

    // Значення збігаються з тими, з яких збудовано `known`, тож відхилити
    // маркер може лише перевірка версії й епохи (`holdsMarked`).
    it.each([{ name: "a higher", version: 3 }])(
      "$name version of the same values: only the version check rejects",
      ({ version }) => {
        const h = inEpoch()
        const at = hold(h, listRow(K1, 2))
        const snapshot = h.store.knownFor([K1], list(K1))!
        h.write((scope) =>
          h.store.put(
            scope,
            { ...listRow(K1, 2), version, values: listRow(K1, 2).values },
            h.now(),
            false
          )
        )
        expect(h.store.get(K1)?.version).toBe(version)
        h.store.drainTail()
        const result = h.write((scope) =>
          h.store.put(scope, markerOf(snapshot.held[0]!), at, false)
        )
        expect(result).toBe("rejected")
        expect(h.store.get(K1)?.version).toBe(version)
        expect(h.store.drainTail()).toEqual([K1])
      }
    )

    it("another version epoch of the same version and values: only the epoch check rejects", () => {
      const h = inEpoch()
      const at = hold(h, listRow(K1, 2))
      const snapshot = h.store.knownFor([K1], list(K1))!
      h.write((scope) =>
        h.store.put(
          scope,
          { ...listRow(K1, 2), versionEpoch: EB },
          h.now(),
          false
        )
      )
      expect(h.store.get(K1)?.versionEpoch).toBe(EB)
      h.store.drainTail()
      const result = h.write((scope) =>
        h.store.put(scope, markerOf(snapshot.held[0]!), at, false)
      )
      expect(result).toBe("rejected")
      expect(h.store.get(K1)?.versionEpoch).toBe(EB)
      expect(h.store.drainTail()).toEqual([K1])
    })

    it("the store holds no such key: a marker never creates a row", () => {
      const h = inEpoch()
      const result = h.write((scope) =>
        h.store.put(scope, markerOf(listRow(K1, 1)), h.now(), false)
      )
      expect(result).toBe("rejected")
      expect(h.store.get(K1)).toBeUndefined()
    })
  })

  // І3: маркер не повертає значень, схованих новішою за старт позначкою.
  describe("returns no values that are hidden or gone", () => {
    it("a hide newer than the start of the read stays", () => {
      const h = inEpoch()
      const at = hold(h, listRow(K1, 1))
      const snapshot = h.store.knownFor([K1], list(K1))!
      h.write((scope) => h.store.hideKeys(scope, [K1]))
      h.store.drainTail()
      const result = h.write((scope) =>
        h.store.put(scope, markerOf(snapshot.held[0]!), at, false)
      )
      expect(result).toBe("rejected")
      expect(h.store.get(K1)?.stale.hidden).toBeDefined()
      expect(visibleRow(h.store.get(K1)!)).toBeUndefined()
      expect(h.store.drainTail()).toEqual([K1])
    })

    it("a row removed after the start stays removed", () => {
      const h = inEpoch()
      const at = hold(h, listRow(K1, 1))
      const snapshot = h.store.knownFor([K1], list(K1))!
      h.write((scope) => h.store.remove(scope, K1, h.now()))
      h.store.drainTail()
      const result = h.write((scope) =>
        h.store.put(scope, markerOf(snapshot.held[0]!), at, false)
      )
      expect(result).toBe("rejected")
      expect(h.store.get(K1)?.removed).toBeDefined()
      expect(visibleRow(h.store.get(K1)!)).toBeUndefined()
    })

    it("a key purged after the start is not brought back", () => {
      const h = inEpoch()
      const at = hold(h, listRow(K1, 1))
      const snapshot = h.store.knownFor([K1], list(K1))!
      h.write((scope) => h.store.purgeKeys(scope, [K1]))
      const result = h.write((scope) =>
        h.store.put(scope, markerOf(snapshot.held[0]!), at, false)
      )
      expect(result).toBe("rejected")
      expect(h.store.get(K1)).toBeUndefined()
    })
  })
})

/** Complete rows of the default test object: every column of the list read. */
const fullValues = (n: number) => taskValues(n, { status: null, subject: null })

/** The wire answer of a read, with its markers counted. */
function markersOnly(entry: FakeReadLog): boolean {
  const rows = (entry.response as { rows: unknown[] }).rows
  return rows.every(
    (row) =>
      typeof row === "number" ||
      (typeof row === "object" && row !== null && "$known" in row)
  )
}

/** The key positions an own page of the re-read answered, to total copies. */
const copiesBytes = (fake: FakeSource, keys: readonly Key[]) =>
  keys.reduce(
    (sum, k) =>
      sum +
      jsonBytes({
        key: k,
        version: fake.row(TASK, k)!.version,
        copies: { title: fake.row(TASK, k)!.values.title },
      }),
    0
  )

// Об'єкт з копією носія: колонка `title` змінюється без підвищення версії,
// тож маркер несе її поточною.
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

const ROWS = 12
const SPECS: readonly { name: string; spec: ViewSpec }[] = [
  { name: "window", spec: { kind: "window", object: TASK } },
  { name: "full", spec: { kind: "full", object: TASK } },
]

describe.each(OBJECT_SETS)("system re-read of own rows, $name", (set) => {
  it.each(SPECS)(
    "an unchanged $name comes back as markers within the budget",
    async ({ spec }) => {
      const { core, fake, inspect } = setup({ objects: set.objects })
      fake.epoch = EA
      for (let n = 1; n <= ROWS; n++) fake.insert(TASK, fullValues(n))
      const handle = core.view(spec)
      watch(handle)
      await settle()
      const before = handle.getSnapshot().rows.map((r) => r.key)
      expect(before).toHaveLength(ROWS)
      const shown = JSON.stringify(handle.getSnapshot().rows)
      const from = fake.log.length

      await core.revalidate(TASK, { visibleOnly: false })
      await settle()

      const reads = fake.log.slice(from)
      // Один запит, одна частина-сторінка, без читань за ключем.
      expect(reads.filter(isPage)).toHaveLength(1)
      expect(reads.filter((r) => keysOf(r.query).length > 0)).toHaveLength(0)
      const page = reads.find(isPage)!
      expect(page.known?.keys).toHaveLength(ROWS)
      expect(markersOnly(page)).toBe(true)
      // Відповідь: 8 Б на рядок і 2 КіБ; з копіями — ще їхні значення.
      const copies = set.copies ? copiesBytes(fake, before) : 0
      expect(jsonBytes(page.response)).toBeLessThanOrEqual(
        8 * ROWS + 2048 + copies
      )
      // Тіло: межа §12 за кодеком (`bodyBound`), не оцінка «64 Б на ключ».
      expect(
        jsonBytes({ ...page.wire, known: page.known })
      ).toBeLessThanOrEqual(bodyBound(fake, [page], false))
      expect(JSON.stringify(handle.getSnapshot().rows)).toBe(shown)
      expect(inspect.violations()).toEqual([])
    }
  )
})

describe("a marker on a row that changed between the start and the answer", () => {
  it("writes nothing and re-reads the key by key without known", async () => {
    const { core, fake, inspect } = setup()
    fake.epoch = EA
    for (let n = 1; n <= 3; n++) fake.insert(TASK, fullValues(n))
    const handle = core.view({ kind: "window", object: TASK })
    watch(handle)
    await settle()
    const card = core.view({ kind: "card", object: TASK, key: key(2) })
    watch(card)
    await settle()

    // Перечитування вікна тримається: його `known` — рядок у версії v1.
    fake.hold = (read) => read.log.known !== undefined && isPage(read.log)
    const stale = core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const held = fake.take()
    // Тим часом сховище отримує v2 (читання картки), а перечитування вікна
    // відповідає знімком сервера на мить свого старту — маркером v1.
    fake.hold = undefined
    fake.edit(TASK, key(2), { title: "newer" })
    await core.revalidate(TASK, { visibleOnly: false })
    const readsBefore = fake.log.length
    held.answer(held.issuedAt)
    await stale
    await settle()

    const row = handle.getSnapshot().rows.find((r) => r.key === key(2))!
    expect(row.state === "removed" ? undefined : row.values.title).toBe("newer")
    // Ключ перечитано за ключем без `known`.
    const byKey = fake.log
      .slice(readsBefore)
      .filter((r) => keysOf(r.query).length > 0)
    expect(byKey.length).toBeGreaterThan(0)
    expect(byKey.every((r) => r.known === undefined)).toBe(true)
    expect(inspect.violations()).toEqual([])
  })
})

describe("copies of a carrier carried by a partial marker", () => {
  const objects = [withCopy(catalogEntry()), org]
  const EPOCH_READ = 1_000_000_000

  /** Holds the rows, then makes the client's copy of `title` differ from the server's. */
  async function heldWithOldCopy(extraViews: readonly ViewSpec[] = []) {
    const h = setup({ objects })
    h.fake.epoch = EA
    for (let n = 1; n <= 3; n++) h.fake.insert(TASK, fullValues(n))
    const handles = [{ kind: "window", object: TASK } as ViewSpec]
      .concat(extraViews)
      .map((spec) => h.core.view(spec))
    for (const handle of handles) watch(handle)
    await settle()
    const server = h.fake.row(TASK, key(2))!
    // Той самий рядок тієї самої версії зі старою копією: версія не зросла.
    h.core.commit(
      (w) =>
        w.apply(
          TASK,
          {
            rows: [
              {
                ...server,
                versionEpoch: EA,
                values: { ...server.values, title: "old" },
              },
            ],
            absent: [],
          },
          EPOCH_READ,
          EA
        ),
      h.core.token()
    )
    return { ...h, handles, server }
  }

  const titleOf = (handle: { getSnapshot(): ViewSnapshot }, k: Key) => {
    const row = handle.getSnapshot().rows.find((r) => r.key === k)!
    return row.state === "removed" ? undefined : row.values.title
  }

  it("writes the copy of the marker into the held row", async () => {
    const { core, fake, handles, server } = await heldWithOldCopy()
    expect(titleOf(handles[0]!, key(2))).toBe("old")
    const from = fake.log.length
    await core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const page = fake.log.slice(from).find(isPage)!
    // Частковий маркер на передачі: `$known` і колонка копії, без колонки
    // ключа (за нею рядок відрізняють від маркера).
    const wire = (page.response as { rows: Record<string, unknown>[] }).rows
    const markers = wire.filter(
      (row) => typeof row === "object" && row !== null && "$known" in row
    )
    expect(markers.length).toBeGreaterThan(0)
    for (const marker of markers) {
      expect(marker).not.toHaveProperty(objects[0]!.key)
      expect(marker).toHaveProperty("title")
    }
    // Маркер ключа з розійшлою копією несе її серверне значення.
    expect(markers).toContainEqual(
      expect.objectContaining({ title: server.values.title })
    )
    expect(titleOf(handles[0]!, key(2))).toBe(server.values.title)
  })

  it("re-reads two views of one carrier key in one request, though the copy changed", async () => {
    const { core, fake, handles, server } = await heldWithOldCopy([
      { kind: "keys", object: TASK, keys: [key(2)] },
    ])
    const requests = fake.requests.length
    await core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(fake.requests.length).toBe(requests + 1)
    for (const handle of handles) {
      expect(titleOf(handle, key(2))).toBe(server.values.title)
    }
  })
})
