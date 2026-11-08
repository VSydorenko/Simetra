import { describe, expect, it } from "vitest"
import { rowVersionSteps, type RowVersionInput } from "../row-version"

const t = { schema: "app", name: "items" }
const input = (o: Partial<RowVersionInput>): RowVersionInput => ({
  sequenceFresh: false,
  epochExists: true,
  mechanicsTables: [],
  entering: [],
  rewritten: [],
  ...o,
})

describe("rowVersionSteps", () => {
  it.each([
    ["nothing to do", input({}), []],
    [
      "fresh sequence over a mechanics table",
      input({ sequenceFresh: true, mechanicsTables: [t] }),
      ["validationScan", "catalogOnly"],
    ],
    [
      "entering table without a new epoch",
      input({ entering: [t] }),
      ["validationScan"],
    ],
    ["missing epoch row only", input({ epochExists: false }), ["catalogOnly"]],
    [
      "fresh sequence without tables",
      input({ sequenceFresh: true }),
      ["catalogOnly"],
    ],
  ])("%s", (_, i, classes) => {
    const steps = rowVersionSteps(i, 3)
    expect(steps.map((s) => s.class)).toEqual(classes)
    expect(steps.every((s) => s.origin === "versions")).toBe(true)
    expect(steps.map((s) => s.id)).toEqual(classes.map((_, k) => `s${4 + k}`))
  })

  it("seeds a fresh sequence under locks and an entering table after a lock-free check", () => {
    const [fresh] = rowVersionSteps(
      input({ sequenceFresh: true, mechanicsTables: [t] }),
      0
    )
    expect(fresh!.sql).toContain("LOCK TABLE app.items IN SHARE MODE")
    expect(fresh!.sql.indexOf("LOCK TABLE")).toBeLessThan(
      fresh!.sql.indexOf("setval")
    )
    const [entering] = rowVersionSteps(input({ entering: [t] }), 0)
    expect(entering!.sql.indexOf("IF v_max >= v_next")).toBeLessThan(
      entering!.sql.indexOf("LOCK TABLE")
    )
    expect(entering!.lockedTables).toEqual([t])
  })
})
