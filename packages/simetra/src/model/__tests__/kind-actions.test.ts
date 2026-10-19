import { describe, it, expect } from "vitest"
import {
  catalogSchema,
  constantSchema,
  documentSchema,
  informationRegisterSchema,
} from "../schemas"
import { KIND_REGISTRY } from "../kinds/registry"
import { actionRequires, closeRequires } from "../kinds/actions"

const ID = "3f2b8a52-6d1e-4c0a-9b7e-5a1c2d3e4f50"
const base = (kind: string) => ({ id: ID, kind, name: "Sample" })

const minimalCatalog = catalogSchema.parse(base("Catalog"))
const minimalDocument = documentSchema.parse(base("Document"))
const minimalConstant = constantSchema.parse({
  ...base("Constant"),
  type: "Integer",
})

const registerNames = (overrides: Record<string, unknown>) =>
  KIND_REGISTRY.InformationRegister.actions(
    informationRegisterSchema.parse({
      ...base("InformationRegister"),
      periodicity: "NonPeriodic",
      ...overrides,
    })
  ).map((a) => a.name)

describe("actions(obj)", () => {
  it("gives a catalog the reference vocabulary with read-only edges", () => {
    const actions = KIND_REGISTRY.Catalog.actions(minimalCatalog)
    expect(actions.map((a) => [a.name, actionRequires(a)])).toEqual([
      ["read", []],
      ["create", ["read"]],
      ["update", ["read"]],
      ["markDeletion", ["read"]],
      ["delete", ["read"]],
    ])
    expect(actions.find((a) => a.name === "markDeletion")!.effects).toEqual({
      dml: ["update"],
      header: ["deletionMark"],
      tabularSections: false,
    })
  })

  it("chains document posting: post requires update, unpost requires post", () => {
    const actions = KIND_REGISTRY.Document.actions(minimalDocument)
    const close = closeRequires(
      actions.map((a) => ({ name: a.name, requires: actionRequires(a) }))
    )
    expect(close.get("unpost")).toEqual(["post", "read", "update"])
    // Вимога не переносить ефектів: post пише лише свою ознаку, не шапку й ТЧ.
    expect(actions.find((a) => a.name === "post")!.effects).toEqual({
      dml: ["update"],
      header: ["posted"],
      tabularSections: false,
    })
  })

  it("marks tabular sections only for kinds that have them", () => {
    const update = (kind: "Catalog" | "Constant", obj: unknown) =>
      KIND_REGISTRY[kind].actions(obj).find((a) => a.name === "update")!
    expect(update("Catalog", minimalCatalog).effects.tabularSections).toBe(true)
    expect(update("Constant", minimalConstant).effects.tabularSections).toBe(
      false
    )
  })

  it("gives an independent information register a write action and a subordinate one none", () => {
    expect(registerNames({ writeMode: "Independent" })).toEqual([
      "read",
      "write",
    ])
    expect(registerNames({ writeMode: "RecorderSubordinate" })).toEqual([
      "read",
    ])
  })

  it("lets a constant insert or update its value", () => {
    expect(
      KIND_REGISTRY.Constant.actions(minimalConstant).find(
        (a) => a.name === "update"
      )!.effects.dml
    ).toEqual(["insert", "update"])
  })

  it("gives kinds without rows no actions", () => {
    for (const kind of [
      "Enumeration",
      "PgEnum",
      "EventSubscription",
    ] as const) {
      expect(KIND_REGISTRY[kind].actions({}), kind).toEqual([])
    }
  })

  it("rejects a requirement cycle in the closure", () => {
    expect(() =>
      closeRequires([
        { name: "a", requires: ["b"] },
        { name: "b", requires: ["a"] },
      ])
    ).toThrow(/cycle/)
  })

  it("declares extents and container facts in the registry", () => {
    expect(KIND_REGISTRY.Catalog.rightsExtents).toEqual([
      "any",
      "own",
      "dimension",
    ])
    expect(KIND_REGISTRY.AccumulationRegister.rightsExtents).toEqual([
      "any",
      "dimension",
    ])
    expect(KIND_REGISTRY.Constant.rightsExtents).toEqual(["any"])
    expect(KIND_REGISTRY.CustomTable.rightsExtents).toEqual([])
    expect(KIND_REGISTRY.Catalog.rightsContainer).toBe(true)
    expect(KIND_REGISTRY.Catalog.rightsBinding).toBe(true)
    expect(KIND_REGISTRY.Document.rightsBinding).toBe(true)
    expect(KIND_REGISTRY.Document.rightsContainer).toBeUndefined()
  })
})
