import { describe, expect, it } from "vitest"
import { storageRefusals } from "../plan"
import {
  appliedStorageSource,
  storageTables,
  type StorageFactsSource,
} from "../storage-facts"
import { tableKey } from "../table-key"

const column = (table: string, name: string) => ({
  kind: "column",
  schema: "app",
  table,
  name,
})
const tableRef = (name: string) => ({ kind: "table", schema: "app", name })
const step = (produced: unknown[] = [], destroyed: unknown[] = []) =>
  ({ produced, destroyed }) as Parameters<typeof storageRefusals>[0][number]
const keys = (...names: string[]) =>
  new Set(names.map((n) => tableKey("app", n)))
const none = keys()

describe("storageRefusals", () => {
  it("refuses storage added to a live table: the model has it, the applied state has not", () => {
    expect(
      storageRefusals([step([column("scan", "file_size")])], {
        desired: keys("scan"),
        applied: none,
      }).map((d) => [d.code, d.params])
    ).toEqual([["plan.storage-added", { table: "app.scan" }]])
  })

  it("refuses storage removed from a live table: the applied state has it, the model has not", () => {
    expect(
      storageRefusals([step([], [column("scan", "file_size")])], {
        desired: none,
        applied: keys("scan"),
      }).map((d) => [d.code, d.params])
    ).toEqual([["plan.storage-removed", { table: "app.scan" }]])
  })

  it("lets a new object with storage through: the table is created in the same plan", () => {
    expect(
      storageRefusals([step([tableRef("scan"), column("scan", "file_size")])], {
        desired: keys("scan"),
        applied: none,
      })
    ).toEqual([])
  })

  it("lets a dropped object with storage through: the table goes with the column", () => {
    expect(
      storageRefusals(
        [step([], [tableRef("scan"), column("scan", "file_size")])],
        { desired: none, applied: keys("scan") }
      )
    ).toEqual([])
  })

  it("an ordinary column named file_size is not a storage trace", () => {
    const same = { desired: none, applied: none }
    expect(
      storageRefusals([step([column("scan", "file_size")])], same)
    ).toEqual([])
    expect(
      storageRefusals([step([], [column("scan", "file_size")])], same)
    ).toEqual([])
  })

  it("an object that keeps its storage passes whatever the plan does to its columns", () => {
    const same = { desired: keys("scan"), applied: keys("scan") }
    expect(
      storageRefusals([step([column("scan", "file_size")])], same)
    ).toEqual([])
  })

  it("names each table once, in a stable order", () => {
    const found = storageRefusals([], {
      desired: keys("b", "a"),
      applied: none,
    })
    expect(found.map((d) => d.params.table)).toEqual(["app.a", "app.b"])
  })
})

describe("storageTables", () => {
  const table = (
    name: string,
    origin: StorageFactsSource["physical"]["tables"][number]["origin"]
  ) => ({ schema: "app", name, origin })
  const source: StorageFactsSource = {
    objects: [
      { id: "with", data: { storage: { maxBytes: 1, mediaTypes: [] } } },
      { id: "without", data: { attributes: [{ name: "file_size" }] } },
    ],
    physical: {
      tables: [
        table("main_with", { objectId: "with" }),
        table("section_with", { objectId: "with", tabularSectionId: "s" }),
        table("main_without", { objectId: "without" }),
      ],
    },
  }

  it("takes the main table of an object whose data has storage, and nothing else", () => {
    expect(storageTables(source)).toEqual(keys("main_with"))
  })

  it("reads the same facts from a marker snapshot", () => {
    expect(storageTables(appliedStorageSource(source))).toEqual(
      keys("main_with")
    )
  })

  it("refuses a snapshot that is not canonical", () => {
    expect(() => appliedStorageSource({ objects: 1 })).toThrow(/canonical/)
  })
})
