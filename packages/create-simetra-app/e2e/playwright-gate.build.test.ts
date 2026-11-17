// Захист від хибно-зеленого (`playwright-gate.mjs`): `skipped`, `flaky`,
// перервано й нуль тестів червоніють; чистий звіт проходить.
import { describe, expect, it } from "vitest"
import { checkReport } from "./playwright-gate.mjs"

const report = (...statuses: Array<[string, string]>) => ({
  suites: [
    {
      specs: statuses.map(([title, status]) => ({
        title,
        tests: [{ status, results: [{ status: "passed" }] }],
      })),
    },
  ],
})

describe("playwright-gate", () => {
  it("passes a report of expected tests", () => {
    expect(checkReport(report(["a", "expected"], ["b", "expected"]))).toEqual(
      []
    )
  })

  it("fails on a skipped test", () => {
    expect(checkReport(report(["a", "expected"], ["b", "skipped"]))).toEqual([
      "skipped: b",
    ])
  })

  it("fails on a flaky test", () => {
    expect(checkReport(report(["a", "flaky"]))).toEqual(["flaky: a"])
  })

  it("fails on a failed test", () => {
    expect(checkReport(report(["a", "unexpected"]))).toEqual(["unexpected: a"])
  })

  it("fails on an interrupted attempt", () => {
    const interrupted = {
      suites: [
        {
          specs: [
            {
              title: "a",
              tests: [
                { status: "expected", results: [{ status: "interrupted" }] },
              ],
            },
          ],
        },
      ],
    }
    expect(checkReport(interrupted)).toEqual(["interrupted: a"])
  })

  it("fails on a report with no tests", () => {
    expect(checkReport({ suites: [] })).toEqual(["the report has no tests"])
  })

  it("reads nested suites", () => {
    const nested = {
      suites: [{ suites: [report(["deep", "skipped"]).suites[0]] }],
    }
    expect(checkReport(nested)).toEqual(["skipped: deep"])
  })
})
