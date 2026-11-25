import { describe, expect, it } from "vitest"
import type { AttemptEvent } from "../attempts"
import type { SyncState, SyncTarget } from "../core"
import { createFakeSource } from "../testing/fake-source"
import { readPartToWire } from "simetra/model"
import { OBJECTS, key, taskValues } from "./core-support"
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

  it("a row's deadline is closed by the read of a view that held exactly that row at its start", () => {
    const row: SyncTarget = { kind: "row", object: OBJECT, key: "k" }
    const states = [
      state(row, { requirements: [{ kind: "value-hidden" }], due: 1_000 }),
    ]
    const run = (held: string[] | undefined) => {
      const o2 = createO2()
      o2.step(input({ now: 0, states }))
      return o2.step(
        input({
          now: 1_000,
          states,
          events: [{ ...read(2, 0), ...(held === undefined ? {} : { held }) }],
        })
      )
    }
    // Вигляд, що на старті тримав саме цей рядок, читає його: борг закрито.
    expect(run([`${OBJECT}\u0000k`])).toBeUndefined()
    // Мутація: читання вигляду того самого об'єкта, що рядка не тримає, — не
    // виконання строку рядка.
    expect(run([`${OBJECT}\u0000other`])).toMatch(/no read by its deadline/)
    expect(run(undefined)).toMatch(/no read by its deadline/)
  })

  it("a missed deadline passes only into an exception with a bound, counted from the deadline", () => {
    const row: SyncTarget = { kind: "row", object: OBJECT, key: "k" }
    const withDue = state(row, {
      requirements: [{ kind: "value-hidden" }],
      due: 1_000,
    })
    const withdrawn = state(row, { requirements: [{ kind: "value-hidden" }] })
    const evaluate = (
      at: number,
      second: SyncState,
      visible: boolean,
      revalidateMs = 10_000
    ) => {
      const o2 = createO2()
      // Вигляд того самого об'єкта — тримач рядка: видимий чи ні.
      const common = {
        revalidateMs,
        holderVisible: () => visible,
        rowAlive: () => true,
      }
      o2.step(input({ now: 0, states: [withDue, state(view(3))], ...common }))
      return o2.step(
        input({ now: at, states: [second, state(view(3))], ...common })
      )
    }
    // До строку: обіцянку знято разом зі строком.
    expect(evaluate(999, withdrawn, true)).toBeUndefined()
    expect(evaluate(999, withdrawn, false)).toBeUndefined()
    // Видимий тримач — виняток з межею: у строк і після нього, поки межа не минула.
    expect(evaluate(1_000, withdrawn, true)).toBeUndefined()
    expect(evaluate(1_500, withdrawn, true)).toBeUndefined()
    // Названий стан без межі (тримача нема) пропущеного строку не прощає.
    expect(evaluate(1_000, withdrawn, false)).toMatch(/no read by its deadline/)
    expect(evaluate(1_500, withdrawn, false)).toMatch(/no read by its deadline/)
    // Межа лічиться від строку: прощений у строк, далі виняток спливає.
    const o2 = createO2()
    const bounded = {
      revalidateMs: 100,
      holderVisible: () => true,
      rowAlive: () => true,
    }
    o2.step(input({ now: 0, states: [withDue, state(view(3))], ...bounded }))
    const at = (now: number) =>
      o2.step(input({ now, states: [withdrawn, state(view(3))], ...bounded }))
    expect(at(1_000)).toBeUndefined()
    expect(at(1_150)).toBeUndefined()
    expect(at(1_500)).toMatch(/no promise and no condition/)
    // Строк лишився у `sync()`, а читання не було: червоний.
    expect(evaluate(1_000, withDue, true)).toMatch(/no read by its deadline/)
    expect(evaluate(1_000, withDue, false)).toMatch(/no read by its deadline/)
    // Вимога поза винятками й без строку, у строк чи після нього: червоний.
    const list: SyncTarget = view(1)
    const noException = createO2()
    noException.step(
      input({
        now: 0,
        states: [state(list, { requirements: [composition], due: 1_000 })],
      })
    )
    expect(
      noException.step(
        input({
          now: 1_500,
          states: [...alive, state(list, { requirements: [composition] })],
        })
      )
    ).toMatch(/no read by its deadline/)
  })

  it("a deadline missed while the tab was hidden by a `suspend` waits for the show, then the read must start within the interval", () => {
    const row: SyncTarget = { kind: "row", object: OBJECT, key: "k" }
    const withDue = state(row, {
      requirements: [{ kind: "value-hidden" }],
      due: 1_000,
    })
    const withdrawn = state(row, { requirements: [{ kind: "value-hidden" }] })
    const common = { revalidateMs: 100, rowAlive: () => true }
    const start = (o2: ReturnType<typeof createO2>) =>
      o2.step(
        input({
          now: 0,
          states: [withDue],
          suspends: 0,
          tabHidden: false,
          ...common,
        })
      )
    const at = (
      o2: ReturnType<typeof createO2>,
      now: number,
      over: Partial<O2Input>
    ) =>
      o2.step(
        input({
          now,
          states: [withdrawn, state(view(3))],
          // Прихована вкладка — видимого тримача нема (названий стан рядка).
          holderVisible: () => over.tabHidden !== true,
          // `suspend` був до строку (1000), якщо тест не каже інакше.
          hiddenSince: 500,
          ...common,
          ...over,
        })
      )
    // `suspend` між записом і оцінкою, вкладка прихована: умова, без межі.
    const hidden = createO2()
    start(hidden)
    expect(at(hidden, 2_000, { suspends: 1, tabHidden: true })).toBeUndefined()
    expect(at(hidden, 50_000, { suspends: 1, tabHidden: true })).toBeUndefined()
    // Після показу читання в межах інтервалу плюс паузи — зелено...
    expect(
      at(hidden, 50_100, {
        suspends: 1,
        tabHidden: false,
        shownAt: 50_000,
        events: [{ ...read(2, 0), held: [`${OBJECT}\u0000k`] }],
      })
    ).toBeUndefined()
    // (а) ...а без читання після показу — червоний.
    const unread = createO2()
    start(unread)
    at(unread, 2_000, { suspends: 1, tabHidden: true })
    expect(
      at(unread, 50_100, { suspends: 1, tabHidden: false, shownAt: 50_000 })
    ).toBeUndefined()
    expect(
      at(unread, 50_300, { suspends: 1, tabHidden: false, shownAt: 50_000 })
    ).toMatch(/no read of the row or its holder within the interval/)
    // Строк минув на видимій вкладці, `suspend` — після строку: прихована
    // вкладка його вже не прощає (послідовність issue #413).
    const late = createO2()
    start(late)
    expect(
      at(late, 2_000, { suspends: 1, tabHidden: true, hiddenSince: 1_500 })
    ).toMatch(/no read by its deadline|no promise and no condition/)
    // (б) Без кроку `suspend` (вкладка видима, таймер нічого не зробив) —
    // пропущений строк червоний.
    const visible = createO2()
    start(visible)
    expect(at(visible, 2_000, { suspends: 0, tabHidden: false })).toMatch(
      /no read by its deadline|no promise and no condition/
    )
    // Вкладка прихована без кроку `suspend` між записом і оцінкою — теж червоний.
    const noStep = createO2()
    start(noStep)
    expect(at(noStep, 2_000, { suspends: 0, tabHidden: true })).toMatch(
      /no read by its deadline|no promise and no condition/
    )
  })

  it("a deadline passed while the key queued behind the flight becomes a queue promise bounded by that flight", () => {
    const row: SyncTarget = { kind: "row", object: OBJECT, key: "k" }
    const withDue = state(row, {
      requirements: [{ kind: "value-hidden" }],
      due: 1_000,
    })
    const withdrawn = state(row, { requirements: [{ kind: "value-hidden" }] })
    const common = { revalidateMs: 100, rowAlive: () => true }
    const queuedRow = [{ at: 1_200, rows: [`${OBJECT}\u0000k`] }]
    const start = () => {
      const o2 = createO2()
      o2.step(
        input({
          now: 0,
          states: [withDue],
          suspends: 0,
          tabHidden: false,
          ...common,
        })
      )
      return o2
    }
    const at = (
      o2: ReturnType<typeof createO2>,
      now: number,
      over: Partial<O2Input>
    ) =>
      o2.step(
        input({
          now,
          states: [withdrawn, state(view(3))],
          holderVisible: () => over.tabHidden !== true,
          hiddenSince: 1_100,
          ...common,
          ...over,
        })
      )
    // Ключ стояв у черзі на мить строку, політ осів, читання ключа почалося.
    const started = start()
    expect(
      at(started, 2_000, {
        suspends: 0,
        tabHidden: false,
        waitingAt: queuedRow,
        events: [{ ...read(2, 0), held: [`${OBJECT}\u0000k`] }],
      })
    ).toBeUndefined()
    // (а) Ключа не було в черзі на мить строку: пропущений строк червоний.
    const notQueued = start()
    expect(
      at(notQueued, 2_000, {
        suspends: 0,
        tabHidden: false,
        waitingAt: [{ at: 1_200, rows: [`${OBJECT}\u0000other`] }],
      })
    ).toMatch(/no read by its deadline|no promise and no condition/)
    const noFact = start()
    expect(at(noFact, 2_000, { suspends: 0, tabHidden: false })).toMatch(
      /no read by its deadline|no promise and no condition/
    )
    // (б) Політ осів на видимій вкладці, а ключ із черги не стартував.
    const stuck = start()
    expect(
      at(stuck, 2_000, { suspends: 0, tabHidden: false, waitingAt: queuedRow })
    ).toMatch(/queued behind the flight did not start/)
    // Поставлено в чергу ПІСЛЯ строку: запис першого кроку строку без ключа.
    const late = start()
    expect(
      at(late, 2_000, {
        suspends: 1,
        tabHidden: true,
        waitingAt: [
          { at: 1_200, rows: [] },
          { at: 1_800, rows: [`${OBJECT}\u0000k`] },
        ],
      })
    ).toMatch(/no read by its deadline|no promise and no condition/)
    // `suspend` ПІСЛЯ осідання польоту (останній крок із ключем у черзі).
    const afterSettle = start()
    expect(
      at(afterSettle, 2_000, {
        suspends: 1,
        tabHidden: true,
        hiddenSince: 1_500,
        waitingAt: queuedRow,
      })
    ).toMatch(/queued behind the flight did not start/)
    // `suspend` до осідання: діє умова прихованої вкладки.
    const hidden = start()
    expect(
      at(hidden, 2_000, { suspends: 1, tabHidden: true, waitingAt: queuedRow })
    ).toBeUndefined()
  })

  it("a deadline withdrawn before its time does not stretch the exception to deadline plus bound", () => {
    const row: SyncTarget = { kind: "row", object: OBJECT, key: "k" }
    const withDue = state(row, {
      requirements: [{ kind: "value-hidden" }],
      due: 1_000,
    })
    const withdrawn = state(row, { requirements: [{ kind: "value-hidden" }] })
    const common = {
      revalidateMs: 100,
      holderVisible: () => true,
      rowAlive: () => true,
    }
    const o2 = createO2()
    o2.step(input({ now: 0, states: [withDue, state(view(3))], ...common }))
    // Знято на 100, до строку: межа винятку (200) лічиться від 100, не від 1000.
    expect(
      o2.step(
        input({ now: 100, states: [withdrawn, state(view(3))], ...common })
      )
    ).toBeUndefined()
    expect(
      o2.step(
        input({ now: 900, states: [withdrawn, state(view(3))], ...common })
      )
    ).toMatch(/no promise and no condition/)
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

    it("a row that left the store between two evaluations took its requirement with it", () => {
      const row: SyncTarget = { kind: "row", object: OBJECT, key: "k" }
      const first = (life: number) => {
        const o2 = createO2()
        o2.step(
          input({
            states: [
              state(row, { requirements: [{ kind: "min-version" }], due: 5 }),
            ],
            rowLife: () => 0,
          })
        )
        // Рядок вилучено `purge` (крок із читанням у польоті О2 не оцінювали) і
        // прочитано знову: нова вимога його не обіцяє.
        return o2.step(
          input({
            now: 5,
            states: alive,
            rowAlive: () => true,
            rowLife: () => life,
          })
        )
      }
      expect(first(1)).toBeUndefined()
      // Без вилучення той самий рядок лишився: зникнення без доказу — червоне.
      expect(first(0)).toMatch(/disappeared with no proof/)
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

    it("excuses a view that never applied a read by its holder, with a bound (row 18)", () => {
      const states = [state(view(9), { requirements: [composition] })]
      const never = {
        states,
        attempts: [] as AttemptEvent[],
        revalidateMs: 100,
      }
      // Без видимого тримача — названий стан.
      expect(
        createO2().step(input({ ...never, holderVisible: () => false }))
      ).toBeUndefined()
      // З видимим тримачем — не довше за інтервал плюс паузу збоїв.
      const o2 = createO2()
      const seen = { ...never, holderVisible: () => true }
      expect(o2.step(input({ ...seen, now: 0 }))).toBeUndefined()
      expect(o2.step(input({ ...seen, now: 200 }))).toBeUndefined()
      expect(o2.step(input({ ...seen, now: 201 }))).toMatch(/no promise/)
      // Застосоване читання знімає виняток.
      expect(
        createO2().step(
          input({
            states,
            attempts: settled(5, 9, "page"),
          })
        )
      ).toMatch(/no promise/)
    })

    it("excuses a view in the state of the first-load error without a time bound (row 18)", () => {
      const states = [state(view(9), { requirements: [composition] })]
      const failedLoad: AttemptEvent[] = [
        ...settled(5, 9, "load").slice(0, 1),
        {
          phase: "settled",
          attempt: 5,
          kind: "load",
          target: { kind: "view", object: OBJECT, id: 9 },
          outcome: "failed",
        },
      ]
      const base = {
        states,
        revalidateMs: 100,
        holderVisible: () => true,
      }
      const o2 = createO2()
      expect(
        o2.step(input({ ...base, attempts: failedLoad, now: 0 }))
      ).toBeUndefined()
      expect(
        o2.step(input({ ...base, attempts: failedLoad, now: 10_000 }))
      ).toBeUndefined()
      // Не в цьому стані (нове завантаження ще не осіло) — межа діє.
      const started = failedLoad.concat(settled(6, 9, "load").slice(0, 1))
      const other = createO2()
      other.step(input({ ...base, attempts: started, now: 0 }))
      expect(
        other.step(input({ ...base, attempts: started, now: 201 }))
      ).toMatch(/no promise/)
    })

    describe("a purged view is a named condition; a restored pair owes a read", () => {
      const states = [state(view(1), { requirements: [composition] })]
      const bare = [...alive, state(view(1))]
      const holder = { holderVisible: () => true, revalidateMs: 100 }

      it("needs no promise while purged", () => {
        expect(
          createO2().step(input({ states, purgedView: () => true }))
        ).toBeUndefined()
        expect(createO2().step(input({ states }))).toMatch(/no promise/)
      })

      it("must be read after the restore, within the bound", () => {
        const run = (events: StampedEvent[], attempts: AttemptEvent[]) => {
          const o2 = createO2()
          o2.step(input({ states, purgedView: () => true }))
          o2.step(input({ ...holder, states: bare, now: 10 }))
          return o2.step(
            input({
              ...holder,
              states: bare,
              now: 300,
              events,
              attempts: [...loaded, ...attempts],
            })
          )
        }
        expect(run([], [])).toMatch(/no read of the target within/)
        expect(run([read(1, 0, 77)], settled(77, 1, "reread"))).toBeUndefined()
      })

      it("may leave sync() instead", () => {
        const o2 = createO2()
        o2.step(input({ states, purgedView: () => true }))
        expect(o2.step(input({ states: alive, now: 10 }))).toBeUndefined()
      })
    })

    it("excuses target-behind-header by the holder of the target (row 17)", () => {
      const card: SyncTarget = {
        kind: "view",
        object: OBJECT,
        spec: { kind: "card", object: OBJECT, key: key(1) },
        id: 1,
      }
      const states = [
        state(card, { requirements: [{ kind: "target-behind-header" }] }),
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

      it.each(["failed"] as const)(
        "after a %s read: a read within the interval and the pause once a holder is visible",
        (outcome) => {
          const failed = [
            ...loaded,
            ...settled(8, 1, "reread").slice(0, 1),
            {
              phase: "settled",
              attempt: 8,
              kind: "reread",
              target: { kind: "view", object: OBJECT, id: 1 },
              outcome,
            } as AttemptEvent,
          ]
          const run = (events: StampedEvent[], extra: AttemptEvent[] = []) => {
            const o2 = createO2()
            start(o2)
            const at = (now: number, seen: StampedEvent[]) =>
              o2.step(
                input({
                  ...model,
                  now,
                  states: bare,
                  attempts: [...failed, ...(seen.length > 0 ? extra : [])],
                  events: seen,
                  holderPresent: () => true,
                  holderVisible: () => true,
                })
              )
            expect(at(10, [])).toBeUndefined()
            return at(300, events)
          }
          expect(run([])).toMatch(/no read of the target within/)
          // Збійне читання вигляду боргу не закриває.
          expect(run([read(1, 0, 8)])).toMatch(/no read of the target within/)
          expect(
            run([read(1, 0, 77)], settled(77, 1, "reread"))
          ).toBeUndefined()
        }
      )

      it("after a read discarded by the epoch: a read by the end of the retry pause, or red", () => {
        const discarded = [
          ...loaded,
          ...settled(8, 1, "reread").slice(0, 1),
          {
            phase: "settled",
            attempt: 8,
            kind: "reread",
            target: { kind: "view", object: OBJECT, id: 1 },
            outcome: "discarded-by-epoch",
          } as AttemptEvent,
        ]
        // Після відкинутої спроби `sync()` показує паузу повтору: строк із причиною.
        const pause = (due: number) => [
          ...alive,
          state(section, { due, dueCause: "retry" }),
        ]
        const run = (
          steps: readonly {
            now: number
            states: SyncState[]
            seen?: StampedEvent[]
            attempts?: AttemptEvent[]
          }[],
          visible = true
        ) => {
          const o2 = createO2()
          start(o2)
          // Перша проблема прогону: борг після червоного кроку знято.
          let first: string | undefined
          for (const step of steps)
            first ??= o2.step(
              input({
                ...model,
                now: step.now,
                states: step.states,
                attempts: step.attempts ?? discarded,
                events: step.seen ?? [],
                holderPresent: () => true,
                holderVisible: () => visible,
              })
            )
          return first
        }
        const waiting = { now: 10, states: pause(110) }
        // До кінця паузи — зелений; у строк і після нього без читання — червоний.
        expect(run([waiting, { now: 100, states: pause(110) }])).toBeUndefined()
        expect(run([waiting, { now: 111, states: pause(110) }])).toMatch(
          /no read of the target by the end of its retry pause/
        )
        // Повтор стартував (подія читання цілі) — борг закрито.
        expect(
          run([waiting, { now: 200, states: bare, seen: [read(1, 0, 77)] }])
        ).toBeUndefined()
        // Ядро, що вічно переставляє паузу й не читає, межу не відсуває.
        expect(run([waiting, { now: 150, states: pause(300) }])).toMatch(
          /no read of the target by the end of its retry pause/
        )
        // Повтор, що осів збоєм чи відкинутий, боргу не закриває: далі діє давня
        // межа читання (інтервал плюс пауза).
        const retried = (outcome: "failed" | "discarded-by-epoch") => [
          ...discarded,
          ...settled(77, 1, "reread").slice(0, 1),
          {
            phase: "settled",
            attempt: 77,
            kind: "reread",
            target: { kind: "view", object: OBJECT, id: 1 },
            outcome,
          } as AttemptEvent,
        ]
        for (const outcome of ["failed", "discarded-by-epoch"] as const)
          expect(
            run([
              waiting,
              {
                now: 120,
                states: bare,
                seen: [read(1, 0, 77)],
                attempts: retried(outcome),
              },
              { now: 500, states: bare, attempts: retried(outcome) },
              { now: 5_000, states: bare, attempts: retried(outcome) },
            ])
          ).toMatch(/no read of the target within/)
        // Той самий повтор, що осів застосованим, борг закриває.
        expect(
          run([
            waiting,
            {
              now: 120,
              states: bare,
              seen: [read(1, 0, 77)],
              attempts: [...discarded, ...settled(77, 1, "reread")],
            },
            {
              now: 5_000,
              states: bare,
              attempts: [...discarded, ...settled(77, 1, "reread")],
            },
          ])
        ).toBeUndefined()
        // Відкинута спроба й застосований повтор у одному вікні кроків: повтор
        // судить сам, пауза не потрібна.
        expect(
          run([
            {
              now: 10,
              states: bare,
              seen: [read(1, 0, 77)],
              attempts: [...discarded, ...settled(77, 1, "reread")],
            },
            {
              now: 500,
              states: bare,
              attempts: [...discarded, ...settled(77, 1, "reread")],
            },
          ])
        ).toBeUndefined()
        // Паузи в `sync()` немає й читання теж: ядро повтор не поставило.
        expect(
          run([
            { now: 10, states: bare },
            { now: 20, states: bare },
          ])
        ).toMatch(/no read of the target by the end of its retry pause/)
        // Невидимий вигляд: плюс інтервал.
        expect(
          run([waiting, { now: 111, states: pause(110) }], false)
        ).toBeUndefined()
        expect(run([waiting, { now: 300, states: pause(110) }], false)).toMatch(
          /no read of the target by the end of its retry pause/
        )
      })

      it("goes with its header only after an applied read that asked for the header and got no row", () => {
        const keysView = (id: number, key: string): SyncTarget => ({
          kind: "view",
          object: OBJECT,
          spec: { kind: "keys", object: OBJECT, keys: [key] },
          id,
        })
        const withHeader = keysView(2, "o")
        const withoutHeader = keysView(3, "x")
        const states = [...bare, state(withHeader), state(withoutHeader)]
        const run = (
          gone: boolean,
          readOf: SyncTarget | undefined,
          outcome: "applied" | "failed" = "applied",
          all = states
        ) => {
          const o2 = createO2()
          start(o2)
          const id = readOf?.kind === "view" ? readOf.id : 0
          const attempts: AttemptEvent[] = [
            ...loaded,
            ...(readOf === undefined
              ? []
              : [
                  ...settled(8, id, "reread").slice(0, 1),
                  {
                    phase: "settled",
                    attempt: 8,
                    kind: "reread",
                    target: { kind: "view", object: OBJECT, id },
                    outcome,
                  } as AttemptEvent,
                ]),
          ]
          return o2.step(
            input({
              ...model,
              now: 10,
              states: all,
              attempts,
              events: readOf === undefined ? [] : [read(id, 0, 8)],
              headerGone: () => gone,
              holderPresent: () => true,
              holderVisible: () => true,
            })
          )
        }
        // Читання секції власника шапку не читає: доказом не є.
        const sectionRead: SyncTarget = { ...section, id: 4 }
        expect(
          run(true, sectionRead, "applied", [...states, state(sectionRead)])
        ).toMatch(/disappeared with no proof/)
        // Читання з шапкою в цілі осіло без її рядка, усі тримачі показують
        // `removed`: вимога пішла разом із шапкою.
        expect(run(true, withHeader)).toBeUndefined()
        // Мутація: читання, ціль якого шапки не містить, — не доказ.
        expect(run(true, withoutHeader)).toMatch(/disappeared with no proof/)
        // Шапка жива (не всі тримачі показують її `removed`): не доказ.
        expect(run(false, withHeader)).toMatch(/disappeared with no proof/)
        // Жодного читання не було, чи воно не осіло застосованим: не доказ.
        expect(run(true, undefined)).toMatch(/disappeared with no proof/)
        expect(run(true, withHeader, "failed")).toMatch(
          /disappeared with no proof/
        )
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
        const run = (events: StampedEvent[], attempts: AttemptEvent[]) => {
          const o2 = createO2()
          start(o2)
          expect(
            o2.step(input({ ...model, now: 10, states: refused }))
          ).toBeUndefined()
          const out = {
            ...model,
            states: bare,
            events,
            attempts: [...loaded, ...attempts],
            holderPresent: () => true,
            holderVisible: () => true,
          }
          expect(o2.step(input({ ...out, now: 20 }))).toBeUndefined()
          return o2.step(input({ ...out, now: 300 }))
        }
        expect(run([], [])).toMatch(/no read of the target within/)
        expect(run([read(1, 0, 77)], settled(77, 1, "reread"))).toBeUndefined()
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

  describe("fix round: deadline, proof table, replacements", () => {
    it("F1: a deadline moved after it has passed is not forgiven", () => {
      const at = (due: number) => [
        state(view(1), { requirements: [composition], due }),
      ]
      const late = createO2()
      late.step(input({ now: 0, states: at(1_000) }))
      expect(late.step(input({ now: 1_200, states: at(5_000) }))).toMatch(
        /no read by its deadline/
      )
      const early = createO2()
      early.step(input({ now: 0, states: at(1_000) }))
      expect(early.step(input({ now: 500, states: at(5_000) }))).toBeUndefined()
    })

    it("F8: a page of the view does not keep a deadline", () => {
      const states = [state(view(1), { requirements: [composition], due: 5 })]
      const page = {
        ...read(1, 0, 7),
        target: { kind: "page", object: OBJECT, id: 1 },
      } as StampedEvent
      const o2 = createO2()
      o2.step(input({ now: 0, states }))
      expect(o2.step(input({ now: 5, states, events: [page] }))).toMatch(
        /no read by its deadline/
      )
    })

    const section: SyncTarget = {
      kind: "view",
      object: OBJECT,
      spec: {
        kind: "section",
        object: OBJECT,
        owner: key(1),
        section: "lines",
      },
      id: 1,
    }
    const hidden = (k: string): SyncTarget => ({
      kind: "row",
      object: OBJECT,
      key: k,
    })

    it("F8: a failed read does not settle the follow-up of a refusal exit", () => {
      const refused = [...alive, state(section, { refusal: "discard-bound" })]
      const standing = [
        state(section, { requirements: [{ kind: "target-behind-header" }] }),
      ]
      const bare = [...alive, state(section)]
      const run = (outcome: "failed" | "applied") => {
        const o2 = createO2()
        o2.step(input({ states: standing, revalidateMs: 100 }))
        o2.step(input({ states: refused, now: 10, revalidateMs: 100 }))
        const attempts: AttemptEvent[] = [
          ...loaded,
          {
            phase: "started",
            attempt: 40,
            kind: "reread",
            target: { kind: "view", object: OBJECT, id: 1 },
            reason: "interval",
            site: "R2",
          } as AttemptEvent,
          {
            phase: "settled",
            attempt: 40,
            kind: "reread",
            target: { kind: "view", object: OBJECT, id: 1 },
            outcome,
          },
        ]
        const out = {
          states: bare,
          attempts,
          events: [read(1, 0, 40)],
          holderVisible: () => true,
          revalidateMs: 100,
        }
        o2.step(input({ ...out, now: 20 }))
        return o2.step(input({ ...out, now: 300 }))
      }
      expect(run("failed")).toMatch(/no read of the target within/)
      expect(run("applied")).toBeUndefined()
    })

    it("F3: other requirement kinds of a purged owner need proof", () => {
      const before = [
        state(section, { requirements: [{ kind: "access-narrowed" }] }),
      ]
      const o2 = createO2()
      o2.step(input({ states: before, holderPresent: () => true }))
      expect(
        o2.step(
          input({
            now: 5,
            states: [...alive, state(section)],
            ownerPurged: () => true,
            holderPresent: () => false,
          })
        )
      ).toMatch(/access-narrowed disappeared with no proof/)
    })

    it("F5: row 17 does not cover a list view", () => {
      const list = view(3)
      const states = [
        state(list, { requirements: [{ kind: "target-behind-header" }] }),
      ]
      expect(
        createO2().step(input({ states, holderPresent: () => false }))
      ).toMatch(/no promise/)
    })

    describe("F4: «значення сховано» replaces the requirement only on the owner key", () => {
      const standing = [
        state(section, { requirements: [{ kind: "target-behind-header" }] }),
      ]
      const run = (row: SyncTarget, before: boolean) => {
        const o2 = createO2()
        const hiddenState = state(row, {
          requirements: [{ kind: "value-hidden" }],
          due: 99,
        })
        o2.step(
          input({
            states: before ? [...standing, hiddenState] : standing,
            holderPresent: () => true,
          })
        )
        return o2.step(
          input({
            now: 5,
            states: [...alive, state(section), hiddenState],
            holderPresent: () => true,
          })
        )
      }
      it("green: the owner key, new", () => {
        expect(run(hidden(key(1)), false)).toBeUndefined()
      })
      it("red: another key of the object", () => {
        expect(run(hidden(key(2)), false)).toMatch(/disappeared with no proof/)
      })
      it("red: the owner key, already hidden before", () => {
        expect(run(hidden(key(1)), true)).toMatch(/disappeared with no proof/)
      })
    })

    describe("proof table, one pair per row", () => {
      const row = hidden(key(1))
      const answered = async (version = 5) => {
        const f = createFakeSource({ objects: OBJECTS })
        void version
        f.insert(OBJECT, taskValues(1))
        const part = readPartToWire(f.index, {
          type: "query",
          query: {
            object: { kind: "Catalog", name: "Task" },
            where: { attribute: "ref", op: "in", value: [key(1)] },
            limit: 10,
          } as never,
        })
        if (!part.ok) throw new Error("wire")
        const reading = f.adapter.read([part.value])
        for (let i = 0; i < 50; i++) await Promise.resolve()
        f.deliverAll()
        await reading
        return f
      }
      const vanish = (
        kind: "min-version" | "value-hidden" | "row-unfinished",
        f: Awaited<ReturnType<typeof answered>> | undefined,
        version?: number
      ) => {
        const o2 = createO2()
        o2.step(
          input({
            states: [
              state(row, {
                requirements: [{ kind, ...(version ? { version } : {}) }],
                due: 5,
              }),
            ],
          })
        )
        return o2.step(
          input({
            now: 5,
            states: alive,
            rowAlive: () => true,
            fake: f ?? fake,
          })
        )
      }

      it("value-hidden and row-unfinished: red with no answer, green with one", async () => {
        const f = await answered()
        for (const kind of ["value-hidden", "row-unfinished"] as const) {
          expect(vanish(kind, undefined)).toMatch(/disappeared/)
          expect(vanish(kind, f)).toBeUndefined()
        }
      })

      it("min-version: the answer must carry a version not below v", async () => {
        const f = await answered()
        expect(vanish("min-version", f, 1)).toBeUndefined()
        expect(vanish("min-version", f, 10_000_000)).toMatch(/disappeared/)
      })

      it("min-version → version-epoch-switched is a replacement", () => {
        const o2 = createO2()
        o2.step(
          input({
            states: [
              state(row, { requirements: [{ kind: "min-version" }], due: 5 }),
            ],
          })
        )
        expect(
          o2.step(
            input({
              now: 4,
              states: [
                state(row, {
                  requirements: [{ kind: "version-epoch-switched" }],
                  due: 9,
                }),
              ],
            })
          )
        ).toBeUndefined()
      })

      it("rights- and version-unconfirmed: need an answered service part", () => {
        for (const service of ["rights", "version"] as const) {
          const target: SyncTarget = { kind: "service", service }
          const kind =
            service === "rights" ? "rights-unconfirmed" : "version-unconfirmed"
          const run = (answeredPart: boolean, rightsReplied = true) => {
            const o2 = createO2()
            o2.step(
              input({
                states: [state(target, { requirements: [{ kind }], due: 5 })],
                storeEmpty: false,
              })
            )
            const event = {
              reason: "requirement",
              requirement: kind,
              target,
              site: "S1",
              at: 0,
              journal: 0,
              request: 1,
            } as StampedEvent
            return o2.step(
              input({
                now: 5,
                states: [...alive, state(target)],
                events: answeredPart ? [event] : [],
                fake: {
                  log: [],
                  pending: [],
                  inFlight: 0,
                  index: fake.index,
                  rightsLog: [
                    {
                      request: 0,
                      known: undefined,
                      response: rightsReplied ? {} : undefined,
                    },
                  ],
                },
              })
            )
          }
          expect(run(false)).toMatch(/disappeared/)
          expect(run(true)).toBeUndefined()
          // Частина прав без відповіді підтвердженням не є.
          if (service === "rights")
            expect(run(true, false)).toMatch(/disappeared/)
        }
      })

      it("access-narrowed and hydration-trust: an applied read of the view", () => {
        for (const kind of ["access-narrowed", "hydration-trust"] as const) {
          const run = (attempts: AttemptEvent[]) => {
            const o2 = createO2()
            o2.step(
              input({
                states: [state(view(1), { requirements: [{ kind }], due: 5 })],
              })
            )
            return o2.step(
              input({
                now: 5,
                states: [...alive, state(view(1))],
                attempts: [...loaded, ...attempts],
                events: [read(1, 0, 7)],
              })
            )
          }
          expect(run([])).toMatch(/disappeared/)
          expect(run(settled(7, 1, "reread"))).toBeUndefined()
        }
      })

      it("hydration-trust → value-hidden of an owner key is a replacement", () => {
        const keysView: SyncTarget = {
          kind: "view",
          object: OBJECT,
          spec: { kind: "keys", object: OBJECT, keys: [key(1)] },
          id: 4,
        }
        const o2 = createO2()
        o2.step(
          input({
            states: [
              state(keysView, {
                requirements: [{ kind: "hydration-trust" }],
                due: 5,
              }),
            ],
          })
        )
        expect(
          o2.step(
            input({
              now: 5,
              states: [
                ...alive,
                state(keysView),
                state(row, {
                  requirements: [{ kind: "value-hidden" }],
                  due: 9,
                }),
              ],
            })
          )
        ).toBeUndefined()
      })

      it("a session beyond the discard limit drops row requirements with its views", () => {
        const refused = [...alive, state(view(1), { refusal: "discard-bound" })]
        const run = (states: SyncState[]) => {
          const o2 = createO2()
          o2.step(
            input({
              states: [
                state(row, { requirements: [{ kind: "min-version" }], due: 5 }),
              ],
            })
          )
          return o2.step(input({ now: 5, states, rowAlive: () => true }))
        }
        expect(run(refused)).toBeUndefined()
        expect(run(alive)).toMatch(/disappeared/)
      })

      it("a closed core drops all requirements with no proof", () => {
        const o2 = createO2()
        o2.step(
          input({
            states: [state(view(1), { requirements: [composition], due: 5 })],
          })
        )
        expect(
          o2.step(
            input({
              now: 5,
              states: [state(view(1), { refusal: "closed" })],
            })
          )
        ).toBeUndefined()
        const live = createO2()
        live.step(
          input({
            states: [state(view(1), { requirements: [composition], due: 5 })],
          })
        )
        expect(
          live.step(input({ now: 5, states: [...alive, state(view(1))] }))
        ).toMatch(/disappeared/)
      })
    })
  })
})
