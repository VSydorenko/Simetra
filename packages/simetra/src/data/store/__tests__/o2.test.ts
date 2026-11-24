import { describe, expect, it } from "vitest"
import type { AttemptEvent } from "../attempts"
import type { SyncState, SyncTarget } from "../core"
import { createFakeSource } from "../testing/fake-source"
import { OBJECTS } from "./core-support"
import { assertEvaluated, createO2, O2_EXCEPTIONS, type O2Input } from "./o2"
import type { StampedEvent } from "./oracles"

/*
 * Самотести О2: оракул, що мовчить, коли порушення є, — не оракул. Входи
 * складено у чистій функції, без ядра й транспорту.
 */

const OBJECT = "Catalog.Task"
const fake = createFakeSource({ objects: OBJECTS })

const view = (id: number): SyncTarget => ({
  kind: "view",
  object: OBJECT,
  spec: { kind: "full", object: OBJECT },
  id,
})
const rights: SyncTarget = { kind: "service", service: "rights" }

const state = (target: SyncTarget, extra: Partial<SyncState> = {}): SyncState =>
  ({
    target,
    requirements: [],
    flights: [],
    queued: [],
    ...extra,
  }) as SyncState

// Службова ціль живе, поки живе ядро: перелік без цілей — закрите ядро, у якого
// зникають усі вимоги разом.
const alive = [state({ kind: "service", service: "version" })]

const composition = { kind: "composition-unconfirmed" } as const

const read = (id: number, journal: number, attempt?: number): StampedEvent =>
  ({
    reason: "requirement",
    requirement: "composition-unconfirmed",
    target: { kind: "view", object: OBJECT, id },
    site: "R1",
    attempt,
    request: journal + 1,
    at: 0,
    journal,
  }) as StampedEvent

const settled = (
  attempt: number,
  id: number,
  kind: "load" | "reread" | "page"
): AttemptEvent[] => [
  {
    phase: "started",
    attempt,
    kind,
    target: { kind: "view", object: OBJECT, id },
    reason: "mount",
    site: "M1",
  } as AttemptEvent,
  {
    phase: "settled",
    attempt,
    kind,
    target: { kind: "view", object: OBJECT, id },
    outcome: "applied",
  },
]

const input = (over: Partial<O2Input>): O2Input => ({
  now: 0,
  states: [],
  events: [],
  attempts: [],
  fake,
  ...over,
})

describe("O2 self-check", () => {
  it("is red for a requirement without a promise or a condition", () => {
    const o2 = createO2()
    const problem = o2.step(
      input({ states: [state(view(1), { requirements: [composition] })] })
    )
    expect(problem).toMatch(/no promise and no condition/)
  })

  it("is green for a named condition and a refusal", () => {
    const o2 = createO2()
    expect(
      o2.step(
        input({
          states: [
            state(view(1), {
              requirements: [composition],
              deferral: "tab-hidden",
            }),
            state(view(2), {
              requirements: [composition],
              refusal: "stale-object",
            }),
          ],
        })
      )
    ).toBeUndefined()
    expect(o2.evaluated()).toBe(1)
  })

  it("is red for `promised` with no flight, queue or deadline behind it", () => {
    const o2 = createO2()
    expect(
      o2.step(
        input({
          states: [
            state(view(1), {
              requirements: [composition],
              deferral: "promised",
            }),
          ],
        })
      )
    ).toMatch(/promised, but no flight/)
  })

  it("is red for a flight with no unanswered request in a quiet state", () => {
    const o2 = createO2()
    expect(
      o2.step(
        input({
          states: [state(view(1), { flights: [{ kind: "reread" }] })],
        })
      )
    ).toMatch(/flight with no unanswered request/)
  })

  it("is red when the counter of evaluated states is zero", () => {
    const o2 = createO2()
    // Спокій без вимог нічого не оцінює.
    expect(o2.step(input({ states: [state(view(1))] }))).toBeUndefined()
    expect(o2.evaluated()).toBe(0)
    expect(() => assertEvaluated(o2.evaluated(), "self-check")).toThrow(
      /evaluated no idle state/
    )
  })

  it("keeps a deadline: a read by the due, or red", () => {
    const states = [state(view(1), { requirements: [composition], due: 1_000 })]
    const red = createO2()
    expect(red.step(input({ now: 0, states }))).toBeUndefined()
    expect(red.step(input({ now: 1_000, states }))).toMatch(
      /no read by its deadline/
    )

    const green = createO2()
    expect(green.step(input({ now: 0, states }))).toBeUndefined()
    expect(
      green.step(input({ now: 1_000, states, events: [read(1, 0)] }))
    ).toBeUndefined()
    // Читання іншої цілі строку цієї не виконує.
    const other = createO2()
    other.step(input({ now: 0, states }))
    expect(
      other.step(input({ now: 1_000, states, events: [read(2, 0)] }))
    ).toMatch(/no read by its deadline/)
  })

  it("keeps a queue: the queued read starts, or red", () => {
    const states = [
      state(view(1), {
        requirements: [composition],
        queued: [{ kind: "reread" }],
      }),
    ]
    const red = createO2()
    red.step(input({ states }))
    expect(red.step(input({ states, now: 10 }))).toMatch(
      /queued read never started/
    )
    const green = createO2()
    green.step(input({ states }))
    expect(
      green.step(input({ states, now: 10, events: [read(1, 0)] }))
    ).toBeUndefined()
  })

  describe("a requirement disappears only with proof of its kind", () => {
    const before = [state(view(1), { requirements: [composition], due: 5 })]
    const gone = [...alive, state(view(1))]
    const after = (events: StampedEvent[], attempts: AttemptEvent[]) => {
      const o2 = createO2()
      o2.step(input({ states: before }))
      return o2.step(input({ now: 5, states: gone, events, attempts }))
    }

    it("is red with no read at all", () => {
      expect(after([], [])).toMatch(/disappeared with no proof/)
    })

    it("is red with a page of the same view: a page confirms only itself", () => {
      expect(after([read(1, 0, 7)], settled(7, 1, "page"))).toMatch(
        /disappeared with no proof/
      )
    })

    it("is red with a read of another view (a page drops a foreign requirement)", () => {
      expect(after([read(2, 0, 7)], settled(7, 2, "reread"))).toMatch(
        /disappeared with no proof/
      )
    })

    it("is green with an applied re-read of the view", () => {
      expect(after([read(1, 0, 7)], settled(7, 1, "reread"))).toBeUndefined()
    })

    it("is green when the rejoin of an unread view becomes its composition requirement", () => {
      const o2 = createO2()
      o2.step(
        input({
          states: [
            state(view(1), {
              requirements: [{ kind: "channel-rejoin" }],
              deferral: "target-invisible",
            }),
          ],
        })
      )
      expect(
        o2.step(
          input({
            now: 5,
            states: [
              state(view(1), {
                requirements: [composition],
                deferral: "target-invisible",
              }),
            ],
          })
        )
      ).toBeUndefined()
    })

    it("is green when the target goes away with the requirement", () => {
      const o2 = createO2()
      o2.step(input({ states: before }))
      expect(o2.step(input({ now: 5, states: alive }))).toBeUndefined()
    })

    it("is red for a row requirement that vanishes with no answer carrying the row", () => {
      const row: SyncTarget = { kind: "row", object: OBJECT, key: "k" }
      const o2 = createO2()
      o2.step(
        input({
          states: [
            state(row, { requirements: [{ kind: "value-hidden" }], due: 5 }),
          ],
        })
      )
      const stored = input({ now: 5, states: alive, rowAlive: () => true })
      expect(o2.step(stored)).toMatch(/disappeared with no proof/)
      const gone = createO2()
      gone.step(
        input({
          states: [
            state(row, { requirements: [{ kind: "value-hidden" }], due: 5 }),
          ],
        })
      )
      expect(
        gone.step(input({ now: 5, states: alive, rowAlive: () => false }))
      ).toBeUndefined()
    })
  })

  describe("exceptions come only from the table of the gaps of main", () => {
    it("excuses the rights snapshot only while the store has no rows", () => {
      const states = [
        state(rights, { requirements: [{ kind: "rights-unconfirmed" }] }),
      ]
      expect(
        createO2().step(input({ states, storeEmpty: true }))
      ).toBeUndefined()
      expect(createO2().step(input({ states, storeEmpty: false }))).toMatch(
        /no promise and no condition/
      )
    })

    it("names a row of the table for every exception", () => {
      for (const exception of O2_EXCEPTIONS)
        expect(exception.rows.every((n) => [3, 4, 5, 6, 12].includes(n))).toBe(
          true
        )
    })
  })
})
