import { beforeAll, describe, expect, it } from "vitest"
import { buildClientCatalog, buildRuntimeCatalog } from "simetra/compiler"
import {
  decodeRow,
  encodeRow,
  type CatalogEntry,
  type LogicalRow,
  type RuntimeObject,
} from "simetra/model"
import {
  adminRoles,
  commandCoreLayer,
  compileRights,
  policyDomain,
  writeRoles,
} from "./fixtures/rights"

const ID = "11111111-1111-4111-8111-111111111111"
const LINE_ID = "22222222-2222-4222-8222-222222222222"
const TARGET_ID = "33333333-3333-4333-8333-333333333333"

// Скомпільований запис з парою й ТЧ: кодек має працювати на реальних іменах
// колонок і id ТЧ, а не лише на будівнику T0.
let runtime: RuntimeObject
let client: CatalogEntry
beforeAll(async () => {
  const { model, diagnostics } = await compileRights(
    policyDomain(writeRoles(), adminRoles(), commandCoreLayer())
  )
  expect(diagnostics).toEqual([])
  const runtimeCatalog = buildRuntimeCatalog(model!)
  runtime = runtimeCatalog.objects.find(
    (o) =>
      o.tabularSections.length > 0 &&
      o.attributes.some((a) => a.pair !== undefined)
  )!
  expect(runtime).toBeDefined()
  client = buildClientCatalog(runtimeCatalog).objects.find(
    (o) => o.id === runtime.id
  )!
})

function cardRow(entry: CatalogEntry): LogicalRow {
  const pair = entry.attributes.find((a) => a.pair !== undefined)!
  const target = pair.pair!.targets[0]!
  const section = entry.tabularSections[0]!
  return {
    [entry.keyName]: ID,
    [entry.versionName]: 2,
    [pair.name]: {
      type: `${target.object.kind}.${target.object.name}`,
      id: TARGET_ID,
    },
    tabularSections: {
      [section.name]: [
        {
          [section.keyName]: LINE_ID,
          [section.parentName]: ID,
          [section.lineNumberName]: 1,
        },
      ],
    },
  }
}

describe("wire codec on a compiled catalog", () => {
  it("encodes a pair as two columns and a section by its id", () => {
    const pair = runtime.attributes.find((a) => a.pair !== undefined)!
    const section = runtime.tabularSections[0]!
    const wire = encodeRow(runtime, cardRow(runtime))
    expect(wire).toEqual({
      [runtime.key]: ID,
      [runtime.versionColumn]: "2",
      [pair.pair!.typeColumn]: pair.pair!.targets[0]!.label,
      [pair.column]: TARGET_ID,
      tabularSections: {
        [section.id]: [
          {
            [section.key]: LINE_ID,
            [section.parent]: ID,
            [section.lineNumber]: "1",
          },
        ],
      },
    })
    expect(decodeRow(client, wire)).toEqual(cardRow(client))
  })

  it("gives the same wire form from the runtime and the client entry", () => {
    expect(encodeRow(client, cardRow(client))).toEqual(
      encodeRow(runtime, cardRow(runtime))
    )
  })
})
