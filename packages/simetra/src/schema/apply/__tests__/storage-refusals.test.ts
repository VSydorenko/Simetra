import { describe, expect, it } from "vitest"
import { storageRefusals } from "../plan"

const column = (table: string, name: string) => ({
  kind: "column",
  schema: "app",
  table,
  name,
})
const tableRef = (name: string) => ({ kind: "table", schema: "app", name })
const step = (produced: unknown[] = [], destroyed: unknown[] = []) =>
  ({ produced, destroyed }) as Parameters<typeof storageRefusals>[0][number]

describe("storageRefusals", () => {
  it("refuses storage added to a live table: the size column appears on a table the plan keeps", () => {
    expect(
      storageRefusals([step([column("scan", "file_size")])]).map((d) => [
        d.code,
        d.params,
      ])
    ).toEqual([["plan.storage-added", { table: "app.scan" }]])
  })

  it("refuses storage removed from a live table: the size column goes, the table stays", () => {
    expect(
      storageRefusals([step([], [column("scan", "file_size")])]).map((d) => [
        d.code,
        d.params,
      ])
    ).toEqual([["plan.storage-removed", { table: "app.scan" }]])
  })

  it("lets a new object with storage through: the table is created in the same plan", () => {
    expect(
      storageRefusals([step([tableRef("scan"), column("scan", "file_size")])])
    ).toEqual([])
  })

  it("lets a dropped object with storage through: the table goes with the column", () => {
    expect(
      storageRefusals([
        step([], [tableRef("scan"), column("scan", "file_size")]),
      ])
    ).toEqual([])
  })

  it("ignores other columns", () => {
    expect(storageRefusals([step([column("scan", "file_name")])])).toEqual([])
  })

  it("names each table once, in a stable order", () => {
    const found = storageRefusals([
      step([column("b", "file_size"), column("a", "file_size")]),
      step([column("a", "file_size")]),
    ])
    expect(found.map((d) => d.params.table)).toEqual(["app.a", "app.b"])
  })
})
