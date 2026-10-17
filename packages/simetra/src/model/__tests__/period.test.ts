import { describe, expect, it } from "vitest"
import { truncatedPeriodExpression } from "simetra/model"

describe("truncatedPeriodExpression", () => {
  it("truncates in project timezone", () => {
    expect(truncatedPeriodExpression("period", "month", "Europe/Kyiv")).toBe(
      "date_trunc('month', (period AT TIME ZONE 'Europe/Kyiv'))::date"
    )
  })

  it("quotes the column like quote_ident", () => {
    expect(truncatedPeriodExpression("Period", "day", "UTC")).toBe(
      `date_trunc('day', ("Period" AT TIME ZONE 'UTC'))::date`
    )
  })

  it("escapes quote in timezone", () => {
    expect(truncatedPeriodExpression("period", "year", "A'B")).toBe(
      "date_trunc('year', (period AT TIME ZONE 'A''B'))::date"
    )
  })
})
