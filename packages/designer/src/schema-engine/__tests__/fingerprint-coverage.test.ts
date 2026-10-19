import { FactBase } from "@supabase/pg-delta"
import { describe, expect, it } from "vitest"
import { coverageGaps } from "../pg-delta/fingerprint-coverage"

/** Сторож контракту сам ловить обидва напрямки розбіжності. */
describe("coverageGaps", () => {
  const facts = new FactBase(
    [
      { id: { kind: "schema", name: "app" }, payload: {} },
      {
        id: { kind: "table", schema: "app", name: "t" },
        payload: { rowSecurity: true, _hidden: 1, absent: undefined },
      },
    ],
    []
  )

  it("passes a map that matches the model exactly", () => {
    expect(
      coverageGaps(
        facts,
        {
          schema: { "@": "schemas" },
          table: { "@": "inventory", rowSecurity: "relations" },
        },
        {}
      )
    ).toEqual([])
  })

  it("fails on an unmapped property and an unmapped kind", () => {
    expect(coverageGaps(facts, { table: { "@": "inventory" } }, {})).toEqual([
      "unmapped kind schema",
      "unmapped table.rowSecurity",
    ])
  })

  it("fails on a map entry the model no longer has", () => {
    expect(
      coverageGaps(
        facts,
        {
          schema: { "@": "schemas" },
          table: {
            "@": "inventory",
            rowSecurity: "relations",
            gone: "relations",
          },
          view: { "@": "views" },
        },
        { owner: "owner" }
      )
    ).toEqual(["stale edge owner", "stale kind view", "stale table.gone"])
  })

  it("does not require an excepted kind or edge to be observed", () => {
    expect(
      coverageGaps(
        facts,
        {
          schema: { "@": "schemas" },
          table: { "@": "inventory", rowSecurity: "relations" },
          eventTrigger: { "*": { exception: "outside" } },
        },
        { managedBy: { exception: "outside" } }
      )
    ).toEqual([])
  })

  it("accepts any property of a kind excepted as a whole", () => {
    expect(
      coverageGaps(
        facts,
        {
          schema: { "*": { exception: "outside" } },
          table: { "@": "inventory", rowSecurity: "relations" },
        },
        {}
      )
    ).toEqual([])
  })
})
