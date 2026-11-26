import { describe, expect, it } from "vitest"
import {
  MEMBER_FILE,
  ORG_ASSIGNMENTS_FILE,
  ORG_ROLES_FILE,
  PROJECT_FILE,
  REGION_FILE,
  TASK_FILE,
  USERS_FILE,
  compileRights,
  withRoles,
  type Layer,
} from "./fixtures/rights"
import { metaFiles, project, uuid } from "./helpers"

const CONDITIONAL = { role: "anon", published: true }

const conditionalRegion = (extra: Record<string, unknown> = {}): Layer => ({
  [REGION_FILE]: { publicRead: CONDITIONAL, ...extra },
})

async function compiledRegion(extra: Record<string, unknown> = {}) {
  const result = await compileRights(withRoles(conditionalRegion(extra)))
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

describe("conditional publicRead in the compiled model (Р-D1-8)", () => {
  it("adds the published column and keeps the string form without it", async () => {
    const model = await compiledRegion()
    const region = model.physical.tables.find((t) => t.name === "region")!
    const published = region.columns.find((c) => c.name === "published")
    expect(published).toMatchObject({
      type: "boolean",
      notNull: true,
      default: "false",
    })
    const plain = await compileRights(
      withRoles({ [REGION_FILE]: { publicRead: "anon" } })
    )
    const plainRegion = plain.model!.physical.tables.find(
      (t) => t.name === "region"
    )!
    expect(plainRegion.columns.map((c) => c.name)).not.toContain("published")
  })

  it("puts published into the transitions, the publish actions and the header of the access contract", async () => {
    const model = await compiledRegion()
    const rights = model.contracts.rights.find(
      (c) => c.table.name === "region"
    )!
    expect(rights.transitions).toContainEqual({
      column: "published",
      default: "false",
    })
    const publish = rights.actions.find((a) => a.name === "publish")!
    expect(publish).toMatchObject({
      requires: ["read"],
      transition: { column: "published", from: false, to: true },
    })
    // «all» не розгортається в колонку переходу: її змінює лише дія.
    for (const name of ["create", "update"]) {
      expect(
        rights.actions.find((a) => a.name === name)!.effects.header
      ).not.toContain("published")
    }
    const access = model.contracts.access.find(
      (a) => a.table.name === "region"
    )!
    expect(access.published).toEqual({
      column: "published",
      mark: "deletion_mark",
    })
    // Колонковий грант: вставка не задає публікації, змінює її лише дія.
    expect(access.command!.insert).not.toContain("published")
    expect(access.command!.update).toContain("published")
  })

  it("leaves the access contract of the string form without published", async () => {
    const result = await compileRights(
      withRoles({ [REGION_FILE]: { publicRead: "anon" } })
    )
    const access = result.model!.contracts.access.find(
      (a) => a.table.name === "region"
    )!
    expect(access.published).toBeUndefined()
  })

  it("refuses a custom action named publish or unpublish as a taken word", async () => {
    const result = await compileRights(
      withRoles(
        conditionalRegion({
          customActions: [
            { id: uuid(7801), name: "publish" },
            { id: uuid(7802), name: "unpublish" },
          ],
        })
      )
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "rights.custom-action-reserved")
        .map((d) => [d.file, d.pointer])
    ).toEqual([
      [REGION_FILE, "/customActions/0/name"],
      [REGION_FILE, "/customActions/1/name"],
    ])
  })

  it("refuses to build a contract for a table of a conditional object without publication columns", async () => {
    // Копії умови в ТЧ приходять із задачею про копії (Р-D1-9); до них таблиця
    // без колонок — внутрішня помилка, а не відкритий доступ.
    await expect(
      compileRights(
        withRoles(
          conditionalRegion({
            tabularSections: [
              {
                id: uuid(7803),
                name: "lines",
                physicalName: "region_lines",
                attributes: [],
              },
            ],
          })
        )
      )
    ).rejects.toThrow(/internal: conditional public read of region_lines/)
  })
})

describe("rules of the conditional publicRead (Р-D1-13)", () => {
  const diagnosticsOf = async (files: Map<string, string>) =>
    (await compileRights(files)).diagnostics
      .filter((d) => d.code.startsWith("rights.public-read"))
      .map((d) => [d.file, d.code, d.pointer])

  it.each([
    {
      case: "a kind without command writes",
      files: () =>
        withRoles({
          [TASK_FILE]: { publicRead: CONDITIONAL },
        }),
      expected: [
        [TASK_FILE, "rights.public-read-published-kind", "/publicRead"],
      ],
    },
    {
      case: "a project without the rights functions",
      files: () => {
        return metaFiles({
          [PROJECT_FILE]: project(),
          [REGION_FILE]: {
            id: uuid(6040),
            kind: "Catalog",
            name: "Region",
            physicalName: "region",
            kindLabel: "region",
            publicRead: CONDITIONAL,
          },
        })
      },
      expected: [
        [REGION_FILE, "rights.public-read-published-rights", "/publicRead"],
      ],
    },
    {
      case: "an object form on the users catalog",
      files: () => withRoles({ [USERS_FILE]: { publicRead: CONDITIONAL } }),
      expected: [[USERS_FILE, "rights.public-read-forbidden", "/publicRead"]],
    },
    {
      case: "an object form on the membership catalog",
      files: () => withRoles({ [MEMBER_FILE]: { publicRead: CONDITIONAL } }),
      expected: [[MEMBER_FILE, "rights.public-read-forbidden", "/publicRead"]],
    },
    {
      case: "an object form on the roles catalog",
      files: () => withRoles({ [ORG_ROLES_FILE]: { publicRead: CONDITIONAL } }),
      expected: [
        [ORG_ROLES_FILE, "rights.public-read-forbidden", "/publicRead"],
      ],
    },
    {
      case: "an object form on the role assignments catalog",
      files: () =>
        withRoles({ [ORG_ASSIGNMENTS_FILE]: { publicRead: CONDITIONAL } }),
      expected: [
        [ORG_ASSIGNMENTS_FILE, "rights.public-read-forbidden", "/publicRead"],
      ],
    },
    {
      case: "a valid conditional object",
      files: () => withRoles(conditionalRegion()),
      expected: [],
    },
  ])("$case", async ({ files, expected }) => {
    expect(await diagnosticsOf(files())).toEqual(expected)
  })
})
