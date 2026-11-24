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

// Вигляди тестів уже застосували читання: інакше їх покриває виняток вигляду,
// що ще не завантажувся.
const loaded = [1, 2].flatMap((id) => settled(100 + id, id, "load"))

const input = (over: Partial<O2Input>): O2Input => ({
  now: 0,
  states: [],
  events: [],
  attempts: loaded,
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

  describe("a load flight in the pause after a discarded answer", () => {
    // Політ завантаження живе й у паузі повтору (M8): запиту немає, подія
    // «осіло: відкинуто за епохою» остання.
    const discarded = (): AttemptEvent[] => [
      ...settled(7, 1, "load").slice(0, 1),
      {
        phase: "settled",
        attempt: 7,
        kind: "load",
        target: { kind: "view", object: OBJECT, id: 1 },
        outcome: "discarded-by-epoch",
      },
    ]
    const flying = [state(view(1), { flights: [{ kind: "load" }] })]

    it("is green inside the pause and red when the pause is overstayed", () => {
      const o2 = createO2()
      const attempts = discarded()
      expect(o2.step(input({ states: flying, attempts }))).toBeUndefined()
      expect(
        o2.step(input({ now: 1_000, states: flying, attempts }))
      ).toBeUndefined()
      expect(
        o2.step(input({ now: 600_000, states: flying, attempts }))
      ).toMatch(/stays after a discarded answer/)
    })

    it("is red when the last attempt was applied, not discarded", () => {
      expect(
        createO2().step(
          input({ states: flying, attempts: settled(7, 1, "load") })
        )
      ).toMatch(/no unanswered request/)
    })
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
      return o2.step(
        input({
          now: 5,
          states: gone,
          events,
          attempts: [...loaded, ...attempts],
        })
      )
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

    // Хвиля, що не читає невидимий вигляд, лише ставить «склад не
    // підтверджено»: заміна не старша за те, що стояло до неї.
    const rejoin = (epoch: number | undefined, before = 5) => {
      const o2 = createO2()
      o2.step(
        input({
          states: [
            state(view(1), {
              requirements: [{ kind: "channel-rejoin", epoch: before }],
              deferral: "target-invisible",
            }),
          ],
        })
      )
      return o2.step(
        input({
          now: 5,
          states: [
            state(view(1), {
              requirements: [
                {
                  kind: "composition-unconfirmed",
                  ...(epoch === undefined ? {} : { epoch }),
                },
              ],
              deferral: "target-invisible",
            }),
          ],
        })
      )
    }

    it("is green when the rejoin of an unread view becomes its composition requirement", () => {
      expect(rejoin(6)).toBeUndefined()
    })

    it("is red when the replacing requirement has an earlier epoch or none", () => {
      expect(rejoin(3)).toMatch(/earlier epoch/)
      expect(rejoin(undefined)).toMatch(/earlier epoch/)
    })

    it("is green when the target shows a refusal: nothing is read, nothing is required", () => {
      const o2 = createO2()
      o2.step(input({ states: before }))
      expect(
        o2.step(
          input({
            now: 5,
            states: [...alive, state(view(1), { refusal: "discard-bound" })],
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

    it("excuses a composition requirement of rows 3 and 5 by the holder, with a bound", () => {
      const states = [state(view(1), { requirements: [composition] })]
      const base = { states, revalidateMs: 1_000 }
      // Без видимого тримача — названий стан.
      expect(
        createO2().step(input({ ...base, holderVisible: () => false }))
      ).toBeUndefined()
      // Без знання про тримача виняток не діє.
      expect(createO2().step(input(base))).toMatch(/no promise/)
      // З видимим тримачем — не довше за інтервал плюс паузу збоїв.
      const o2 = createO2()
      const visible = { ...base, holderVisible: () => true }
      expect(o2.step(input({ ...visible, now: 0 }))).toBeUndefined()
      expect(o2.step(input({ ...visible, now: 2_000 }))).toBeUndefined()
      expect(o2.step(input({ ...visible, now: 2_001 }))).toMatch(/no promise/)
    })

    it("excuses a view that never applied a read, until it does (row 18)", () => {
      const states = [state(view(9), { requirements: [composition] })]
      expect(createO2().step(input({ states, attempts: [] }))).toBeUndefined()
      expect(
        createO2().step(input({ states, attempts: settled(5, 9, "page") }))
      ).toMatch(/no promise/)
    })

    it("excuses target-behind-header by the holder of the target (row 17)", () => {
      const states = [
        state(view(1), { requirements: [{ kind: "target-behind-header" }] }),
      ]
      expect(
        createO2().step(
          input({ states, holderPresent: () => false, revalidateMs: 100 })
        )
      ).toBeUndefined()
      const o2 = createO2()
      const held = { states, holderPresent: () => true, revalidateMs: 100 }
      expect(o2.step(input({ ...held, now: 0 }))).toBeUndefined()
      expect(o2.step(input({ ...held, now: 101 }))).toMatch(/no promise/)
    })

    it("excuses a row requirement by the visible holders of its object (rows 2, 4, 12, 19)", () => {
      const row: SyncTarget = { kind: "row", object: OBJECT, key: "k" }
      const states = [
        state(row, { requirements: [{ kind: "value-hidden" }] }),
        state(view(1)),
      ]
      expect(
        createO2().step(
          input({ states, holderVisible: () => false, revalidateMs: 100 })
        )
      ).toBeUndefined()
      const o2 = createO2()
      const held = { states, holderVisible: () => true, revalidateMs: 100 }
      expect(o2.step(input({ ...held, now: 0 }))).toBeUndefined()
      expect(o2.step(input({ ...held, now: 201 }))).toMatch(/no promise/)
    })

    it("lets target-behind-header go with the owner of its section", () => {
      const section: SyncTarget = {
        kind: "view",
        object: OBJECT,
        spec: { kind: "section", object: OBJECT, owner: "o", section: "lines" },
        id: 1,
      }
      const before = [
        state(section, { requirements: [{ kind: "target-behind-header" }] }),
      ]
      const after = [...alive, state(section)]
      const gone = createO2()
      gone.step(input({ states: before, holderPresent: () => false }))
      expect(
        gone.step(input({ now: 5, states: after, ownerPurged: () => true }))
      ).toBeUndefined()
      const kept = createO2()
      kept.step(input({ states: before, holderPresent: () => false }))
      expect(
        kept.step(input({ now: 5, states: after, ownerPurged: () => false }))
      ).toMatch(/disappeared with no proof/)
    })

    describe("target-behind-header leaves with no proof (row 20), each trigger bounded", () => {
      const section: SyncTarget = {
        kind: "view",
        object: OBJECT,
        spec: { kind: "section", object: OBJECT, owner: "o", section: "lines" },
        id: 1,
      }
      const standing = [
        state(section, { requirements: [{ kind: "target-behind-header" }] }),
      ]
      const bare = [...alive, state(section)]
      const model = { revalidateMs: 100, releaseDelayMs: 1_000 }
      const start = (o2: ReturnType<typeof createO2>) =>
        o2.step(input({ states: standing, holderPresent: () => true }))

      it("after a failed read: a read within the interval and the pause once a holder is visible", () => {
        const failed = [
          ...loaded,
          ...settled(8, 1, "reread").slice(0, 1),
          {
            phase: "settled",
            attempt: 8,
            kind: "reread",
            target: { kind: "view", object: OBJECT, id: 1 },
            outcome: "failed",
          } as AttemptEvent,
        ]
        const run = (events: StampedEvent[]) => {
          const o2 = createO2()
          start(o2)
          const at = (now: number, seen: StampedEvent[]) =>
            o2.step(
              input({
                ...model,
                now,
                states: bare,
                attempts: failed,
                events: seen,
                holderPresent: () => true,
                holderVisible: () => true,
              })
            )
          expect(at(10, [])).toBeUndefined()
          return at(300, events)
        }
        expect(run([])).toMatch(/no read of the target within/)
        expect(run([read(1, 0)])).toBeUndefined()
      })

      it("after the holder is released: a read once a holder appears", () => {
        const o2 = createO2()
        start(o2)
        const gone = { ...model, states: bare, holderPresent: () => false }
        expect(o2.step(input({ ...gone, now: 10 }))).toBeUndefined()
        // Без тримача читання не винне.
        expect(
          o2.step(input({ ...gone, now: 5_000, holderVisible: () => false }))
        ).toBeUndefined()
        const back = {
          ...model,
          states: bare,
          holderPresent: () => true,
          holderVisible: () => true,
        }
        expect(o2.step(input({ ...back, now: 5_010 }))).toBeUndefined()
        expect(o2.step(input({ ...back, now: 5_300 }))).toMatch(
          /no read of the target within/
        )
      })

      it("after a purge of the owner: the target leaves sync() within the release delay", () => {
        const o2 = createO2()
        start(o2)
        const purged = {
          ...model,
          states: bare,
          ownerPurged: () => true,
          holderPresent: () => false,
        }
        expect(o2.step(input({ ...purged, now: 10 }))).toBeUndefined()
        expect(o2.step(input({ ...purged, now: 900 }))).toBeUndefined()
        expect(o2.step(input({ ...purged, now: 1_500 }))).toMatch(
          /past the release delay/
        )
        const left = createO2()
        start(left)
        left.step(input({ ...purged, now: 10 }))
        expect(left.step(input({ now: 900, states: alive }))).toBeUndefined()
      })

      it("is red for any other trigger", () => {
        const o2 = createO2()
        start(o2)
        expect(
          o2.step(input({ states: bare, holderPresent: () => true, now: 10 }))
        ).toMatch(/disappeared with no proof/)
      })

      it("must be read after it leaves a refusal", () => {
        const refused = [...alive, state(section, { refusal: "discard-bound" })]
        const run = (events: StampedEvent[]) => {
          const o2 = createO2()
          start(o2)
          expect(
            o2.step(input({ ...model, now: 10, states: refused }))
          ).toBeUndefined()
          const out = {
            ...model,
            states: bare,
            events,
            holderPresent: () => true,
            holderVisible: () => true,
          }
          expect(o2.step(input({ ...out, now: 20 }))).toBeUndefined()
          return o2.step(input({ ...out, now: 300 }))
        }
        expect(run([])).toMatch(/no read of the target within/)
        expect(run([read(1, 0)])).toBeUndefined()
      })
    })

    describe("the composition requirement of a rejoin goes only with a read after the join", () => {
      const run = (readAt: number) => {
        const o2 = createO2()
        const base = { lastJoin: () => 3 }
        o2.step(
          input({
            ...base,
            states: [
              state(view(1), {
                requirements: [{ kind: "channel-rejoin" }],
                deferral: "target-invisible",
              }),
            ],
          })
        )
        o2.step(
          input({
            ...base,
            now: 5,
            states: [
              state(view(1), {
                requirements: [{ ...composition, epoch: 9 }],
                deferral: "target-invisible",
              }),
            ],
          })
        )
        const events = [0, 1, 2, 3, 4].map((i) =>
          i === readAt ? read(1, i, 77) : read(2, i, 50 + i)
        )
        return o2.step(
          input({
            ...base,
            now: 9,
            states: alive.concat(state(view(1))),
            events,
            attempts: [...loaded, ...settled(77, 1, "reread")],
          })
        )
      }

      it("is red when the removing read started before the join", () => {
        expect(run(1)).toMatch(/started before the join/)
      })

      it("is green when it started after the join", () => {
        expect(run(4)).toBeUndefined()
      })
    })

    it("names a row of the table for every exception", () => {
      for (const exception of O2_EXCEPTIONS)
        expect(
          exception.rows.every((n) =>
            [2, 3, 4, 5, 6, 12, 17, 18, 19].includes(n)
          )
        ).toBe(true)
    })
  })
})
