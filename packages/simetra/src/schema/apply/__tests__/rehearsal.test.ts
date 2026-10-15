import { describe, expect, it } from "vitest"
import {
  countOf,
  parseRehearsal,
  planFileName,
  REHEARSAL_FORMAT,
  rehearsalFileName,
  rehearsalHash,
  rehearsalReport,
  serializeRehearsal,
  statementTimeoutFromReport,
  type RehearsalEvidence,
  type RehearsalReport,
} from "simetra/schema"

describe("countOf", () => {
  it("reads a count as a safe integer", () => {
    expect(countOf("12")).toBe(12)
    expect(countOf(0)).toBe(0)
    expect(countOf("0")).toBe(0)
    // Від'ємне, понад безпечне ціле, дробове чи не лічильник — дефект порту
    for (const bad of [
      "-1",
      "9007199254740993",
      "1.5",
      "",
      "12a",
      null,
      1.5,
      -1,
    ])
      expect(() => countOf(bad), String(bad)).toThrow(Error)
  })
})

const PLAN_HASH = "a".repeat(64)

/** Докази раннера з дробовими тривалостями, як їх дає `performance.now`. */
const evidence: RehearsalEvidence = {
  server: {
    major: 17,
    encoding: "UTF8",
    collate: "C.UTF-8",
    ctype: "C.UTF-8",
    localeProvider: "c",
    locale: null,
    collationVersion: null,
  },
  ledgerHead: "6f1c1e8e-3d7a-4c3e-9f55-0b7f0a2d9c11",
  rows: [{ schema: "app", table: "t", rows: 10 }],
  durations: {
    phases: [
      { phase: "advisory", extractMs: 0 },
      { phase: "compute", extractMs: 0 },
      { phase: "write", extractMs: 0 },
      { phase: "intent", extractMs: 0 },
      { phase: "proof", extractMs: 12.2 },
      { phase: "state", extractMs: 0 },
    ],
    steps: [
      { id: "advisory-1", phase: "advisory", ms: 0.2 },
      { id: "compute-1", phase: "compute", ms: 1.5 },
      { id: "compute-table-1", phase: "compute", ms: 2.1 },
      { id: "write-table-1", phase: "write", ms: 3 },
      { id: "constraints-data", phase: "write", ms: 0.01 },
      { id: "s1", phase: "intent", ms: 4.4 },
      { id: "proof-1", phase: "proof", ms: 0.5 },
    ],
  },
  data: [{ schema: "app", table: "t", computed: 10, written: 10 }],
  preservation: [{ schema: "app", table: "t", rows: 10 }],
  plpgsqlCheck: {
    mode: "installed",
    baseline: [],
    after: [
      {
        oid: "16400",
        signature: "app.f()",
        relationOid: null,
        relation: null,
        sqlstate: "42703",
        message: 'column "x" does not exist',
      },
    ],
  },
  triggers: [{ schema: "app", table: "t", name: "tg", enabled: "O" }],
  lockFootprint: [{ table: "app.w", mode: "SHARE", planned: "none" }],
}

const report = (): RehearsalReport => rehearsalReport(PLAN_HASH, evidence)

/** Звіт з підміненими тривалостями — для перевірок схеми. */
const withSteps = (steps: { id: string; ms: number }[]): string =>
  JSON.stringify({
    ...report(),
    durations: { ...report().durations, steps },
  })

describe("rehearsalReport", () => {
  it("rounds every statement up once and sums the phases from the rounded statements", () => {
    const { durations, format, planHash } = report()
    expect(format).toBe(REHEARSAL_FORMAT)
    expect(planHash).toBe(PLAN_HASH)
    // Округлення вгору: тайм-аут, виведений зі звіту, не недооцінює оператор
    expect(durations.steps).toEqual([
      { id: "advisory-1", ms: 1 },
      { id: "compute-1", ms: 2 },
      { id: "compute-table-1", ms: 3 },
      { id: "write-table-1", ms: 3 },
      { id: "constraints-data", ms: 1 },
      { id: "s1", ms: 5 },
      { id: "proof-1", ms: 1 },
    ])
    // Фаза — сума вже округлених операторів; доказ — ще й округлений витяг
    expect(durations.phases).toEqual([
      { phase: "advisory", ms: 1 },
      { phase: "compute", ms: 5 },
      { phase: "write", ms: 4 },
      { phase: "intent", ms: 5 },
      { phase: "proof", ms: 1 + 13 },
      { phase: "state", ms: 0 },
    ])
    // Найдовший — максимум округлених операторів, не витяг
    expect(durations.longestStatementMs).toBe(5)
  })
})

describe("rehearsal file", () => {
  it("round-trips a report through its canonical form", async () => {
    const text = serializeRehearsal(report())
    expect(text.endsWith("}\n")).toBe(true)
    const parsed = parseRehearsal(text)
    expect(parsed).toEqual({ ok: true, report: report() })
    if (!parsed.ok) throw new Error(parsed.message)
    // Канонічна форма: той самий звіт — той самий текст і хеш
    expect(serializeRehearsal(parsed.report)).toBe(text)
    expect(await rehearsalHash(parsed.report)).toBe(
      await rehearsalHash(report())
    )
    expect(await rehearsalHash(report())).toMatch(/^[0-9a-f]{64}$/)
    expect(await rehearsalHash({ ...report(), ledgerHead: null })).not.toBe(
      await rehearsalHash(report())
    )
  })

  it("refuses an unknown field", () => {
    for (const text of [
      JSON.stringify({ ...report(), extra: 1 }),
      JSON.stringify({
        ...report(),
        rows: [{ schema: "app", table: "t", rows: 1, note: "x" }],
      }),
    ]) {
      const parsed = parseRehearsal(text)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.reason).toBe("invalid")
    }
    expect(parseRehearsal("not json")).toMatchObject({
      ok: false,
      reason: "invalid",
    })
  })

  it("reports another format as format", () => {
    expect(
      parseRehearsal(JSON.stringify({ ...report(), format: 2, other: true }))
    ).toMatchObject({ ok: false, reason: "format" })
  })

  it("refuses a fractional or negative duration and a fractional count", () => {
    for (const text of [
      withSteps([{ id: "s1", ms: 1.5 }]),
      withSteps([{ id: "s1", ms: -1 }]),
      JSON.stringify({
        ...report(),
        durations: { ...report().durations, longestStatementMs: 0.5 },
      }),
      JSON.stringify({
        ...report(),
        rows: [{ schema: "app", table: "t", rows: 1.5 }],
      }),
    ])
      expect(parseRehearsal(text)).toMatchObject({
        ok: false,
        reason: "invalid",
      })
  })

  it("refuses a duplicate statement id", () => {
    expect(
      parseRehearsal(
        withSteps([
          { id: "s1", ms: 1 },
          { id: "s1", ms: 1 },
        ])
      )
    ).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("refuses a statement id outside the scheme", () => {
    for (const id of [
      "d1",
      "foo-1",
      "s0",
      "compute-table-0",
      "compute-table",
      "intent-0",
      "constraints-other",
    ])
      expect(parseRehearsal(withSteps([{ id, ms: 1 }])), id).toMatchObject({
        ok: false,
        reason: "invalid",
      })
    // Кожна форма схеми id приймається
    expect(
      parseRehearsal(
        withSteps(
          [
            "s12",
            "compute-table-2",
            "write-table-1",
            "constraints-data",
            "constraints-deferred",
            "measureBefore-3",
            "compute-1",
          ].map((id) => ({ id, ms: 1 }))
        )
      ).ok
    ).toBe(true)
  })

  it("refuses a phase outside the phase list", () => {
    expect(
      parseRehearsal(
        JSON.stringify({
          ...report(),
          durations: {
            ...report().durations,
            phases: [{ phase: "warmup", ms: 1 }],
          },
        })
      )
    ).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("refuses a duplicate phase", () => {
    expect(
      parseRehearsal(
        JSON.stringify({
          ...report(),
          durations: {
            ...report().durations,
            phases: [
              { phase: "advisory", ms: 1 },
              { phase: "advisory", ms: 1 },
            ],
          },
        })
      )
    ).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("names the report after the plan", () => {
    const h = "0123456789abcdef".repeat(4)
    for (const from of [null, "fedcba9876543210".repeat(4)])
      expect(rehearsalFileName(from, h)).toBe(
        planFileName(from, h).replace(/\.plan\.json$/, ".rehearsal.json")
      )
    expect(rehearsalFileName(null, h)).toBe(
      "initial-0123456789ab.rehearsal.json"
    )
  })
})

describe("statementTimeoutFromReport", () => {
  /** Звіт з рядками копії й найдовшим оператором репетиції. */
  const timed = (
    longestStatementMs: number,
    rows: RehearsalReport["rows"]
  ): RehearsalReport => ({
    ...report(),
    rows,
    durations: { ...report().durations, longestStatementMs },
  })
  /** Лише значення тайм-ауту — для випадків нижче межі. */
  const timeoutMs = (...a: Parameters<typeof statementTimeoutFromReport>) =>
    statementTimeoutFromReport(...a).ms
  const copy = [
    { schema: "app", table: "a", rows: 10 },
    { schema: "app", table: "b", rows: 1000 },
  ]
  const target = [
    { schema: "app", table: "a", rows: 1000 },
    { schema: "app", table: "b", rows: 1000 },
  ]

  it("scales by the worst table, not the sum", () => {
    // Review Focus 5: `a` у сто разів більша на цілі, `b` рівна — множник
    // 100, а не відношення сум (2000 / 1010)
    expect(timeoutMs(timed(100, copy), target)).toBe(60_000)
    expect(timeoutMs(timed(1000, copy), target)).toBe(300_000)
  })

  it("has a floor of a minute", () => {
    expect(timeoutMs(timed(0, copy), target)).toBe(60_000)
    // Ціль, меншу за копію, множник не зменшує нижче одиниці
    expect(
      timeoutMs(
        timed(30_000, copy),
        copy.map((t) => ({ ...t, rows: 1 }))
      )
    ).toBe(90_000)
  })

  it("leaves out a table empty on the copy", () => {
    // Відношення до нуля немає; таку таблицю з рядками на цілі зупиняє фаза 6c
    expect(
      timeoutMs(timed(30_000, [{ schema: "app", table: "a", rows: 0 }]), [
        { schema: "app", table: "a", rows: 5 },
      ])
    ).toBe(90_000)
  })

  it("rounds a fractional product up", () => {
    expect(
      timeoutMs(timed(20_001, [{ schema: "app", table: "a", rows: 3 }]), [
        { schema: "app", table: "a", rows: 4 },
      ])
    ).toBe(80_004)
  })

  it("caps the timeout at the Postgres limit", () => {
    // Рішення R10: формула з L = 1 і копією в 3 рядки дає рівно рядки цілі
    const at = (rows: number) =>
      statementTimeoutFromReport(
        timed(1, [{ schema: "app", table: "a", rows: 3 }]),
        [{ schema: "app", table: "a", rows }]
      )
    expect(at(2_147_483_647)).toEqual({
      ms: 2_147_483_647,
      computed: 2_147_483_647,
      clamped: false,
    })
    expect(at(2_147_483_648)).toEqual({
      ms: 2_147_483_647,
      computed: 2_147_483_648,
      clamped: true,
    })
    expect(at(1e15)).toEqual({
      ms: 2_147_483_647,
      computed: 1e15,
      clamped: true,
    })
  })
})
