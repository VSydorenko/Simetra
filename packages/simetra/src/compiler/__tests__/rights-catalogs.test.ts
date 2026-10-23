import { describe, expect, it } from "vitest"
import type { PhysicalSnapshot, PhysicalTable } from "simetra/model"
import {
  GLOBAL_ROLES_FILE,
  ORG_ASSIGNMENTS_FILE,
  ORG_ASSIGNMENTS_ID,
  ORG_ROLES_FILE,
  ORG_ROLES_ID,
  ROLE_FILE,
  compileRights,
  grant,
  grantAll,
  objects,
  singleTenantRights,
  withRoles,
} from "./fixtures/rights"

type Layer = Record<string, Record<string, unknown>>

/** Роль `OrgMember` лише з власними грантами, без включень. */
const member = (...grants: unknown[]): Layer => ({
  [ROLE_FILE("OrgMember")]: { include: [], grants },
})

async function compiled(...layers: Layer[]) {
  const result = await compileRights(withRoles(...layers))
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

function tableOf(physical: PhysicalSnapshot, name: string): PhysicalTable {
  const table = physical.tables.find((t) => t.name === name)
  if (table === undefined) throw new Error(`no table ${name}`)
  return table
}

const columnsOf = (table: PhysicalTable, names: readonly string[]) =>
  names.map((name) => {
    const column = table.columns.find((c) => c.name === name)
    return column === undefined ? [name] : [name, column.type, column.notNull]
  })

describe("system rights catalogs", () => {
  it("gives the roles catalog its standard columns and the delta tabular section", async () => {
    const { physical } = await compiled()
    const roles = tableOf(physical, "org_roles")
    expect(columnsOf(roles, ["archetype", "order"])).toEqual([
      ["archetype", "uuid", true],
      ["order", "integer", false],
    ])

    const delta = tableOf(physical, "org_roles_delta")
    expect(delta.origin).toEqual({
      objectId: ORG_ROLES_ID,
      tabularSectionId: `${ORG_ROLES_ID}#delta`,
    })
    expect(
      columnsOf(delta, ["object", "action", "extent", "dimension", "effect"])
    ).toEqual([
      ["object", "text", true],
      ["action", "text", true],
      ["extent", "text", true],
      ["dimension", "uuid", false],
      ["effect", "text", true],
    ])
    // Знімок сортує CHECK за іменем: dimension, effect, extent.
    expect(delta.checks.map((c) => c.expression)).toEqual([
      "(extent = 'dimension') = (dimension IS NOT NULL)",
      "effect IN ('allow', 'deny')",
      "extent IN ('any', 'own', 'dimension')",
    ])
    expect(delta.foreignKeys).toContainEqual(
      expect.objectContaining({
        columns: ["org_id", "parent_id"],
        references: {
          schema: "public",
          table: "org_roles",
          columns: ["org_id", "id"],
        },
        onDelete: "cascade",
      })
    )
  })

  it.each([
    {
      level: "org",
      table: "org_role_assignments",
      subject: {
        columns: ["org_id", "subject"],
        references: { table: "org_member", columns: ["org_id", "id"] },
      },
      customRole: {
        columns: ["org_id", "custom_role"],
        references: { table: "org_roles", columns: ["org_id", "id"] },
      },
      indexes: [
        ["org_id", "subject"],
        ["org_id", "container"],
      ],
    },
    {
      level: "global",
      table: "global_role_assignments",
      subject: {
        columns: ["subject"],
        references: { table: "users", columns: ["id"] },
      },
      customRole: {
        columns: ["custom_role"],
        references: { table: "global_roles", columns: ["id"] },
      },
      indexes: [["subject"], ["container"]],
    },
  ])(
    "points the assignment subject at the member of the $level level",
    async ({ table, subject, customRole, indexes }) => {
      const { physical } = await compiled()
      const assignments = tableOf(physical, table)
      const foreignKeys = assignments.foreignKeys.map((fk) => ({
        columns: fk.columns,
        references: {
          table: fk.references.table,
          columns: fk.references.columns,
        },
      }))
      expect(foreignKeys).toContainEqual(subject)
      expect(foreignKeys).toContainEqual(customRole)
      // Цілі контейнера — різні довідники-контейнери, тож FK немає.
      expect(
        assignments.foreignKeys.filter((fk) => fk.columns.includes("container"))
      ).toEqual([])
      expect(assignments.checks.map((c) => c.expression)).toEqual([
        "num_nonnulls(archetype, custom_role) = 1",
      ])
      const keys = assignments.indexes.map((index) =>
        index.keys.map((key) => ("column" in key ? key.column : key))
      )
      for (const index of indexes) expect(keys).toContainEqual(index)
    }
  )

  it("system rights catalogs have only read and stay out of selectors", async () => {
    const all = await compiled(member(grantAll("any")))
    const names = new Map(all.objects.map((o) => [o.id, o.name]))
    const assignments = all.contracts.rights.find(
      (c) => names.get(c.objectId) === "OrgRoleAssignments"
    )
    expect(assignments?.actions.map((a) => a.action)).toEqual(["read"])
    const projected = (model: typeof all) =>
      model.contracts.rightsProjection
        .map((row) => names.get(row.objectId))
        .filter((name) => name === "OrgRoles" || name === "OrgRoleAssignments")
    expect(projected(all)).toEqual([])
    const selected = await compiled(
      member(grant({ withAction: "read" }, ["read"], "any"))
    )
    expect(projected(selected)).toEqual([])

    const explicit = await compiled(
      member(grant(objects(["Catalog", "OrgRoleAssignments"]), ["read"], "any"))
    )
    expect(projected(explicit)).toEqual(["OrgRoleAssignments"])
  })

  it("a rights catalog belongs only to its level", async () => {
    const levelErrors = async (target: string) => {
      const result = await compileRights(
        withRoles(member(grant(objects(["Catalog", target]), ["read"], "any")))
      )
      return result.diagnostics
        .filter((d) => d.severity === "error")
        .map(({ code, file, pointer }) => ({ code, file, pointer }))
    }
    expect(await levelErrors("GlobalRoleAssignments")).toEqual([
      {
        code: "rights.grant-level",
        file: ROLE_FILE("OrgMember"),
        pointer: "/grants/0/grant/actions/0",
      },
    ])
    // Нескоуплений довідник, що не є довідником прав, роль скоупу читає.
    expect(await levelErrors("Users")).toEqual([])
  })

  // Контейнерний рівень — не рівень довідника: контейнерні призначення лише
  // лежать у довіднику виду скоупу контейнера (Р2a1-20). «Кожен користувач»
  // має лише вужчі обсяги, тож глобальні «Ролі» отримують власність.
  it.each([
    { role: "Support", target: "GlobalRoles", extent: "any" },
    { role: "Support", target: "OrgRoles", extent: "any" },
    { role: "Everyone", target: "GlobalRoles", extent: "own" },
    { role: "ProjectLead", target: "GlobalRoleAssignments", extent: "any" },
    { role: "ProjectLead", target: "OrgRoleAssignments", extent: "any" },
  ])(
    "$role reads $target only on its own level",
    async ({ role, target, extent }) => {
      const result = await compileRights(
        withRoles({
          [GLOBAL_ROLES_FILE]: { trackAuthor: true, ownership: ["createdBy"] },
          [ROLE_FILE(role)]: {
            grants: [grant(objects(["Catalog", target]), ["read"], extent)],
          },
        })
      )
      const errors = result.diagnostics
        .filter((d) => d.severity === "error")
        .map(({ code, file, pointer }) => ({ code, file, pointer }))
      // Глобальна роль на глобальних «Ролях» — свій рівень, без помилки.
      expect(errors).toEqual(
        role === "Support" && target === "GlobalRoles"
          ? []
          : [
              {
                code: "rights.grant-level",
                file: ROLE_FILE(role),
                pointer: "/grants/0/grant/actions/0",
              },
            ]
      )
    }
  )

  it("keeps generated constraint names of a long catalog within 63 bytes", async () => {
    const long = (base: string) => base.padEnd(60, "x")
    const { physical } = await compiled({
      [ORG_ROLES_FILE]: { physicalName: long("org_roles") },
      [ORG_ASSIGNMENTS_FILE]: { physicalName: long("org_assignments") },
    })
    const delta = physical.tables.find(
      (t) => t.origin.tabularSectionId === `${ORG_ROLES_ID}#delta`
    )!
    const assignments = physical.tables.find(
      (t) =>
        t.origin.objectId === ORG_ASSIGNMENTS_ID && !t.origin.tabularSectionId
    )!
    const bytes = (name: string) => new TextEncoder().encode(name).length
    expect(bytes(delta.name)).toBeLessThanOrEqual(63)
    expect(delta.name.endsWith("_delta")).toBe(true)
    const names = [...delta.checks, ...assignments.checks].map((c) => c.name)
    expect(names).toHaveLength(4)
    expect(new Set(names).size).toBe(4)
    for (const name of names) {
      expect(bytes(name)).toBeLessThanOrEqual(63)
      expect(name.endsWith("_check")).toBe(true)
    }
  })

  it("singleTenantRights compiles without errors", async () => {
    const result = await compileRights(singleTenantRights())
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  })
})
