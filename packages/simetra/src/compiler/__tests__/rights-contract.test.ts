import { describe, expect, it } from "vitest"
import { applyChanges, fixFiles, localize } from "simetra/compiler"
import {
  MEMBER_REGION_ID,
  ORG_KIND_ID,
  TASK_FILE,
  TASK_ID,
  compileRights,
  rightsFiles,
} from "./fixtures/rights"
import { uuid } from "./helpers"

const STOCK_FILE = "accumulation-registers/RegionStock/RegionStock.meta.json"
const MEMBER_REGION_FILE =
  "information-registers/MemberRegion/MemberRegion.meta.json"

function errors(result: Awaited<ReturnType<typeof compileRights>>) {
  return result.diagnostics.filter((d) => d.severity === "error")
}

async function contractOf(files: Map<string, string>, objectId = TASK_ID) {
  const result = await compileRights(files)
  expect(errors(result)).toEqual([])
  return result.model!.contracts.rights.find((c) => c.objectId === objectId)!
}

async function codes(files: Map<string, string>) {
  const result = await compileRights(files)
  return result.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => [d.code, d.pointer])
}

describe("rights contract", () => {
  it("builds a rights contract with the kind actions and any extent", async () => {
    const result = await compileRights(rightsFiles())
    expect(errors(result)).toEqual([])
    const task = result.model!.contracts.rights.find(
      (c) => c.objectId === TASK_ID
    )!
    expect(task.kindLabel).toBe("task")
    expect(task.table).toEqual({ schema: "public", name: "task" })
    expect(task.scopeKindId).toBe(ORG_KIND_ID)
    expect(task.actions.map((a) => [a.action, a.requires])).toEqual([
      ["read", []],
      ["create", ["read"]],
      ["update", ["read"]],
      ["markDeletion", ["read"]],
      ["delete", ["read"]],
      ["post", ["read", "update"]],
      ["unpost", ["post", "read", "update"]],
    ])
    expect(task.actions[0]!.extents).toEqual([{ form: "any" }])
    // Ефекти стандартних дій — з реєстру, канонічні імена — у фізичні колонки.
    expect(
      task.actions.find((a) => a.action === "markDeletion")!.effects
    ).toEqual({
      dml: ["update"],
      header: ["deletion_mark"],
      tabularSections: false,
    })
    expect(task.actions.find((a) => a.action === "create")!.effects).toEqual({
      dml: ["insert"],
      header: "all",
      tabularSections: true,
    })
  })

  it("has a record for every kind with rights extents and none for others", async () => {
    const result = await compileRights(rightsFiles())
    const rights = result.model!.contracts.rights
    const ids = rights.map((c) => c.objectId)
    expect(ids).toEqual([...ids].sort())
    expect(ids).toContain(MEMBER_REGION_ID)
    const register = rights.find((c) => c.objectId === MEMBER_REGION_ID)!
    expect(register.actions.map((a) => a.action)).toEqual(["read", "write"])
    // «Користувачі» без скоупу: вид скоупу в контракті не вказано.
    const users = result.model!.objects.find((o) => o.name === "Users")!
    expect(rights.find((c) => c.objectId === users.id)!.scopeKindId).toBe(
      undefined
    )
  })

  it("adds a custom action by its UUID with derived update effects", async () => {
    const files = rightsFiles({
      [TASK_FILE]: {
        customActions: [
          {
            id: uuid(7701),
            name: "reassign",
            requires: ["update"],
            effects: { header: ["assignee"] },
          },
        ],
      },
    })
    const action = (await contractOf(files)).actions.find(
      (a) => a.name === "reassign"
    )!
    expect(action).toMatchObject({
      action: uuid(7701),
      requires: ["read", "update"],
      effects: {
        dml: ["update"],
        header: ["assignee_id"],
        tabularSections: false,
      },
      extents: [{ form: "any" }],
    })
  })

  it("orders custom actions by id after the kind actions and closes their requirements", async () => {
    const files = rightsFiles({
      [TASK_FILE]: {
        customActions: [
          {
            id: uuid(7703),
            name: "archive",
            requires: ["close"],
            effects: { header: "all", tabularSections: true },
          },
          { id: uuid(7702), name: "close", requires: ["post"] },
          {
            id: uuid(7704),
            name: "stamp",
            effects: { header: ["deletionMark", "createdBy"] },
          },
        ],
      },
    })
    const task = await contractOf(files)
    expect(task.actions.map((a) => a.action).slice(7)).toEqual([
      uuid(7702),
      uuid(7703),
      uuid(7704),
    ])
    const [close, archive, stamp] = task.actions.slice(7)
    // Дія без ефектів нічого не пише, тож загального ребра `read` не має.
    expect(close).toMatchObject({
      requires: ["post", "read", "update"],
      effects: { dml: [], header: [], tabularSections: false },
    })
    expect(archive).toMatchObject({
      requires: ["post", "read", "update", uuid(7702)].sort(),
      effects: { dml: ["update"], header: "all", tabularSections: true },
    })
    // Стандартні реквізити — за ім'ям у стилі проєкту.
    expect(stamp!.effects.header).toEqual(["deletion_mark", "created_by_id"])
    expect(stamp!.requires).toEqual(["read"])
  })

  it("rejects an unknown action, a reserved name and a requires cycle", async () => {
    const one = (customActions: unknown[]) =>
      codes(rightsFiles({ [TASK_FILE]: { customActions } }))
    expect([
      ...(await one([
        { id: uuid(7711), name: "reassign", requires: ["write"] },
      ])),
      ...(await one([{ id: uuid(7712), name: "post" }])),
      ...(await one([
        { id: uuid(7713), name: "close", requires: ["archive"] },
        { id: uuid(7714), name: "archive", requires: ["close"] },
      ])),
    ]).toEqual([
      ["rights.action-unknown", "/customActions/0/requires/0"],
      ["rights.custom-action-reserved", "/customActions/0/name"],
      ["rights.requires-cycle", "/customActions/0/requires/0"],
    ])
  })

  it("names the cycle chain", async () => {
    const result = await compileRights(
      rightsFiles({
        [TASK_FILE]: {
          customActions: [
            { id: uuid(7715), name: "close", requires: ["close"] },
          ],
        },
      })
    )
    expect(errors(result)).toEqual([
      expect.objectContaining({
        code: "rights.requires-cycle",
        params: { actions: "close → close" },
      }),
    ])
  })

  it("reports an unknown header attribute", async () => {
    expect(
      await codes(
        rightsFiles({
          [TASK_FILE]: {
            customActions: [
              {
                id: uuid(7721),
                name: "reassign",
                effects: { header: ["owner"] },
              },
            ],
          },
        })
      )
    ).toEqual([
      ["rights.attribute-unknown", "/customActions/0/effects/header/0"],
    ])
  })

  it("refuses custom action effects on a kind whose standard actions write nothing", async () => {
    const stock = (effects: Record<string, unknown>) =>
      compileRights(
        rightsFiles({
          [STOCK_FILE]: {
            id: uuid(7751),
            kind: "AccumulationRegister",
            name: "RegionStock",
            physicalName: "region_stock",
            kindLabel: "region_stock",
            scope: "org",
            registerType: "Turnover",
            dimensions: [
              {
                id: uuid(7752),
                name: "region",
                physicalName: "region_id",
                type: "Ref",
                ref: { kind: "Catalog", name: "Region" },
              },
            ],
            resources: [
              {
                id: uuid(7753),
                name: "qty",
                physicalName: "qty",
                type: "Numeric",
                precision: 15,
                scale: 3,
              },
            ],
            customActions: [{ id: uuid(7754), name: "approve", effects }],
          },
        })
      )
    const found = async (effects: Record<string, unknown>) =>
      errors(await stock(effects)).map((d) => [d.code, d.pointer, d.params])
    const noWrite = [
      "rights.custom-action-effects",
      "/customActions/0/effects",
      { action: "approve", reason: "noWrite" },
    ]
    expect(await found({ header: ["qty"] })).toEqual([noWrite])
    expect(await found({ header: "all" })).toEqual([noWrite])
    expect(await found({ tabularSections: true })).toEqual([noWrite])
    // Порожні ефекти нічого не пишуть, тож і на виді без запису законні.
    expect(await found({ header: [], tabularSections: false })).toEqual([])
  })

  it("refuses tabular section effects on a kind without tabular sections", async () => {
    const result = await compileRights(
      rightsFiles({
        [MEMBER_REGION_FILE]: {
          customActions: [
            {
              id: uuid(7761),
              name: "approve",
              effects: { header: ["region"], tabularSections: true },
            },
          ],
        },
      })
    )
    expect(errors(result).map((d) => [d.code, d.pointer, d.params])).toEqual([
      [
        "rights.custom-action-effects",
        "/customActions/0/effects/tabularSections",
        { action: "approve", reason: "noTabularSections" },
      ],
    ])
    expect(localize(errors(result)[0]!, "uk").message).not.toBe(
      localize(errors(result)[0]!, "en").message
    )
  })

  it("accepts header effects on an independent information register", async () => {
    const contract = await contractOf(
      rightsFiles({
        [MEMBER_REGION_FILE]: {
          customActions: [
            {
              id: uuid(7771),
              name: "approve",
              effects: { header: ["region"] },
            },
          ],
        },
      }),
      MEMBER_REGION_ID
    )
    expect(contract.actions.find((a) => a.name === "approve")?.effects).toEqual(
      { dml: ["update"], header: ["region_id"], tabularSections: false }
    )
  })

  it("refuses a custom action named like a sibling attribute", async () => {
    expect(
      await codes(
        rightsFiles({
          [TASK_FILE]: {
            customActions: [{ id: uuid(7731), name: "assignee" }],
          },
        })
      )
    ).toEqual([["identity.name-duplicate", "/customActions/0/name"]])
  })

  it("keeps custom action names camelCase in a snake_case project", async () => {
    const files = rightsFiles({
      "project.meta.json": { naming: { attributeCase: "snake_case" } },
      [TASK_FILE]: {
        customActions: [
          { id: uuid(7741), name: "closeTask" },
          { id: uuid(7742), name: "close_task" },
        ],
      },
    })
    const result = await compileRights(files)
    expect(
      errors(result)
        .filter((d) => d.file === TASK_FILE)
        .map((d) => [d.code, d.pointer, d.params?.style])
    ).toEqual([["identity.name-case", "/customActions/1/name", "camelCase"]])
  })

  it("requires an id on a custom action and indexes custom requirements", async () => {
    expect(
      await codes(
        rightsFiles({ [TASK_FILE]: { customActions: [{ name: "close" }] } })
      )
    ).toEqual([["identity.id-missing", "/customActions/0/id"]])

    const result = await compileRights(
      rightsFiles({
        [TASK_FILE]: {
          customActions: [
            { id: uuid(7751), name: "close" },
            {
              id: uuid(7752),
              name: "archive",
              requires: ["close", "read"],
              effects: { header: ["assignee"] },
            },
          ],
        },
      })
    )
    expect(errors(result)).toEqual([])
    const refs = result.model!.references.filter((r) =>
      r.from.pointer.startsWith("/customActions/")
    )
    expect(refs.map((r) => [r.from.pointer, r.role, r.to])).toEqual([
      [
        "/customActions/1/effects/header/0",
        "customAction.header",
        { kind: "Element", id: uuid(6011) },
      ],
      [
        "/customActions/1/requires/0",
        "customAction.requires",
        { kind: "Element", id: uuid(7751) },
      ],
    ])
  })

  it("fix gives a custom action an id and no physical name", async () => {
    const files = rightsFiles({
      [TASK_FILE]: { customActions: [{ name: "close" }] },
    })
    let n = 0
    const result = await fixFiles(files, {
      schemaPath: (_, schemaFile) => schemaFile,
      newId: () => uuid(7800 + ++n),
    })
    expect(result.ok).toBe(true)
    const task = JSON.parse(
      applyChanges(files, result.changes).get(TASK_FILE)!
    ) as { customActions: Record<string, unknown>[] }
    expect(task.customActions).toEqual([{ id: uuid(7801), name: "close" }])
  })
})
