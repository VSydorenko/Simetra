import { describe, expect, it } from "vitest"
import { completeFiles } from "simetra/compiler"
import {
  GRANT_FILE,
  GRANTS_SOURCE_ID,
  ORG_ASSIGNMENTS_FILE,
  ORG_ROLES_FILE,
  MEMBERSHIP_FILE,
  MEMBERSHIP_ID,
  MEMBERS_SOURCE_ID,
  MEMBER_FILE,
  POLY_GRANT_FILE,
  SOURCE_ROLE_FILE,
  MEMBER_REGION_FILE,
  ORG_KIND_ID,
  PROJECT_ID,
  ROLE_FILE,
  SET_FILE,
  SUPPORT_ID,
  TASK_FILE,
  TASK_READERS_ID,
  adoptedGrantTable,
  adoptedCrossKind,
  adoptedMembershipTable,
  adoptedSourcesDomain,
  compileRights,
  globalGrantsSource,
  grantTable,
  grantsSource,
  membersSource,
  membershipTable,
  polyColumns,
  polyContainerGrantsSource,
  polyGrantTable,
  polyGrantsSource,
  polymorphicGrantsDomain,
  rightsFiles,
  rightsSet,
  role,
  sourceRoleRef,
  sourceRoleTable,
  without,
  withoutUsers,
  type Layer,
} from "./fixtures/rights"
import { expectClean, uuid } from "./helpers"

type Files = ReturnType<typeof rightsFiles>

const PROJECT = "project.meta.json"
const USERS_FILE = "catalogs/Users/Users.meta.json"

const ref = (kind: string, name: string) => ({ kind, name })

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
    // Три джерела над однією `RoleGrant` — лише з несумісними умовами
    // дискримінатора `level` (Р2d1-19).
    const level = (value: string) => [{ column: "level", equals: value }]
    const table = grantTable()
    const model = await compiled(
      adopted(
        {
          membershipSources: [membersSource()],
          assignmentSources: [
            grantsSource({ where: level("container") }),
            grantsSource({
              id: uuid(6122),
              name: "orgGrants",
              assignedOn: { scopeKind: "org" },
              columns: { member: "memberId", role: "roleKey", scope: null },
              where: level("org"),
            }),
            grantsSource({
              id: uuid(6123),
              name: "globalGrants",
              assignedOn: "global",
              columns: { member: "memberId", role: "roleKey" },
              where: level("global"),
            }),
          ],
        },
        {
          [GRANT_FILE]: {
            ...table,
            columns: [
              ...table.columns,
              {
                id: uuid(6119),
                name: "level",
                physicalName: "level",
                type: "Text",
                notNull: true,
              },
            ],
          },
        }
      )
    )
    const levelContract = (value: string) => [
      { column: "level", equals: value, type: "text" },
    ]
    expect(model.contracts.membershipSources).toEqual([
      {
        sourceId: MEMBERS_SOURCE_ID,
        name: "members",
        scopeKindId: ORG_KIND_ID,
        table: { schema: "public", name: "membership" },
        scope: "org_id",
        member: "id",
        user: "user_id",
        active: "is_active",
        where: [],
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
        where: levelContract("container"),
      },
      {
        sourceId: uuid(6122),
        name: "orgGrants",
        assignedOn: { level: "scope", scopeKindId: ORG_KIND_ID },
        table: { schema: "public", name: "role_grant" },
        member: "member_id",
        role: "role_key",
        where: levelContract("org"),
      },
      {
        sourceId: uuid(6123),
        name: "globalGrants",
        assignedOn: { level: "global" },
        table: { schema: "public", name: "role_grant" },
        member: "member_id",
        role: "role_key",
        where: levelContract("global"),
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
    expect(task.ownership).toEqual([
      {
        column: "assignee_id",
        value: "assignee_id",
        owner: { membership: ORG_KIND_ID },
      },
    ])
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

/** Таблиця з колонкою `name` іншого типу. */
const retype = (
  table: { columns: { name: string }[] },
  name: string,
  type: string
) => ({
  ...table,
  columns: table.columns.map((c) => (c.name === name ? { ...c, type } : c)),
})

describe("adopted source member and column types", () => {
  // Зламаний ключ таблиці дає й супутні діагностики (власність `Task.assignee`
  // на неї), тож рядок перевіряє наявність свого коду на своєму вказівнику.
  it.each<{
    case: string
    layer: Layer
    code: string
    pointer: string
    params: Record<string, string>
  }>([
    {
      case: "composite key",
      layer: {
        [MEMBERSHIP_FILE]: { primaryKey: { columns: ["orgId", "id"] } },
      },
      code: "rights.source-member-key",
      pointer: "/membershipSources/0/table",
      params: { source: "members", table: "Membership" },
    },
    {
      case: "text key",
      layer: {
        [MEMBERSHIP_FILE]: retype(adoptedMembershipTable(), "id", "Text"),
      },
      code: "rights.source-member-key",
      pointer: "/membershipSources/0/table",
      params: { source: "members", table: "Membership" },
    },
    {
      // Суб'єкт довідників прав `org` посилається на таблицю складеним FK.
      case: "no unique for subject",
      layer: { [MEMBERSHIP_FILE]: { uniques: [] } },
      code: "rights.source-member-unique",
      pointer: "/membershipSources/0/table",
      params: { source: "members", table: "Membership" },
    },
    {
      case: "member text",
      layer: { [GRANT_FILE]: retype(adoptedGrantTable(), "memberId", "Text") },
      code: "rights.source-column-type",
      pointer: "/assignmentSources/0/columns/member",
      params: { source: "grants", column: "memberId", expected: "UUID" },
    },
    {
      case: "active text",
      layer: {
        [MEMBERSHIP_FILE]: retype(adoptedMembershipTable(), "isActive", "Text"),
      },
      code: "rights.source-column-type",
      pointer: "/membershipSources/0/columns/active",
      params: { source: "members", column: "isActive", expected: "Boolean" },
    },
    {
      case: "user text",
      layer: {
        [MEMBERSHIP_FILE]: retype(adoptedMembershipTable(), "userId", "Text"),
      },
      code: "rights.source-column-type",
      pointer: "/membershipSources/0/columns/user",
      params: { source: "members", column: "userId", expected: "UUID" },
    },
    {
      case: "membership scope text",
      layer: {
        [MEMBERSHIP_FILE]: retype(adoptedMembershipTable(), "orgId", "Text"),
      },
      code: "rights.source-column-type",
      pointer: "/membershipSources/0/columns/scope",
      params: { source: "members", column: "orgId", expected: "UUID" },
    },
    {
      case: "container text",
      layer: {
        [GRANT_FILE]: retype(adoptedGrantTable(), "projectId", "Text"),
      },
      code: "rights.source-column-type",
      pointer: "/assignmentSources/0/columns/container",
      params: { source: "grants", column: "projectId", expected: "UUID" },
    },
    {
      case: "role key column uuid",
      layer: { [GRANT_FILE]: retype(adoptedGrantTable(), "roleKey", "UUID") },
      code: "rights.source-column-type",
      pointer: "/assignmentSources/0/columns/role",
      params: { source: "grants", column: "roleKey", expected: "Text" },
    },
  ])("$case", async ({ layer, code, pointer, params }) => {
    const result = await compileRights(adoptedSourcesDomain(layer))
    expect(
      errors(result).map((d) => ({
        code: d.code,
        pointer: d.pointer,
        params: d.params,
      }))
    ).toContainEqual({ code, pointer, params })
  })

  it("asks for UNIQUE (scope, id) only when the scope kind has rights catalogs", async () => {
    const result = await compileRights(
      adoptedSourcesDomain(
        { [MEMBERSHIP_FILE]: { uniques: [] } },
        without(ORG_ROLES_FILE, ORG_ASSIGNMENTS_FILE)
      )
    )
    expect(errors(result).map((d) => d.code)).not.toContain(
      "rights.source-member-unique"
    )
  })

  it("clean: only the write-boundary warning on every source", async () => {
    const result = await compileRights(adoptedSourcesDomain())
    expectClean(result, { allow: ["rights.adopted-source-writes"] })
    expect(
      result.diagnostics
        .map((d) => [d.code, d.pointer, d.params])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    ).toEqual([
      [
        "rights.adopted-source-writes",
        "/assignmentSources/0",
        { source: "grants" },
      ],
      [
        "rights.adopted-source-writes",
        "/assignmentSources/1",
        { source: "globalGrants" },
      ],
      [
        "rights.adopted-source-writes",
        "/membershipSources/0",
        { source: "members" },
      ],
    ])
    expect(result.model!.contracts.membershipSources).toEqual([
      expect.objectContaining({ sourceId: MEMBERS_SOURCE_ID, member: "id" }),
    ])
  })

  it.each([
    ["without users", withoutUsers()],
    ["with a second scope kind", adoptedCrossKind()],
  ])("clean %s: only the write-boundary warning", async (_, layer) => {
    const result = await compileRights(adoptedSourcesDomain(layer))
    expectClean(result, { allow: ["rights.adopted-source-writes"] })
  })
})

// Uuid з літерами hex: регістр літералу має значення лише для них.
const ORG_UUID = "0000abcd-0000-4000-8000-00000000ef01"

const poly = polymorphicGrantsDomain

/** `PolyGrant` з додатковими колонками й перевизначеннями. */
const polyTable = (
  extra: Record<string, unknown>[] = [],
  overrides: Record<string, unknown> = {}
): Layer => {
  const table = polyGrantTable(overrides)
  return {
    [POLY_GRANT_FILE]: { ...table, columns: [...table.columns, ...extra] },
  }
}

const polyColumn = (
  n: number,
  name: string,
  physicalName: string,
  type: string,
  more: Record<string, unknown> = {}
) => ({ id: uuid(n), name, physicalName, type, notNull: true, ...more })

const roleWithout = { role: sourceRoleRef({ where: [] }) }

/** Ціла колонка `PolyGrant` для умов рівності з числом. */
const RANK = polyColumn(6174, "rank", "rank", "Integer")

/** Скоуплена видом `kind` таблиця `PolyGrant` зі скоуп-колонкою. */
const scopedPolyOf = (kind: string, scopeColumn: string) =>
  polyTable([], { scope: kind, scopeColumn })

/** Скоуплена `org` таблиця `PolyGrant` зі скоуп-колонкою. */
const scopedPoly = (
  scopeColumn: string,
  extra: Record<string, unknown>[] = []
) => polyTable(extra, { scope: "org", scopeColumn })

async function diagnosticsOf(files: Map<string, string>) {
  return errors(await compileRights(files)).map((d) => ({
    code: d.code,
    pointer: d.pointer,
    params: d.params,
  }))
}

describe("adopted source where, row scope and role table", () => {
  // Рядок перевіряє наявність свого коду на своєму вказівнику (як у Задачі 1):
  // зламана умова тягне й супутні діагностики.
  it.each<{
    case: string
    files: () => Map<string, string>
    expected: { code: string; pointer: string; params?: object }[]
  }>([
    {
      case: "where unknown column",
      files: () =>
        poly({ polyGrants: { where: [{ column: "nope", equals: "org" }] } }),
      expected: [
        {
          code: "customTable.column-unknown",
          pointer: "/assignmentSources/2/where/0/column",
        },
      ],
    },
    {
      case: "where literal of a text column",
      files: () =>
        poly({ polyGrants: { where: [{ column: "scopeType", equals: 1 }] } }),
      expected: [
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/2/where/0",
          params: {
            source: "polyGrants",
            column: "scopeType",
            reason: "literal",
          },
        },
      ],
    },
    {
      case: "where uuid literal",
      files: () =>
        poly({
          polyGrants: {
            where: [
              { column: "scopeType", equals: "org" },
              { column: "scopeId", equals: "not-a-uuid" },
            ],
          },
        }),
      expected: [
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/2/where/1",
          params: {
            source: "polyGrants",
            column: "scopeId",
            reason: "literal",
          },
        },
      ],
    },
    {
      case: "where uuid without dashes",
      files: () =>
        poly({
          polyGrants: {
            where: [
              { column: "scopeType", equals: "org" },
              { column: "scopeId", equals: ORG_UUID.replaceAll("-", "") },
            ],
          },
        }),
      expected: [
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/2/where/1",
          params: {
            source: "polyGrants",
            column: "scopeId",
            reason: "literal",
          },
        },
      ],
    },
    {
      case: "where integer literal",
      files: () =>
        poly(
          {
            polyGrants: {
              where: [
                { column: "scopeType", equals: "org" },
                { column: "rank", equals: "7" },
              ],
            },
          },
          polyTable([RANK])
        ),
      expected: [
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/2/where/1",
          params: { source: "polyGrants", column: "rank", reason: "literal" },
        },
      ],
    },
    {
      case: "where array column",
      files: () =>
        poly(
          {
            polyGrants: {
              where: [
                { column: "scopeType", equals: "org" },
                { column: "tags", equals: "x" },
              ],
            },
          },
          polyTable([polyColumn(6171, "tags", "tags", "Text", { array: true })])
        ),
      expected: [
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/2/where/1",
          params: { source: "polyGrants", column: "tags", reason: "type" },
        },
      ],
    },
    {
      case: "where unsupported type",
      files: () =>
        poly(
          {
            polyGrants: {
              where: [
                { column: "scopeType", equals: "org" },
                { column: "weight", equals: 1 },
              ],
            },
          },
          polyTable([polyColumn(6172, "weight", "weight", "Numeric")])
        ),
      expected: [
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/2/where/1",
          params: { source: "polyGrants", column: "weight", reason: "type" },
        },
      ],
    },
    {
      case: "membership where",
      files: () =>
        poly({ members: { where: [{ column: "isActive", equals: "yes" }] } }),
      expected: [
        {
          code: "rights.source-where",
          pointer: "/membershipSources/0/where/0",
          params: { source: "members", column: "isActive", reason: "literal" },
        },
      ],
    },
    {
      case: "scope missing",
      files: () =>
        poly({
          polyGrants: {
            columns: { member: "memberId", role: sourceRoleRef() },
          },
        }),
      expected: [
        {
          code: "rights.source-scope-column",
          pointer: "/assignmentSources/2/columns",
          params: { source: "polyGrants", reason: "missing" },
        },
      ],
    },
    {
      case: "scope null on a table with a scope column",
      files: () =>
        poly(
          { polyGrants: { columns: polyColumns({ scope: null }) } },
          scopedPoly("scopeId")
        ),
      expected: [
        {
          code: "rights.source-scope-column",
          pointer: "/assignmentSources/2/columns/scope",
          params: { source: "polyGrants", reason: "column" },
        },
      ],
    },
    {
      case: "scope null on a container level",
      files: () =>
        poly({
          grants: {
            columns: {
              member: "memberId",
              role: "roleKey",
              container: "projectId",
              scope: null,
            },
          },
        }),
      expected: [
        {
          code: "rights.source-scope-column",
          pointer: "/assignmentSources/0/columns/scope",
          params: { source: "grants", reason: "level" },
        },
      ],
    },
    {
      case: "scope on a container level",
      files: () =>
        poly({
          grants: {
            columns: {
              member: "memberId",
              role: "roleKey",
              container: "projectId",
              scope: "projectId",
            },
          },
        }),
      expected: [
        {
          code: "rights.source-scope-column",
          pointer: "/assignmentSources/0/columns/scope",
          params: { source: "grants", reason: "level" },
        },
      ],
    },
    {
      case: "scope text",
      files: () =>
        poly(
          {},
          {
            [POLY_GRANT_FILE]: retype(polyGrantTable(), "scopeId", "Text"),
          }
        ),
      expected: [
        {
          code: "rights.source-column-type",
          pointer: "/assignmentSources/2/columns/scope",
          params: { source: "polyGrants", column: "scopeId", expected: "UUID" },
        },
      ],
    },
    {
      case: "scope other than the table scope column",
      files: () =>
        poly(
          {},
          scopedPoly("orgId", [polyColumn(6173, "orgId", "org_id", "UUID")])
        ),
      expected: [
        {
          code: "rights.source-scope-column",
          pointer: "/assignmentSources/2/columns/scope",
          params: { source: "polyGrants", reason: "column" },
        },
      ],
    },
    {
      case: "shared table without where",
      files: () => poly({ polyContainerGrants: { where: [] } }),
      expected: [
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/2/table",
          params: { source: "polyGrants", reason: "shared" },
        },
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/3/table",
          params: { source: "polyContainerGrants", reason: "shared" },
        },
      ],
    },
    ...(
      [
        [
          "shared with the same literal",
          [{ column: "scopeType", equals: "org" }],
          [{ column: "scopeType", equals: "org" }],
        ],
        [
          "shared with the same uuid in another case",
          [{ column: "scopeId", equals: ORG_UUID }],
          [{ column: "scopeId", equals: ORG_UUID.toUpperCase() }],
        ],
        [
          "shared with equals against isNull false",
          [{ column: "scopeType", equals: "org" }],
          [{ column: "scopeType", isNull: false }],
        ],
        [
          "shared with isNull true on both",
          [{ column: "scopeType", isNull: true }],
          [{ column: "scopeType", isNull: true }],
        ],
        [
          "shared with isNull false against equals",
          [{ column: "scopeType", isNull: false }],
          [{ column: "scopeType", equals: "container" }],
        ],
        [
          "shared with conditions on different columns",
          [{ column: "scopeType", equals: "org" }],
          [{ column: "scopeId", isNull: true }],
        ],
      ] as const
    ).map(([label, left, right]) => ({
      case: label,
      files: () =>
        poly({
          polyGrants: { where: left },
          polyContainerGrants: { where: right },
        }),
      expected: [
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/2/table",
          params: { source: "polyGrants", reason: "shared" },
        },
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/3/table",
          params: { source: "polyContainerGrants", reason: "shared" },
        },
      ],
    })),
    {
      case: "shared with different literals under a column collation",
      files: () =>
        poly(
          {},
          {
            [POLY_GRANT_FILE]: {
              ...polyGrantTable(),
              columns: polyGrantTable().columns.map((c) =>
                c.name === "scopeType" ? { ...c, collation: { name: "C" } } : c
              ),
            },
          }
        ),
      expected: [
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/2/table",
          params: { source: "polyGrants", reason: "shared" },
        },
      ],
    },
    {
      case: "role ambiguous",
      files: () =>
        poly({
          polyGrants: { columns: polyColumns(roleWithout) },
          polyContainerGrants: {
            columns: {
              member: "memberId",
              container: "scopeId",
              ...roleWithout,
            },
          },
        }),
      expected: [
        {
          code: "rights.source-role-key",
          pointer: "/assignmentSources/2/columns/role",
          params: {
            source: "polyGrants",
            table: "SourceRole",
            reason: "ambiguous",
          },
        },
        {
          code: "rights.source-role-key",
          pointer: "/assignmentSources/3/columns/role",
          params: {
            source: "polyContainerGrants",
            table: "SourceRole",
            reason: "ambiguous",
          },
        },
      ],
    },
    ...(
      [
        [
          "role ambiguous with a collated unique index",
          {
            name: "source_roles_key",
            unique: true,
            keys: [{ column: "key", collation: { name: "C" } }],
          },
        ],
        [
          "role ambiguous with an opclass unique index",
          {
            name: "source_roles_key",
            unique: true,
            keys: [{ column: "key", opclass: { name: "text_pattern_ops" } }],
          },
        ],
        [
          "role ambiguous with a composite index",
          {
            name: "source_roles_key_org",
            unique: true,
            keys: [{ column: "key" }, { column: "orgId" }],
          },
        ],
        [
          "role ambiguous with a partial unique index",
          {
            name: "source_roles_key_system",
            unique: true,
            keys: [{ column: "key" }],
            where: "org_id IS NULL",
          },
        ],
      ] as const
    ).map(([label, index]) => ({
      case: label,
      files: () =>
        poly(
          { polyGrants: { columns: polyColumns(roleWithout) } },
          { [SOURCE_ROLE_FILE]: sourceRoleTable({ indexes: [index] }) }
        ),
      expected: [
        {
          code: "rights.source-role-key",
          pointer: "/assignmentSources/2/columns/role",
          params: {
            source: "polyGrants",
            table: "SourceRole",
            reason: "ambiguous",
          },
        },
      ],
    })),
    ...(
      [
        ["role ambiguous with a deferrable unique", "deferrable"],
        [
          "role ambiguous with an initially deferred unique",
          "initiallyDeferred",
        ],
      ] as const
    ).map(([label, deferrable]) => ({
      case: label,
      files: () =>
        poly(
          { polyGrants: { columns: polyColumns(roleWithout) } },
          {
            [SOURCE_ROLE_FILE]: sourceRoleTable({
              uniques: [{ columns: ["key"], deferrable }],
            }),
          }
        ),
      expected: [
        {
          code: "rights.source-role-key",
          pointer: "/assignmentSources/2/columns/role",
          params: {
            source: "polyGrants",
            table: "SourceRole",
            reason: "ambiguous",
          },
        },
      ],
    })),
    {
      case: "role ambiguous with a composite unique",
      files: () =>
        poly(
          { polyGrants: { columns: polyColumns(roleWithout) } },
          {
            [SOURCE_ROLE_FILE]: sourceRoleTable({
              uniques: [{ columns: ["key", "orgId"] }],
            }),
          }
        ),
      expected: [
        {
          code: "rights.source-role-key",
          pointer: "/assignmentSources/2/columns/role",
          params: {
            source: "polyGrants",
            table: "SourceRole",
            reason: "ambiguous",
          },
        },
      ],
    },
    {
      // Скоуплена таблиця іншого виду несе чужий тенант.
      case: "table scoped by another kind than the level",
      files: () =>
        poly({}, adoptedCrossKind(), scopedPolyOf("team", "scopeId")),
      expected: [
        {
          code: "rights.source-scope-column",
          pointer: "/assignmentSources/2/table",
          params: { source: "polyGrants", reason: "scope" },
        },
      ],
    },
    {
      case: "role table not adopted",
      files: () =>
        poly({
          polyGrants: {
            columns: polyColumns({
              role: sourceRoleRef({ references: ref("Catalog", "Project") }),
            }),
          },
        }),
      expected: [
        {
          code: "rights.source-table",
          pointer: "/assignmentSources/2/columns/role/references",
          params: { source: "polyGrants" },
        },
      ],
    },
    {
      case: "role table composite key",
      files: () =>
        poly(
          {},
          {
            [SOURCE_ROLE_FILE]: sourceRoleTable({
              primaryKey: { columns: ["orgId", "id"] },
            }),
          }
        ),
      expected: [
        {
          code: "rights.source-role-key",
          pointer: "/assignmentSources/2/columns/role/references",
          params: {
            source: "polyGrants",
            table: "SourceRole",
            reason: "primaryKey",
          },
        },
      ],
    },
    {
      case: "role table forced rls",
      files: () =>
        poly(
          {},
          {
            [SOURCE_ROLE_FILE]: sourceRoleTable({ rowLevelSecurity: "forced" }),
          }
        ),
      expected: [
        {
          code: "rights.source-forced-rls",
          pointer: "/assignmentSources/2/columns/role/references",
          params: { source: "polyGrants", table: "SourceRole" },
        },
      ],
    },
    {
      case: "role key uuid",
      files: () =>
        poly({
          polyGrants: {
            columns: polyColumns({ role: sourceRoleRef({ key: "id" }) }),
          },
        }),
      expected: [
        {
          code: "rights.source-column-type",
          pointer: "/assignmentSources/2/columns/role/key",
          params: { source: "polyGrants", column: "id", expected: "Text" },
        },
      ],
    },
    {
      case: "role column text",
      files: () =>
        poly(
          {},
          { [POLY_GRANT_FILE]: retype(polyGrantTable(), "roleId", "Text") }
        ),
      expected: [
        {
          code: "rights.source-column-type",
          pointer: "/assignmentSources/2/columns/role/column",
          params: { source: "polyGrants", column: "roleId", expected: "UUID" },
        },
      ],
    },
    {
      case: "role where literal",
      files: () =>
        poly({
          polyGrants: {
            columns: polyColumns({
              role: sourceRoleRef({
                where: [{ column: "orgId", equals: true }],
              }),
            }),
          },
        }),
      expected: [
        {
          code: "rights.source-where",
          pointer: "/assignmentSources/2/columns/role/where/0",
          params: { source: "polyGrants", column: "orgId", reason: "literal" },
        },
      ],
    },
  ])("$case", async ({ files, expected }) => {
    const found = await diagnosticsOf(files())
    for (const { code, pointer, params } of expected) {
      expect(found).toContainEqual(
        params === undefined
          ? expect.objectContaining({ code, pointer })
          : { code, pointer, params }
      )
    }
  })

  // Негативні правила: таблиця вище перевіряє лише наявність коду.
  const codesOf = async (files: Map<string, string>) =>
    (await diagnosticsOf(files)).map((d) => d.code)

  it("isNull accepts a column of any type", async () => {
    expect(
      await codesOf(
        poly(
          {
            polyGrants: {
              where: [
                { column: "scopeType", equals: "org" },
                { column: "weight", isNull: true },
              ],
            },
          },
          polyTable([polyColumn(6172, "weight", "weight", "Numeric")])
        )
      )
    ).not.toContain("rights.source-where")
  })

  it("an integer column takes a JSON integer literal", async () => {
    expect(
      await codesOf(
        poly(
          {
            polyGrants: {
              where: [
                { column: "scopeType", equals: "org" },
                { column: "rank", equals: 7 },
              ],
            },
          },
          polyTable([RANK])
        )
      )
    ).not.toContain("rights.source-where")
  })

  it("reports shared conditions of every pair, not only of neighbours", async () => {
    // Третє джерело над `PolyGrant` перетинається з першим, а друге — посередині
    // — несумісне з обома: сусідні пари пройшли б.
    const found = await diagnosticsOf(
      poly(
        {},
        {
          [PROJECT]: {
            assignmentSources: [
              grantsSource(),
              globalGrantsSource({ table: ref("CustomTable", "GlobalGrant") }),
              polyGrantsSource(),
              polyContainerGrantsSource(),
              polyGrantsSource({ id: uuid(6162), name: "polyOrgGrants" }),
            ],
          },
        }
      )
    )
    expect(
      found
        .filter(
          (d) =>
            d.code === "rights.source-where" &&
            (d.params as { reason?: string }).reason === "shared"
        )
        .map((d) => d.pointer)
    ).toEqual(["/assignmentSources/2/table", "/assignmentSources/4/table"])
  })

  it.each([
    ["scope null", { columns: polyColumns({ scope: null }) }],
    // Нескоуплена `PolyGrant` без `scopeColumn` з `columns.scope` — законна.
    ["unscoped table with a scope column", {}],
  ])("%s: no row scope error", async (_, polyGrants) => {
    expect(await codesOf(poly({ polyGrants }))).not.toContain(
      "rights.source-scope-column"
    )
  })

  it.each([
    [
      "different literals",
      [{ column: "scopeType", equals: "org" }],
      [{ column: "scopeType", equals: "container" }],
    ],
    [
      "equals against isNull true",
      [{ column: "scopeType", equals: "org" }],
      [{ column: "scopeType", isNull: true }],
    ],
    [
      "isNull true against equals",
      [{ column: "scopeType", isNull: true }],
      [{ column: "scopeType", equals: "container" }],
    ],
    [
      "isNull true against isNull false",
      [{ column: "scopeType", isNull: true }],
      [{ column: "scopeType", isNull: false }],
    ],
    [
      "one disjoint column among shared conjuncts",
      [
        { column: "scopeId", isNull: false },
        { column: "scopeType", equals: "org" },
      ],
      [
        { column: "scopeId", isNull: false },
        { column: "scopeType", equals: "container" },
      ],
    ],
  ])("disjoint conditions pass: %s", async (_, left, right) => {
    const found = await diagnosticsOf(
      poly({
        polyGrants: { where: left },
        polyContainerGrants: { where: right },
      })
    )
    expect(found).not.toContainEqual(
      expect.objectContaining({
        code: "rights.source-where",
        params: expect.objectContaining({ reason: "shared" }),
      })
    )
  })

  it.each([
    ["a unique constraint", { uniques: [{ columns: ["key"] }] }],
    [
      "a unique index without where",
      {
        indexes: [
          { name: "source_roles_key", unique: true, keys: [{ column: "key" }] },
        ],
      },
    ],
  ])("a unique role key needs no role where: %s", async (_, overrides) => {
    expect(
      await codesOf(
        poly(
          { polyGrants: { columns: polyColumns(roleWithout) } },
          { [SOURCE_ROLE_FILE]: sourceRoleTable(overrides) }
        )
      )
    ).not.toContain("rights.source-role-key")
  })

  it("clean: only the write-boundary warning on every source", async () => {
    const result = await compileRights(poly())
    expectClean(result, { allow: ["rights.adopted-source-writes"] })
    expect(result.diagnostics.map((d) => d.pointer).sort()).toEqual([
      "/assignmentSources/0",
      "/assignmentSources/1",
      "/assignmentSources/2",
      "/assignmentSources/3",
      "/membershipSources/0",
    ])
  })
})
