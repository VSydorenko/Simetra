import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReadQuery } from "simetra/model"
import type { SiteCode } from "../sync/vocabulary"
import type { FakePart } from "../testing/fake-source"
import {
  IDLE_EXCEPTIONS,
  collectReads,
  readJournalViolations,
  type StampedEvent,
} from "./oracles"
import { ORG, TASK, key, seed, settle, setup, watch } from "./core-support"

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
  reason: "user",
  target: { kind: "view", object },
  site,
  request: journal + 1,
  at,
  journal,
})

describe("O1: events against the journal of the fake source", () => {
  const journal = {
    requests: [2],
    requestParts: [[part("Task"), part("Organization")]],
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
        requests: [1, 1],
        requestParts: [[part("Task")], [part("Task")]],
      })
    ).toEqual(["request 1: 1 parts, no events"])
    expect(
      readJournalViolations([event("R7", TASK, 1)], {
        requests: [1],
        requestParts: [[part("Task")]],
      }).join()
    ).toContain("request 0: 1 parts, no events")
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
      readJournalViolations([], { requests: [], requestParts: [] })
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
  it("is red for a read of a code outside the exceptions inside the window", async () => {
    const h = setup()
    seed(h.fake, 1, 2)
    watch(h.core.view({ kind: "full", object: TASK }))
    await settle()
    h.core.suspend()
    await settle()
    const collector = collectReads(h.inspect, h.fake, { standalone: true })
    // Крок, після якого вкладка прихована й запитів без відповіді немає,
    // відкриває вікно; сам він не оцінюється.
    expect(collector.idleStep({ quiet: false, idle: true })).toBeUndefined()
    // Підписка на прихованій вкладці — дія host-а: `mount` не виняток.
    watch(h.core.view({ kind: "full", object: ORG }))
    await settle()
    expect(collector.idleStep({ quiet: true, idle: true })).toMatch(
      /a read in the idle window: M[12]/
    )
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
    h.fake.deliverAll()
    await settle()
    // Вкладка видима: `idle` каже тест.
    expect(collector.idleStep({ quiet: true, idle: false })).toBeUndefined()
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

    it("is red for an exception path without a cause event of its target", async () => {
      const { collector } = await open(event("M1", ORG, 0, 0))
      collector.events.push(event("M8", TASK, 1, 0))
      expect(collector.idleStep({ quiet: true, idle: true })).toMatch(/M8/)
    })

    it("lets one cause excuse one read: a spent cause does not excuse a later one", async () => {
      const { collector } = await open(event("M1", TASK, 0, 0))
      collector.events.push(
        event("M8", TASK, 1, 0),
        event("M8", TASK, 2, rule("M8").delayMs + 1)
      )
      // M1 уже дозволив першу M8; друга — пізніше межі від першої M8.
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
