import { describe, expect, it } from "vitest"
import { completeFiles } from "simetra/compiler"
import {
  EVERYONE_ID,
  GRANT_FILE,
  GRANTS_SOURCE_ID,
  ORG_ADMIN_ID,
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  PROJECT_FILE,
  PROJECT_ID,
  PROJECT_LEAD_ID,
  ROLE_FILE,
  SET_FILE,
  SUPPORT_ID,
  TASK_EDITORS_ID,
  TASK_READERS_ID,
  compileRights,
  grantTable,
  grantsSource,
  rightsFiles,
  role,
  rolesAndSets,
} from "./fixtures/rights"
import { uuid } from "./helpers"

const ref = (kind: string, name: string) => ({ kind, name })

/** Ролі й набори фікстури; перевизначення зливається з файлом за шляхом. */
function files(overrides: Record<string, Record<string, unknown>> = {}) {
  const merged = rolesAndSets()
  for (const [path, fields] of Object.entries(overrides)) {
    merged[path] = { ...merged[path], ...fields }
  }
  return rightsFiles(merged)
}

/** Джерела призначень контейнерного (`grants`) і глобального рівня. */
function withSources(overrides: Record<string, Record<string, unknown>> = {}) {
  return files({
    [PROJECT_FILE]: {
      assignmentSources: [
        grantsSource(),
        grantsSource({
          id: uuid(6122),
          name: "globalGrants",
          assignedOn: "global",
          columns: { member: "memberId", role: "roleKey" },
        }),
      ],
    },
    [GRANT_FILE]: grantTable(),
    ...overrides,
  })
}

async function errors(input: ReturnType<typeof files>) {
  const result = await compileRights(input)
  return result.diagnostics
    .filter((d) => d.severity === "error")
    .map(({ code, file, pointer, params }) => ({ code, file, pointer, params }))
}

describe("roles and rights sets", () => {
  it("compiles roles into role contracts", async () => {
    const result = await compileRights(
      withSources({
        [ROLE_FILE("OrgMember")]: { rootCreator: true },
        [ROLE_FILE("Support")]: {
          order: 2,
          assignable: false,
          maxHolders: 3,
          sourceKeys: [{ source: "globalGrants", key: "support" }],
        },
        [ROLE_FILE("ProjectLead")]: {
          sourceKeys: [{ source: "grants", key: "lead" }],
        },
      })
    )
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const roles = result.model!.contracts.roles
    expect(roles.find((r) => r.name === "OrgAdmin")).toEqual({
      roleId: ORG_ADMIN_ID,
      name: "OrgAdmin",
      assignedOn: { level: "scope", scopeKindId: ORG_KIND_ID },
      fullAccess: true,
      assignable: true,
      rootCreator: false,
      sourceKeys: [],
      sets: [],
    })
    // Замикання: `OrgMember` включає `TaskEditors`, а той — `TaskReaders`.
    expect(
      roles.map((r) => [r.roleId, r.assignedOn, r.sets, r.rootCreator])
    ).toEqual([
      [ORG_ADMIN_ID, { level: "scope", scopeKindId: ORG_KIND_ID }, [], false],
      [
        ORG_MEMBER_ROLE_ID,
        { level: "scope", scopeKindId: ORG_KIND_ID },
        [TASK_EDITORS_ID, TASK_READERS_ID],
        true,
      ],
      [
        PROJECT_LEAD_ID,
        { level: "container", containerId: PROJECT_ID },
        [],
        false,
      ],
      [SUPPORT_ID, { level: "global" }, [], false],
      [EVERYONE_ID, { level: "everyUser" }, [], false],
    ])
    expect(roles.find((r) => r.name === "Support")).toMatchObject({
      order: 2,
      assignable: false,
      maxHolders: 3,
      sourceKeys: [{ sourceId: uuid(6122), key: "support" }],
    })
    expect(roles.find((r) => r.name === "ProjectLead")?.sourceKeys).toEqual([
      { sourceId: GRANTS_SOURCE_ID, key: "lead" },
    ])
    // Посилання ролей і наборів — в індексі: перейменування й видалення цілі
    // бачать їх так само, як посилання реквізитів.
    expect(
      result
        .model!.references.filter(
          (r) => r.role.startsWith("role.") || r.role === "rights.include"
        )
        .map((r) => [r.from.file, r.from.pointer, r.role, r.to.id])
    ).toEqual(
      expect.arrayContaining([
        [
          ROLE_FILE("OrgMember"),
          "/include/0",
          "rights.include",
          TASK_EDITORS_ID,
        ],
        [
          SET_FILE("TaskEditors"),
          "/include/0",
          "rights.include",
          TASK_READERS_ID,
        ],
        [
          ROLE_FILE("OrgAdmin"),
          "/assignedOn/scopeKind",
          "role.scopeKind",
          ORG_KIND_ID,
        ],
        [
          ROLE_FILE("ProjectLead"),
          "/assignedOn/container",
          "role.container",
          PROJECT_ID,
        ],
        [
          ROLE_FILE("ProjectLead"),
          "/sourceKeys/0/source",
          "role.sourceKey",
          GRANTS_SOURCE_ID,
        ],
      ])
    )
  })

  const team = {
    scopeKinds: [
      {
        id: ORG_KIND_ID,
        name: "org",
        physicalName: "org_id",
        root: { object: ref("Catalog", "Organization") },
        setFunction: "membership",
      },
      {
        id: uuid(6140),
        name: "team",
        physicalName: "team_id",
        root: { external: { schema: "auth", table: "users", column: "id" } },
        setFunction: { schema: "public", name: "team_ids" },
      },
    ],
  }

  it.each([
    {
      case: "includes a role instead of a set",
      input: files({
        [ROLE_FILE("OrgMember")]: { include: [ref("Role", "OrgAdmin")] },
      }),
      code: "rights.include-target",
      file: ROLE_FILE("OrgMember"),
      pointer: "/include/0",
      params: { kind: "Role", name: "OrgAdmin" },
    },
    {
      case: "closes an include cycle",
      input: files({
        [SET_FILE("TaskReaders")]: {
          include: [ref("RightsSet", "TaskEditors")],
        },
      }),
      code: "rights.include-cycle",
      file: SET_FILE("TaskEditors"),
      pointer: "/include/0",
      params: { chain: "TaskEditors → TaskReaders → TaskEditors" },
    },
    {
      case: "assigns on a scope kind without membership",
      input: files({
        [PROJECT_FILE]: team,
        [ROLE_FILE("TeamLead")]: role(uuid(6220), "TeamLead", {
          scopeKind: "team",
        }),
      }),
      code: "rights.scope-without-membership",
      file: ROLE_FILE("TeamLead"),
      pointer: "/assignedOn/scopeKind",
      params: { scopeKind: "team" },
    },
    {
      case: "gives full access on a container role",
      input: files({ [ROLE_FILE("ProjectLead")]: { fullAccess: true } }),
      code: "rights.full-access-level",
      file: ROLE_FILE("ProjectLead"),
      pointer: "/fullAccess",
      params: { level: "container" },
    },
    {
      case: "gives full access to every user",
      input: files({ [ROLE_FILE("Everyone")]: { fullAccess: true } }),
      code: "rights.full-access-level",
      file: ROLE_FILE("Everyone"),
      pointer: "/fullAccess",
      params: { level: "everyUser" },
    },
    {
      case: "makes a global role the root creator",
      input: files({ [ROLE_FILE("Support")]: { rootCreator: true } }),
      code: "rights.root-creator-level",
      file: ROLE_FILE("Support"),
      pointer: "/rootCreator",
      params: { level: "global" },
    },
    {
      case: "declares two root creators of one scope kind",
      input: files({
        [ROLE_FILE("OrgAdmin")]: { rootCreator: true },
        [ROLE_FILE("OrgMember")]: { rootCreator: true },
      }),
      code: "rights.root-creator-duplicate",
      file: ROLE_FILE("OrgMember"),
      pointer: "/rootCreator",
      params: { scopeKind: "org", firstFile: ROLE_FILE("OrgAdmin") },
    },
    {
      case: "keys a role to a source of another level",
      input: withSources({
        [ROLE_FILE("OrgAdmin")]: {
          sourceKeys: [{ source: "grants", key: "admin" }],
        },
      }),
      code: "rights.source-key-level",
      file: ROLE_FILE("OrgAdmin"),
      pointer: "/sourceKeys/0/source",
      params: { source: "grants" },
    },
    {
      case: "keys every user to a source",
      input: withSources({
        [ROLE_FILE("Everyone")]: {
          sourceKeys: [{ source: "globalGrants", key: "everyone" }],
        },
      }),
      code: "rights.source-key-level",
      file: ROLE_FILE("Everyone"),
      pointer: "/sourceKeys/0/source",
      params: { source: "globalGrants" },
    },
    {
      case: "repeats a key of one source in two roles",
      input: withSources({
        [ROLE_FILE("ProjectGuest")]: role(
          uuid(6221),
          "ProjectGuest",
          { container: ref("Catalog", "Project") },
          { sourceKeys: [{ source: "grants", key: "lead" }] }
        ),
        [ROLE_FILE("ProjectLead")]: {
          sourceKeys: [{ source: "grants", key: "lead" }],
        },
      }),
      code: "rights.source-key-duplicate",
      file: ROLE_FILE("ProjectLead"),
      pointer: "/sourceKeys/0/key",
      params: {
        source: "grants",
        key: "lead",
        firstFile: ROLE_FILE("ProjectGuest"),
      },
    },
    {
      case: "keys a role to an unknown source",
      input: withSources({
        [ROLE_FILE("Support")]: {
          sourceKeys: [{ source: "nowhere", key: "support" }],
        },
      }),
      code: "rights.source-unknown",
      file: ROLE_FILE("Support"),
      pointer: "/sourceKeys/0/source",
      params: { source: "nowhere" },
    },
    {
      case: "assigns on an unknown scope kind",
      input: files({
        [ROLE_FILE("TeamLead")]: role(uuid(6220), "TeamLead", {
          scopeKind: "team",
        }),
      }),
      code: "rights.scope-kind-unknown",
      file: ROLE_FILE("TeamLead"),
      pointer: "/assignedOn/scopeKind",
      params: { scopeKind: "team" },
    },
    {
      case: "assigns on an object that is not a container",
      input: files({
        [ROLE_FILE("ProjectLead")]: {
          assignedOn: { container: ref("Catalog", "Region") },
        },
      }),
      code: "rights.container-target",
      file: ROLE_FILE("ProjectLead"),
      pointer: "/assignedOn/container",
      params: { role: "ProjectLead", name: "Region" },
    },
  ])("rejects a role that $case", async (row) => {
    const { case: label, input, ...expected } = row
    expect(await errors(input), label).toEqual([expected])
  })

  it("needs no physical name and gets an id from fix", async () => {
    const declared = rightsFiles({
      [ROLE_FILE("Support")]: {
        kind: "Role",
        name: "Support",
        assignedOn: "global",
      },
      [SET_FILE("TaskReaders")]: { kind: "RightsSet", name: "TaskReaders" },
    })
    let next = 7300
    const completed = completeFiles(declared, {
      schemaPath: (_, schema) => schema,
      newId: () => uuid(++next),
    })
    for (const path of [ROLE_FILE("Support"), SET_FILE("TaskReaders")]) {
      const written = JSON.parse(completed.files.get(path)!) as Record<
        string,
        unknown
      >
      expect(written.id, path).toMatch(/^[0-9a-f-]{36}$/)
      expect(written, path).not.toHaveProperty("physicalName")
    }
    expect(await errors(completed.files)).toEqual([])
  })
})
