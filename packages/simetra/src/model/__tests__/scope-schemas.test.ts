import { describe, it, expect } from "vitest"
import { z } from "zod"
import { KIND_REGISTRY } from "../kinds/registry"
import { enumerationSchema } from "../schemas/enumeration"
import { pgEnumSchema } from "../schemas/pg-enum"
import { projectSchema } from "../schemas/project"
import { refineValueType, valueTypeShape } from "../schemas/value-type"

function rules(schema: z.ZodType, input: unknown): (string | undefined)[] {
  const res = schema.safeParse(input)
  if (res.success) return []
  return res.error.issues.map(
    (i) => (i as { params?: { rule?: string } }).params?.rule
  )
}

describe("scope declarations", () => {
  it("project accepts object and external roots", () => {
    const res = projectSchema.safeParse({
      name: "app",
      database: { provider: "supabase" },
      scopeKinds: [
        {
          name: "org",
          root: { object: { kind: "Catalog", name: "Organization" } },
          setFunction: { name: "set_org" },
        },
        {
          name: "user",
          root: { external: { schema: "auth", table: "users", column: "id" } },
          setFunction: { schema: "private", name: "set_user" },
          onRootDelete: "cascade",
        },
      ],
    })
    expect(res.success).toBe(true)
    if (!res.success) return
    expect(res.data.scopeKinds[0]?.onRootDelete).toBe("restrict")
    expect(res.data.scopeKinds[1]?.onRootDelete).toBe("cascade")
    expect(
      projectSchema.parse({ name: "app", database: { provider: "supabase" } })
        .scopeKinds
    ).toEqual([])
  })

  it("setFunction accepts the literal membership and nothing else as a string", () => {
    const project = (setFunction: unknown) => ({
      name: "app",
      database: { provider: "supabase" },
      scopeKinds: [
        {
          name: "org",
          root: { object: { kind: "Catalog", name: "Organization" } },
          setFunction,
        },
      ],
    })
    const parsed = projectSchema.safeParse(project("membership"))
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.scopeKinds[0]?.setFunction).toBe("membership")
    }
    expect(projectSchema.safeParse(project("set_org")).success).toBe(false)
    expect(projectSchema.safeParse(project("Membership")).success).toBe(false)
  })

  it("scope kind named none is rejected", () => {
    expect(
      rules(projectSchema, {
        name: "app",
        database: { provider: "supabase" },
        scopeKinds: [
          {
            name: "none",
            root: { object: { kind: "Catalog", name: "Organization" } },
            setFunction: { name: "set_org" },
          },
        ],
      })
    ).toContain("scope.name-reserved")
  })

  it("schema simetra is reserved for the platform", () => {
    const external = {
      schema: "simetra",
      table: "t",
      column: "id",
    }
    const project = {
      name: "app",
      database: { provider: "supabase" },
      scopeKinds: [
        {
          name: "org",
          root: { external },
          setFunction: { name: "set_org" },
        },
      ],
    }
    expect(rules(projectSchema, project)).toEqual(["schema.reserved"])
    expect(
      rules(projectSchema, {
        ...project,
        scopeKinds: [
          {
            ...project.scopeKinds[0],
            root: { external: { ...external, schema: "app" } },
            setFunction: { schema: "simetra", name: "set_org" },
          },
        ],
      })
    ).toEqual(["schema.reserved"])
    expect(
      rules(projectSchema, {
        name: "app",
        database: { provider: "supabase" },
        defaultSchema: "simetra",
      })
    ).toEqual(["schema.reserved"])
  })

  it("enumeration accepts only none", () => {
    const base = { kind: "Enumeration", name: "Status" }
    expect(
      enumerationSchema.safeParse({ ...base, scope: "none" }).success
    ).toBe(true)
    expect(rules(enumerationSchema, { ...base, scope: "org" })).toContain(
      "scope.not-allowed"
    )
  })

  it("pg enum has no scope field", () => {
    expect(Object.keys(pgEnumSchema.shape)).not.toContain("scope")
  })

  it("crossScope only on Ref", () => {
    const schema = z.object(valueTypeShape).superRefine(refineValueType)
    expect(rules(schema, { type: "Text", crossScope: true })).toContain(
      "type.cross-scope-not-allowed"
    )
    expect(
      schema.safeParse({
        type: "Ref",
        ref: { kind: "Catalog", name: "Product" },
        crossScope: true,
      }).success
    ).toBe(true)
  })

  it("registry scope policy", () => {
    expect(KIND_REGISTRY.Catalog.scope).toBe("required")
    expect(KIND_REGISTRY.CustomTable.scope).toBe("required")
    expect(KIND_REGISTRY.Enumeration.scope).toBe("noneOnly")
    expect(KIND_REGISTRY.PgEnum.scope).toBe("absent")
  })
})
