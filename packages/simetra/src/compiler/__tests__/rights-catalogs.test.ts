import { describe, expect, it } from "vitest"
import type { PhysicalSnapshot, PhysicalTable } from "simetra/model"
import {
  GLOBAL_ASSIGNMENTS_FILE,
  GLOBAL_ASSIGNMENTS_ID,
  GLOBAL_ROLES_FILE,
  GLOBAL_ROLES_ID,
  GRANT_FILE,
  MEMBER_FILE,
  ORG_ASSIGNMENTS_FILE,
  ORG_ASSIGNMENTS_ID,
  ORG_KIND_ID,
  ORG_ROLES_FILE,
  ORG_ADMIN_ID,
  ORG_ROLES_ID,
  PROJECT_FILE,
  PROJECT_LEAD_ID,
  REGION_FILE,
  ROLE_FILE,
  USERS_FILE,
  adoptedMembership,
  compileRights,
  globalGrantsSource,
  grant,
  grantAll,
  grantTable,
  grantsSource,
  membersSource,
  objects,
  singleTenantRights,
  systemCatalog,
  teamScopeKind,
  without,
  withRoles,
  type Layer,
} from "./fixtures/rights"
import { uuid } from "./helpers"
import { rightsLevelOf } from "../rights/system-catalogs"
import { expandedProjection } from "../rights/functions"

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

  it("system rights catalogs have read and administerRights at any only", async () => {
    const all = await compiled(member(grantAll("any")))
    const names = new Map(all.objects.map((o) => [o.id, o.name]))
    const catalogs = all.contracts.rights.filter((c) => c.system !== undefined)
    expect(catalogs.map((c) => names.get(c.objectId)).sort()).toEqual([
      "GlobalRoleAssignments",
      "GlobalRoles",
      "OrgRoleAssignments",
      "OrgRoles",
    ])
    for (const catalog of catalogs) {
      expect(catalog.actions.map((a) => a.action)).toEqual([
        "read",
        "administerRights",
      ])
      for (const action of catalog.actions) {
        expect(action.extents).toEqual([{ form: "any" }])
      }
      expect(catalog.actions[1]).toMatchObject({
        requires: ["read"],
        natural: [],
        effects: {
          dml: ["insert", "update", "delete"],
          tabularSections: true,
        },
      })
    }
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
      member(
        grant(
          objects(["Catalog", "OrgRoleAssignments"]),
          ["read", "administerRights"],
          "any"
        )
      )
    )
    expect(
      explicit.contracts.rightsProjection
        .filter((row) => names.get(row.objectId) === "OrgRoleAssignments")
        .map((row) => row.action)
    ).toEqual(["administerRights", "read"])
    const full = expandedProjection(all.contracts)
      .filter((row) => row.roleId === ORG_ADMIN_ID)
      .filter((row) => row.action === "administerRights")
      .map((row) => names.get(row.objectId))
      .sort()
    expect(full).toEqual(["OrgRoleAssignments", "OrgRoles"])
  })

  it("rejects administerRights as a withAction selector", async () => {
    const result = await compileRights(
      withRoles(
        member(
          grant({ withAction: "administerRights" }, ["administerRights"], "any")
        )
      )
    )
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([
      expect.objectContaining({
        code: "file.schema",
        file: ROLE_FILE("OrgMember"),
      }),
    ])
  })

  it("rejects a container role administering a scope rights catalog", async () => {
    const result = await compileRights(
      withRoles({
        [ROLE_FILE("ProjectLead")]: {
          grants: [
            grant(
              objects(["Catalog", "OrgRoleAssignments"]),
              ["administerRights"],
              "any"
            ),
          ],
        },
      })
    )
    expect(
      result.diagnostics
        .filter((d) => d.severity === "error")
        .map(({ code, file, pointer }) => ({ code, file, pointer }))
    ).toEqual([
      {
        code: "rights.grant-level",
        file: ROLE_FILE("ProjectLead"),
        pointer: "/grants/0/grant/actions/0",
      },
    ])
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
  // лежать у довіднику виду скоупу контейнера (спека прав §4.6). «Кожен користувач»
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

  it("lists the rights catalogs of every level", async () => {
    const { contracts } = await compiled()
    const table = (name: string) => ({ schema: "public", name })
    expect(contracts.rightsCatalogs).toEqual([
      {
        level: { level: "global" },
        roles: {
          objectId: GLOBAL_ROLES_ID,
          table: table("global_roles"),
          delta: table("global_roles_delta"),
        },
        assignments: {
          objectId: GLOBAL_ASSIGNMENTS_ID,
          table: table("global_role_assignments"),
        },
      },
      {
        level: { level: "scope", scopeKindId: ORG_KIND_ID },
        roles: {
          objectId: ORG_ROLES_ID,
          table: table("org_roles"),
          delta: table("org_roles_delta"),
        },
        assignments: {
          objectId: ORG_ASSIGNMENTS_ID,
          table: table("org_role_assignments"),
        },
      },
    ])
  })

  it("singleTenantRights compiles without errors", async () => {
    const result = await compileRights(singleTenantRights())
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  })
})

/** Проєкт задає прийняті джерела призначень над `RoleGrant`. */
const assignmentSources = (...sources: unknown[]): Layer => ({
  [PROJECT_FILE]: { assignmentSources: sources },
  [GRANT_FILE]: grantTable(),
})

const ORG_ROLES_EXTRA_FILE = "catalogs/OrgRolesExtra/OrgRolesExtra.meta.json"
const TEAM_ASSIGNMENTS_FILE =
  "catalogs/TeamRoleAssignments/TeamRoleAssignments.meta.json"

const writes = (pointer: string, source: string) => ({
  code: "rights.adopted-source-writes",
  severity: "warning",
  file: PROJECT_FILE,
  pointer,
  params: { source },
})

const unread = (pointer: string, scopeKind: string) => ({
  code: "rights.scope-kind-unread",
  severity: "warning",
  file: PROJECT_FILE,
  pointer,
  params: { scopeKind },
})

const error = (
  code: string,
  file: string,
  pointer: string,
  params: Record<string, string>
) => ({ code, severity: "error", file, pointer, params })

describe("system rights catalog checks", () => {
  it.each([
    {
      case: "missing-roles",
      layers: [without(ORG_ROLES_FILE)],
      expected: [
        error(
          "rights.system-catalog-missing",
          ROLE_FILE("OrgAdmin"),
          "/assignedOn",
          { level: "org", missing: "rightsRoles" }
        ),
      ],
    },
    {
      // Контейнер `Project` лежить у виді `org`: його призначення — у
      // довідниках рівня `org` (спека прав §4.6).
      case: "missing-for-container",
      layers: [
        without(
          ROLE_FILE("OrgAdmin"),
          ROLE_FILE("OrgMember"),
          ORG_ROLES_FILE,
          ORG_ASSIGNMENTS_FILE
        ),
      ],
      expected: ["rightsRoles", "roleAssignments"].map((missing) =>
        error(
          "rights.system-catalog-missing",
          ROLE_FILE("ProjectLead"),
          "/assignedOn",
          { level: "org", missing }
        )
      ),
    },
    {
      case: "duplicate",
      layers: [
        {
          [ORG_ROLES_EXTRA_FILE]: systemCatalog(
            uuid(6234),
            "OrgRolesExtra",
            "org_roles_extra",
            "rightsRoles",
            "org"
          ),
        },
      ],
      expected: [
        error(
          "rights.system-catalog-duplicate",
          ORG_ROLES_EXTRA_FILE,
          "/role",
          {
            role: "rightsRoles",
            level: "org",
            firstFile: ORG_ROLES_FILE,
          }
        ),
      ],
    },
    {
      case: "scope-without-membership",
      layers: [
        teamScopeKind(),
        {
          [TEAM_ASSIGNMENTS_FILE]: systemCatalog(
            uuid(6235),
            "TeamRoleAssignments",
            "team_role_assignments",
            "roleAssignments",
            "team"
          ),
        },
      ],
      expected: [
        error("rights.system-catalog-scope", TEAM_ASSIGNMENTS_FILE, "/scope", {
          name: "TeamRoleAssignments",
          scopeKind: "team",
        }),
      ],
    },
    {
      case: "no-description",
      layers: [{ [ORG_ROLES_FILE]: { descriptionLength: 0 } }],
      expected: [
        error(
          "rights.system-catalog-description",
          ORG_ROLES_FILE,
          "/descriptionLength",
          { name: "OrgRoles" }
        ),
      ],
    },
    {
      // Запис довідників прав — дія адміністрування прав (спека прав §4.6), тож
      // кастомна дія на них — помилка, а не мовчазний пропуск.
      case: "custom-action",
      layers: [
        {
          [ORG_ROLES_FILE]: {
            customActions: [{ id: uuid(6236), name: "invite" }],
          },
        },
      ],
      expected: [
        error(
          "rights.system-catalog-custom-action",
          ORG_ROLES_FILE,
          "/customActions/0",
          { name: "OrgRoles", action: "invite" }
        ),
      ],
    },
    {
      // Ім'я стандартної ТЧ зайняте в просторі імен ТЧ, як стандартні
      // колонки — у просторі реквізитів.
      case: "delta-section",
      layers: [
        {
          [ORG_ROLES_FILE]: {
            tabularSections: [
              {
                id: uuid(6237),
                name: "delta",
                physicalName: "extra",
                attributes: [],
              },
            ],
          },
        },
      ],
      expected: [
        error(
          "identity.name-reserved",
          ORG_ROLES_FILE,
          "/tabularSections/0/name",
          { name: "delta", kind: "Catalog" }
        ),
      ],
    },
    {
      case: "every-user-only",
      layers: [
        without(
          ROLE_FILE("OrgAdmin"),
          ROLE_FILE("OrgMember"),
          ROLE_FILE("ProjectLead"),
          ROLE_FILE("Support"),
          ORG_ROLES_FILE,
          ORG_ASSIGNMENTS_FILE,
          GLOBAL_ROLES_FILE,
          GLOBAL_ASSIGNMENTS_FILE
        ),
      ],
      // Роль «кожного користувача» скоуплених об'єктів не читає (спека прав §5.2).
      expected: [unread("/scopeKinds/0", "org")],
    },
    {
      // Членство `org` дає джерело, а ролі рівня `org` джерелом призначень не
      // покрито: довідники потрібні, як на будь-якому рівні (спека прав §4.7).
      case: "source-membership-without-catalogs",
      layers: [
        adoptedMembership(),
        without(ORG_ROLES_FILE, ORG_ASSIGNMENTS_FILE),
        { [PROJECT_FILE]: { membershipSources: [membersSource()] } },
      ],
      expected: [
        writes("/membershipSources/0", "members"),
        ...["rightsRoles", "roleAssignments"].map((missing) =>
          error(
            "rights.system-catalog-missing",
            ROLE_FILE("OrgAdmin"),
            "/assignedOn",
            { level: "org", missing }
          )
        ),
      ],
    },
    {
      case: "source-covers-level",
      layers: [
        without(GLOBAL_ROLES_FILE, GLOBAL_ASSIGNMENTS_FILE),
        assignmentSources(globalGrantsSource()),
      ],
      expected: [writes("/assignmentSources/0", "globalGrants")],
    },
    {
      case: "parallel",
      layers: [assignmentSources(globalGrantsSource())],
      expected: [
        error(
          "rights.system-catalog-parallel",
          GLOBAL_ASSIGNMENTS_FILE,
          "/role",
          { level: "global", source: "globalGrants" }
        ),
        error("rights.system-catalog-parallel", GLOBAL_ROLES_FILE, "/role", {
          level: "global",
          source: "globalGrants",
        }),
        writes("/assignmentSources/0", "globalGrants"),
      ],
    },
    {
      // Перша міграція: прийняті контейнерні призначення поряд із новими
      // ролями рівня скоупу в тому самому виді (спека прав Рх14).
      case: "mixed-in-scope-kind",
      layers: [assignmentSources(grantsSource())],
      expected: [writes("/assignmentSources/0", "grants")],
    },
    {
      // Перша міграція: прийняте членство й ролі Simetra в довідниках, чий
      // `subject` посилається на таблицю-джерело (спека прав §4.7).
      case: "source-only-membership",
      layers: [
        adoptedMembership(),
        { [PROJECT_FILE]: { membershipSources: [membersSource()] } },
      ],
      expected: [writes("/membershipSources/0", "members")],
    },
  ])("$case", async ({ layers, expected }) => {
    const result = await compileRights(withRoles(...layers))
    expect(
      result.diagnostics.map(({ code, severity, file, pointer, params }) => ({
        code,
        severity,
        file,
        pointer,
        params,
      }))
    ).toEqual(expected)
  })
})

describe("rights catalogs of a kind with an adopted membership", () => {
  it("refer the subject to the source table by a composite key", async () => {
    const { physical } = await compiled(adoptedMembership(), {
      [PROJECT_FILE]: { membershipSources: [membersSource()] },
    })
    const fk = tableOf(physical, "org_role_assignments").foreignKeys.find((f) =>
      f.columns.includes("subject")
    )
    expect(fk && [fk.columns, fk.references]).toEqual([
      ["org_id", "subject"],
      { schema: "public", table: "membership", columns: ["org_id", "id"] },
    ])
  })
})

// Рядки людей і їхніх прав не відкриваються `publicRead` (спека прав §5.2): він
// зняв би межу тенанта й межу видимості «Користувачів».
describe("publicRead on catalogs of people and their rights", () => {
  const publicCodes = async (file: string) => {
    const result = await compileRights(
      withRoles({ [file]: { publicRead: "anon" } })
    )
    return result.diagnostics
      .filter((d) => d.code === "rights.public-read-forbidden")
      .map(({ file, pointer, params }) => ({ file, pointer, params }))
  }

  it.each([
    { file: USERS_FILE, object: "Users", holds: "users" },
    { file: MEMBER_FILE, object: "OrgMember", holds: "membership" },
    { file: ORG_ROLES_FILE, object: "OrgRoles", holds: "rightsRoles" },
    {
      file: ORG_ASSIGNMENTS_FILE,
      object: "OrgRoleAssignments",
      holds: "roleAssignments",
    },
  ])("forbids it on $object ($holds)", async ({ file, object, holds }) => {
    expect(await publicCodes(file)).toEqual([
      { file, pointer: "/publicRead", params: { object, holds } },
    ])
  })

  it("allows it on an ordinary catalog", async () => {
    expect(await publicCodes(REGION_FILE)).toEqual([])
  })
})

describe("rightsLevelOf", () => {
  const orgGrants = grantsSource({
    id: uuid(6122),
    name: "orgGrants",
    assignedOn: { scopeKind: "org" },
    // `RoleGrant` скоупу не несе: скоуп — з учасника (спека прав §4.7).
    columns: { member: "memberId", role: "roleKey", scope: null },
  })
  const ORG = { level: "scope", scopeKindId: ORG_KIND_ID }

  // Покриття — за рівнем призначення: сусід на тому самому рівні зберігання
  // (`org`) без джерела лишається на ньому (спека прав Рх14).
  it.each([
    {
      case: "a covered scope level",
      source: orgGrants,
      roleId: ORG_ADMIN_ID,
      expected: undefined,
    },
    {
      case: "the uncovered container next to a covered scope level",
      source: orgGrants,
      roleId: PROJECT_LEAD_ID,
      expected: ORG,
    },
    {
      case: "a covered container",
      source: grantsSource(),
      roleId: PROJECT_LEAD_ID,
      expected: undefined,
    },
    {
      case: "the uncovered scope level next to a covered container",
      source: grantsSource(),
      roleId: ORG_ADMIN_ID,
      expected: ORG,
    },
  ])("maps $case", async ({ source, roleId, expected }) => {
    const { contracts } = await compiled(assignmentSources(source))
    const role = contracts.roles.find((r) => r.roleId === roleId)!
    expect(rightsLevelOf(role.assignedOn, contracts)).toEqual(expected)
  })
})
