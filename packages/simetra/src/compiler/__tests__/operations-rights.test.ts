import { describe, expect, it } from "vitest"
import {
  addElement,
  applyChanges,
  compile,
  createObject,
  deleteElement,
  explainObject,
  renameElement,
  type CompiledModel,
  type ElementTarget,
  type SchemaPathResolver,
} from "simetra/compiler"
import {
  COMMENT_FILE,
  MEMBER_FILE,
  ORG_KIND_ID,
  PROJECT_CATALOG_FILE,
  TASK_FILE,
  TASK_ID,
  rightsFiles,
} from "./fixtures/rights"
import { uuid } from "./helpers"

type Json = Record<string, unknown>
type Files = ReadonlyMap<string, string>

const PROJECT = "project.meta.json"
const MEMBERSHIP_FILE = "custom-tables/Membership/Membership.meta.json"
const REGION_DIM_ID = uuid(6060)
const REASSIGN_ID = uuid(7701)
const ESCALATE_ID = uuid(7702)

const ref = (kind: string, name: string) => ({ kind, name })

/** Детерміноване джерело id у формі UUID v4. */
function counter(start = 900_000): () => string {
  let n = start
  return () => uuid(++n)
}

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

const options = () => ({ schemaPath, newId: counter() })

const errors = (result: { diagnostics: { severity: string }[] }) =>
  result.diagnostics.filter((d) => d.severity === "error")

const json = (files: Files, path: string) =>
  JSON.parse(files.get(path)!) as Json

async function modelOf(files: Files): Promise<CompiledModel> {
  const compiled = await compile(files)
  expect(errors(compiled)).toEqual([])
  return compiled.model!
}

/**
 * Проєкт з усіма полями прав, що мають посилання: контейнер, прив'язка
 * (реквізитом і шляхом), власники, вимір доступу з мапінгом і кастомні дії,
 * одна з яких вимагає іншу.
 */
function allRights(): Map<string, string> {
  return rightsFiles({
    [PROJECT]: {
      accessDimensions: [
        {
          id: REGION_DIM_ID,
          name: "region",
          target: ref("Catalog", "Region"),
          values: {
            relation: {
              object: ref("InformationRegister", "MemberRegion"),
              subject: "member",
              value: "region",
            },
          },
        },
      ],
    },
    [PROJECT_CATALOG_FILE]: { rightsContainer: true },
    [TASK_FILE]: {
      ownership: ["assignee"],
      containerBinding: "project",
      access: [{ attribute: "region", dimension: "region" }],
      customActions: [
        {
          id: REASSIGN_ID,
          name: "reassign",
          requires: ["update"],
          effects: { header: ["assignee"] },
        },
        { id: ESCALATE_ID, name: "escalate", requires: ["reassign"] },
      ],
    },
    [COMMENT_FILE]: {
      ownership: [["task", "assignee"]],
      containerBinding: ["task", "project"],
    },
  })
}

/**
 * Вид `org` з прийнятою таблицею членства замість довідника: джерело
 * членства посилається на колонки таблиці за логічними іменами.
 */
function adoptedMembership(): Map<string, string> {
  const column = (
    id: number,
    name: string,
    physicalName: string,
    type: string
  ) => ({
    id: uuid(id),
    name,
    physicalName,
    type,
    notNull: true,
  })
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
      membershipSources: [
        {
          id: uuid(6120),
          name: "members",
          scopeKind: "org",
          table: ref("CustomTable", "Membership"),
          columns: { scope: "orgId", user: "userId", active: "isActive" },
        },
      ],
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
    [MEMBERSHIP_FILE]: {
      id: uuid(6100),
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
    },
  })
  files.delete(MEMBER_FILE)
  files.delete("information-registers/MemberRegion/MemberRegion.meta.json")
  return files
}

/** Перейменування, яке мусить вдатися; повертає файли після нього. */
async function renamed(files: Files, target: ElementTarget, newName: string) {
  const result = await renameElement(files, { target, newName })
  expect(errors(result)).toEqual([])
  expect(result.ok).toBe(true)
  return applyChanges(files, result.changes)
}

const TASK: ElementTarget = { kind: "Document", name: "Task" }
const element = (...chain: string[]): ElementTarget => ({
  ...TASK,
  element: chain,
})

describe("designer operations over rights fields", () => {
  it("adds a custom action and an access dimension with ids", async () => {
    const files = allRights()
    const o = options()
    const action = await addElement(
      files,
      {
        target: TASK,
        collection: "customActions",
        element: { name: "archive", requires: ["escalate"] },
      },
      o
    )
    expect(errors(action)).toEqual([])
    expect(action.ok).toBe(true)
    const withAction = applyChanges(files, action.changes)
    const added = (json(withAction, TASK_FILE).customActions as Json[]).find(
      (a) => a.name === "archive"
    )!
    expect(typeof added.id).toBe("string")

    const dimension = await addElement(
      withAction,
      {
        target: { kind: "Project" },
        collection: "accessDimensions",
        element: {
          name: "zone",
          target: ref("Catalog", "Region"),
          values: {
            relation: {
              object: ref("InformationRegister", "MemberRegion"),
              subject: "member",
              value: "region",
            },
          },
        },
      },
      o
    )
    expect(errors(dimension)).toEqual([])
    expect(dimension.ok).toBe(true)
    const after = applyChanges(withAction, dimension.changes)
    const dims = json(after, PROJECT).accessDimensions as Json[]
    expect(typeof dims.find((d) => d.name === "zone")!.id).toBe("string")
    await modelOf(after)
  })

  it("renames an attribute in every rights place", async () => {
    const owner = await renamed(allRights(), element("assignee"), "owner")
    const task = json(owner, TASK_FILE)
    expect(task.ownership).toEqual(["owner"])
    expect((task.customActions as Json[])[0]!.effects).toEqual({
      header: ["owner"],
    })
    expect(json(owner, COMMENT_FILE).ownership).toEqual([["task", "owner"]])

    const project = await renamed(allRights(), element("project"), "workspace")
    expect(json(project, TASK_FILE).containerBinding).toBe("workspace")
    expect(json(project, COMMENT_FILE).containerBinding).toEqual([
      "task",
      "workspace",
    ])

    const column = await renamed(
      adoptedMembership(),
      { kind: "CustomTable", name: "Membership", element: ["userId"] },
      "memberUser"
    )
    const [source] = json(column, PROJECT).membershipSources as Json[]
    expect(source!.columns).toEqual({
      scope: "orgId",
      user: "memberUser",
      active: "isActive",
    })
  })

  it("renames a dimension and a custom action", async () => {
    const dim = await renamed(
      allRights(),
      { kind: "Project", element: ["region"] },
      "area"
    )
    expect(json(dim, TASK_FILE).access).toEqual([
      { attribute: "region", dimension: "area" },
    ])

    const action = await renamed(allRights(), element("reassign"), "handOver")
    const actions = json(action, TASK_FILE).customActions as Json[]
    expect(actions.map((a) => [a.name, a.requires])).toEqual([
      ["handOver", ["update"]],
      ["escalate", ["handOver"]],
    ])
  })

  it("refuses to delete a dimension, a container and a carrier that are referenced", async () => {
    const files = allRights()
    const roles = async (target: ElementTarget) => {
      const result = await deleteElement(files, { target })
      expect(result.ok).toBe(false)
      expect(result.changes).toEqual([])
      expect(new Set(result.diagnostics.map((d) => d.code))).toEqual(
        new Set(["operation.delete-referenced"])
      )
      return result.diagnostics.map((d) => (d.params as { role: string }).role)
    }
    expect(await roles({ kind: "Project", element: ["region"] })).toEqual([
      "access.dimension",
    ])
    expect(await roles({ kind: "Catalog", name: "Project" })).toContain(
      "attribute.ref"
    )
    // Реквізит-контейнер тримає прив'язка задачі, а через шлях — і коментаря.
    expect(await roles(element("project"))).toEqual(
      expect.arrayContaining(["rights.carrier", "rights.carrierPath"])
    )
    expect(await roles(element("assignee"))).toEqual(
      expect.arrayContaining([
        "rights.carrier",
        "rights.carrierPath",
        "customAction.header",
      ])
    )
    expect(await roles(element("reassign"))).toEqual(["customAction.requires"])
  })

  it("creates a container catalog with rights fields", async () => {
    const files = allRights()
    const result = await createObject(
      files,
      {
        kind: "Catalog",
        name: "Board",
        data: {
          scope: "org",
          rightsContainer: true,
          attributes: [
            { name: "project", type: "Ref", ref: ref("Catalog", "Project") },
            { name: "region", type: "Ref", ref: ref("Catalog", "Region") },
          ],
          containerBinding: "project",
          access: [{ attribute: "region", dimension: "region" }],
          customActions: [{ name: "pin", effects: { header: ["region"] } }],
        },
      },
      options()
    )
    expect(errors(result)).toEqual([])
    expect(result.ok).toBe(true)
    const after = applyChanges(files, result.changes)
    const board = json(after, "catalogs/Board/Board.meta.json")
    expect(board.rightsContainer).toBe(true)
    expect(typeof (board.customActions as Json[])[0]!.id).toBe("string")
    const model = await modelOf(after)
    const explained = explainObject(model, { kind: "Catalog", name: "Board" })!
    expect(explained.contracts).toContainEqual(
      expect.objectContaining({ container: true })
    )
  })

  it("addresses a custom action unambiguously", async () => {
    const files = allRights()
    const clash = await addElement(
      files,
      {
        target: TASK,
        collection: "customActions",
        element: { name: "region" },
      },
      options()
    )
    // Невдала компіляція результату: обгортка не пише жодної зміни.
    expect(clash.ok).toBe(false)
    expect(clash.diagnostics.map((d) => d.code)).toContain(
      "identity.name-duplicate"
    )

    const after = await renamed(files, element("reassign"), "handOver")
    const before = json(files, TASK_FILE)
    expect(json(after, TASK_FILE).attributes).toEqual(before.attributes)
    const requires = (await modelOf(after)).references.filter(
      (r) => r.role === "customAction.requires"
    )
    expect(requires.map((r) => r.to.id)).toEqual([REASSIGN_ID])

    const deleted = await deleteElement(files, { target: element("escalate") })
    expect(errors(deleted)).toEqual([])
    const left = json(applyChanges(files, deleted.changes), TASK_FILE)
    expect((left.customActions as Json[]).map((a) => a.name)).toEqual([
      "reassign",
    ])
    expect(left.attributes).toEqual(before.attributes)
    expect(TASK_ID).toBe(before.id)
  })
})
