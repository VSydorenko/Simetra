import { describe, expect, it } from "vitest"
import type { z } from "zod"
import { KIND_REGISTRY } from "../kinds/registry"
import { catalogSchema } from "../schemas/catalog"
import { documentSchema } from "../schemas/document"
import { customTableSchema } from "../schemas/custom-table"
import { informationRegisterSchema } from "../schemas/information-register"
import { customActionSchema, rightsCarrierSchema } from "../schemas/rights"
import { METADATA_KINDS } from "../schemas/metadata-kind"

describe("custom actions", () => {
  it("accepts a custom action with defaults", () => {
    expect(
      customActionSchema.parse({ name: "invite", requires: ["read"] })
    ).toEqual({ name: "invite", requires: ["read"], effects: {} })
    expect(customActionSchema.parse({ name: "invite" })).toEqual({
      name: "invite",
      requires: [],
      effects: {},
    })
  })

  it("rejects an unknown key", () => {
    expect(
      customActionSchema.safeParse({ name: "invite", title: "Invite" }).success
    ).toBe(false)
    expect(
      customActionSchema.safeParse({
        name: "invite",
        effects: { dml: ["update"] },
      }).success
    ).toBe(false)
  })

  it("accepts both header forms", () => {
    for (const header of ["all", ["status"]]) {
      expect(
        customActionSchema.safeParse({ name: "close", effects: { header } })
          .success
      ).toBe(true)
    }
  })

  it("lives on kinds with a rights contract only", () => {
    expect(
      catalogSchema.safeParse({
        kind: "Catalog",
        name: "Project",
        customActions: [{ name: "archive" }],
      }).success
    ).toBe(true)
    expect(
      customTableSchema.safeParse({
        kind: "CustomTable",
        name: "Ledger",
        columns: [{ name: "id", type: "UUID" }],
        customActions: [{ name: "archive" }],
      }).success
    ).toBe(false)
    for (const kind of METADATA_KINDS) {
      const def = KIND_REGISTRY[kind]
      const shape = (def.schema as z.ZodObject).shape
      expect("customActions" in shape, kind).toBe(def.rightsExtents.length > 0)
      expect(
        def.idElementFields?.includes("customActions") === true,
        kind
      ).toBe(def.rightsExtents.length > 0)
    }
  })
})

describe("ownership", () => {
  it("accepts an attribute or a two-step path", () => {
    expect(rightsCarrierSchema.safeParse("assignee").success).toBe(true)
    expect(rightsCarrierSchema.safeParse(["task", "assignee"]).success).toBe(
      true
    )
    expect(rightsCarrierSchema.safeParse(["a", "b", "c"]).success).toBe(false)
    expect(
      catalogSchema.safeParse({
        kind: "Catalog",
        name: "Project",
        ownership: [],
      }).success
    ).toBe(false)
  })

  it("lives on kinds with the own extent only", () => {
    expect(
      informationRegisterSchema.safeParse({
        kind: "InformationRegister",
        name: "MemberRegion",
        ownership: ["member"],
      }).success
    ).toBe(false)
    for (const kind of METADATA_KINDS) {
      const def = KIND_REGISTRY[kind]
      const shape = (def.schema as z.ZodObject).shape
      expect("ownership" in shape, kind).toBe(def.rightsExtents.includes("own"))
    }
  })
})

describe("container and binding", () => {
  it("live on kinds with the registry facts only", () => {
    expect(
      documentSchema.safeParse({
        kind: "Document",
        name: "Task",
        rightsContainer: true,
      }).success
    ).toBe(false)
    for (const kind of METADATA_KINDS) {
      const def = KIND_REGISTRY[kind]
      const shape = (def.schema as z.ZodObject).shape
      expect("rightsContainer" in shape, kind).toBe(
        def.rightsContainer === true
      )
      expect("containerBinding" in shape, kind).toBe(def.rightsBinding === true)
    }
  })
})
