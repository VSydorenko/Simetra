import { describe, expect, it } from "vitest"
import { makeObjectName, type PhysicalTable } from "simetra/model"
import type { CompileResult } from "simetra/compiler"
import { expectClean, uuid } from "./helpers"
import {
  ATTACHMENTS_TABLE,
  CHECKLIST_TABLE,
  COMMENT_FILE,
  COMMENT_TABLE,
  PROJECT_FILE,
  TASK_FILE,
  TASK_HOURS_FILE,
  TASK_ID,
  compileRights,
  policyDomain,
  refAttribute,
  regionDimension,
  singleTenantRights,
  type Layer,
} from "./fixtures/rights"

const TASK = { schema: "public", name: "task" }
const PATH_COPY = makeObjectName("task_id", undefined, "assignee_id")

function tableOf(result: CompileResult, name: string): PhysicalTable {
  return result.model!.physical.tables.find((t) => t.name === name)!
}

/** Копії таблиці: ім'я → `copyOf`, `notNull` і FK, що містить колонку. */
function copiesOf(table: PhysicalTable) {
  return table.columns
    .filter((c) => c.origin.copyOf !== undefined)
    .map((c) => ({
      name: c.name,
      copyOf: c.origin.copyOf,
      notNull: c.notNull,
      foreignKey: table.foreignKeys.some((fk) => fk.columns.includes(c.name)),
    }))
}

const indexKeys = (table: PhysicalTable) =>
  table.indexes.map((i) =>
    i.keys.map((k) => ("column" in k ? k.column : k.expression))
  )

const codes = (result: CompileResult) =>
  result.diagnostics.map((d) => [d.code, d.file, d.pointer])

describe("carrier copies in the physical snapshot", () => {
  it("copies every owner carrier into each tabular section", async () => {
    const checklist = tableOf(
      await compileRights(policyDomain()),
      CHECKLIST_TABLE
    )
    expect(copiesOf(checklist)).toEqual(
      ["assignee_id", "project_id", "region_id"].map((column) => ({
        name: column,
        copyOf: { table: TASK, column, through: "parent_id" },
        notNull: false,
        foreignKey: false,
      }))
    )
    expect(indexKeys(checklist)).toEqual(
      expect.arrayContaining([
        ["org_id", "assignee_id"],
        ["org_id", "region_id"],
        ["org_id", "project_id"],
      ])
    )
  })

  it("denormalizes a path carrier into the object row and its tabular sections", async () => {
    const result = await compileRights(policyDomain())
    const comment = tableOf(result, COMMENT_TABLE)
    expect(copiesOf(comment)).toEqual([
      {
        name: PATH_COPY,
        copyOf: { table: TASK, column: "assignee_id", through: "task_id" },
        notNull: false,
        foreignKey: false,
      },
    ])
    expect(indexKeys(comment)).toContainEqual(["org_id", PATH_COPY])
    expect(copiesOf(tableOf(result, ATTACHMENTS_TABLE))).toEqual([
      {
        name: PATH_COPY,
        copyOf: {
          table: { schema: "public", name: COMMENT_TABLE },
          column: PATH_COPY,
          through: "parent_id",
        },
        notNull: false,
        foreignKey: false,
      },
    ])
    const rights = result.model!.contracts.rights
    const commentRights = rights.find((c) => c.table.name === COMMENT_TABLE)!
    expect(commentRights.ownership[0]!.value).toBe(PATH_COPY)
    const task = rights.find((c) => c.objectId === TASK_ID)!
    expect(task.ownership[0]!.value).toBe(task.ownership[0]!.column)
  })

  it("the policy domain compiles clean", async () => {
    expectClean(await compileRights(policyDomain()))
  })

  it("a key carrier has no copy in tabular sections", async () => {
    const devices = tableOf(
      await compileRights(policyDomain()),
      "users_devices"
    )
    expect(copiesOf(devices)).toEqual([])
  })
})

const LEDGER_FILE = "custom-tables/Ledger/Ledger.meta.json"

/** Однотенантний проєкт з власністю задачі шляхом через прийняту таблицю. */
function pathThroughAdopted() {
  const column = (id: number, name: string, physicalName: string) => ({
    id: uuid(id),
    name,
    physicalName,
    type: "UUID",
    notNull: true,
  })
  return singleTenantRights({
    [LEDGER_FILE]: {
      id: uuid(6570),
      kind: "CustomTable",
      name: "Ledger",
      physicalName: "ledger",
      kindLabel: "ledger",
      scope: "none",
      columns: [column(6571, "id", "id"), column(6572, "keeper", "keeper")],
      primaryKey: { columns: ["id"] },
    },
    [TASK_FILE]: {
      ownership: [["ledger", "keeper"]],
      attributes: [
        refAttribute(6012, "project", "project_id", {
          kind: "Catalog",
          name: "Project",
        }),
        refAttribute(6573, "ledger", "ledger_id", {
          kind: "CustomTable",
          name: "Ledger",
        }),
      ],
    },
  })
}

/** `TaskHours` з мапінгом `access` на поле, що не є виміром регістра. */
function hoursAccess(access: Record<string, unknown>, extra = {}): Layer {
  return {
    [TASK_HOURS_FILE]: {
      access: [{ ...access, dimension: "region" }],
      ...extra,
    },
  }
}

/** Другий вимір проєкту з іменем `name` поруч із `region`. */
function dimensionNamed(name: string): Layer {
  return {
    [PROJECT_FILE]: {
      accessDimensions: [
        regionDimension(),
        { ...regionDimension(), id: uuid(6580), name },
      ],
    },
  }
}

describe("carrier copy rules", () => {
  it.each([
    {
      name: "column-taken",
      files: () =>
        policyDomain({
          [TASK_FILE]: {
            tabularSections: [
              {
                id: uuid(6511),
                name: "checklist",
                physicalName: CHECKLIST_TABLE,
                attributes: [
                  refAttribute(6512, "assignee", "assignee_id", {
                    kind: "Catalog",
                    name: "OrgMember",
                  }),
                ],
              },
            ],
          },
        }),
      expected: [["rights.carrier-column-taken", TASK_FILE, "/ownership/0"]],
    },
    {
      name: "path-adopted",
      files: pathThroughAdopted,
      expected: [["rights.carrier-path-adopted", TASK_FILE, "/ownership/0/0"]],
    },
    {
      name: "register-resource",
      files: () => policyDomain(hoursAccess({ attribute: "hours" })),
      expected: [
        [
          "rights.register-access-dimension",
          TASK_HOURS_FILE,
          "/access/0/attribute",
        ],
      ],
    },
    {
      name: "register-attribute",
      files: () =>
        policyDomain(
          hoursAccess(
            { attribute: "zone" },
            {
              attributes: [
                refAttribute(6533, "zone", "zone_id", {
                  kind: "Catalog",
                  name: "Region",
                }),
              ],
            }
          )
        ),
      expected: [
        [
          "rights.register-access-dimension",
          TASK_HOURS_FILE,
          "/access/0/attribute",
        ],
      ],
    },
    {
      name: "register-path",
      files: () =>
        policyDomain(
          hoursAccess(
            { ref: ["task", "region"] },
            {
              dimensions: [
                refAttribute(6531, "region", "region_id", {
                  kind: "Catalog",
                  name: "Region",
                }),
                refAttribute(6534, "task", "task_id", {
                  kind: "Document",
                  name: "Task",
                }),
              ],
            }
          )
        ),
      expected: [
        ["rights.register-access-dimension", TASK_HOURS_FILE, "/access/0/ref"],
      ],
    },
    ...["any", "own", "ownRegion", "inProject"].map((name) => ({
      name: `dimension-reserved ${name}`,
      files: () => policyDomain(dimensionNamed(name)),
      expected: [
        [
          "rights.dimension-name-reserved",
          PROJECT_FILE,
          "/accessDimensions/1/name",
        ],
      ],
    })),
  ])("$name", async ({ files, expected }) => {
    expect(codes(await compileRights(files()))).toEqual(expected)
  })

  it("a copy of the path carrier is not taken by an object attribute", async () => {
    // Збіг імені копії шляху з колонкою основної таблиці — той самий код.
    const result = await compileRights(
      policyDomain({
        [COMMENT_FILE]: {
          attributes: [
            refAttribute(6051, "task", "task_id", {
              kind: "Document",
              name: "Task",
            }),
            refAttribute(6052, "taskIdAssignee", PATH_COPY, {
              kind: "Catalog",
              name: "OrgMember",
            }),
          ],
        },
      })
    )
    expect(codes(result)).toContainEqual([
      "rights.carrier-column-taken",
      COMMENT_FILE,
      "/ownership/0",
    ])
  })
})
