import { describe, expect, it } from "vitest"
import type { z } from "zod"
import { KIND_REGISTRY } from "../kinds/registry"
import { catalogSchema } from "../schemas/catalog"
import { documentSchema } from "../schemas/document"
import { customTableSchema } from "../schemas/custom-table"
import { informationRegisterSchema } from "../schemas/information-register"
import { constantSchema } from "../schemas/constant"
import { projectSchema } from "../schemas/project"
import {
  accessDimensionSchema,
  accessMappingSchema,
  assignedOnSchema,
  assignmentSourceSchema,
  customActionSchema,
  membershipSourceSchema,
  rightsCarrierSchema,
} from "../schemas/rights"
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

describe("access dimensions", () => {
  const target = { kind: "Catalog", name: "Region" }

  it("accepts both forms of values", () => {
    expect(
      accessDimensionSchema.safeParse({
        name: "region",
        target,
        values: {
          relation: {
            object: { kind: "InformationRegister", name: "MemberRegion" },
            subject: "member",
            value: "region",
          },
        },
      }).success
    ).toBe(true)
    expect(
      accessDimensionSchema.safeParse({
        name: "region",
        target,
        values: { function: { name: "my_regions" } },
      }).success
    ).toBe(true)
  })

  it("rejects a title until it has a consumer", () => {
    expect(
      accessDimensionSchema.safeParse({
        name: "region",
        title: { en: "Region" },
        target,
        values: { function: { name: "my_regions" } },
      }).success
    ).toBe(false)
  })

  it("lives on the project with an empty default", () => {
    expect(
      projectSchema.parse({ name: "App", database: { provider: "supabase" } })
        .accessDimensions
    ).toEqual([])
  })
})

describe("access mapping", () => {
  it("accepts an attribute or a path", () => {
    expect(
      accessMappingSchema.safeParse({
        attribute: "region",
        dimension: "region",
      }).success
    ).toBe(true)
    expect(
      accessMappingSchema.safeParse({
        ref: ["task", "region"],
        dimension: "region",
      }).success
    ).toBe(true)
    expect(
      accessMappingSchema.safeParse({
        attribute: "region",
        ref: ["task", "region"],
        dimension: "region",
      }).success
    ).toBe(false)
  })

  it("lives on kinds with the dimension extent only", () => {
    expect(
      constantSchema.safeParse({
        kind: "Constant",
        name: "MainCurrency",
        type: "String",
        length: 3,
        access: [{ attribute: "value", dimension: "region" }],
      }).success
    ).toBe(false)
    expect(
      documentSchema.safeParse({
        kind: "Document",
        name: "Task",
        access: [],
      }).success
    ).toBe(false)
    for (const kind of METADATA_KINDS) {
      const def = KIND_REGISTRY[kind]
      const shape = (def.schema as z.ZodObject).shape
      expect("access" in shape, kind).toBe(
        def.rightsExtents.includes("dimension")
      )
    }
  })
})

describe("adopted sources", () => {
  const table = { kind: "CustomTable", name: "RoleGrant" }

  it("assignedOn accepts three forms and rejects a mixed one", () => {
    for (const form of [
      "global",
      { scopeKind: "org" },
      { container: { kind: "Catalog", name: "Project" } },
    ]) {
      expect(
        assignedOnSchema.safeParse(form).success,
        JSON.stringify(form)
      ).toBe(true)
    }
    expect(
      assignedOnSchema.safeParse({
        scopeKind: "org",
        container: { kind: "Catalog", name: "Project" },
      }).success
    ).toBe(false)
    expect(assignedOnSchema.safeParse("scope").success).toBe(false)
  })

  it("parses both sources strictly", () => {
    expect(
      membershipSourceSchema.safeParse({
        name: "members",
        scopeKind: "org",
        table,
        columns: { scope: "orgId", user: "userId", active: "isActive" },
      }).success
    ).toBe(true)
    expect(
      membershipSourceSchema.safeParse({
        name: "members",
        scopeKind: "org",
        table,
        columns: { scope: "orgId", user: "userId", member: "id" },
      }).success
    ).toBe(false)
    expect(
      assignmentSourceSchema.safeParse({
        name: "grants",
        assignedOn: "global",
        table,
        columns: { member: "memberId", role: "roleKey" },
      }).success
    ).toBe(true)
  })

  it("live on the project with empty defaults", () => {
    const parsed = projectSchema.parse({
      name: "App",
      database: { provider: "supabase" },
    })
    expect(parsed.membershipSources).toEqual([])
    expect(parsed.assignmentSources).toEqual([])
  })
})
