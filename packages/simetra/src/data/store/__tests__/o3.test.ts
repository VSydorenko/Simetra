import { describe, expect, it } from "vitest"
import { REJOIN_JITTER_MS } from "../receiver"
import type { RowState } from "../types"
import {
  assertEvaluated,
  changeBound,
  checkpoints,
  createO3,
  judgeRows,
  judgeSection,
  lastBound,
  noEventBound,
  viewBound,
  type O3Input,
  type O3State,
  type O3View,
} from "./o3"

/*
 * Самотести О3: оракул, що мовчить, коли показ не збігається з сервером, — не
 * оракул. Входи складено у чистій функції, без ядра й транспорту.
 */

const OBJECT = "Catalog.Task"
const INTERVAL = 2_000

const view = (
  over: Partial<O3View> & { stale?: boolean; state?: O3State } = {}
): O3View => ({
  id: 1,
  objects: [OBJECT],
  state: over.state ?? "live",
  truth: over.truth ?? (() => (over.stale === false ? undefined : "stale row")),
  ...(over.id === undefined ? {} : { id: over.id }),
})

const input = (over: Partial<O3Input> = {}): O3Input => ({
  now: 0,
  phaseStart: 0,
  intervalMs: INTERVAL,
  changes: [{ object: OBJECT, at: 0 }],
  joins: [],
  views: [view()],
  ...over,
})

describe("O3 self-check", () => {
  it("is red when the server changed a row after the last read and no channel told the client", () => {
    const o3 = createO3()
    // Межа зміни без події каналу — початок фази плюс два інтервали.
    const at = noEventBound(input())
    expect(at).toBe(2 * INTERVAL)
    expect(o3.step(input({ now: at }))).toMatch(/stale row/)
  })

  it("is green before the bound: the client may not know yet", () => {
    const o3 = createO3()
    expect(o3.step(input({ now: noEventBound(input()) - 1 }))).toBeUndefined()
    expect(o3.evaluated()).toBe(0)
  })

  it("is green when the view shows the server's truth past the bound", () => {
    const o3 = createO3()
    expect(
      o3.step(
        input({ now: noEventBound(input()), views: [view({ stale: false })] })
      )
    ).toBeUndefined()
    expect(o3.evaluated()).toBe(1)
  })

  it("is red when the counter of evaluated views is zero", () => {
    const o3 = createO3()
    expect(o3.step(input({ views: [] }))).toBeUndefined()
    expect(() => assertEvaluated(o3.evaluated(), "self-check")).toThrow(
      /evaluated no view/
    )
    expect(() => assertEvaluated(1, "self-check")).not.toThrow()
  })

  describe("the bound comes from the cause of the change", () => {
    // Приєднання після зміни: хвиля читає не пізніше джитера від приєднання.
    const joined = (at: number, phaseStart = 0) =>
      input({
        phaseStart,
        // Інтервал набагато більший за джитер: такт хвилю не підміняє.
        intervalMs: 600_000,
        changes: [{ object: OBJECT, at: phaseStart - 100 }],
        joins: [{ object: OBJECT, at }],
      })

    it("takes the bound from the join, not the interval", () => {
      const i = joined(500)
      expect(changeBound(i.changes[0]!, i)).toBe(500 + REJOIN_JITTER_MS)
      expect(viewBound(view(), i)).toBe(500 + REJOIN_JITTER_MS)
      expect(checkpoints(i)).toEqual([500 + REJOIN_JITTER_MS])
      expect(lastBound(i)).toBe(500 + REJOIN_JITTER_MS)
    })

    it("is red when the wave did not read: the row stays old at the join bound", () => {
      const i = joined(500)
      const o3 = createO3()
      expect(o3.step({ ...i, now: 500 + REJOIN_JITTER_MS - 1 })).toBeUndefined()
      expect(o3.step({ ...i, now: 500 + REJOIN_JITTER_MS })).toMatch(
        /past its bound/
      )
    })

    it("a join of another object does not shorten the bound", () => {
      const i = {
        ...joined(500),
        joins: [{ object: "Catalog.Organization" as const, at: 500 }],
      }
      expect(changeBound(i.changes[0]!, i)).toBe(noEventBound(i))
    })

    it("a join before the change does not cover it", () => {
      const i = {
        ...joined(500),
        changes: [{ object: OBJECT, at: 600 }],
      }
      expect(changeBound(i.changes[0]!, i)).toBe(noEventBound(i))
    })

    it("a wave that was due before the phase does not shorten the bound", () => {
      // Читання тієї хвилі могла відповісти стара репліка: лише такт виправляє.
      const i = { ...joined(500, 3_000), joins: [{ object: OBJECT, at: 500 }] }
      expect(changeBound(i.changes[0]!, i)).toBe(noEventBound(i))
    })

    it("a later change without an event takes the interval bound back", () => {
      const i = {
        ...joined(500),
        changes: [
          { object: OBJECT, at: 0 },
          { object: OBJECT, at: 3_000 },
        ],
      }
      expect(viewBound(view(), i)).toBe(noEventBound(i))
    })
  })

  describe("named states hold the display, anything else is judged", () => {
    const states: readonly O3State[] = [
      "first-load-error",
      "discard-bound",
      "stale-object",
      "purged",
      "card-without-duty",
      "section-owner-removed",
    ]
    for (const state of states) {
      it(`${state}: green with a wrong display, red once the state is gone`, () => {
        const at = noEventBound(input())
        const held = createO3()
        expect(
          held.step(input({ now: at, views: [view({ state })] }))
        ).toBeUndefined()
        expect(held.skipped(state)).toBe(1)
        expect(held.evaluated()).toBe(0)
        // Мутація: той самий показ без названого стану — червоний.
        expect(createO3().step(input({ now: at }))).toMatch(/stale row/)
      })
    }
  })

  describe("an own unfinished mutation is a boundary of the display, not an exception", () => {
    const rows = (state: RowState) => [
      { state, mismatch: () => "row differs from the server" as const },
    ]

    it("is green while the own change is pending, failed, conflicting or unknown", () => {
      for (const state of ["pending", "failed", "conflict", "unknown"] as const)
        expect(judgeRows(rows(state))).toBeUndefined()
    })

    it("judges the row again once the own change ends: red after the bound, green before", () => {
      // Мутація закінчилась у мить 3 000: зміна для О3 від цієї миті.
      const ended = input({
        phaseStart: 3_000,
        changes: [{ object: OBJECT, at: 3_000 }],
      })
      const o3 = createO3()
      const display = (state: RowState) =>
        view({
          truth: () => judgeRows(rows(state)),
        })
      const at = noEventBound(ended)
      // Ще незавершена: зелений навіть за межею.
      expect(
        o3.step({ ...ended, now: at, views: [display("pending")] })
      ).toBeUndefined()
      // Завершена, сервер інший: до межі зелений, за межею червоний.
      expect(
        o3.step({ ...ended, now: at - 1, views: [display("synced")] })
      ).toBeUndefined()
      expect(
        o3.step({ ...ended, now: at, views: [display("synced")] })
      ).toMatch(/row differs/)
    })
  })

  describe("the section over a hidden owner is judged by the data", () => {
    const shown = (over: Partial<Parameters<typeof judgeSection>[1]> = {}) => ({
      ownerState: "synced" as RowState,
      ownerVersion: undefined,
      lines: [] as unknown[],
      ...over,
    })
    const hidden = { ownerVersion: undefined, lines: [] as unknown[] }

    it("is green with no rows, whatever the owner mark says", () => {
      expect(judgeSection(hidden, shown())).toBeUndefined()
      expect(
        judgeSection(hidden, shown({ ownerState: "removed" }))
      ).toBeUndefined()
    })

    it("is red when the section shows rows the server does not give", () => {
      expect(judgeSection(hidden, shown({ lines: [1] }))).toMatch(
        /no owner, section shows 1 lines/
      )
    })

    it("is red for an old owner version or old lines of a live owner", () => {
      const live = { ownerVersion: 5, lines: [1, 2] }
      expect(
        judgeSection(live, shown({ ownerVersion: 4, lines: [1, 2] }))
      ).toMatch(/owner version/)
      expect(
        judgeSection(live, shown({ ownerVersion: 5, lines: [1] }))
      ).toMatch(/lines/)
      expect(
        judgeSection(live, shown({ ownerVersion: 5, lines: [1, 2] }))
      ).toBeUndefined()
    })

    it("an own change on the owner is a boundary", () => {
      expect(
        judgeSection(hidden, shown({ ownerState: "conflict", lines: [1] }))
      ).toBeUndefined()
    })
  })
})
