import { describe, expect, it } from "vitest"
import {
  COMMENT_FILE,
  PROJECT_CATALOG_FILE,
  TASK_FILE,
  TASK_ID,
  compileRights,
  rightsFiles,
} from "./fixtures/rights"
import { uuid } from "./helpers"

const USERS_FILE = "catalogs/Users/Users.meta.json"

type Files = ReturnType<typeof rightsFiles>

function errors(result: Awaited<ReturnType<typeof compileRights>>) {
  return result.diagnostics.filter((d) => d.severity === "error")
}

async function contractOf(files: Files, objectId: string) {
  const result = await compileRights(files)
  expect(errors(result)).toEqual([])
  return result.model!.contracts.rights.find((c) => c.objectId === objectId)!
}

async function codes(files: Files) {
  return errors(await compileRights(files)).map((d) => [d.code, d.pointer])
}

const ref = (kind: string, name: string) => ({ kind, name })

/** Реквізити `Task` фікстури плюс додаткові: перевизначення замінює масив. */
function taskAttributes(...extra: Record<string, unknown>[]) {
  return [
    {
      id: uuid(6011),
      name: "assignee",
      physicalName: "assignee_id",
      type: "Ref",
      ref: ref("Catalog", "OrgMember"),
    },
    {
      id: uuid(6012),
      name: "project",
      physicalName: "project_id",
      type: "Ref",
      ref: ref("Catalog", "Project"),
    },
    {
      id: uuid(6013),
      name: "region",
      physicalName: "region_id",
      type: "Ref",
      ref: ref("Catalog", "Region"),
    },
    ...extra,
  ]
}

describe("rights ownership", () => {
  it("accepts a member reference and a users reference as owners", async () => {
    const task = await contractOf(
      rightsFiles({ [TASK_FILE]: { ownership: ["assignee", "createdBy"] } }),
      TASK_ID
    )
    expect(task.ownership).toEqual([
      { column: "assignee_id" },
      { column: "created_by_id" },
    ])
    for (const action of task.actions) {
      expect(action.extents).toEqual([{ form: "any" }, { form: "own" }])
    }
  })

  it("has no own extent and no owners without ownership", async () => {
    const task = await contractOf(rightsFiles(), TASK_ID)
    expect(task.ownership).toEqual([])
    expect(task.actions[0]!.extents).toEqual([{ form: "any" }])
  })

  it("accepts the key of the users catalog", async () => {
    const files = rightsFiles({ [USERS_FILE]: { ownership: ["ref"] } })
    const result = await compileRights(files)
    expect(errors(result)).toEqual([])
    const users = result.model!.objects.find((o) => o.name === "Users")!
    const contract = result.model!.contracts.rights.find(
      (c) => c.objectId === users.id
    )!
    expect(contract.ownership).toEqual([{ column: "id" }])

    const other = errors(
      await compileRights(
        rightsFiles({ [PROJECT_CATALOG_FILE]: { ownership: ["ref"] } })
      )
    )
    expect(other.map((d) => [d.code, d.pointer, d.params?.reason])).toEqual([
      ["rights.ownership-target", "/ownership/0", "key"],
    ])
  })

  it("accepts a path through an in-scope reference", async () => {
    const comment = await contractOf(
      rightsFiles({ [COMMENT_FILE]: { ownership: [["task", "assignee"]] } }),
      uuid(6050)
    )
    expect(comment.ownership).toEqual([
      {
        column: "task_id",
        via: {
          objectId: TASK_ID,
          table: { schema: "public", name: "task" },
          column: "assignee_id",
        },
      },
    ])
  })

  it("rejects carriers that leave the tenant or are not references", async () => {
    const one = (ownership: unknown[], ...extra: Record<string, unknown>[]) =>
      codes(
        rightsFiles({
          [TASK_FILE]: { ownership, attributes: taskAttributes(...extra) },
        })
      )
    expect(
      await one(["reviewer"], {
        id: uuid(6014),
        name: "reviewer",
        physicalName: "reviewer_id",
        type: "Ref",
        ref: ref("Catalog", "OrgMember"),
        crossScope: true,
      })
    ).toEqual([["rights.carrier-cross-tenant", "/ownership/0"]])
    expect(
      await one(["note"], {
        id: uuid(6015),
        name: "note",
        physicalName: "note",
        type: "String",
        length: 40,
      })
    ).toEqual([["rights.carrier-not-ref", "/ownership/0"]])
    const region = errors(
      await compileRights(
        rightsFiles({ [TASK_FILE]: { ownership: ["region"] } })
      )
    )
    expect(region.map((d) => [d.code, d.pointer, d.params?.reason])).toEqual([
      ["rights.ownership-target", "/ownership/0", "target"],
    ])
    expect(await one(["nobody"])).toEqual([
      ["rights.attribute-unknown", "/ownership/0"],
    ])
    expect(
      await one([["subject", "user"]], {
        id: uuid(6016),
        name: "subject",
        physicalName: "subject",
        type: "Ref",
        allowedTypes: [ref("Catalog", "OrgMember"), ref("Catalog", "Project")],
      })
    ).toEqual([["rights.carrier-not-ref", "/ownership/0/0"]])
  })

  it("checks the target of the last step of a path", async () => {
    expect(
      await codes(
        rightsFiles({ [COMMENT_FILE]: { ownership: [["task", "region"]] } })
      )
    ).toEqual([["rights.ownership-target", "/ownership/0/1"]])
    expect(
      await codes(
        rightsFiles({ [COMMENT_FILE]: { ownership: [["task", "nobody"]] } })
      )
    ).toEqual([["rights.attribute-unknown", "/ownership/0/1"]])
  })
})
