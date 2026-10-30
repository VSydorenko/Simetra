import { describe, expect, it } from "vitest"
import { PLATFORM_SCHEMA } from "simetra/model"
import { compileRights, rightsFiles, withRoles } from "./fixtures/rights"

const tables = [
  [
    "rights_versions",
    "rightsVersions",
    ["scope_kind_id", "scope", "version"],
    ["scope_kind_id", "scope"],
  ],
  [
    "rights_journal",
    "rightsJournal",
    [
      "id",
      "seq",
      "xid",
      "at",
      "scope_kind_id",
      "scope",
      "actor",
      "reason",
      "action",
      "object",
      "relation",
      "operation",
      "row_id",
      "parent_id",
      "before",
      "after",
    ],
    ["id"],
  ],
  [
    "rights_tx_actor",
    "rightsTxActor",
    [
      "xid",
      "actor",
      "level",
      "level_id",
      "scope",
      "container",
      "object",
      "action",
      "extent",
      "dimension_id",
      "full_access",
    ],
    undefined,
  ],
  [
    "rights_tx_pending",
    "rightsTxPending",
    ["xid", "kind", "key", "scope_kind_id", "scope", "maintenance"],
    ["xid", "kind", "scope_kind_id", "key"],
  ],
] as const

describe("rights administration storage", () => {
  it.each(tables)(
    "adds closed platform table %s with its identity",
    async (name, part, columns, key) => {
      const result = await compileRights(withRoles())
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
        []
      )
      const table = result.model!.physical.tables.find(
        (t) => t.schema === PLATFORM_SCHEMA && t.name === name
      )
      expect(table).toBeDefined()
      expect(table!.origin.part).toBe(part)
      expect(table!.origin.objectId).toBe(
        result.model!.contracts.rightsCatalogs[0]!.assignments.objectId
      )
      expect(table!.columns.map((c) => c.name)).toEqual(columns)
      expect(table!.primaryKey?.columns).toEqual(key)
      expect(table!.rowLevelSecurity).toBe("off")
      expect(table!.foreignKeys).toEqual([])
      if (name === "rights_journal") {
        expect(table!.columns.find((c) => c.name === "seq")?.identity).toEqual({
          generation: "always",
          sequence: "rights_journal_seq_seq",
        })
        // Первинний образ рядка — за (xid, relation, row_id, seq); журнал
        // скоупу новіші першими — за (вид, скоуп, at, seq).
        expect(
          Object.fromEntries(table!.indexes.map((i) => [i.name, i.keys]))
        ).toEqual({
          rights_journal_xid_relation_row_id_seq_idx: [
            { column: "xid" },
            { column: "relation" },
            { column: "row_id" },
            { column: "seq" },
          ],
          rights_journal_scope_kind_id_scope_at_seq_idx: [
            { column: "scope_kind_id" },
            { column: "scope" },
            { column: "at", order: "desc" },
            { column: "seq", order: "desc" },
          ],
        })
      }
      if (name === "rights_tx_actor")
        expect(table!.indexes.map((i) => i.keys)).toEqual([[{ column: "xid" }]])
    }
  )

  it("does not add rights storage without roles and system catalogs", async () => {
    const result = await compileRights(rightsFiles())
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(
      result
        .model!.physical.tables.filter((t) => t.schema === PLATFORM_SCHEMA)
        .map((t) => t.name)
    ).toEqual(["identities"])
  })
})
