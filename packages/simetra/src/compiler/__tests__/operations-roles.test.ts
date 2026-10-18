import { describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  createObject,
  deleteElement,
  renameElement,
  type ElementTarget,
  type SchemaPathResolver,
} from "simetra/compiler"
import {
  COMMENT_FILE,
  GRANT_FILE,
  PROJECT_FILE,
  ROLE_FILE,
  SET_FILE,
  TASK_FILE,
  grant,
  grantTable,
  grantsSource,
  objects,
  regionDimension,
  withRoles,
} from "./fixtures/rights"
import { uuid } from "./helpers"

type Json = Record<string, unknown>
type Files = ReadonlyMap<string, string>
type Layer = Record<string, Record<string, unknown>>

const TASK = objects(["Document", "Task"])
const ref = (kind: string, name: string) => ({ kind, name })

/**
 * Ролі й набори з кожним видом посилання за іменем: включення, об'єкт
 * гранту, вид скоупу й контейнер рівня, вимір обсягу, кастомна дія й
 * джерело ключа ролі.
 */
const BASE: Layer = {
  [PROJECT_FILE]: {
    accessDimensions: [regionDimension()],
    assignmentSources: [grantsSource()],
  },
  [GRANT_FILE]: grantTable(),
  [TASK_FILE]: {
    ownership: ["assignee"],
    access: [{ attribute: "region", dimension: "region" }],
    containerBinding: "project",
    customActions: [{ id: uuid(6300), name: "reassign" }],
  },
  [COMMENT_FILE]: { containerBinding: ["task", "project"] },
  [SET_FILE("TaskReaders")]: { grants: [grant(TASK, ["read"], "any")] },
  [ROLE_FILE("OrgMember")]: {
    grants: [grant(TASK, ["reassign"], { dimension: "region" })],
  },
  [ROLE_FILE("ProjectLead")]: {
    sourceKeys: [{ source: "grants", key: "lead" }],
  },
}

const files = () => withRoles(BASE)

const errors = (result: { diagnostics: { severity: string }[] }) =>
  result.diagnostics.filter((d) => d.severity === "error")

const json = (input: Files, path: string) =>
  JSON.parse(input.get(path)!) as Json

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

function counter(start = 900_000): () => string {
  let n = start
  return () => uuid(++n)
}

describe("designer operations over roles and rights sets", () => {
  it("creates a rights set and a role in their folders", async () => {
    const before = files()
    const o = { schemaPath, newId: counter() }
    const set = await createObject(
      before,
      {
        kind: "RightsSet",
        name: "TaskPosters",
        data: { grants: [grant(TASK, ["post"], "any")] },
      },
      o
    )
    expect(errors(set)).toEqual([])
    const withSet = applyChanges(before, set.changes)
    const created = await createObject(
      withSet,
      {
        kind: "Role",
        name: "Auditor",
        data: {
          assignedOn: "global",
          grants: [grant(objects(["Catalog", "Users"]), ["read"], "any")],
        },
      },
      o
    )
    expect(errors(created)).toEqual([])
    const after = applyChanges(withSet, created.changes)
    for (const path of [SET_FILE("TaskPosters"), ROLE_FILE("Auditor")]) {
      const file = json(after, path)
      expect(typeof file.id, path).toBe("string")
      expect(file, path).not.toHaveProperty("physicalName")
    }
    expect(errors(await compile(after))).toEqual([])
  })

  // Кожне перейменування переписує місце в ролі чи наборі, і стан після
  // нього компілюється проти стану до нього без зміни рівня ролі.
  it.each<[string, ElementTarget, string, (after: Files) => unknown, unknown]>([
    [
      "a set",
      { kind: "RightsSet", name: "TaskReaders" },
      "Readers",
      (after) => json(after, SET_FILE("TaskEditors")).include,
      [ref("RightsSet", "Readers")],
    ],
    [
      "an object",
      { kind: "Document", name: "Task" },
      "Job",
      (after) =>
        (json(after, SET_FILE("TaskReaders")).grants as Json[]).map(
          (g) => (g.grant as Json).objects
        ),
      [[ref("Document", "Job")]],
    ],
    [
      "a scope kind",
      { kind: "Project", element: ["org"] },
      "tenant",
      (after) => json(after, ROLE_FILE("OrgMember")).assignedOn,
      { scopeKind: "tenant" },
    ],
    [
      "a dimension",
      { kind: "Project", element: ["region"] },
      "area",
      (after) =>
        (json(after, ROLE_FILE("OrgMember")).grants as Json[]).map(
          (g) => (g.grant as Json).extent
        ),
      [{ dimension: "area" }],
    ],
    [
      "a custom action",
      { kind: "Document", name: "Task", element: ["reassign"] },
      "handOver",
      (after) =>
        (json(after, ROLE_FILE("OrgMember")).grants as Json[]).map(
          (g) => (g.grant as Json).actions
        ),
      [["handOver"]],
    ],
    [
      "a source",
      { kind: "Project", element: ["grants"] },
      "leadGrants",
      (after) => json(after, ROLE_FILE("ProjectLead")).sourceKeys,
      [{ source: "leadGrants", key: "lead" }],
    ],
  ])("renames %s everywhere in roles", async (_, target, newName, at, want) => {
    const before = files()
    const result = await renameElement(before, { target, newName })
    expect(errors(result)).toEqual([])
    expect(result.ok).toBe(true)
    const after = applyChanges(before, result.changes)
    expect(at(after)).toEqual(want)
    expect(errors(await compile(after, { baseline: before }))).toEqual([])
  })

  it.each<[string, ElementTarget, string]>([
    ["a set", { kind: "RightsSet", name: "TaskReaders" }, "rights.include"],
    ["an object", { kind: "Document", name: "Task" }, "grant.object"],
    ["a scope kind", { kind: "Project", element: ["org"] }, "role.scopeKind"],
    ["a container", { kind: "Catalog", name: "Project" }, "role.container"],
  ])("refuses to delete %s a role refers to", async (_, target, role) => {
    const result = await deleteElement(files(), { target })
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "operation.delete-referenced"
    )
    expect(
      result.diagnostics.map((d) => (d.params as { role: string }).role)
    ).toContain(role)
  })
})
