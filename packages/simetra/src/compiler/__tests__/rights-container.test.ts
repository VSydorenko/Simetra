import { describe, expect, it } from "vitest"
import {
  COMMENT_FILE,
  PROJECT_CATALOG_FILE,
  PROJECT_ID,
  TASK_FILE,
  TASK_ID,
  compileRights,
  rightsFiles,
} from "./fixtures/rights"
import { uuid } from "./helpers"

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

const CONTAINER = { [PROJECT_CATALOG_FILE]: { rightsContainer: true } }

describe("rights container", () => {
  it("binds a document to a container catalog", async () => {
    const files = rightsFiles({
      ...CONTAINER,
      [TASK_FILE]: { containerBinding: "project" },
    })
    const task = await contractOf(files, TASK_ID)
    expect(task.binding).toEqual({
      containerId: PROJECT_ID,
      carrier: { column: "project_id", value: "project_id" },
    })
    expect(task.container).toBeUndefined()
    const project = await contractOf(files, PROJECT_ID)
    expect(project.container).toBe(true)
    expect(project.binding).toBeUndefined()
  })

  it("binds through a path", async () => {
    const comment = await contractOf(
      rightsFiles({
        ...CONTAINER,
        [COMMENT_FILE]: { containerBinding: ["task", "project"] },
      }),
      uuid(6050)
    )
    expect(comment.binding?.containerId).toBe(PROJECT_ID)
    expect(comment.binding?.carrier.column).toBe("task_id")
    expect(comment.binding?.carrier.via?.column).toBe("project_id")
  })

  it("rejects a binding to an object that is not a container", async () => {
    expect(
      await codes(rightsFiles({ [TASK_FILE]: { containerBinding: "project" } }))
    ).toEqual([["rights.container-target", "/containerBinding"]])
  })

  it("rejects a binding that leaves the tenant", async () => {
    expect(
      await codes(
        rightsFiles({
          ...CONTAINER,
          [TASK_FILE]: {
            containerBinding: "other",
            attributes: [
              {
                id: uuid(6016),
                name: "other",
                physicalName: "other_id",
                type: "Ref",
                ref: ref("Catalog", "Project"),
                crossScope: true,
              },
            ],
          },
        })
      )
    ).toEqual([["rights.carrier-cross-tenant", "/containerBinding"]])
  })

  it("rejects a container bound to itself", async () => {
    expect(
      await codes(
        rightsFiles({
          [PROJECT_CATALOG_FILE]: {
            rightsContainer: true,
            containerBinding: "ref",
          },
        })
      )
    ).toEqual([["rights.container-self", "/containerBinding"]])
  })

  it("rejects a non-container bound to itself as a binding to a non-container", async () => {
    expect(
      await codes(rightsFiles({ [COMMENT_FILE]: { containerBinding: "ref" } }))
    ).toEqual([["rights.container-target", "/containerBinding"]])
  })
})
