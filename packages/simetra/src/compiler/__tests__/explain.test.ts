import { describe, expect, it } from "vitest"
import { compile, explainObject } from "simetra/compiler"
import { readReferenceDomain } from "./fixtures/reference-domain"

async function referenceModel() {
  const result = await compile(readReferenceDomain())
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

describe("explainObject", () => {
  it("explains a document", async () => {
    const e = explainObject(await referenceModel(), {
      kind: "Document",
      name: "ServiceAccrual",
    })!
    expect(e.object).toMatchObject({
      kind: "Document",
      name: "ServiceAccrual",
      scopeKind: "org",
    })
    // Шапка й обидві ТЧ.
    expect(e.tables.map((t) => t.part)).toEqual([
      "main",
      "tabularSection",
      "tabularSection",
    ])
    const main = e.tables[0]!
    expect(main.columns).toContainEqual(
      expect.objectContaining({
        name: "counterparty_id",
        logical: "counterparty",
      })
    )
    expect(main.columns.map((c) => c.standard)).toEqual(
      expect.arrayContaining(["number", "date"])
    )
    expect(main.columns).toContainEqual(
      expect.objectContaining({ name: "org_id", scope: true })
    )
    expect(e.movementQueries).toHaveLength(2)
    expect(e.contracts.length).toBeGreaterThan(0)
  })

  it("explains a register", async () => {
    const model = await referenceModel()
    const e = explainObject(model, {
      kind: "AccumulationRegister",
      name: "PerformerSettlements",
    })!
    expect(e.tables.map((t) => t.part)).toContain("totals")
    const doc = model.objects.find((o) => o.name === "ServiceAccrual")!
    expect(e.referencedBy.length).toBeGreaterThan(0)
    expect(e.referencedBy.some((r) => r.file === doc.file)).toBe(true)
  })

  it("explains an event subscription: no tables, its trigger contract", async () => {
    const model = await referenceModel()
    const e = explainObject(model, {
      kind: "EventSubscription",
      name: "CheckContractStart",
    })!
    expect(e.tables).toEqual([])
    expect(e.contracts).toEqual([
      expect.objectContaining({
        name: "check_contract_start",
        sources: [{ schema: "app", table: "contract" }],
        whenChanged: ["start_date"],
        handler: { schema: "app", name: "check_contract_start" },
      }),
    ])
    const contract = explainObject(model, {
      kind: "Catalog",
      name: "Contract",
    })!
    expect(contract.referencedBy).toContainEqual(
      expect.objectContaining({ role: "eventSubscription.source" })
    )
  })

  it("unknown object", async () => {
    expect(
      explainObject(await referenceModel(), { kind: "Catalog", name: "Nope" })
    ).toBeUndefined()
  })
})
