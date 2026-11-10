import { describe, expect, it } from "vitest"
import { keyId } from "../epoch"
import { mergeVersioned } from "../object-store"
import { sectionLinesStale } from "../section-store"
import { computeRowView } from "../snapshot"
import type { ServerRow } from "../types"
import { harness, K1, OBJECT, row, S, type Harness } from "./store-support"

const EA = "a".repeat(64)
const EB = "b".repeat(64)

const inEpoch = (
  r: ReturnType<typeof row>,
  versionEpoch: string | null
): ServerRow => ({ ...r, versionEpoch })

const put = (h: Harness, r: ServerRow, lazyRead = false) =>
  h.write((s) => h.store.put(s, r, h.now(), lazyRead))

const putLines = (
  h: Harness,
  ownerVersion: number,
  versionEpoch: string | null
) =>
  h.write((s) =>
    h.sections.put(
      s,
      K1,
      "lines",
      [{ key: "00000000-0000-4000-8000-0000000000c1", values: { qty: 1 } }],
      ownerVersion,
      versionEpoch,
      h.now(),
      S,
      "owner-section"
    )
  )

const remember = (h: Harness, r: ServerRow) => {
  put(h, r)
  h.write((s) => h.store.own(s, K1))
  h.write((s) => h.store.disown(s, K1))
}

const seenOf = (h: Harness) => h.session.epochs.seen(keyId(OBJECT, K1))

// Перемикання з A (перша непорожня епоха — без перемикання) на B.
const switchToB = (h: Harness) => {
  h.write(() => h.session.acceptEpoch(EA, h.now()))
  h.write(() => h.session.acceptEpoch(EB, h.now()))
}

// Кожен шлях запису епохи в стан сховища (P4-B план B1c, Р5, Р6): відповідь
// з `null` після епохи A лишає A, тож наступна відповідь епохи B з меншою
// версією або заміняє запис (рядок, `ownerVersions`), або робить старі дані
// `stale` (рядки ТЧ, ліниве поле). Стерта A дала б порівняння версій різних
// епох — і B з меншою версією відкинуто чи показано свіжим.
const PATHS: { path: string; check: () => void }[] = [
  {
    path: "mergeVersioned",
    check: () => {
      const held = mergeVersioned(
        inEpoch(row(K1, 5), EA),
        inEpoch(row(K1, 6), null)
      )
      expect(held?.versionEpoch).toBe(EA)
      expect(mergeVersioned(held, inEpoch(row(K1, 1), EB))).toMatchObject({
        version: 1,
        versionEpoch: EB,
      })
    },
  },
  {
    path: "row put",
    check: () => {
      const h = harness()
      put(h, inEpoch(row(K1, 5), EA))
      expect(put(h, inEpoch(row(K1, 6), null))).toBe("written")
      expect(h.store.get(K1)).toMatchObject({
        versionEpoch: EA,
        row: { versionEpoch: EA },
      })
      expect(put(h, inEpoch(row(K1, 1), EB))).toBe("written")
      expect(h.store.get(K1)).toMatchObject({ version: 1, versionEpoch: EB })
    },
  },
  {
    path: "removed restore",
    check: () => {
      const h = harness()
      put(h, inEpoch(row(K1, 5), EA))
      h.write((s) => h.store.remove(s, K1, h.now()))
      expect(put(h, inEpoch(row(K1, 6), null))).toBe("written")
      expect(h.store.get(K1)).toMatchObject({
        versionEpoch: EA,
        row: { versionEpoch: EA },
      })
      expect(put(h, inEpoch(row(K1, 1), EB))).toBe("written")
      expect(h.store.get(K1)).toMatchObject({ version: 1, versionEpoch: EB })
    },
  },
  {
    path: "section put",
    check: () => {
      const h = harness()
      put(h, inEpoch(row(K1, 5), EA))
      expect(putLines(h, 5, null)).toBe("written")
      expect(h.sections.get(K1, "lines")?.versionEpoch).toBe(EA)
      put(h, inEpoch(row(K1, 1), EB))
      expect(
        sectionLinesStale(h.sections.get(K1, "lines")!, h.store.get(K1)!)
      ).toBe(true)
    },
  },
  {
    // Тримана епоха — спершу запис власника, а не шапка: шапка вже EB, а
    // `null`-рядки не доводять, що вони з EB, тож лишаються EA і `stale`.
    path: "section put after a header switch",
    check: () => {
      const h = harness()
      expect(putLines(h, 5, EA)).toBe("written")
      put(h, inEpoch(row(K1, 1), EB))
      expect(putLines(h, 6, null)).toBe("written")
      expect(h.sections.get(K1, "lines")?.versionEpoch).toBe(EA)
      expect(
        sectionLinesStale(h.sections.get(K1, "lines")!, h.store.get(K1)!)
      ).toBe(true)
    },
  },
  {
    // Гілка навмисного дефекту теж пише рядок у стан — і теж через правило.
    path: "version-decrease fault branch",
    check: () => {
      const h = harness({ defects: new Set(["version-decrease"]) })
      put(h, inEpoch(row(K1, 5), EA))
      expect(put(h, inEpoch(row(K1, 3), null))).toBe("written")
      expect(h.store.get(K1)).toMatchObject({
        version: 3,
        versionEpoch: EA,
        row: { versionEpoch: EA },
      })
    },
  },
  {
    path: "ownerVersions",
    check: () => {
      const h = harness()
      expect(putLines(h, 5, EA)).toBe("written")
      expect(putLines(h, 6, null)).toBe("written")
      expect(putLines(h, 1, EB)).toBe("written")
      expect(h.sections.get(K1, "lines")).toMatchObject({
        ownerVersion: 1,
        versionEpoch: EB,
      })
    },
  },
  {
    path: "version memory",
    check: () => {
      const h = harness()
      h.session.epochs.remember(keyId(OBJECT, K1), 5, EA)
      h.session.epochs.remember(keyId(OBJECT, K1), 6, null)
      expect(seenOf(h)).toMatchObject({ version: 6, versionEpoch: EA })
      h.session.epochs.remember(keyId(OBJECT, K1), 1, EB)
      expect(seenOf(h)).toMatchObject({ version: 1, versionEpoch: EB })
    },
  },
  {
    // Новий слот бере епоху пам'яті версій, а не лише відповіді.
    path: "insert of a remembered key",
    check: () => {
      const h = harness()
      remember(h, inEpoch(row(K1, 5), EA))
      expect(put(h, inEpoch(row(K1, 6), null))).toBe("written")
      expect(h.store.get(K1)).toMatchObject({
        versionEpoch: EA,
        row: { versionEpoch: EA },
      })
      expect(put(h, inEpoch(row(K1, 1), EB))).toBe("written")
      expect(h.store.get(K1)).toMatchObject({ version: 1, versionEpoch: EB })
    },
  },
  {
    path: "stale.minVersion",
    check: () => {
      const h = harness()
      remember(h, inEpoch(row(K1, 5), EA))
      put(h, inEpoch(row(K1, 3), null))
      expect(h.store.get(K1)?.stale.minVersion).toMatchObject({
        v: 5,
        versionEpoch: EA,
      })
      put(h, inEpoch(row(K1, 1), EB))
      expect(h.store.get(K1)?.stale.minVersion).toBeUndefined()
      expect(computeRowView(K1, h.store.get(K1)!, [], undefined)).toMatchObject(
        { version: 1, state: "synced" }
      )
    },
  },
  {
    // Рядок без епохи до перемикання належить покинутій (Р5, Р6).
    path: "switch: row",
    check: () => {
      const h = harness()
      put(h, inEpoch(row(K1, 5), null))
      switchToB(h)
      expect(h.store.get(K1)).toMatchObject({
        versionEpoch: EA,
        row: { versionEpoch: EA },
      })
      expect(put(h, inEpoch(row(K1, 1), EB))).toBe("written")
      expect(h.store.get(K1)).toMatchObject({ version: 1, versionEpoch: EB })
    },
  },
  {
    path: "switch: lazy field",
    check: () => {
      const h = harness()
      put(h, inEpoch(row(K1, 5, { notes: "n" }), null), true)
      switchToB(h)
      expect(h.store.get(K1)?.lazyEpochs.get("notes")).toBe(EA)
      put(h, inEpoch(row(K1, 6), EB))
      const view = computeRowView(K1, h.store.get(K1)!, ["notes"], undefined)
      expect(view).toMatchObject({ version: 6, staleFields: ["notes"] })
    },
  },
  {
    path: "switch: section lines and ownerVersions",
    check: () => {
      const h = harness()
      expect(putLines(h, 5, null)).toBe("written")
      switchToB(h)
      expect(h.sections.get(K1, "lines")?.versionEpoch).toBe(EA)
      expect(putLines(h, 1, EB)).toBe("written")
      expect(h.sections.get(K1, "lines")).toMatchObject({
        ownerVersion: 1,
        versionEpoch: EB,
      })
    },
  },
  {
    path: "switch: version memory",
    check: () => {
      const h = harness()
      remember(h, inEpoch(row(K1, 5), null))
      switchToB(h)
      expect(seenOf(h)).toMatchObject({ version: 5, versionEpoch: EA })
      put(h, inEpoch(row(K1, 1), EB))
      expect(h.store.get(K1)?.stale.minVersion).toBeUndefined()
    },
  },
  {
    path: "lazy field",
    check: () => {
      const h = harness()
      put(h, inEpoch(row(K1, 5, { notes: "n" }), EA), true)
      put(h, inEpoch(row(K1, 6, { notes: "m" }), null), true)
      expect(h.store.get(K1)?.lazyEpochs.get("notes")).toBe(EA)
      put(h, inEpoch(row(K1, 1), EB))
      const view = computeRowView(K1, h.store.get(K1)!, ["notes"], undefined)
      expect(view).toMatchObject({ version: 1, staleFields: ["notes"] })
    },
  },
]

describe("epoch writes into store state (B1c Р5, Р6)", () => {
  it.each(PATHS)(
    "$path: a null answer after EA keeps EA; EB with a lower version then wins",
    ({ check }) => check()
  )
})
