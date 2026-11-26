import { describe, it, expect } from "vitest"
import {
  catalogSchema,
  constantSchema,
  documentSchema,
  informationRegisterSchema,
} from "../schemas"
import { KIND_REGISTRY } from "../kinds/registry"
import {
  STANDARD_ACTIONS,
  actionRequires,
  closeRequires,
} from "../kinds/actions"
import { parsePublicRead } from "../schemas/public-read"

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

describe("conditional publicRead (Р-D1-1, Р-D1-8)", () => {
  const conditional = catalogSchema.parse({
    ...base("Catalog"),
    publicRead: { role: "anon", published: true },
  })
  const columnNames = (obj: unknown) =>
    KIND_REGISTRY.Catalog.standardColumns(obj).map((c) => c.logicalName)

  it("the schema accepts the string form and the object form, nothing else", () => {
    expect(
      catalogSchema.parse({ ...base("Catalog"), publicRead: "anon" }).publicRead
    ).toBe("anon")
    expect(conditional.publicRead).toEqual({ role: "anon", published: true })
    for (const publicRead of [
      { role: "anon", published: false },
      { role: "anon" },
      { role: "service", published: true },
      { role: "anon", published: true, extra: 1 },
    ]) {
      expect(
        catalogSchema.safeParse({ ...base("Catalog"), publicRead }).success,
        JSON.stringify(publicRead)
      ).toBe(false)
    }
  })

  it("the column and the actions exist only for the conditional form", () => {
    const published = KIND_REGISTRY.Catalog.standardColumns(conditional).find(
      (c) => c.logicalName === "published"
    )
    expect(published).toMatchObject({
      physicalName: "published",
      type: { type: "Boolean" },
      notNull: true,
      default: "false",
    })
    for (const publicRead of [undefined, "anon"]) {
      const plain = catalogSchema.parse({ ...base("Catalog"), publicRead })
      expect(columnNames(plain)).not.toContain("published")
      expect(
        KIND_REGISTRY.Catalog.actions(plain).map((a) => a.name)
      ).not.toContain("publish")
    }
    const actions = KIND_REGISTRY.Catalog.actions(conditional)
    expect(actions.map((a) => [a.name, actionRequires(a)]).slice(-2)).toEqual([
      ["publish", ["read"]],
      ["unpublish", ["read"]],
    ])
    expect(actions.find((a) => a.name === "publish")!.transition).toEqual({
      column: "published",
      from: false,
      to: true,
    })
    expect(actions.find((a) => a.name === "unpublish")!.transition).toEqual({
      column: "published",
      from: true,
      to: false,
    })
    expect(STANDARD_ACTIONS).toEqual(
      expect.arrayContaining(["publish", "unpublish"])
    )
  })

  it("parsePublicRead gives the role and the flag of both forms", () => {
    expect(parsePublicRead(undefined)).toBeUndefined()
    expect(parsePublicRead("authenticated")).toEqual({
      role: "authenticated",
      conditional: false,
    })
    expect(parsePublicRead({ role: "anon", published: true })).toEqual({
      role: "anon",
      conditional: true,
    })
  })
})
