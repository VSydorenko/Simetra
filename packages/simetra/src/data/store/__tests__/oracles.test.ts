import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { catalogIndex, type ReadQuery } from "simetra/model"
import type { AttemptEvent } from "../attempts"
import type { ReadEvent } from "../source"
import { DISCARDS_MAX } from "../session"
import type { SiteCode } from "../sync/vocabulary"
import type { FakePart } from "../testing/fake-source"
import {
  IDLE_EXCEPTIONS,
  collectReads,
  readJournalViolations,
  settleJournalViolations,
  type StampedEvent,
} from "./oracles"
import {
  ORG,
  OBJECTS,
  TASK,
  key,
  seed,
  settle,
  setup,
  watch,
} from "./core-support"

/*
 * Самотести оракулів О1 і О4 (план SK-0, §6, рядок 5): оракул, що мовчить на
 * порожньому, не оракул. Кожен випадок ламає одне — загублена подія,
 * переставлене походження, порожній журнал подій, запит у спокої — і чекає
 * червоного; зелений контроль стоїть поруч.
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const index = catalogIndex(OBJECTS)

const query = (name: "Task" | "Organization", n = 0): ReadQuery =>
  n === 0
    ? { object: { kind: "Catalog", name }, limit: 10 }
    : { object: { kind: "Catalog", name }, id: key(n) }
const part = (name: "Task" | "Organization"): FakePart => ({
  type: "query",
  query: query(name),
})
const event = (
  site: SiteCode,
  object: string,
  journal: number,
  at = 0
): StampedEvent => ({
  // Не `mount` і не `user`: ці причини О4 допускає й без винятків таблиці.
  reason: "retry",
  target: { kind: "view", object, id: 0 },
  site,
  request: journal + 1,
  at,
  journal,
})

describe("O1: events against the journal of the fake source", () => {
  const journal = {
    requests: [2],
    requestParts: [[part("Task"), part("Organization")]],
    index,
  }

  it("is green when each event names the part of its own slot", () => {
    expect(
      readJournalViolations(
        [event("R7", TASK, 0), event("R7", ORG, 0)],
        journal
      )
    ).toEqual([])
  })

  it("is red when the origins of two parts of a request are permuted", () => {
    const problems = readJournalViolations(
      [event("R7", ORG, 0), event("R7", TASK, 0)],
      journal
    )
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain("request 0 part 0")
  })

  describe("keyed parts of another object (include of a flight)", () => {
    const keyedOrg: FakePart = {
      type: "query",
      query: query("Organization", 1),
    }
    const keyedTask: FakePart = { type: "query", query: query("Task", 1) }
    const keysOf = (object: string): StampedEvent => ({
      ...event("M1", object, 0),
      target: { kind: "keys", object },
    })

    it("is green for a keyed read of an object the target reaches by a ref", () => {
      expect(
        readJournalViolations([event("M1", TASK, 0)], {
          requests: [1],
          requestParts: [[keyedOrg]],
          index,
        })
      ).toEqual([])
    })

    it("is red for a keyed read of an object the target does not reach", () => {
      expect(
        readJournalViolations([event("M1", ORG, 0)], {
          requests: [1],
          requestParts: [[keyedTask]],
          index,
        })
      ).toHaveLength(1)
    })

    it("is red when the code of the event is not a flight that reads includes", () => {
      expect(
        readJournalViolations([event("S1", TASK, 0)], {
          requests: [1],
          requestParts: [[keyedOrg]],
          index,
        })
      ).toHaveLength(1)
    })

    it("is red when the targets of two flights are swapped inside one request", () => {
      const parts = {
        requests: [2],
        requestParts: [[keyedOrg, part("Organization")]],
        index,
      }
      expect(
        readJournalViolations([keysOf(TASK), event("R7", ORG, 0)], parts)
      ).toEqual([])
      expect(
        readJournalViolations([event("R7", ORG, 0), keysOf(TASK)], parts)
      ).not.toEqual([])
    })
  })

  it("is red for a code outside the inventory and for the service code of tests", () => {
    const problems = readJournalViolations(
      [
        { ...event("R7", TASK, 0), site: "test" as SiteCode },
        event("R7", ORG, 0),
      ],
      journal
    )
    expect(problems.join()).toContain("not in the inventory")
  })

  it("is red for a request without events and for events without a request", () => {
    expect(
      readJournalViolations([event("R7", TASK, 0)], {
        index,
        requests: [1, 1],
        requestParts: [[part("Task")], [part("Task")]],
      })
    ).toEqual(["request 1: 1 parts, no events"])
    expect(
      readJournalViolations([event("R7", TASK, 1)], {
        index,
        requests: [1],
        requestParts: [[part("Task")]],
      }).join()
    ).toContain("request 1: events of a request the fake never got")
  })

  it("is red for a part count that differs from the events of the request", () => {
    expect(readJournalViolations([event("R7", TASK, 0)], journal)).toEqual([
      "request 0: 2 parts, 1 events",
    ])
  })

  it("is red for an empty event log over a non-empty journal", () => {
    expect(readJournalViolations([], journal)).toEqual([
      "the fake journal has 1 requests, the event log is empty",
    ])
  })

  it("is green for an empty journal with no events", () => {
    expect(
      readJournalViolations([], { requests: [], requestParts: [], index })
    ).toEqual([])
  })
})

describe("O1 over a real core", () => {
  it("pairs every request of a run with its events", async () => {
    const h = setup()
    seed(h.fake, 1, 3)
    watch(h.core.view({ kind: "full", object: TASK }))
    watch(h.core.view({ kind: "full", object: ORG }))
    await settle()
    expect(h.fake.requests.length).toBeGreaterThan(0)
    expect(h.reads.events.length).toBeGreaterThan(0)
    expect(h.reads.violations()).toEqual([])
  })

  it("is red when the listener loses one event", async () => {
    const h = setup()
    let seen = 0
    const lossy = collectReads(
      {
        watchReads: (listener) =>
          h.inspect.watchReads((e) => {
            if (seen++ > 0) listener(e)
          }),
      },
      h.fake,
      { standalone: true }
    )
    seed(h.fake, 1, 2)
    watch(h.core.view({ kind: "full", object: TASK }))
    await settle()
    expect(h.reads.violations()).toEqual([])
    expect(lossy.violations().length).toBeGreaterThan(0)
  })

  it("is red when the listener hears nothing", async () => {
    const h = setup()
    const deaf = collectReads({ watchReads: () => () => {} }, h.fake, {
      standalone: true,
    })
    watch(h.core.view({ kind: "full", object: TASK }))
    await settle()
    expect(h.fake.requests.length).toBeGreaterThan(0)
    expect(deaf.violations()).toEqual([
      `the fake journal has ${h.fake.requests.length} requests, the event log is empty`,
    ])
  })

  it("is red when the origins of two parts of one request are swapped", async () => {
    const h = setup()
    seed(h.fake, 1, 2)
    watch(h.core.view({ kind: "full", object: TASK }))
    watch(h.core.view({ kind: "full", object: ORG }))
    await settle()
    // Один запит з двома цілями: Task і Organization в одному пакеті.
    await Promise.all([
      h.core.revalidate(TASK, { visibleOnly: false }),
      h.core.revalidate(ORG, { visibleOnly: false }),
    ])
    await settle()
    const request = h.fake.requests.length - 1
    const mine = h.reads.events.filter((e) => e.journal === request)
    expect(mine.length).toBe(2)
    const [a, b] = mine as [StampedEvent, StampedEvent]
    const permuted = [
      ...h.reads.events.filter((e) => e.journal !== request),
      { ...a, target: b.target },
      { ...b, target: a.target },
    ]
    expect(readJournalViolations(h.reads.events, h.fake)).toEqual([])
    expect(readJournalViolations(permuted, h.fake)).not.toEqual([])
  })
})

describe("O4: the idle window of a hidden tab", () => {
  // Події читання подає тест сам: причина — те, що судить О4, а не код рядка.
  const feed = () => {
    let listener: ((event: ReadEvent) => void) | undefined
    return {
      source: {
        watchReads: (l: (event: ReadEvent) => void) => {
          listener = l
          return () => {}
        },
      },
      emit: (event: ReadEvent) => listener?.(event),
    }
  }
  const target = { kind: "view", object: TASK, id: 1 } as const
  const window = async (event: ReadEvent) => {
    const h = setup()
    const f = feed()
    const collector = collectReads(f.source, h.fake, { standalone: true })
    // Крок, після якого вкладка прихована й запитів без відповіді немає,
    // відкриває вікно; сам він не оцінюється.
    expect(collector.idleStep({ quiet: false, idle: true })).toBeUndefined()
    f.emit(event)
    return collector.idleStep({ quiet: true, idle: true })
  }

  it("is red for a read of a code and reason outside the exceptions inside the window", async () => {
    expect(
      await window({
        reason: "interval",
        target,
        site: "R2",
        request: 1,
      } as ReadEvent)
    ).toMatch(/a read in the idle window: R2/)
    // M6 з причиною `requirement` (черга R11) — читання вкладки у спокої.
    expect(
      await window({
        reason: "requirement",
        requirement: "access-narrowed",
        target,
        site: "M6",
        request: 1,
      } as ReadEvent)
    ).toMatch(/a read in the idle window: M6 \(requirement\)/)
  })

  it("admits the reasons `mount` and `user`: an action, not a tab at rest", async () => {
    // M6 з причиною `mount` (черга підписки) і підписка на прихованій вкладці.
    for (const [reason, site] of [
      ["mount", "M6"],
      ["mount", "M1"],
      ["user", "R7"],
    ] as const)
      expect(
        await window({ reason, target, site, request: 1 } as ReadEvent)
      ).toBeUndefined()
  })

  it("is green for a quiet step without reads, and a step with an action closes the window", async () => {
    const h = setup()
    h.core.suspend()
    const collector = collectReads(h.inspect, h.fake, { standalone: true })
    expect(collector.idleStep({ quiet: false, idle: true })).toBeUndefined()
    expect(collector.idleStep({ quiet: true, idle: true })).toBeUndefined()
    expect(collector.evaluated()).toBe(1)
    // Дія закриває вікно: її читання не належать вікну.
    watch(h.core.view({ kind: "full", object: TASK }))
    await settle()
    expect(collector.idleStep({ quiet: false, idle: true })).toBeUndefined()
    // Вікно відкрите знову, читань немає.
    expect(collector.idleStep({ quiet: true, idle: true })).toBeUndefined()
  })

  it("does not open the window while the tab is visible or a request is unanswered", async () => {
    const h = setup({ mode: "manual" })
    const collector = collectReads(h.inspect, h.fake, { standalone: true })
    watch(h.core.view({ kind: "full", object: TASK }))
    await settle()
    expect(h.fake.pending.length).toBeGreaterThan(0)
    // Запит без відповіді: вікно не відкрито, подія кроку не оцінюється.
    expect(collector.idleStep({ quiet: true, idle: true })).toBeUndefined()
    expect(collector.idleStep({ quiet: true, idle: true })).toBeUndefined()
    // Вікно лишилось закритим: нове читання кроку не оцінюється.
    watch(h.core.view({ kind: "full", object: ORG }))
    await settle()
    expect(collector.idleStep({ quiet: true, idle: true })).toBeUndefined()
    h.fake.deliverAll()
    await settle()
    // Вкладка видима після кроку: вікно не відкрито, хоч запитів без відповіді
    // немає, тож наступне читання кроку не оцінюється.
    expect(collector.idleStep({ quiet: true, idle: false })).toBeUndefined()
    watch(h.core.view({ kind: "keys", object: TASK, keys: [key(1)] }))
    await settle()
    expect(collector.idleStep({ quiet: true, idle: true })).toBeUndefined()
  })

  describe("the exceptions of row 1 §5.14 have a model-time bound", () => {
    // Причини стоять до вікна: подія-причина сама в вікні була б читанням
    // вікна, а не причиною.
    const open = async (...causes: StampedEvent[]) => {
      const h = setup()
      const clock = { now: 0 }
      const collector = collectReads(h.inspect, h.fake, {
        standalone: true,
        clock: () => clock.now,
      })
      h.core.suspend()
      collector.events.push(...causes)
      expect(collector.idleStep({ quiet: false, idle: true })).toBeUndefined()
      return { collector }
    }
    const rule = (site: SiteCode) =>
      IDLE_EXCEPTIONS.find((r) => r.site === site)!

    it("allows the retry of a discarded load after the cause event within the pause", async () => {
      const { collector } = await open(event("M1", TASK, 0, 0))
      collector.events.push(event("M8", TASK, 1, 0))
      expect(collector.idleStep({ quiet: true, idle: true })).toBeUndefined()
    })

    it("is red for the same retry later than the bound of its path", async () => {
      const { collector } = await open(event("M1", TASK, 0, 0))
      collector.events.push(event("M8", TASK, 1, rule("M8").delayMs + 1))
      expect(collector.idleStep({ quiet: true, idle: true })).toMatch(/M8/)
    })

    it("is red for an exception path whose cause event is of another path", async () => {
      const { collector } = await open(event("R2", TASK, 0, 0))
      collector.events.push(event("M8", TASK, 1, 0))
      expect(collector.idleStep({ quiet: true, idle: true })).toMatch(/M8/)
    })

    it("is red for an exception path without a cause event of its target", async () => {
      const { collector } = await open(event("M1", ORG, 0, 0))
      collector.events.push(event("M8", TASK, 1, 0))
      expect(collector.idleStep({ quiet: true, idle: true })).toMatch(/M8/)
    })

    it("allows a chain of retries as long as the discard limit and no longer", async () => {
      const { collector } = await open(event("M1", TASK, 0, 0))
      const step = rule("M8").delayMs
      for (let n = 1; n <= DISCARDS_MAX; n++)
        collector.events.push(event("M8", TASK, n, n * step))
      expect(collector.idleStep({ quiet: true, idle: true })).toBeUndefined()
      collector.events.push(event("M8", TASK, 99, (DISCARDS_MAX + 1) * step))
      expect(collector.idleStep({ quiet: true, idle: true })).toMatch(/M8/)
    })

    it("holds a delay-0 path to the instant of its cause", async () => {
      const { collector } = await open(event("M1", TASK, 0, 0))
      collector.events.push(event("R16", TASK, 1, 0))
      expect(collector.idleStep({ quiet: true, idle: true })).toBeUndefined()
      collector.events.push(event("R16", TASK, 2, 1))
      expect(collector.idleStep({ quiet: true, idle: true })).toMatch(/R16/)
    })

    it("names its row for every exception", () => {
      for (const r of IDLE_EXCEPTIONS) {
        expect([1, 13]).toContain(r.row)
        expect(Number.isFinite(r.delayMs)).toBe(true)
      }
    })
  })
})

describe("settle events against the journal of the fake source (two-sided)", () => {
  const target = { kind: "view", object: TASK, id: 1 } as const
  const started = (attempt: number): AttemptEvent => ({
    phase: "started",
    attempt,
    kind: "load",
    target,
    reason: "mount",
    site: "M1",
  })
  const settledAs = (
    attempt: number,
    outcome: "applied" | "failed" | "closed"
  ): AttemptEvent => ({
    phase: "settled",
    attempt,
    kind: "load",
    target,
    outcome,
  })
  const read = (attempt: number, request: number): StampedEvent => ({
    ...event("M1", TASK, request - 1),
    attempt,
    request,
  })
  // Запит 1 дістав відповідь, запит 2 — відмову, запит 3 ще без відповіді.
  const wire = { object: { kind: "Catalog", name: "Task" } } as never
  const log = (request: number, state: "answer" | "error" | "open") =>
    ({
      wire,
      known: undefined,
      request: request - 1,
      query: undefined,
      issuedAt: 0,
      ...(state === "answer" ? { response: {} as never } : {}),
      ...(state === "error" ? { error: new Error("x") } : {}),
    }) as never
  const fake = {
    log: [log(1, "answer"), log(2, "error"), log(3, "open")],
    requestParts: [[part("Task")], [part("Task")], [part("Task")]],
  }

  it("is green for an applied attempt with an answer and a failed one with a refusal", () => {
    expect(
      settleJournalViolations(
        [
          started(1),
          settledAs(1, "applied"),
          started(2),
          settledAs(2, "failed"),
        ],
        [read(1, 1), read(2, 2)],
        fake
      )
    ).toEqual([])
  })

  it("is green for a failed attempt that sent no request (a skip condition)", () => {
    expect(
      settleJournalViolations([started(1), settledAs(1, "failed")], [], fake)
    ).toEqual([])
  })

  it("is red when an applied attempt has no answer in the journal", () => {
    expect(
      settleJournalViolations(
        [started(2), settledAs(2, "applied")],
        [read(2, 2)],
        fake
      )
    ).toEqual(["attempt 2: applied without an answered part"])
  })

  it("is red when a failed attempt was answered in full", () => {
    expect(
      settleJournalViolations(
        [started(1), settledAs(1, "failed")],
        [read(1, 1)],
        fake
      )
    ).toHaveLength(1)
  })

  it("is red when the settle event of an answered attempt is lost", () => {
    expect(
      settleJournalViolations([started(1)], [read(1, 1)], fake)
    ).toHaveLength(1)
  })

  it("is green for an attempt still in flight (no answer, no settle)", () => {
    expect(settleJournalViolations([started(3)], [read(3, 3)], fake)).toEqual(
      []
    )
  })

  it("is red for a settle event without a start and for a double settle", () => {
    expect(
      settleJournalViolations([settledAs(9, "closed")], [], fake)
    ).toHaveLength(1)
    expect(
      settleJournalViolations(
        [started(1), settledAs(1, "applied"), settledAs(1, "applied")],
        [read(1, 1)],
        fake
      )
    ).toHaveLength(1)
  })
})
