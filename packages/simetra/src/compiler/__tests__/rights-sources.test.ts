import { describe, expect, it } from "vitest"
import { completeFiles } from "simetra/compiler"
import {
  GRANT_FILE,
  GRANTS_SOURCE_ID,
  MEMBER_FILE,
  ORG_KIND_ID,
  PROJECT_ID,
  ROLE_FILE,
  SET_FILE,
  SUPPORT_ID,
  TASK_FILE,
  TASK_READERS_ID,
  compileRights,
  grantTable,
  grantsSource,
  rightsFiles,
  rightsSet,
  role,
} from "./fixtures/rights"
import { uuid } from "./helpers"

type Files = ReturnType<typeof rightsFiles>

const PROJECT = "project.meta.json"
const MEMBERSHIP_FILE = "custom-tables/Membership/Membership.meta.json"
const MEMBER_REGION_FILE =
  "information-registers/MemberRegion/MemberRegion.meta.json"
const USERS_FILE = "catalogs/Users/Users.meta.json"
const MEMBERSHIP_ID = uuid(6100)
const MEMBERS_SOURCE_ID = uuid(6120)

const ref = (kind: string, name: string) => ({ kind, name })

function column(id: number, name: string, physicalName: string, type: string) {
  return { id: uuid(id), name, physicalName, type, notNull: true }
}

/** Прийнята таблиця членства виду `org`; `uniques` дає `UNIQUE (scope, id)`. */
function membershipTable(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBERSHIP_ID,
    kind: "CustomTable",
    name: "Membership",
    physicalName: "membership",
    kindLabel: "membership",
    scope: "org",
    columns: [
      column(6101, "id", "id", "UUID"),
      column(6102, "orgId", "org_id", "UUID"),
      column(6103, "userId", "user_id", "UUID"),
      column(6104, "isActive", "is_active", "Boolean"),
    ],
    primaryKey: { columns: ["id"] },
    uniques: [{ columns: ["orgId", "id"] }],
    scopeColumn: "orgId",
    ...overrides,
  }
}

function membersSource(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBERS_SOURCE_ID,
    name: "members",
    scopeKind: "org",
    table: ref("CustomTable", "Membership"),
    columns: { scope: "orgId", user: "userId", active: "isActive" },
    ...overrides,
  }
}

/**
 * Вид `org` без довідника членства: членство дає прийнята таблиця, тож
 * функція множини — дослівна (Р1a-17), а `OrgMember` і зв'язок над ним
 * прибрано. Виконавець задачі посилається на прийняту таблицю.
 */
function adopted(
  project: Record<string, unknown>,
  overrides: Record<string, Record<string, unknown>> = {}
): Files {
  const files = rightsFiles({
    [PROJECT]: {
      scopeKinds: [
        {
          id: ORG_KIND_ID,
          name: "org",
          physicalName: "org_id",
          root: { object: ref("Catalog", "Organization") },
          setFunction: { schema: "public", name: "org_ids" },
        },
      ],
      ...project,
    },
    [TASK_FILE]: {
      attributes: [
        {
          id: uuid(6011),
          name: "assignee",
          physicalName: "assignee_id",
          type: "Ref",
          ref: ref("CustomTable", "Membership"),
        },
      ],
    },
    [MEMBERSHIP_FILE]: membershipTable(),
    [GRANT_FILE]: grantTable(),
    "catalogs/Project/Project.meta.json": { rightsContainer: true },
    ...overrides,
  })
  files.delete(MEMBER_FILE)
  files.delete(MEMBER_REGION_FILE)
  return files
}

function errors(result: Awaited<ReturnType<typeof compileRights>>) {
  return result.diagnostics.filter((d) => d.severity === "error")
}

async function compiled(files: Files) {
  const result = await compileRights(files)
  expect(errors(result)).toEqual([])
  return result.model!
}

async function codes(files: Files) {
  return errors(await compileRights(files)).map((d) => [d.code, d.pointer])
}

describe("adopted sources", () => {
  it("compiles a membership source and an assignment source", async () => {
    const model = await compiled(
      adopted({
        membershipSources: [membersSource()],
        assignmentSources: [
          grantsSource(),
          grantsSource({
            id: uuid(6122),
            name: "orgGrants",
            assignedOn: { scopeKind: "org" },
            columns: { member: "memberId", role: "roleKey" },
          }),
          grantsSource({
            id: uuid(6123),
            name: "globalGrants",
            assignedOn: "global",
            columns: { member: "memberId", role: "roleKey" },
          }),
        ],
      })
    )
    expect(model.contracts.membershipSources).toEqual([
      {
        sourceId: MEMBERS_SOURCE_ID,
        name: "members",
        scopeKindId: ORG_KIND_ID,
        table: { schema: "public", name: "membership" },
        scope: "org_id",
        user: "user_id",
        active: "is_active",
      },
    ])
    expect(model.contracts.assignmentSources).toEqual([
      {
        sourceId: GRANTS_SOURCE_ID,
        name: "grants",
        assignedOn: { level: "container", containerId: PROJECT_ID },
        table: { schema: "public", name: "role_grant" },
        member: "member_id",
        role: "role_key",
        container: "project_id",
      },
      {
        sourceId: uuid(6122),
        name: "orgGrants",
        assignedOn: { level: "scope", scopeKindId: ORG_KIND_ID },
        table: { schema: "public", name: "role_grant" },
        member: "member_id",
        role: "role_key",
      },
      {
        sourceId: uuid(6123),
        name: "globalGrants",
        assignedOn: { level: "global" },
        table: { schema: "public", name: "role_grant" },
        member: "member_id",
        role: "role_key",
      },
    ])
    // Колонки джерела — посилання за іменем: перейменування їх переписує.
    expect(
      model.references
        .filter((r) => r.from.file === PROJECT && r.role.startsWith("source."))
        .map((r) => [r.from.pointer, r.role, r.to.id])
    ).toEqual(
      expect.arrayContaining([
        ["/membershipSources/0/table", "source.table", MEMBERSHIP_ID],
        ["/membershipSources/0/scopeKind", "source.scopeKind", ORG_KIND_ID],
        ["/membershipSources/0/columns/user", "source.column", uuid(6103)],
        [
          "/assignmentSources/0/assignedOn/container",
          "source.container",
          PROJECT_ID,
        ],
        [
          "/assignmentSources/1/assignedOn/scopeKind",
          "source.scopeKind",
          ORG_KIND_ID,
        ],
      ])
    )
  })

  it("rejects broken sources", async () => {
    expect(
      await codes(
        adopted({
          membershipSources: [
            membersSource({ table: ref("Catalog", "Region") }),
          ],
        })
      )
    ).toContainEqual(["rights.source-table", "/membershipSources/0/table"])
    expect(
      await codes(
        adopted(
          { membershipSources: [membersSource()] },
          { [MEMBERSHIP_FILE]: membershipTable({ rowLevelSecurity: "forced" }) }
        )
      )
    ).toContainEqual(["rights.source-forced-rls", "/membershipSources/0/table"])
    // У виду `org` типового проєкту вже є довідник членства `OrgMember`.
    expect(
      await codes(
        rightsFiles({
          [PROJECT]: { membershipSources: [membersSource()] },
          [MEMBERSHIP_FILE]: membershipTable(),
        })
      )
    ).toEqual([
      ["rights.membership-source-duplicate", "/membershipSources/0/scopeKind"],
    ])
    expect(
      await codes(
        adopted({
          membershipSources: [membersSource()],
          assignmentSources: [
            grantsSource({ columns: { member: "memberId", role: "roleKey" } }),
          ],
        })
      )
    ).toEqual([
      ["rights.source-container-column", "/assignmentSources/0/columns"],
    ])
    expect(
      await codes(
        adopted({
          membershipSources: [membersSource()],
          assignmentSources: [grantsSource({ assignedOn: "global" })],
        })
      )
    ).toEqual([
      [
        "rights.source-container-column",
        "/assignmentSources/0/columns/container",
      ],
    ])
    expect(
      await codes(
        adopted({
          membershipSources: [membersSource({ scopeKind: "team" })],
          assignmentSources: [
            grantsSource({
              assignedOn: { scopeKind: "team" },
              columns: { member: "memberId", role: "roleKey" },
            }),
          ],
        })
      )
    ).toEqual(
      expect.arrayContaining([
        ["rights.scope-kind-unknown", "/membershipSources/0/scopeKind"],
        [
          "rights.scope-kind-unknown",
          "/assignmentSources/0/assignedOn/scopeKind",
        ],
      ])
    )
    // Два джерела членства одного виду — теж дубль.
    expect(
      await codes(
        adopted({
          membershipSources: [
            membersSource(),
            membersSource({ id: uuid(6124), name: "moreMembers" }),
          ],
        })
      )
    ).toEqual([
      ["rights.membership-source-duplicate", "/membershipSources/1/scopeKind"],
    ])
    expect(
      await codes(
        adopted({
          membershipSources: [
            membersSource({ columns: { scope: "orgId", user: "account" } }),
          ],
        })
      )
    ).toEqual([
      ["customTable.column-unknown", "/membershipSources/0/columns/user"],
    ])
    expect(
      await codes(
        adopted({
          membershipSources: [membersSource()],
          assignmentSources: [
            grantsSource({
              assignedOn: { container: ref("Catalog", "Region") },
            }),
          ],
        })
      )
    ).toEqual([
      ["rights.container-target", "/assignmentSources/0/assignedOn/container"],
    ])
  })

  it("ties the scope of a membership source to the scope of its table", async () => {
    // Колонка скоупу джерела — не скоуп-колонка таблиці: складений FK тримав
    // би один тенант, а членство читалося б з іншого.
    expect(
      await codes(
        adopted({
          membershipSources: [
            membersSource({ columns: { scope: "userId", user: "userId" } }),
          ],
        })
      )
    ).toEqual([
      ["rights.source-scope-column", "/membershipSources/0/columns/scope"],
    ])
    const unscoped = membershipTable({ scope: "none" })
    delete (unscoped as { scopeColumn?: string }).scopeColumn
    expect(
      await codes(
        adopted(
          { membershipSources: [membersSource()] },
          { [MEMBERSHIP_FILE]: unscoped }
        )
      )
    ).toEqual([["rights.source-scope-column", "/membershipSources/0/table"]])
    const otherKind = await compileRights(
      adopted(
        {
          scopeKinds: [
            {
              id: ORG_KIND_ID,
              name: "org",
              physicalName: "org_id",
              root: { object: ref("Catalog", "Organization") },
              setFunction: { schema: "public", name: "org_ids" },
            },
            {
              id: uuid(6140),
              name: "team",
              physicalName: "team_id",
              root: {
                external: { schema: "auth", table: "users", column: "id" },
              },
              setFunction: { schema: "public", name: "team_ids" },
            },
          ],
          membershipSources: [membersSource()],
        },
        { [MEMBERSHIP_FILE]: membershipTable({ scope: "team" }) }
      )
    )
    expect(
      errors(otherKind)
        .filter((d) => d.code === "rights.source-scope-column")
        .map((d) => [d.pointer, d.params])
    ).toEqual([
      ["/membershipSources/0/table", { source: "members", reason: "scope" }],
    ])
  })

  it("requires users or a membership source for rights declarations", async () => {
    const withoutUsers = (
      project: Record<string, unknown>,
      task: Record<string, unknown> = {},
      extra: Record<string, Record<string, unknown>> = {}
    ) => {
      const files = adopted(project, {
        ...extra,
        [TASK_FILE]: {
          trackAuthor: false,
          attributes: [
            {
              id: uuid(6011),
              name: "assignee",
              physicalName: "assignee_id",
              type: "Ref",
              ref: ref("CustomTable", "Membership"),
            },
            {
              id: uuid(6012),
              name: "project",
              physicalName: "project_id",
              type: "Ref",
              ref: ref("Catalog", "Project"),
            },
          ],
          ...task,
        },
      })
      files.delete(USERS_FILE)
      return files
    }
    const region = {
      id: uuid(6130),
      name: "region",
      target: ref("Catalog", "Region"),
      values: { function: { name: "my_regions" } },
    }
    // Кожна декларація прав окремо вимагає «Користувачів» чи джерела.
    const declarations: [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, Record<string, unknown>>?,
    ][] = [
      ["ownership", {}, { ownership: ["assignee"] }],
      [
        "access",
        {},
        { access: [{ attribute: "project", dimension: "region" }] },
      ],
      ["containerBinding", {}, { containerBinding: "project" }],
      ["accessDimensions", { accessDimensions: [region] }, {}],
      ["assignmentSources", { assignmentSources: [grantsSource()] }, {}],
      [
        "Role",
        {},
        {},
        { [ROLE_FILE("Support")]: role(SUPPORT_ID, "Support", "global") },
      ],
      [
        "RightsSet",
        {},
        {},
        {
          [SET_FILE("TaskReaders")]: rightsSet(TASK_READERS_ID, "TaskReaders"),
        },
      ],
    ]
    for (const [label, project, task, extra] of declarations) {
      expect(
        await codes(withoutUsers(project, task, extra)),
        label
      ).toContainEqual(["rights.users-missing", ""])
    }
    // Без декларацій прав «Користувачі» не потрібні.
    await compiled(withoutUsers({}))
    await compiled(
      withoutUsers(
        { membershipSources: [membersSource()] },
        { ownership: ["assignee"] }
      )
    )
  })

  it("accepts an owner that refers to the adopted membership source", async () => {
    const owned = (
      project: Record<string, unknown>,
      table: Record<string, unknown> = membershipTable()
    ) =>
      adopted(project, {
        [TASK_FILE]: {
          ownership: ["assignee"],
          attributes: [
            {
              id: uuid(6011),
              name: "assignee",
              physicalName: "assignee_id",
              type: "Ref",
              ref: ref("CustomTable", "Membership"),
            },
          ],
        },
        [MEMBERSHIP_FILE]: table,
      })
    const model = await compiled(
      owned({ membershipSources: [membersSource()] })
    )
    const task = model.contracts.rights.find((r) => r.table.name === "task")!
    expect(task.ownership).toEqual([{ column: "assignee_id" }])
    const fk = model.physical.tables
      .find((t) => t.name === "task")!
      .foreignKeys.find((f) => f.columns.includes("assignee_id"))!
    expect(fk.columns).toEqual(["org_id", "assignee_id"])

    expect(
      await codes(
        owned(
          { membershipSources: [membersSource()] },
          membershipTable({ uniques: [] })
        )
      )
    ).toEqual([["rights.carrier-cross-tenant", "/ownership/0"]])

    const notSource = await compileRights(owned({}))
    expect(
      errors(notSource)
        .filter((d) => d.code === "rights.ownership-target")
        .map((d) => [d.pointer, d.params])
    ).toEqual([["/ownership/0", { attribute: "assignee", reason: "target" }]])
  })

  it("assigns ids to sources", () => {
    const members = membersSource({ id: undefined })
    const grants = grantsSource({ id: undefined })
    let next = 7200
    const completed = completeFiles(
      adopted({ membershipSources: [members], assignmentSources: [grants] }),
      { schemaPath: (_, schema) => schema, newId: () => uuid(++next) }
    )
    const written = JSON.parse(completed.files.get(PROJECT)!) as {
      membershipSources: { id?: string }[]
      assignmentSources: { id?: string }[]
    }
    expect(written.membershipSources[0]!.id).toBe(uuid(7201))
    expect(written.assignmentSources[0]!.id).toBe(uuid(7202))
  })
})
