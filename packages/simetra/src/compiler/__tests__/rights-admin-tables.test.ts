import { describe, expect, it } from "vitest"
import { PLATFORM_SCHEMA } from "simetra/model"
import { INPUT_COLUMNS } from "../rights/admin-tables"
import { snapshotInputs } from "../rights/actor-snapshot"
import { LIVE, liveInputs } from "../rights/functions"
import {
  compileRights,
  policyDomain,
  rightsFiles,
  withRoles,
} from "./fixtures/rights"
import { bodyShape, loadShapeParsers, nodes, tree } from "./fixtures/sql-shape"
import { expectClean } from "./helpers"

interface TypedInsert {
  InsertStmt: {
    relation: { relname: string }
    cols: { ResTarget: { name: string } }[]
  }
}

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
    "rights_tx_header",
    "rightsTxHeader",
    ["xid", "fact", "actor"],
    ["xid", "fact"],
  ],
  [
    "rights_tx_typed",
    "rightsTxTyped",
    [
      "xid",
      "storage",
      "storage_id",
      "scope_kind_id",
      "scope",
      "container",
      "custom_role",
      "archetype",
      "level",
      "level_id",
      "provenance",
      "assignment",
    ],
    undefined,
  ],
  [
    "rights_tx_containers",
    "rightsTxContainers",
    ["xid", "level_id", "container", "scope_kind_id", "scope"],
    undefined,
  ],
  [
    "rights_tx_deltas",
    "rightsTxDeltas",
    [
      "xid",
      "storage",
      "storage_id",
      "custom_role",
      "scope_key",
      "effect",
      "object",
      "action",
      "extent",
      "dimension_id",
    ],
    undefined,
  ],
  [
    "rights_tx_holders",
    "rightsTxHolders",
    ["xid", "level", "level_id", "scope"],
    undefined,
  ],
  [
    "rights_tx_start",
    "rightsTxStart",
    [
      "xid",
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
    "rights_tx_scopes",
    "rightsTxScopes",
    ["xid", "scope_kind_id", "scope", "member", "catalog"],
    undefined,
  ],
  [
    "rights_tx_values",
    "rightsTxValues",
    ["xid", "dimension_id", "value"],
    undefined,
  ],
  [
    "rights_tx_scope_sets",
    "rightsTxScopeSets",
    ["xid", "scope_kind_id", "scope"],
    undefined,
  ],
  [
    "rights_tx_pending",
    "rightsTxPending",
    ["xid", "kind", "key", "scope_kind_id", "scope", "maintenance"],
    ["xid", "kind", "scope_kind_id", "key"],
  ],
  [
    "rights_tx_root_marker",
    "rightsTxRootMarker",
    ["xid", "scope_kind_id", "root", "actor"],
    ["xid", "scope_kind_id", "root"],
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
      // Індекси знімка (спека прав §7): рядки факту — за xid і ключем
      // точкового читання.
      const indexes: Record<string, string[][]> = {
        rights_tx_header: [],
        rights_tx_typed: [["xid"], ["xid", "assignment"]],
        rights_tx_containers: [["xid", "level_id", "container"]],
        rights_tx_deltas: [["xid", "storage", "custom_role", "scope_key"]],
        rights_tx_holders: [["xid"]],
        rights_tx_start: [["xid", "level", "level_id", "scope"]],
        rights_tx_scopes: [["xid", "scope_kind_id", "scope"]],
        rights_tx_values: [["xid", "dimension_id"]],
        rights_tx_scope_sets: [["xid", "scope_kind_id"]],
        rights_tx_root_marker: [],
      }
      if (name in indexes)
        expect(
          table!.indexes.map((i) =>
            i.keys.map((k) => ("column" in k ? k.column : ""))
          )
        ).toEqual(indexes[name])
    }
  )

  it("adds the snapshot tables", async () => {
    const result = await compileRights(withRoles())
    const snapshot = result
      .model!.physical.tables.filter(
        (t) => t.schema === PLATFORM_SCHEMA && t.name.startsWith("rights_tx_")
      )
      .map((t) => [t.name, t.primaryKey?.columns ?? null])
    expect(snapshot).toEqual([
      ["rights_tx_containers", null],
      ["rights_tx_deltas", null],
      ["rights_tx_header", ["xid", "fact"]],
      ["rights_tx_holders", null],
      ["rights_tx_pending", ["xid", "kind", "scope_kind_id", "key"]],
      ["rights_tx_root_marker", ["xid", "scope_kind_id", "root"]],
      ["rights_tx_scope_sets", null],
      ["rights_tx_scopes", null],
      ["rights_tx_start", null],
      ["rights_tx_typed", null],
      ["rights_tx_values", null],
    ])
  })

  // Р3-15: факт `rights` — входи `rights_mine`, а не її вихід, і кеш прав
  // початку на COMMIT у формі колишнього рядка прав.
  it("adds the input tables of the rights fact", async () => {
    const result = await compileRights(withRoles())
    const of = (name: string) =>
      result.model!.physical.tables.find(
        (t) => t.schema === PLATFORM_SCHEMA && t.name === name
      )
    expect(of("rights_tx_actor")).toBeUndefined()
    const shape = (name: string) => {
      const table = of(name)!
      return {
        columns: table.columns.map((c) => [c.name, c.type, c.notNull]),
        indexes: table.indexes.map((i) => [
          i.name,
          i.keys.map((k) => ("column" in k ? k.column : "")),
        ]),
      }
    }
    const nullable = (columns: [string, string][]) =>
      columns.map(([name, type]) => [name, type, false])
    expect(shape("rights_tx_typed")).toEqual({
      columns: [
        ["xid", "bigint", true],
        ...nullable([
          ["storage", "text"],
          ["storage_id", "uuid"],
          ["scope_kind_id", "uuid"],
          ["scope", "uuid"],
          ["container", "uuid"],
          ["custom_role", "uuid"],
          ["archetype", "uuid"],
          ["level", "text"],
          ["level_id", "uuid"],
          // Походження рядка функції гранту (Р-A6-5) — лише в DDL.
          ["provenance", "text"],
          ["assignment", "uuid"],
        ]),
      ],
      indexes: [
        ["rights_tx_typed_xid_idx", ["xid"]],
        ["rights_tx_typed_xid_assignment_idx", ["xid", "assignment"]],
      ],
    })
    // Частковий: `EXISTS` причини журналу читає лише рядки з походженням, а
    // не всі рядки `typed` актора.
    expect(
      of("rights_tx_typed")!.indexes.map((i) => [i.name, i.where])
    ).toEqual([
      ["rights_tx_typed_xid_idx", undefined],
      ["rights_tx_typed_xid_assignment_idx", "provenance IS NOT NULL"],
    ])
    expect(shape("rights_tx_containers")).toEqual({
      columns: [
        ["xid", "bigint", true],
        ...nullable([
          ["level_id", "uuid"],
          ["container", "uuid"],
          ["scope_kind_id", "uuid"],
          ["scope", "uuid"],
        ]),
      ],
      indexes: [
        [
          "rights_tx_containers_xid_level_id_container_idx",
          ["xid", "level_id", "container"],
        ],
      ],
    })
    expect(shape("rights_tx_deltas")).toEqual({
      columns: [
        ["xid", "bigint", true],
        ...nullable([
          ["storage", "text"],
          ["storage_id", "uuid"],
          ["custom_role", "uuid"],
          ["scope_key", "uuid"],
          ["effect", "text"],
          ["object", "text"],
          ["action", "text"],
          ["extent", "text"],
          ["dimension_id", "uuid"],
        ]),
      ],
      indexes: [
        [
          "rights_tx_deltas_xid_storage_custom_role_scope_key_idx",
          ["xid", "storage", "custom_role", "scope_key"],
        ],
      ],
    })
    expect(shape("rights_tx_holders")).toEqual({
      columns: [
        ["xid", "bigint", true],
        ...nullable([
          ["level", "text"],
          ["level_id", "uuid"],
          ["scope", "uuid"],
        ]),
      ],
      indexes: [["rights_tx_holders_xid_idx", ["xid"]]],
    })
    expect(shape("rights_tx_start")).toEqual({
      columns: [
        ["xid", "bigint", true],
        ...nullable([
          ["level", "text"],
          ["level_id", "uuid"],
          ["scope", "uuid"],
          ["container", "uuid"],
          ["object", "text"],
          ["action", "text"],
          ["extent", "text"],
          ["dimension_id", "uuid"],
        ]),
        ["full_access", "boolean", true],
      ],
      indexes: [
        [
          "rights_tx_start_xid_level_level_id_scope_idx",
          ["xid", "level", "level_id", "scope"],
        ],
      ],
    })
  })

  // Р-A6-5: походження й рядок призначення пише лише функція гранту; знімок,
  // його читання й живі входи `rights_mine` колонок не бачать — інакше рядок
  // функції відрізнявся б від живого рядка входу того самого призначення.
  it("snapshot inputs do not see provenance", async () => {
    await loadShapeParsers()
    const result = await compileRights(policyDomain())
    expectClean(result)
    const model = result.model!
    const names = (sql: string) =>
      nodes(tree(sql), "sval").map((v) => (v as { sval: string }).sval)
    const typedColumns = INPUT_COLUMNS.typed.map(([name]) => name)
    // Літеральна перевірка: очікування нижче беруться з `INPUT_COLUMNS`, тож
    // колонка походження, додана туди, змінила б обидві сторони порівняння.
    expect(typedColumns).not.toContain("provenance")
    expect(typedColumns).not.toContain("assignment")
    expect(snapshotInputs("x").typed).not.toMatch(/provenance|assignment/)
    expect(snapshotInputs("x").typed).toBe(
      `SELECT ${typedColumns.map((c) => `i.${c}`).join(", ")} FROM simetra.rights_tx_typed i WHERE i.xid = x`
    )
    const live = liveInputs(
      model.contracts,
      model.physical,
      model.project.naming.attributeCase,
      LIVE
    ).typed
    expect(names(live)).not.toContain("provenance")
    expect(names(live)).not.toContain("assignment")
    const snapshot = model.sqlUnits.find(
      (u) =>
        u.identity ===
        "function:public.org_role_assignments_simetra_rights_snapshot()"
    )!
    const inserts = bodyShape(snapshot.sql)
      .map((s) => s.expressions[0]?.tree as TypedInsert | undefined)
      .filter((t) => t?.InsertStmt?.relation.relname === "rights_tx_typed")
    expect(
      inserts.map((t) => t!.InsertStmt.cols.map((c) => c.ResTarget.name))
    ).toEqual([["xid", ...typedColumns]])
    expect(
      inserts[0]!.InsertStmt.cols.map((c) => c.ResTarget.name)
    ).not.toContain("provenance")
  })

  // Р-A6-7, Р-A6-23: маркер кореня — ключ транзакції, виду й кореня з
  // актором вставки; закритий, як решта таблиць схеми платформи.
  it("adds the root marker table without grants", async () => {
    const result = await compileRights(withRoles())
    const marker = result.model!.physical.tables.find(
      (t) => t.schema === PLATFORM_SCHEMA && t.name === "rights_tx_root_marker"
    )!
    expect(marker.columns.map((c) => [c.name, c.type, c.notNull])).toEqual([
      ["xid", "bigint", true],
      ["scope_kind_id", "uuid", true],
      ["root", "uuid", true],
      ["actor", "uuid", true],
    ])
    expect(marker.indexes).toEqual([])
    expect(
      result.model!.contracts.access.filter(
        (a) => a.table.schema === PLATFORM_SCHEMA
      )
    ).toEqual([])
    expect(
      result
        // Функція перевірки маркера має лише відкликання `EXECUTE`.
        .model!.sqlUnits.filter((u) =>
          /rights_tx_root_marker(?!_check)/.test(u.sql)
        )
        .filter((u) => u.class === "grant" || u.class === "policy")
    ).toEqual([])
  })

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
