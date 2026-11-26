import { describe, expect, it } from "vitest"
import {
  BASE,
  baseAnswer,
  HIDDEN_TAB,
  HIDDEN_TAB_BASIS,
  JUDGED_CONDITIONS,
  OVERRIDES,
  type JudgedCondition,
} from "../sync/admission"
import {
  createGate,
  isPermit,
  recordOf,
  type Admission,
  type GateState,
} from "../sync/flight"
import {
  READ_REASONS,
  REQUIREMENT_KINDS,
  SITE_CODES,
  type ReadCause,
  type ReadReason,
  type ReadTarget,
  type SiteCode,
} from "../sync/vocabulary"

/*
 * Шлюз допуску SK-1 клітинка за клітинкою (план SK-1, задача 3, Р-SK1-3…5):
 * базові клітинки — цільова таблиця §5.3 і колонка «Прихована й невидима»
 * §5.2; відповідь шлюзу на кожен код Додатка Б — те, що `main` робить на цій
 * умові (звірено з характеристикою `read-sites-main.test.ts`). Очікування
 * записано літералами зі спеки, а не виведено з даних таблиці.
 */

const OBJECT = "Catalog.Task"
const VIEW: ReadTarget = { kind: "view", object: OBJECT, id: 1 }
const PAGE: ReadTarget = { kind: "page", object: OBJECT, id: 1 }
const KEYS: ReadTarget = { kind: "keys", object: OBJECT }
const VERSION: ReadTarget = { kind: "service", service: "version" }
const RIGHTS: ReadTarget = { kind: "service", service: "rights" }

const req = (requirement: ReadCause & { reason: "requirement" }) => requirement

/** Причина й ціль кожного коду за Додатком Б (рядки «причина виклику» — M1, R7). */
const SITES: Record<SiteCode, { cause: ReadCause; target: ReadTarget }> = {
  M1: { cause: { reason: "mount" }, target: VIEW },
  M2: { cause: { reason: "mount" }, target: VIEW },
  M3: { cause: { reason: "mount" }, target: VIEW },
  M4: {
    cause: req({ reason: "requirement", requirement: "target-behind-header" }),
    target: VIEW,
  },
  M5: { cause: { reason: "user" }, target: VIEW },
  M6: { cause: { reason: "mount" }, target: VIEW },
  M7: { cause: { reason: "retry" }, target: VIEW },
  M8: { cause: { reason: "retry" }, target: VIEW },
  P1: { cause: { reason: "user" }, target: PAGE },
  P2: { cause: { reason: "retry" }, target: PAGE },
  P3: { cause: { reason: "retry" }, target: PAGE },
  R1: {
    cause: req({
      reason: "requirement",
      requirement: "version-epoch-switched",
    }),
    target: VIEW,
  },
  R2: { cause: { reason: "interval" }, target: VIEW },
  R3: { cause: { reason: "retry" }, target: VIEW },
  R4: {
    cause: req({ reason: "requirement", requirement: "channel-rejoin" }),
    target: VIEW,
  },
  R5: {
    cause: req({ reason: "requirement", requirement: "hydration-trust" }),
    target: VIEW,
  },
  R6: { cause: { reason: "interval" }, target: VIEW },
  R7: { cause: { reason: "user" }, target: VIEW },
  R8: { cause: { reason: "signal" }, target: VIEW },
  R9: { cause: { reason: "signal" }, target: VIEW },
  R10: {
    cause: req({ reason: "requirement", requirement: "value-hidden" }),
    target: VIEW,
  },
  R11: {
    cause: req({ reason: "requirement", requirement: "access-narrowed" }),
    target: VIEW,
  },
  R12: {
    cause: req({ reason: "requirement", requirement: "target-behind-header" }),
    target: VIEW,
  },
  R13: {
    cause: req({
      reason: "requirement",
      requirement: "composition-unconfirmed",
    }),
    target: VIEW,
  },
  R14: {
    cause: req({ reason: "requirement", requirement: "hydration-trust" }),
    target: VIEW,
  },
  // Хвіст бере причину виклику, що його поставив; тут — звірка гідратації
  // (R5), вимога, яку ціль відкладає на прихованій вкладці (рішення
  // архітекторки 25.11).
  R15: {
    cause: req({ reason: "requirement", requirement: "hydration-trust" }),
    target: VIEW,
  },
  R16: { cause: { reason: "retry" }, target: VIEW },
  R17: { cause: { reason: "retry" }, target: VIEW },
  R18: { cause: { reason: "retry" }, target: VIEW },
  K1: { cause: { reason: "signal" }, target: KEYS },
  K2: {
    cause: req({ reason: "requirement", requirement: "min-version" }),
    target: KEYS,
  },
  K3: {
    cause: req({ reason: "requirement", requirement: "row-unfinished" }),
    target: KEYS,
  },
  K4: { cause: { reason: "write-confirm" }, target: KEYS },
  S1: {
    cause: req({ reason: "requirement", requirement: "version-unconfirmed" }),
    target: VERSION,
  },
  S2: {
    cause: req({ reason: "requirement", requirement: "rights-unconfirmed" }),
    target: RIGHTS,
  },
  S3: {
    cause: req({ reason: "requirement", requirement: "rights-unconfirmed" }),
    target: RIGHTS,
  },
}

type Verdict = "permit" | "deferred" | "refused"
const verdictOf = (a: Admission): Verdict =>
  isPermit(a) ? "permit" : "deferred" in a ? "deferred" : "refused"

const OPEN = { valid: true } as const
const SHUT = { valid: false } as const

/** Шлюз, у якого настала лише одна умова. */
function gateWith(condition: JudgedCondition | undefined) {
  const state: GateState = {
    token: () => (condition === "closed" ? SHUT : OPEN),
    staleObject: () => condition === "stale-object",
    discardBound: () => condition === "discard-bound",
    tabHidden: () => condition === "tab-hidden",
  }
  return createGate(state)
}

const answer = (code: SiteCode, condition: JudgedCondition | undefined) => {
  const { cause, target } = SITES[code]
  return gateWith(condition).admit(cause, target, code)
}

describe("base cells: the target table §5.3", () => {
  // Колонки чотирьох умов SK-1 цільової таблиці §5.3, дослівно.
  const TARGET: Record<
    ReadReason,
    Record<JudgedCondition, "admit" | "defer" | "refuse" | "by-kind">
  > = {
    mount: {
      closed: "refuse",
      "stale-object": "refuse",
      "discard-bound": "refuse",
      "tab-hidden": "admit",
    },
    user: {
      closed: "refuse",
      "stale-object": "refuse",
      "discard-bound": "refuse",
      "tab-hidden": "admit",
    },
    retry: {
      closed: "refuse",
      "stale-object": "refuse",
      "discard-bound": "refuse",
      "tab-hidden": "defer",
    },
    requirement: {
      closed: "refuse",
      "stale-object": "refuse",
      "discard-bound": "refuse",
      "tab-hidden": "by-kind",
    },
    interval: {
      closed: "refuse",
      "stale-object": "refuse",
      "discard-bound": "refuse",
      "tab-hidden": "defer",
    },
    signal: {
      closed: "refuse",
      "stale-object": "refuse",
      "discard-bound": "refuse",
      "tab-hidden": "defer",
    },
    "write-confirm": {
      closed: "refuse",
      "stale-object": "refuse",
      "discard-bound": "refuse",
      "tab-hidden": "admit",
    },
  }

  it.each(READ_REASONS)("%s", (reason) => {
    for (const condition of JUDGED_CONDITIONS) {
      const want = TARGET[reason][condition]
      expect(BASE[reason][condition], `${reason} × ${condition}`).toBe(
        want === "by-kind" ? "hidden-by-kind" : want
      )
    }
  })

  it("the four other conditions are judged by the path until SK-3/SK-4", () => {
    for (const reason of READ_REASONS)
      for (const condition of [
        "target-invisible",
        "paused",
        "promised",
        "hydrating",
      ] as const)
        expect(BASE[reason][condition], `${reason} × ${condition}`).toBe("path")
  })

  it("the hidden tab by requirement kind: column «Прихована й невидима» §5.2; rights-unconfirmed and version-unconfirmed are admitted by row 23 of §5.14", () => {
    expect(HIDDEN_TAB).toEqual({
      "composition-unconfirmed": "defer",
      "channel-rejoin": "defer",
      "hydration-trust": "defer",
      "access-narrowed": "admit",
      "target-behind-header": "defer",
      "min-version": "defer",
      "value-hidden": "defer",
      "row-unfinished": "defer",
      "version-epoch-switched": "defer",
      "rights-unconfirmed": "admit",
      "version-unconfirmed": "admit",
    })
    for (const requirement of REQUIREMENT_KINDS)
      expect(
        baseAnswer({ reason: "requirement", requirement }, "view", "tab-hidden")
      ).toBe(HIDDEN_TAB[requirement])
  })

  it("every hidden-tab cell that differs from §5.2 names row 23 of §5.14, and only those", () => {
    // Колонка §5.2 літералом: `by-setter` — відповідь залежить від
    // постановника вимоги, якого SK-1 не несе, тож одна клітинка з нею
    // розходиться завжди.
    const spec: Record<
      keyof typeof HIDDEN_TAB,
      "defer" | "admit" | "by-setter"
    > = {
      "composition-unconfirmed": "defer",
      "channel-rejoin": "defer",
      "hydration-trust": "defer",
      "access-narrowed": "admit",
      "target-behind-header": "defer",
      "min-version": "defer",
      "value-hidden": "defer",
      "row-unfinished": "defer",
      "version-epoch-switched": "defer",
      "rights-unconfirmed": "by-setter",
      "version-unconfirmed": "by-setter",
    }
    const differing = REQUIREMENT_KINDS.filter(
      (kind) => HIDDEN_TAB[kind] !== spec[kind]
    )
    expect(Object.keys(HIDDEN_TAB_BASIS).sort()).toEqual([...differing].sort())
    expect(HIDDEN_TAB_BASIS).toEqual({
      "rights-unconfirmed": { row: 23 },
      "version-unconfirmed": { row: 23 },
    })
  })

  it("discard-bound does not apply to service targets, for every reason", () => {
    for (const reason of READ_REASONS) {
      const cause: ReadCause =
        reason === "requirement"
          ? { reason, requirement: "version-unconfirmed" }
          : { reason }
      expect(baseAnswer(cause, "service", "discard-bound"), reason).toBe(
        "admit"
      )
      expect(baseAnswer(cause, "keys", "discard-bound"), reason).toBe("refuse")
    }
  })
})

/*
 * Відповідь шлюзу на кожен код за кожною умовою: база й перевизначення разом.
 * `permit` там, де шлях на `main` умови не перевіряє (його відмовляє пізня
 * відмова Р-SK1-6, рядок 8 чи 16, чи читання на прихованій вкладці — рядки 1
 * і 13 §5.14); `refused` / `deferred` — де перевіряє сам.
 */
const P = "permit" as const
const R = "refused" as const
const D = "deferred" as const
const EFFECTIVE: Record<SiteCode, Record<JudgedCondition, Verdict>> = {
  M1: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  M2: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  M3: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  M4: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  M5: { closed: R, "stale-object": R, "discard-bound": P, "tab-hidden": P },
  M6: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  M7: { closed: R, "stale-object": P, "discard-bound": R, "tab-hidden": D },
  M8: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  P1: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  P2: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  P3: { closed: R, "stale-object": P, "discard-bound": R, "tab-hidden": D },
  R1: { closed: R, "stale-object": R, "discard-bound": R, "tab-hidden": D },
  R2: { closed: R, "stale-object": R, "discard-bound": R, "tab-hidden": D },
  R3: { closed: R, "stale-object": P, "discard-bound": R, "tab-hidden": D },
  R4: { closed: R, "stale-object": R, "discard-bound": R, "tab-hidden": D },
  R5: { closed: R, "stale-object": R, "discard-bound": P, "tab-hidden": P },
  R6: { closed: R, "stale-object": R, "discard-bound": P, "tab-hidden": D },
  R7: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  R8: { closed: R, "stale-object": R, "discard-bound": R, "tab-hidden": D },
  R9: { closed: R, "stale-object": P, "discard-bound": R, "tab-hidden": D },
  // R10 судить схований об'єкт, а не ціль: несумісного тримача відмовляє
  // пізня відмова (рішення архітекторки 25.11).
  R10: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  R11: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  R12: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  R13: { closed: R, "stale-object": R, "discard-bound": R, "tab-hidden": D },
  R14: { closed: R, "stale-object": R, "discard-bound": P, "tab-hidden": P },
  // R15 судить позначку вигляду, а не межу сесії: хвіст над виглядом, чий
  // політ упав збоєм, читає й за межею (рішення архітекторки 25.11).
  R15: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  R16: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  R17: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  R18: { closed: R, "stale-object": P, "discard-bound": R, "tab-hidden": D },
  K1: { closed: R, "stale-object": R, "discard-bound": R, "tab-hidden": D },
  K2: { closed: R, "stale-object": R, "discard-bound": R, "tab-hidden": D },
  K3: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  K4: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  S1: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  S2: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
  S3: { closed: R, "stale-object": P, "discard-bound": P, "tab-hidden": P },
}

describe("the gate per code of Appendix Б: base and overrides", () => {
  it.each(SITE_CODES)("%s", (code) => {
    // Контроль: без умови шлюз дозволяє кожному коду.
    expect(verdictOf(answer(code, undefined)), `${code} control`).toBe(P)
    for (const condition of JUDGED_CONDITIONS) {
      const got = answer(code, condition)
      const want = EFFECTIVE[code][condition]
      expect(verdictOf(got), `${code} × ${condition}`).toBe(want)
      // Відмова й відкладення називають умову, що їх дала.
      if (want === R) expect(got).toEqual({ refused: condition })
      if (want === D) expect(got).toEqual({ deferred: condition })
    }
  })

  it("every override differs from its base cell and names its basis", () => {
    for (const code of SITE_CODES) {
      const { cause, target } = SITES[code]
      for (const [condition, override] of Object.entries(
        OVERRIDES[code] ?? {}
      )) {
        const label = `${code} × ${condition}`
        expect(
          baseAnswer(cause, target.kind, condition as JudgedCondition),
          label
        ).not.toBe(override.answer)
        expect(Object.keys(override.basis), label).toHaveLength(1)
      }
    }
  })
})

describe("closed: the session token is invalid (Р-SK1-5)", () => {
  // `closedSnapshot` шлюз не бачить узагалі: вікно «токен недійсний, знімок
  // закриття ще не виставлено» — це просто недійсний токен.
  it("refuses every code when the token is invalid, before any other condition", () => {
    const gate = createGate({
      token: () => SHUT,
      staleObject: () => true,
      discardBound: () => true,
      tabHidden: () => true,
    })
    for (const code of SITE_CODES) {
      const { cause, target } = SITES[code]
      expect(gate.admit(cause, target, code), code).toEqual({
        refused: "closed",
      })
    }
  })

  it("reads the token at the moment of admit, not at creation", () => {
    let valid = true
    const gate = createGate({ token: () => ({ valid }) })
    const { cause, target } = SITES.M1
    expect(isPermit(gate.admit(cause, target, "M1"))).toBe(true)
    valid = false
    expect(gate.admit(cause, target, "M1")).toEqual({ refused: "closed" })
  })

  it("the timer query asks the same predicate, at the moment of the question", () => {
    let valid = true
    const gate = createGate({ token: () => ({ valid }) })
    expect(gate.closed()).toBe(false)
    valid = false
    expect(gate.closed()).toBe(true)
  })

  it("a condition without a state function never holds", () => {
    const gate = createGate({ token: () => OPEN })
    for (const code of SITE_CODES) {
      const { cause, target } = SITES[code]
      expect(isPermit(gate.admit(cause, target, code)), code).toBe(true)
    }
  })
})

describe("stale-object: the sticky mark of the object (Р-SK1-6)", () => {
  it("judges the object of the target at the moment of admit", () => {
    const stale = new Set<string>()
    const gate = createGate({
      token: () => OPEN,
      staleObject: (object) => stale.has(object),
    })
    const { cause, target } = SITES.M5
    expect(isPermit(gate.admit(cause, target, "M5"))).toBe(true)
    stale.add(OBJECT)
    expect(gate.admit(cause, target, "M5")).toEqual({
      refused: "stale-object",
    })
    // Інший об'єкт тієї самої сесії не зачеплено.
    expect(
      isPermit(
        gate.admit(
          cause,
          { kind: "view", object: "Catalog.Other", id: 1 },
          "M5"
        )
      )
    ).toBe(true)
  })

  it("the late refusal asks the same predicate, at the moment of the question", () => {
    const stale = new Set<string>()
    const gate = createGate({
      token: () => OPEN,
      staleObject: (object) => stale.has(object),
    })
    expect(gate.staleObject(OBJECT)).toBe(false)
    stale.add(OBJECT)
    expect(gate.staleObject(OBJECT)).toBe(true)
    expect(gate.staleObject("Catalog.Other")).toBe(false)
    // Без функції стану умова не настає й для пізньої відмови.
    expect(createGate({ token: () => OPEN }).staleObject(OBJECT)).toBe(false)
  })
})

describe("discard-bound: the discard limit of the session (Р-SK1-7)", () => {
  it("judges the limit at the moment of admit; the two queries ask the same predicate", () => {
    let unavailable = false
    const gate = createGate({
      token: () => OPEN,
      discardBound: () => unavailable,
    })
    const { cause, target } = SITES.R13
    expect(isPermit(gate.admit(cause, target, "R13"))).toBe(true)
    expect(gate.discardBound()).toBe(false)
    expect(gate.settledPastBound()).toBe(false)
    unavailable = true
    expect(gate.admit(cause, target, "R13")).toEqual({
      refused: "discard-bound",
    })
    expect(gate.discardBound()).toBe(true)
    expect(gate.settledPastBound()).toBe(true)
    // Без функції стану умова не настає й для запитів.
    const bare = createGate({ token: () => OPEN })
    expect(bare.discardBound()).toBe(false)
    expect(bare.settledPastBound()).toBe(false)
  })

  // Мутації самотесту сягають рішення шлюзу лише для кодів свого шляху:
  // прапорець, що відкрив би межу всім, ловився б чужою перевіркою.
  it.each([
    ["scheduler-reads-unavailable", ["R1", "R2", "R3"]],
    ["receiver-reads-unavailable", ["K1", "K2", "R8", "R9"]],
  ] as const)(
    "the defect %s admits only the codes of its path",
    (flag, own) => {
      const gate = createGate({
        token: () => OPEN,
        discardBound: () => true,
        defects: new Set([flag]),
      })
      for (const code of SITE_CODES) {
        const { cause, target } = SITES[code]
        const want: Verdict = (own as readonly SiteCode[]).includes(code)
          ? P
          : EFFECTIVE[code]["discard-bound"]
        expect(verdictOf(gate.admit(cause, target, code)), code).toBe(want)
      }
      // Запити таймерів і осідання прапорець не чіпає: їх вимикає шлях.
      expect(gate.discardBound()).toBe(true)
      expect(gate.settledPastBound()).toBe(true)
    }
  )
})

describe("tab-hidden: the tab state of the core (Р-SK1-8)", () => {
  it("judges the tab at the moment of admit; the query asks the same predicate", () => {
    let hidden = false
    const gate = createGate({ token: () => OPEN, tabHidden: () => hidden })
    const { cause, target } = SITES.R13
    expect(isPermit(gate.admit(cause, target, "R13"))).toBe(true)
    expect(gate.tabHidden()).toBe(false)
    hidden = true
    expect(gate.admit(cause, target, "R13")).toEqual({ deferred: "tab-hidden" })
    expect(gate.tabHidden()).toBe(true)
    // Без функції стану умова не настає й для запиту.
    expect(createGate({ token: () => OPEN }).tabHidden()).toBe(false)
  })

  // Мутація самотесту сягає рішення шлюзу лише для кодів, які читає такт.
  it("the defect scheduler-fires-hidden admits only the codes of the tick", () => {
    const own: readonly SiteCode[] = ["R1", "R2", "R3", "R4"]
    const gate = createGate({
      token: () => OPEN,
      tabHidden: () => true,
      defects: new Set(["scheduler-fires-hidden"]),
    })
    for (const code of SITE_CODES) {
      const { cause, target } = SITES[code]
      const want: Verdict = own.includes(code)
        ? P
        : EFFECTIVE[code]["tab-hidden"]
      expect(verdictOf(gate.admit(cause, target, code)), code).toBe(want)
    }
    // Запит вкладки прапорець не чіпає: видимість вимикає сам планувальник.
    expect(gate.tabHidden()).toBe(true)
  })
})

describe("the permit issues one flight (рішення архітекторки 25.11)", () => {
  it("issues a flight of this gate with the cause, target and code of admit", () => {
    const gate = createGate({ token: () => OPEN })
    const other = createGate({ token: () => OPEN })
    const permit = gate.admit({ reason: "user" }, VIEW, "R7")
    if (!isPermit(permit)) throw new Error("refused")
    expect(permit.why).toEqual({ reason: "user", site: "R7" })
    expect(permit.target).toEqual(VIEW)
    const flight = permit.flight({ attempt: 3 })
    expect(gate.issued(flight)).toBe(true)
    expect(other.issued(flight)).toBe(false)
    expect(recordOf(flight)).toEqual({
      reason: "user",
      target: VIEW,
      site: "R7",
      attempt: 3,
    })
  })

  it("throws on a second flight", () => {
    const permit = createGate({ token: () => OPEN }).admit(
      { reason: "user" },
      VIEW,
      "R7"
    )
    if (!isPermit(permit)) throw new Error("refused")
    permit.flight()
    expect(() => permit.flight()).toThrow("a permit issues one flight")
  })

  it("the flight is an immutable value", () => {
    const permit = createGate({ token: () => OPEN }).admit(
      { reason: "user" },
      VIEW,
      "R7"
    )
    if (!isPermit(permit)) throw new Error("refused")
    const flight = permit.flight()
    expect(Object.isFrozen(flight)).toBe(true)
    expect(() => {
      ;(flight as { site: string }).site = "R1"
    }).toThrow(TypeError)
  })
})

describe("diagnostics queries of the gate (Р-SK1-12)", () => {
  it("refusal lists closed, stale-object and discard-bound in the order of §5.3; a service has no object", () => {
    const stale = new Set<string>()
    let unavailable = false
    let valid = true
    const gate = createGate({
      token: () => (valid ? OPEN : SHUT),
      staleObject: (object) => stale.has(object),
      discardBound: () => unavailable,
    })
    expect(gate.refusal(OBJECT)).toBeUndefined()
    unavailable = true
    expect(gate.refusal(OBJECT)).toBe("discard-bound")
    expect(gate.refusal()).toBeUndefined()
    stale.add(OBJECT)
    expect(gate.refusal(OBJECT)).toBe("stale-object")
    valid = false
    expect(gate.refusal(OBJECT)).toBe("closed")
    expect(gate.refusal()).toBe("closed")
  })

  it("timersRead needs a visible tab, a compatible object and a session within the limit", () => {
    const stale = new Set<string>()
    let hidden = false
    let unavailable = false
    const state: GateState = {
      token: () => OPEN,
      staleObject: (object) => stale.has(object),
      discardBound: () => unavailable,
      tabHidden: () => hidden,
    }
    const gate = createGate(state)
    expect(gate.timersRead(OBJECT)).toBe(true)
    hidden = true
    expect(gate.timersRead(OBJECT)).toBe(false)
    hidden = false
    stale.add(OBJECT)
    expect(gate.timersRead(OBJECT)).toBe(false)
    stale.clear()
    unavailable = true
    expect(gate.timersRead(OBJECT)).toBe(false)
    // Мутація самотесту відкриває межу таймерам.
    expect(
      createGate({
        ...state,
        defects: new Set(["scheduler-reads-unavailable"]),
      }).timersRead(OBJECT)
    ).toBe(true)
  })
})
