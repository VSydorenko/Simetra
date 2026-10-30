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
  extentSchema,
  grantEntrySchema,
  membershipSourceSchema,
  objectSelectorSchema,
  rightsCarrierSchema,
  rightsSetSchema,
  roleSchema,
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

describe("rights sets and roles", () => {
  const container = { container: { kind: "Catalog", name: "Project" } }
  const role = (fields: Record<string, unknown>) => ({
    kind: "Role",
    name: "Lead",
    assignedOn: "global",
    ...fields,
  })
  const set = (fields: Record<string, unknown>) => ({
    kind: "RightsSet",
    name: "Readers",
    ...fields,
  })

  it.each([
    { case: "a global role", schema: roleSchema, input: role({}), ok: true },
    {
      case: "a role of every user",
      schema: roleSchema,
      input: role({ assignedOn: "everyUser" }),
      ok: true,
    },
    {
      case: "a role on a scope kind",
      schema: roleSchema,
      input: role({ assignedOn: { scopeKind: "org" } }),
      ok: true,
    },
    {
      case: "a role on a container",
      schema: roleSchema,
      input: role({ assignedOn: container }),
      ok: true,
    },
    {
      case: "a role with a physical name",
      schema: roleSchema,
      input: role({ physicalName: "lead" }),
      ok: false,
    },
    {
      case: "a role with a title",
      schema: roleSchema,
      input: role({ title: { en: "Lead" } }),
      ok: false,
    },
    {
      case: "a role with no holders",
      schema: roleSchema,
      input: role({ maxHolders: 0 }),
      ok: false,
    },
    {
      case: "a role with a negative order",
      schema: roleSchema,
      input: role({ order: -1 }),
      ok: false,
    },
    {
      case: "a role with an empty source key",
      schema: roleSchema,
      input: role({ sourceKeys: [{ source: "grants", key: "" }] }),
      ok: false,
    },
    { case: "a set", schema: rightsSetSchema, input: set({}), ok: true },
    {
      case: "a set with a level",
      schema: rightsSetSchema,
      input: set({ assignedOn: "global" }),
      ok: false,
    },
    {
      case: "a set with full access",
      schema: rightsSetSchema,
      input: set({ fullAccess: true }),
      ok: false,
    },
    {
      case: "a set with a physical name",
      schema: rightsSetSchema,
      input: set({ physicalName: "readers" }),
      ok: false,
    },
    {
      case: "a role with every grant form",
      schema: roleSchema,
      input: role({
        grants: [
          { grantAll: { extent: "own" } },
          {
            grant: {
              objects: [{ kind: "Document", name: "Task" }],
              actions: ["read"],
              extent: "any",
            },
          },
          {
            deny: {
              objects: { withAction: "post" },
              actions: ["post"],
            },
          },
        ],
      }),
      ok: true,
    },
    {
      case: "a grant without an extent",
      schema: roleSchema,
      input: role({
        grants: [
          {
            grant: {
              objects: [{ kind: "Document", name: "Task" }],
              actions: ["read"],
            },
          },
        ],
      }),
      ok: false,
    },
    {
      case: "a grant without actions",
      schema: roleSchema,
      input: role({
        grants: [
          {
            grant: {
              objects: [{ kind: "Document", name: "Task" }],
              actions: [],
              extent: "any",
            },
          },
        ],
      }),
      ok: false,
    },
    {
      case: "a grant entry of two forms",
      schema: grantEntrySchema,
      input: {
        grantAll: { extent: "any" },
        deny: { objects: { withAction: "read" }, actions: ["read"] },
      },
      ok: false,
    },
    {
      case: "a set that grants",
      schema: rightsSetSchema,
      input: set({
        grants: [
          { grantAll: { extent: { dimension: "region" } } },
          {
            grant: {
              objects: { withAction: "post" },
              actions: ["post"],
              extent: "any",
            },
          },
        ],
      }),
      ok: true,
    },
    // `deny` віднімає з архетипу ролі, тож наборові він не належить (спека прав §4.1).
    {
      case: "a set that denies",
      schema: rightsSetSchema,
      input: set({
        grants: [
          {
            deny: {
              objects: [{ kind: "Document", name: "Task" }],
              actions: ["read"],
            },
          },
        ],
      }),
      ok: false,
    },
    { case: "the any extent", schema: extentSchema, input: "any", ok: true },
    { case: "the own extent", schema: extentSchema, input: "own", ok: true },
    {
      case: "a dimension extent",
      schema: extentSchema,
      input: { dimension: "region" },
      ok: true,
    },
    {
      case: "an unknown extent",
      schema: extentSchema,
      input: "all",
      ok: false,
    },
    {
      case: "a list of objects",
      schema: objectSelectorSchema,
      input: [{ kind: "Document", name: "Task" }],
      ok: true,
    },
    {
      case: "an empty list of objects",
      schema: objectSelectorSchema,
      input: [],
      ok: false,
    },
    {
      case: "objects with an action",
      schema: objectSelectorSchema,
      input: { withAction: "post" },
      ok: true,
    },
    // Кастомна дія в різних об'єктах — різні UUID: селектор бере лише слово
    // словника (спека прав §4.1).
    {
      case: "objects with a custom action",
      schema: objectSelectorSchema,
      input: { withAction: "reassign" },
      ok: false,
    },
    // «Кожен дійсний користувач» — рівень лише ролі, не джерела (спека прав Рх7).
    {
      case: "a source of every user",
      schema: assignmentSourceSchema,
      input: {
        name: "grants",
        assignedOn: "everyUser",
        table: { kind: "CustomTable", name: "RoleGrant" },
        columns: { member: "memberId", role: "roleKey" },
      },
      ok: false,
    },
  ])("parses $case strictly", ({ schema, input, ok }) => {
    expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(ok)
  })

  it("fills role defaults", () => {
    expect(roleSchema.parse(role({}))).toEqual({
      kind: "Role",
      name: "Lead",
      assignedOn: "global",
      fullAccess: false,
      assignable: true,
      rootCreator: false,
      sourceKeys: [],
      include: [],
      grants: [],
    })
    expect(rightsSetSchema.parse(set({}))).toEqual({
      kind: "RightsSet",
      name: "Readers",
      include: [],
      grants: [],
    })
  })
})
