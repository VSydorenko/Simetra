import { describe, expect, it } from "vitest"
import {
  PROJECT_FILE,
  ROLE_FILE,
  TASK_FILE,
  compileRights,
  grant,
  objects,
  rightsFiles,
  teamScopeKind,
  without,
  withRoles,
} from "./fixtures/rights"
import { uuid } from "./helpers"

const TASK = objects(["Document", "Task"])
const OTHER_ROLES = ["OrgMember", "ProjectLead", "Support", "Everyone"].map(
  ROLE_FILE
)

/** Єдина роль рівня `org` — `OrgMember` з грантами; `OrgAdmin` прибрано. */
const orgMemberOnly = (...grants: unknown[]) => [
  without(ROLE_FILE("OrgAdmin")),
  { [ROLE_FILE("OrgMember")]: { grants } },
]

const uuidColumn = (id: number, name: string, physicalName: string) => ({
  id: uuid(id),
  name,
  physicalName,
  type: "UUID",
  notNull: true,
})

/** Скоуплений об'єкт виду `team` (вид без членства). */
const inTeam = (kind: "Document" | "CustomTable") => ({
  [kind === "Document"
    ? "documents/TeamDoc/TeamDoc.meta.json"
    : "custom-tables/TeamTable/TeamTable.meta.json"]:
    kind === "Document"
      ? {
          id: uuid(6700),
          kind: "Document",
          name: "TeamDoc",
          physicalName: "team_doc",
          kindLabel: "team_doc",
          scope: "team",
        }
      : {
          id: uuid(6701),
          kind: "CustomTable",
          name: "TeamTable",
          physicalName: "team_table",
          kindLabel: "team_table",
          scope: "team",
          scopeColumn: "teamId",
          columns: [
            uuidColumn(6702, "id", "id"),
            uuidColumn(6703, "teamId", "team_id"),
          ],
          primaryKey: { columns: ["id"] },
        },
})

describe("rights.scope-kind-unread", () => {
  it.each([
    {
      name: "a kind whose objects no role reads (no roles)",
      files: rightsFiles(),
      expected: [["/scopeKinds/0", "org"]],
    },
    {
      name: "a kind with only adopted tables",
      files: withRoles(teamScopeKind(), inTeam("CustomTable")),
      expected: [],
    },
    {
      name: "read@any on Task",
      files: withRoles(...orgMemberOnly(grant(TASK, ["read"], "any"))),
      expected: [],
    },
    {
      name: "only read@own on Task",
      files: withRoles(...orgMemberOnly(grant(TASK, ["read"], "own")), {
        [TASK_FILE]: { ownership: ["assignee"] },
      }),
      expected: [],
    },
    {
      name: "a kind without membership with a scoped document",
      files: withRoles(teamScopeKind(), inTeam("Document")),
      expected: [["/scopeKinds/1", "team"]],
    },
    {
      name: "OrgAdmin (fullAccess) as the only role",
      files: withRoles(without(...OTHER_ROLES)),
      expected: [],
    },
    {
      // Кастомна дія без ефектів не вимагає `read`: рядок проєкції є, читання — ні.
      name: "only a custom action without read on Task",
      files: withRoles(...orgMemberOnly(grant(TASK, ["reassign"], "any")), {
        [TASK_FILE]: { customActions: [{ id: uuid(6710), name: "reassign" }] },
      }),
      expected: [["/scopeKinds/0", "org"]],
    },
    {
      // Р2a2-31: `read` системного довідника прав не відкриває даних виду.
      name: "read only on the kind's rights system catalog",
      files: withRoles(
        ...orgMemberOnly(
          grant(objects(["Catalog", "OrgRoles"]), ["read"], "any")
        )
      ),
      expected: [["/scopeKinds/0", "org"]],
    },
  ])("$name", async ({ files, expected }) => {
    const result = await compileRights(files)
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(
      result.diagnostics
        .filter((d) => d.code === "rights.scope-kind-unread")
        .map((d) => [d.file, d.pointer, d.params?.scopeKind])
    ).toEqual(
      expected.map(([pointer, scopeKind]) => [PROJECT_FILE, pointer, scopeKind])
    )
  })
})
