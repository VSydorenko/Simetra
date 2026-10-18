import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  MEMBER_REGION_ID,
  TASK_FILE,
  TASK_ID,
  compileRights,
  rightsFiles,
} from "./fixtures/rights"
import { catalog, metaFiles, project, uuid } from "./helpers"

type Files = ReturnType<typeof rightsFiles>

const PROJECT = "project.meta.json"
const REGION_DIM_ID = uuid(6060)
const STOCK_ID = uuid(6070)
const STOCK_FILE = "accumulation-registers/RegionStock/RegionStock.meta.json"

const ref = (kind: string, name: string) => ({ kind, name })

const RELATION = {
  relation: {
    object: ref("InformationRegister", "MemberRegion"),
    subject: "member",
    value: "region",
  },
}

function dimension(overrides: Record<string, unknown> = {}) {
  return {
    id: REGION_DIM_ID,
    name: "region",
    target: ref("Catalog", "Region"),
    values: RELATION,
    ...overrides,
  }
}

function errors(result: Awaited<ReturnType<typeof compileRights>>) {
  return result.diagnostics.filter((d) => d.severity === "error")
}

async function compiled(files: Files) {
  const result = await compileRights(files)
  expect(errors(result)).toEqual([])
  return result.model!.contracts
}

async function codes(files: Files) {
  return errors(await compileRights(files)).map((d) => [
    d.code,
    d.file,
    d.pointer,
  ])
}

/** Функція значень у закритій формі: без неї стадія 5 червоніє (Р1a-14). */
function withValuesFunction(files: Files, name: string): Files {
  files.set(
    "sql/public/access-dimensions.sql",
    `CREATE FUNCTION public.${name}() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT NULL::uuid $$;`
  )
  return files
}

const withDimension = (
  overrides: Record<string, Record<string, unknown>>,
  dim: Record<string, unknown> = dimension()
) => rightsFiles({ [PROJECT]: { accessDimensions: [dim] }, ...overrides })

describe("access dimensions", () => {
  it("maps an attribute to a dimension", async () => {
    const contracts = await compiled(
      withDimension({
        [TASK_FILE]: {
          ownership: ["assignee"],
          access: [{ attribute: "region", dimension: "region" }],
        },
      })
    )
    const task = contracts.rights.find((c) => c.objectId === TASK_ID)!
    expect(task.access).toEqual([
      { dimensionId: REGION_DIM_ID, carrier: { column: "region_id" } },
    ])
    for (const action of task.actions) {
      expect(action.extents).toEqual([
        { form: "any" },
        { form: "own" },
        { form: "dimension", dimensionId: REGION_DIM_ID },
      ])
    }
    expect(contracts.accessDimensions).toEqual([
      {
        dimensionId: REGION_DIM_ID,
        name: "region",
        targetId: uuid(6040),
        values: {
          relation: {
            objectId: MEMBER_REGION_ID,
            table: { schema: "public", name: "member_region" },
            subject: "member_id",
            value: "region_id",
          },
        },
      },
    ])
  })

  it("names the function of values in the default schema", async () => {
    const contracts = await compiled(
      withValuesFunction(
        withDimension(
          {},
          dimension({ values: { function: { name: "my_regions" } } })
        ),
        "my_regions"
      )
    )
    expect(contracts.accessDimensions[0]!.values).toEqual({
      function: { schema: "public", name: "my_regions" },
    })
  })

  it("maps through a path", async () => {
    const contracts = await compiled(
      withDimension({
        "catalogs/TaskComment/TaskComment.meta.json": {
          access: [{ ref: ["task", "region"], dimension: "region" }],
        },
      })
    )
    const comment = contracts.rights.find((c) => c.objectId === uuid(6050))!
    expect(comment.access).toEqual([
      {
        dimensionId: REGION_DIM_ID,
        carrier: {
          column: "task_id",
          via: {
            objectId: TASK_ID,
            table: { schema: "public", name: "task" },
            column: "region_id",
          },
        },
      },
    ])
  })

  it("maps a register dimension", async () => {
    const contracts = await compiled(
      withDimension({
        [STOCK_FILE]: {
          id: STOCK_ID,
          kind: "AccumulationRegister",
          name: "RegionStock",
          physicalName: "region_stock",
          kindLabel: "region_stock",
          scope: "org",
          registerType: "Turnover",
          dimensions: [
            {
              id: uuid(6071),
              name: "region",
              physicalName: "region_id",
              type: "Ref",
              ref: ref("Catalog", "Region"),
            },
          ],
          resources: [
            {
              id: uuid(6072),
              name: "qty",
              physicalName: "qty",
              type: "Numeric",
              precision: 15,
              scale: 3,
            },
          ],
          access: [{ attribute: "region", dimension: "region" }],
        },
      })
    )
    const stock = contracts.rights.find((c) => c.objectId === STOCK_ID)!
    expect(stock.access).toEqual([
      { dimensionId: REGION_DIM_ID, carrier: { column: "region_id" } },
    ])
    expect(stock.actions[0]!.extents).toEqual([
      { form: "any" },
      { form: "dimension", dimensionId: REGION_DIM_ID },
    ])
  })

  it("rejects broken dimension declarations", async () => {
    const functionValues = { values: { function: { name: "my_ids" } } }
    expect(
      await codes(
        withDimension({
          [TASK_FILE]: { access: [{ attribute: "region", dimension: "zone" }] },
        })
      )
    ).toEqual([["rights.dimension-unknown", TASK_FILE, "/access/0/dimension"]])
    expect(
      await codes(
        withValuesFunction(
          withDimension(
            {},
            dimension({ target: ref("Document", "Task"), ...functionValues })
          ),
          "my_ids"
        )
      )
    ).toEqual([
      ["rights.dimension-target", PROJECT, "/accessDimensions/0/target"],
    ])
    expect(
      await codes(
        withValuesFunction(
          withDimension(
            { "catalogs/Region/Region.meta.json": { scope: "none" } },
            dimension(functionValues)
          ),
          "my_ids"
        )
      )
    ).toEqual([
      ["rights.dimension-target", PROJECT, "/accessDimensions/0/target"],
    ])
    expect(
      await codes(
        withDimension(
          {},
          dimension({
            values: { relation: { ...RELATION.relation, value: "member" } },
          })
        )
      )
    ).toEqual([
      [
        "rights.dimension-relation",
        PROJECT,
        "/accessDimensions/0/values/relation/value",
      ],
    ])
    expect(
      await codes(
        withDimension({
          [TASK_FILE]: {
            access: [{ attribute: "project", dimension: "region" }],
          },
        })
      )
    ).toEqual([["rights.access-target", TASK_FILE, "/access/0/attribute"]])
    expect(
      await codes(
        withDimension({
          [TASK_FILE]: {
            access: [
              { attribute: "region", dimension: "region" },
              { ref: ["assignee", "user"], dimension: "region" },
            ],
          },
        })
      )
    ).toEqual([["rights.access-duplicate", TASK_FILE, "/access/1/dimension"]])
  })

  it("names the reason of a broken target and relation", async () => {
    const result = await compileRights(
      withDimension(
        {},
        dimension({
          target: ref("Document", "Task"),
          values: { function: { name: "my_ids" } },
        })
      )
    )
    expect(errors(result)[0]!.params).toEqual({
      dimension: "region",
      reason: "kind",
    })
    const relation = await compileRights(
      withDimension(
        {},
        dimension({
          values: { relation: { ...RELATION.relation, subject: "region" } },
        })
      )
    )
    expect(errors(relation)[0]!.params).toEqual({
      dimension: "region",
      field: "subject",
      reason: "target",
    })
  })

  it("accepts an unscoped target in a single-tenant project", async () => {
    const result = await compile(
      withValuesFunction(
        metaFiles({
          [PROJECT]: project({
            accessDimensions: [
              {
                id: uuid(6080),
                name: "region",
                target: ref("Catalog", "Region"),
                values: { function: { name: "my_regions" } },
              },
            ],
          }),
          "catalogs/Region/Region.meta.json": catalog("Region"),
          // Права без «Користувачів» — `rights.users-missing` (§4.6).
          "catalogs/Users/Users.meta.json": catalog("Users", { role: "users" }),
        }),
        "my_regions"
      )
    )
    expect(errors(result)).toEqual([])
  })
})
