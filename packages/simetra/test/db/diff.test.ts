import { describe, expect, it } from "vitest"
import type {
  CatalogConstraint,
  CatalogIndex,
  CatalogShape,
  CatalogTable,
} from "./catalog"
import {
  diffCatalogs,
  scopeReplacementViolations,
  type CatalogDiff,
} from "./diff"

/**
 * Охоронець пар паперового тесту без бази: на справжньому домені він бачить
 * лише правильні пари, тож кожне порушення, яке він мусить ловити, тут
 * зібране вручну з каталогів.
 */

function fk(
  name: string,
  columns: string[],
  table: string,
  refColumns: string[]
): CatalogConstraint {
  return {
    name,
    type: "foreignKey",
    definition: `FOREIGN KEY (${columns.join(", ")}) REFERENCES <schema>.${table}(${refColumns.join(", ")})`,
    columns,
    deferrable: false,
    initiallyDeferred: false,
    references: {
      schema: "s",
      table,
      columns: refColumns,
      onDelete: "noAction",
      onUpdate: "noAction",
    },
  }
}

function check(name: string, definition: string): CatalogConstraint {
  return {
    name,
    type: "check",
    definition,
    columns: [],
    deferrable: false,
    initiallyDeferred: false,
  }
}

function index(name: string, columns: string[]): CatalogIndex {
  return {
    name,
    definition: `CREATE INDEX ${name} ON <schema>.doc USING btree (${columns.join(", ")})`,
    unique: false,
    method: "btree",
    keys: columns.map((column) => ({ column })),
    include: [],
    nullsNotDistinct: false,
  }
}

function catalog(
  doc: Pick<CatalogTable, "constraints" | "indexes"> & {
    comment?: string
  }
): CatalogShape {
  return {
    enumTypes: [],
    functions: [],
    tables: [
      {
        schema: "s",
        name: "doc",
        rowLevelSecurity: "enabled",
        ...(doc.comment === undefined ? {} : { comment: doc.comment }),
        columns: [],
        constraints: doc.constraints,
        indexes: doc.indexes,
      },
    ],
  }
}

const CARRIERS = new Map([
  ["doc", "org_id"],
  ["target", "org_id"],
])

function violations(
  accepted: CatalogShape,
  compiled: CatalogShape
): { diff: CatalogDiff; violations: string[] } {
  const diff = diffCatalogs(accepted, compiled, ["doc"])
  return {
    diff,
    violations: scopeReplacementViolations(diff, accepted, compiled, CARRIERS),
  }
}

describe("scopeReplacementViolations", () => {
  it("accepts a plain FK and index replaced by scope-prefixed ones", () => {
    const result = violations(
      catalog({
        constraints: [fk("doc_ref_fkey", ["ref"], "target", ["id"])],
        indexes: [index("doc_ref_idx", ["ref"])],
      }),
      catalog({
        constraints: [
          fk("doc_org_id_ref_fkey", ["org_id", "ref"], "target", [
            "org_id",
            "id",
          ]),
        ],
        indexes: [index("doc_org_id_ref_idx", ["org_id", "ref"])],
      })
    )
    expect(result.diff.map((entry) => entry.op).sort()).toEqual([
      "add",
      "add",
      "drop",
      "drop",
    ])
    expect(result.violations).toEqual([])
  })

  it("reports an FK drop without a scope-prefixed replacement", () => {
    const result = violations(
      catalog({
        constraints: [fk("doc_ref_fkey", ["ref"], "target", ["id"])],
        indexes: [],
      }),
      // Носій є, але ціль без носія — це не складений FK скоупу.
      catalog({
        constraints: [
          fk("doc_org_id_ref_fkey", ["org_id", "ref"], "target", ["id"]),
        ],
        indexes: [],
      })
    )
    expect(result.violations).toEqual([
      "drop constraint doc.doc_ref_fkey: 0 scope-prefixed replacements, expected 1",
    ])
  })

  it("reports a dropped CHECK", () => {
    const result = violations(
      catalog({
        constraints: [check("doc_amount_check", "CHECK ((amount > 0))")],
        indexes: [],
      }),
      catalog({ constraints: [], indexes: [] })
    )
    expect(result.violations).toEqual([
      "drop constraint doc.doc_amount_check: not a reference FK or index of a scoped table",
    ])
  })

  it("reports an alter", () => {
    const result = violations(
      catalog({ constraints: [], indexes: [] }),
      catalog({ constraints: [], indexes: [], comment: "changed" })
    )
    expect(result.violations).toEqual(["alter table doc.doc"])
  })

  it("reports one add used to replace two drops", () => {
    // Два однакові прості індекси під різними іменами — обидва знаходять ту
    // саму складену заміну, але заміна одна.
    const result = violations(
      catalog({
        constraints: [],
        indexes: [
          index("doc_ref_a_idx", ["ref"]),
          index("doc_ref_b_idx", ["ref"]),
        ],
      }),
      catalog({
        constraints: [],
        indexes: [index("doc_org_id_ref_idx", ["org_id", "ref"])],
      })
    )
    expect(result.violations).toEqual([
      "drop index doc.doc_ref_b_idx: replacement doc_org_id_ref_idx already used",
    ])
  })
})
