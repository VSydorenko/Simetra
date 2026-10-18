import { describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import {
  COMMENT_FILE,
  GRANT_FILE,
  ORG_MEMBER_ROLE_ID,
  PROJECT_FILE,
  ROLE_FILE,
  SET_FILE,
  STATUS_FILE,
  TASK_FILE,
  TASK_READERS_ID,
  USERS_FILE,
  compileRights,
  deny,
  grant,
  grantAll,
  grantTable,
  objects,
  regionDimension,
  rightsSet,
  statusEnumeration,
  withRoles,
} from "./fixtures/rights"
import { uuid } from "./helpers"

type Layer = Record<string, Record<string, unknown>>

const REASSIGN_ID = uuid(6300)
const COMMENT_REASSIGN_ID = uuid(6301)
const SET_A_ID = uuid(6203)
const SET_B_ID = uuid(6204)

const TASK = objects(["Document", "Task"])
const USERS = objects(["Catalog", "Users"])
const REGION = objects(["Catalog", "Region"])
const ref = (kind: string, name: string) => ({ kind, name })

/**
 * Права об'єктів для розгортання: `Task` має власність, вимір `region` і
 * прив'язку до контейнера `Project`, коментар — прив'язку через задачу,
 * «Користувачі» — власність самого рядка. `TaskReaders` дає `read@any` на
 * `Task`, `TaskEditors` — `update@own`.
 */
const BASE: Layer = {
  [PROJECT_FILE]: { accessDimensions: [regionDimension()] },
  [TASK_FILE]: {
    ownership: ["assignee"],
    access: [{ attribute: "region", dimension: "region" }],
    containerBinding: "project",
  },
  [COMMENT_FILE]: { containerBinding: ["task", "project"] },
  [USERS_FILE]: { ownership: ["ref"] },
  [SET_FILE("TaskReaders")]: { grants: [grant(TASK, ["read"], "any")] },
  [SET_FILE("TaskEditors")]: { grants: [grant(TASK, ["update"], "own")] },
}

/** Кастомна дія `reassign` у задачі й коментаря — з різними UUID. */
const REASSIGN: Layer = {
  [TASK_FILE]: {
    ...BASE[TASK_FILE],
    customActions: [{ id: REASSIGN_ID, name: "reassign" }],
  },
  [COMMENT_FILE]: {
    ...BASE[COMMENT_FILE],
    customActions: [{ id: COMMENT_REASSIGN_ID, name: "reassign" }],
  },
}

/** Роль `OrgMember` лише з власними грантами, без включень. */
const member = (...grants: unknown[]): Layer => ({
  [ROLE_FILE("OrgMember")]: { include: [], grants },
})

const files = (...layers: Layer[]) => withRoles(BASE, ...layers)

async function compiled(input: ReturnType<typeof files>) {
  const result = await compileRights(input)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

async function errors(input: ReturnType<typeof files>) {
  const result = await compileRights(input)
  return result.diagnostics
    .filter((d) => d.severity === "error")
    .map(({ code, file, pointer, params }) => ({ code, file, pointer, params }))
}

/** Рядки проєкції в порядку контракту: `[роль, об'єкт, дія, ключ обсягу]`. */
function rows(model: CompiledModel) {
  const names = new Map(model.objects.map((o) => [o.id, o.name]))
  const dimensions = new Map(
    model.project.accessDimensions.map((d) => [d.id, d.name])
  )
  return model.contracts.rightsProjection.map((row) => [
    names.get(row.roleId),
    names.get(row.objectId),
    row.action,
    typeof row.extent === "string"
      ? row.extent
      : `dim:${dimensions.get(row.extent.dimensionId)}`,
  ])
}

const objectsOf = (model: CompiledModel) => [
  ...new Set(rows(model).map(([, object]) => object)),
]

describe("rights projection", () => {
  it("expands sets transitively and derives own from any", async () => {
    expect(rows(await compiled(files()))).toEqual([
      ["OrgMember", "Task", "read", "any"],
      ["OrgMember", "Task", "read", "own"],
      ["OrgMember", "Task", "read", "dim:region"],
      ["OrgMember", "Task", "update", "own"],
    ])
  })

  it("denies with extent precision", async () => {
    const denied = (...grants: unknown[]) =>
      files({ [ROLE_FILE("OrgMember")]: { grants } })
    expect(rows(await compiled(denied(deny(TASK, ["read"], "any"))))).toEqual([
      ["OrgMember", "Task", "read", "own"],
      ["OrgMember", "Task", "read", "dim:region"],
      ["OrgMember", "Task", "update", "own"],
    ])
    // Без обсягу `deny` знімає всі обсяги дії — і `update@own` лишається без
    // своєї вимоги.
    expect(await errors(denied(deny(TASK, ["read"])))).toEqual([
      {
        code: "rights.requires-missing",
        file: SET_FILE("TaskEditors"),
        pointer: "/grants/0",
        params: {
          object: "Task",
          action: "update",
          requires: "read",
          extent: "own",
        },
      },
    ])
  })

  it("merges a diamond of sets", async () => {
    const model = await compiled(
      files({
        [ROLE_FILE("OrgMember")]: {
          include: [ref("RightsSet", "SetA"), ref("RightsSet", "SetB")],
        },
        [SET_FILE("SetA")]: rightsSet(SET_A_ID, "SetA", {
          include: [ref("RightsSet", "TaskReaders")],
        }),
        [SET_FILE("SetB")]: rightsSet(SET_B_ID, "SetB", {
          include: [ref("RightsSet", "TaskReaders")],
        }),
      })
    )
    const anyRead = model.contracts.rightsProjection.filter(
      (row) => row.action === "read" && row.extent === "any"
    )
    expect(anyRead).toHaveLength(1)
    expect(anyRead[0]!.sources).toEqual([
      { kind: "RightsSet", id: TASK_READERS_ID },
      { kind: "RightsSet", id: SET_A_ID },
      { kind: "RightsSet", id: SET_B_ID },
      { kind: "Role", id: ORG_MEMBER_ROLE_ID },
    ])
  })

  it("limits a scope role on unscoped objects to read", async () => {
    const all = rows(await compiled(files(member(grantAll("any")))))
    expect(
      all.filter(
        ([, object]) => object === "Users" || object === "Announcement"
      )
    ).toEqual([
      ["OrgMember", "Users", "read", "any"],
      ["OrgMember", "Users", "read", "own"],
      ["OrgMember", "Announcement", "read", "any"],
    ])
    expect(all).toContainEqual(["OrgMember", "Task", "post", "any"])
    const posting = rows(
      await compiled(
        files(
          member(
            grant(TASK, ["read", "update"], "any"),
            grant({ withAction: "post" }, ["post"], "any")
          )
        )
      )
    )
    // `withAction` бере лише дії, які рівень дозволяє: нескоуплений
    // `Announcement` має `post`, але роль скоупу його там не дає.
    expect(
      new Set(
        posting
          .filter(([, , action]) => action === "post")
          .map(([, object]) => object)
      )
    ).toEqual(new Set(["Task"]))
  })

  it("limits global, container and everyUser roles to their level", async () => {
    const lead = await compiled(
      files({ [ROLE_FILE("ProjectLead")]: { grants: [grantAll("any")] } })
    )
    expect(objectsOf(lead).sort()).toEqual(["Task", "TaskComment"])
    const everyone = await compiled(
      files({
        [ROLE_FILE("Everyone")]: { grants: [grant(USERS, ["read"], "own")] },
      })
    )
    expect(rows(everyone)).toContainEqual(["Everyone", "Users", "read", "own"])
  })

  it("skips unsupported extents in grantAll", async () => {
    const model = await compiled(files(member(grantAll("own"))))
    expect(objectsOf(model)).toContain("Task")
    expect(objectsOf(model)).not.toContain("Region")
  })

  it("grants a custom action by name", async () => {
    const model = await compiled(
      files(REASSIGN, member(grant(TASK, ["reassign"], "any")))
    )
    expect(rows(model)).toContainEqual([
      "OrgMember",
      "Task",
      REASSIGN_ID,
      "any",
    ])
    expect(
      model.references.find(
        (r) =>
          r.role === "grant.customAction" &&
          r.from.file === ROLE_FILE("OrgMember") &&
          r.from.pointer === "/grants/0/grant/actions/0"
      )?.to.id
    ).toBe(REASSIGN_ID)
  })

  it("grants one custom action name on each object separately", async () => {
    // Одне ім'я в різних об'єктах — різні дії, тож і різні рядки.
    const model = await compiled(
      files(
        REASSIGN,
        member(
          grant(TASK, ["reassign"], "any"),
          grant(objects(["Catalog", "TaskComment"]), ["reassign"], "any")
        )
      )
    )
    expect(rows(model).filter(([, , , extent]) => extent === "any")).toEqual([
      ["OrgMember", "Task", REASSIGN_ID, "any"],
      ["OrgMember", "TaskComment", COMMENT_REASSIGN_ID, "any"],
    ])
  })

  const memberFile = ROLE_FILE("OrgMember")
  it.each([
    {
      case: "grants more than read on an unscoped object to a scope role",
      input: files(member(grant(USERS, ["update"], "any"))),
      code: "rights.grant-level",
      file: memberFile,
      pointer: "/grants/0/grant/actions/0",
      params: { object: "Users", action: "update", level: "scope" },
    },
    {
      case: "grants a scoped object to a global role",
      input: files({
        [ROLE_FILE("Support")]: { grants: [grant(TASK, ["read"], "any")] },
      }),
      code: "rights.grant-level",
      file: ROLE_FILE("Support"),
      pointer: "/grants/0/grant/actions/0",
      params: { object: "Task", action: "read", level: "global" },
    },
    {
      case: "grants the any extent to every user",
      input: files({
        [ROLE_FILE("Everyone")]: { grants: [grant(USERS, ["read"], "any")] },
      }),
      code: "rights.grant-level",
      file: ROLE_FILE("Everyone"),
      pointer: "/grants/0/grant/extent",
      params: { object: "Users", action: "read", level: "everyUser" },
    },
    {
      case: "grants an extent the object lacks",
      input: files(member(grant(REGION, ["read"], "own"))),
      code: "rights.extent-unsupported",
      file: memberFile,
      pointer: "/grants/0/grant/extent",
      params: { object: "Region", extent: "own" },
    },
    {
      case: "grants an unknown dimension",
      input: files(member(grant(TASK, ["read"], { dimension: "nowhere" }))),
      code: "rights.dimension-unknown",
      file: memberFile,
      pointer: "/grants/0/grant/extent/dimension",
      params: { dimension: "nowhere" },
    },
    {
      case: "grants an unknown action",
      input: files(member(grant(TASK, ["approve"], "any"))),
      code: "rights.action-unknown",
      file: memberFile,
      pointer: "/grants/0/grant/actions/0",
      params: { action: "approve", object: "Task" },
    },
    {
      case: "has an unknown action in a set that two roles include",
      input: files({
        [SET_FILE("TaskReaders")]: {
          grants: [grant(TASK, ["approve"], "any")],
        },
        [ROLE_FILE("OrgAdmin")]: {
          include: [ref("RightsSet", "TaskReaders")],
        },
      }),
      code: "rights.action-unknown",
      file: SET_FILE("TaskReaders"),
      pointer: "/grants/0/grant/actions/0",
      params: { action: "approve", object: "Task" },
    },
    {
      case: "grants a custom action on two objects",
      input: files(
        REASSIGN,
        member(
          grant(
            objects(["Document", "Task"], ["Catalog", "TaskComment"]),
            ["reassign"],
            "any"
          )
        )
      ),
      code: "rights.custom-action-multi-object",
      file: memberFile,
      pointer: "/grants/0/grant/actions/0",
      params: { action: "reassign" },
    },
    {
      case: "grants a custom action through an action selector",
      input: files(
        REASSIGN,
        member(grant({ withAction: "reassign" }, ["reassign"], "any"))
      ),
      code: "rights.custom-action-multi-object",
      file: memberFile,
      pointer: "/grants/0/grant/actions/0",
      params: { action: "reassign" },
    },
    {
      case: "selects objects by a custom action",
      input: files(
        REASSIGN,
        member(grant({ withAction: "reassign" }, ["read"], "any"))
      ),
      code: "rights.custom-action-multi-object",
      file: memberFile,
      pointer: "/grants/0/grant/objects/withAction",
      params: { action: "reassign" },
    },
    {
      case: "denies an unknown action",
      input: files(member(deny(TASK, ["approve"]))),
      code: "rights.action-unknown",
      file: memberFile,
      pointer: "/grants/0/deny/actions/0",
      params: { action: "approve", object: "Task" },
    },
    {
      case: "denies an extent the object lacks",
      input: files(member(deny(REGION, ["read"], "own"))),
      code: "rights.extent-unsupported",
      file: memberFile,
      pointer: "/grants/0/deny/extent",
      params: { object: "Region", extent: "own" },
    },
    {
      case: "grants an adopted table",
      input: files(
        { [GRANT_FILE]: grantTable() },
        member(grant(objects(["CustomTable", "RoleGrant"]), ["read"], "any"))
      ),
      code: "rights.custom-table-no-contract",
      file: memberFile,
      pointer: "/grants/0/grant/objects/0",
      params: { object: "RoleGrant" },
    },
    {
      case: "grants an enumeration",
      input: files(
        { [STATUS_FILE]: statusEnumeration() },
        member(grant(objects(["Enumeration", "Status"]), ["read"], "any"))
      ),
      code: "rights.object-without-rights",
      file: memberFile,
      pointer: "/grants/0/grant/objects/0",
      params: { object: "Status", kind: "Enumeration" },
    },
  ])("rejects a grant that $case", async (row) => {
    const { case: label, input, ...expected } = row
    expect(await errors(input), label).toEqual([expected])
  })
})
