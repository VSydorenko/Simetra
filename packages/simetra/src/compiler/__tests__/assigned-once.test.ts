import { describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  renameElement,
  type CompileResult,
} from "simetra/compiler"
import { attribute, catalog, metaFiles, project, uuid } from "./helpers"

type Json = Record<string, unknown>

const PROJECT = "project.meta.json"
const CONTRACT = "catalogs/Contract/Contract.meta.json"
const STATUS = "enumerations/Status/Status.meta.json"

const contract = () =>
  catalog("Contract", {
    id: uuid(1),
    attributes: [attribute("amount", { id: uuid(2) })],
    predefinedItems: [{ id: uuid(3), name: "Main", physicalName: "main" }],
  })

const status = () => ({
  id: uuid(4),
  kind: "Enumeration",
  name: "Status",
  physicalName: "status",
  values: [{ id: uuid(5), name: "Draft", physicalName: "draft" }],
})

function baseState(entries: Record<string, unknown> = {}) {
  return {
    [PROJECT]: project(),
    [CONTRACT]: contract(),
    [STATUS]: status(),
    ...entries,
  }
}

/** Поточний стан — база з правкою одного файлу. */
function edited(
  base: Record<string, unknown>,
  path: string,
  edit: (content: Json) => Json
) {
  return { ...base, [path]: edit(structuredClone(base[path]) as Json) }
}

async function againstBase(
  base: Record<string, unknown>,
  current: Record<string, unknown>
): Promise<CompileResult> {
  return compile(metaFiles(current), { baseline: metaFiles(base) })
}

const changes = (result: CompileResult) =>
  result.diagnostics
    .filter((d) => d.code === "identity.assigned-once-changed")
    .map((d) => [d.file, d.pointer, d.params])

describe("assigned-once fields against the baseline", () => {
  it.each([
    ["kindLabel", (c: Json) => ({ ...c, kindLabel: "other" }), "contract"],
    [
      "physicalName",
      (c: Json) => ({ ...c, physicalName: "other" }),
      "contract",
    ],
    ["schema", (c: Json) => ({ ...c, schema: "billing" }), "public"],
  ])("changing an object's %s is an error", async (field, edit, before) => {
    const base = baseState()
    const result = await againstBase(base, edited(base, CONTRACT, edit))
    expect(changes(result)).toEqual([
      [
        CONTRACT,
        `/${field}`,
        {
          field,
          before,
          after: field === "schema" ? "billing" : "other",
        },
      ],
    ])
    expect(result.ok).toBe(false)
    expect(result.model).toBeUndefined()
    expect(result.diagnostics[0]!.range).toBeDefined()
  })

  it("changing an attribute, enumeration value or predefined label physicalName is an error", async () => {
    const base = baseState()
    const current = edited(
      edited(base, CONTRACT, (c) => {
        const attributes = c.attributes as Json[]
        const items = c.predefinedItems as Json[]
        attributes[0]!.physicalName = "sum"
        items[0]!.physicalName = "primary"
        return c
      }),
      STATUS,
      (c) => {
        ;(c.values as Json[])[0]!.physicalName = "draft_v2"
        return c
      }
    )
    expect(changes(await againstBase(base, current))).toEqual([
      [
        CONTRACT,
        "/attributes/0/physicalName",
        { field: "physicalName", before: "amount", after: "sum" },
      ],
      [
        CONTRACT,
        "/predefinedItems/0/physicalName",
        { field: "physicalName", before: "main", after: "primary" },
      ],
      [
        STATUS,
        "/values/0/physicalName",
        { field: "physicalName", before: "draft", after: "draft_v2" },
      ],
    ])
  })

  it("moving defaultSchema moves objects without explicit schema — an error on each", async () => {
    const base = baseState({
      "catalogs/Pinned/Pinned.meta.json": catalog("Pinned", {
        schema: "public",
      }),
      "catalogs/Other/Other.meta.json": catalog("Other"),
    })
    const current = edited(base, PROJECT, (p) => ({
      ...p,
      defaultSchema: "app",
    }))
    // Явна `schema` не рухається, перерахування не матеріалізується: помилка
    // лише на кожен об'єкт, що успадковував схему проєкту.
    expect(changes(await againstBase(base, current))).toEqual([
      [
        PROJECT,
        "/defaultSchema",
        { field: "schema", before: "public", after: "app" },
      ],
      [
        PROJECT,
        "/defaultSchema",
        { field: "schema", before: "public", after: "app" },
      ],
    ])
  })

  it("an explicit schema equal to the inherited one is not a change", async () => {
    const base = baseState()
    const current = edited(base, CONTRACT, (c) => ({ ...c, schema: "public" }))
    expect(changes(await againstBase(base, current))).toEqual([])
  })

  it("assigning a missing physicalName is not a change", async () => {
    const current = baseState()
    const base = edited(current, CONTRACT, (c) => {
      delete (c.attributes as Json[])[0]!.physicalName
      return c
    })
    const result = await againstBase(base, current)
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("removing an assigned value is a change", async () => {
    const base = baseState()
    const current = edited(base, CONTRACT, (c) => {
      delete c.kindLabel
      return c
    })
    expect(changes(await againstBase(base, current))).toEqual([
      [
        CONTRACT,
        "/kindLabel",
        { field: "kindLabel", before: "contract", after: "(removed)" },
      ],
    ])
  })

  it("rename keeps assigned fields: compile against the pre-rename baseline is clean", async () => {
    const before = metaFiles(baseState())
    const renamed = await renameElement(before, {
      target: { kind: "Catalog", name: "Contract" },
      newName: "Agreement",
    })
    expect(renamed.ok).toBe(true)
    const after = applyChanges(before, renamed.changes)
    const result = await compile(after, { baseline: before })
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("deleted and re-created object (new id) is not a change", async () => {
    const base = baseState()
    const current = edited(base, CONTRACT, (c) => ({
      ...c,
      id: uuid(99),
      physicalName: "contract_v2",
      kindLabel: "contract_v2",
    }))
    const result = await againstBase(base, current)
    expect(result.diagnostics).toEqual([])
  })

  it("a broken baseline file is skipped", async () => {
    const base = { ...baseState(), [CONTRACT]: "{ broken" }
    const result = await againstBase(base, baseState())
    expect(result.diagnostics).toEqual([])
  })

  it("without baseline nothing is checked", async () => {
    const base = baseState()
    const current = edited(base, CONTRACT, (c) => ({
      ...c,
      physicalName: "other",
    }))
    const result = await compile(metaFiles(current))
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })
})
