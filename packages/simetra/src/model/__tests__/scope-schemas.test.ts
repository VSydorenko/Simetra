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
    expect(projectSchema.parse({ name: "app" }).scopeKinds).toEqual([])
  })

  it("scope kind named none is rejected", () => {
    expect(
      rules(projectSchema, {
        name: "app",
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
