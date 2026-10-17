import {
  encodeId,
  FactBase,
  type DependencyEdge,
  type Fact,
  type StableId,
} from "@supabase/pg-delta"
import { describe, expect, it } from "vitest"
import { typePhase } from "../pg-delta/type-phase"

const schema = (name: string): StableId => ({ kind: "schema", name })
const app = schema("app")
const color: StableId = { kind: "type", schema: "app", name: "color" }
const table: StableId = { kind: "table", schema: "app", name: "t" }
const column: StableId = {
  kind: "column",
  schema: "app",
  table: "t",
  name: "c",
}
const domain: StableId = { kind: "domain", schema: "app", name: "positive" }
const check: StableId = {
  kind: "constraint",
  schema: "app",
  table: "positive",
  name: "positive_check",
}
const isPositive: StableId = {
  kind: "function",
  schema: "app",
  name: "is_positive",
  args: ["integer"],
}
const publicGrant: StableId = {
  kind: "acl",
  target: schema("public"),
  grantee: "anon",
}

const fact = (id: StableId, parent?: StableId): Fact => ({
  id,
  ...(parent === undefined ? {} : { parent }),
  payload: {},
})
const depends = (from: StableId, to: StableId): DependencyEdge => ({
  from,
  to,
  kind: "depends",
})

/** Засіяна копія: схема `public` з грантом пресету. */
const seeded = new FactBase(
  [fact(schema("public")), fact(publicGrant, schema("public"))],
  []
)

const ids = (base: FactBase | undefined) =>
  (base?.facts() ?? []).map((f) => encodeId(f.id)).sort()

describe("typePhase", () => {
  it("adds an enum and its schema, not the table that uses it", () => {
    const target = new FactBase(
      [
        fact(schema("public")),
        fact(app),
        fact(color, app),
        fact(table, app),
        fact(column, table),
      ],
      [depends(color, app), depends(table, app), depends(column, color)]
    )
    const phase = typePhase(seeded, target)
    expect(ids(phase)).toEqual(
      [schema("public"), publicGrant, app, color].map(encodeId).sort()
    )
  })

  it("keeps every seeded fact when the boundary schema has no types", () => {
    // Межа `app, public`: факти цілі в `public` без типів не замінюють засіяні,
    // інакше план фази 1 зняв би гранти пресету
    const target = new FactBase(
      [fact(schema("public")), fact(app), fact(color, app)],
      [depends(color, app)]
    )
    const phase = typePhase(seeded, target)
    for (const f of seeded.facts()) expect(phase?.has(f.id)).toBe(true)
  })

  it("adds a domain with its check and the function the check calls", () => {
    const target = new FactBase(
      [
        fact(schema("public")),
        fact(app),
        fact(domain, app),
        fact(check, domain),
        fact(isPositive, app),
      ],
      [depends(domain, app), depends(check, isPositive)]
    )
    expect(ids(typePhase(seeded, target))).toEqual(
      [schema("public"), publicGrant, app, domain, check, isPositive]
        .map(encodeId)
        .sort()
    )
  })

  it("builds no phase when the closure reaches a table", () => {
    // Функція перевірки домену читає таблицю: типи раніше за таблиці не
    // відокремити
    const target = new FactBase(
      [
        fact(schema("public")),
        fact(app),
        fact(domain, app),
        fact(check, domain),
        fact(isPositive, app),
        fact(table, app),
      ],
      [depends(check, isPositive), depends(isPositive, table)]
    )
    expect(typePhase(seeded, target)).toBeUndefined()
  })

  it("builds no phase without types", () => {
    const target = new FactBase(
      [fact(schema("public")), fact(app), fact(table, app)],
      [depends(table, app)]
    )
    expect(typePhase(seeded, target)).toBeUndefined()
  })

  it("builds no phase when the copy already has every type", () => {
    const both = new FactBase(
      [fact(schema("public")), fact(app), fact(color, app)],
      []
    )
    expect(typePhase(both, both)).toBeUndefined()
  })

  it("keeps only edges whose both ends are in the phase", () => {
    const target = new FactBase(
      [
        fact(schema("public")),
        fact(app),
        fact(color, app),
        fact(table, app),
        fact(column, table),
      ],
      [depends(color, app), depends(column, color), depends(table, app)]
    )
    const phase = typePhase(seeded, target)!
    expect(phase.edges.length).toBeGreaterThan(0)
    for (const edge of phase.edges) {
      expect(phase.has(edge.from)).toBe(true)
      expect(phase.has(edge.to)).toBe(true)
    }
    expect(phase.edges).toEqual([depends(color, app)])
  })
})
