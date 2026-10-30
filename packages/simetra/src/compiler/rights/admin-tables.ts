import {
  KIND_REGISTRY,
  PLATFORM_SCHEMA,
  makeObjectName,
  type PhysicalColumn,
  type PhysicalIndexKey,
  type PhysicalOrigin,
  type PhysicalTable,
} from "simetra/model"
import { compareStrings } from "../diagnostics"
import type { ParsedObject } from "../stages/files"

/**
 * Стан механізму прав належить платформі, а не довіднику застосунку:
 * без FK журнал переживає видалення скоупу, без грантів API його не читає.
 * Походження детерміноване за файлом, як у решти похідних таблиць.
 */
export function rightsAdminTables(
  objects: readonly ParsedObject[]
): PhysicalTable[] {
  if (!objects.some((o) => KIND_REGISTRY[o.kind].rightsDeclaration === "role"))
    return []
  const owner = objects
    .filter(
      (o) => KIND_REGISTRY[o.kind].rightsSystem?.(o.data) === "roleAssignments"
    )
    .sort((a, b) => compareStrings(a.file, b.file))[0]
  if (owner === undefined) return []
  const column = (
    name: string,
    type: string,
    notNull = true,
    extra: Partial<PhysicalColumn> = {}
  ): PhysicalColumn => ({ name, type, notNull, origin: {}, ...extra })
  const table = (
    name: string,
    part: PhysicalOrigin["part"],
    columns: PhysicalColumn[],
    key?: string[],
    indexes: PhysicalIndexKey[][] = []
  ): PhysicalTable => ({
    schema: PLATFORM_SCHEMA,
    name,
    origin: { objectId: owner.id!, part },
    rowLevelSecurity: "off",
    columns,
    ...(key === undefined
      ? {}
      : {
          primaryKey: {
            name: makeObjectName(name, undefined, "pkey"),
            columns: key,
          },
        }),
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: indexes.map((keys) => ({
      name: makeObjectName(
        name,
        keys.map((k) => ("column" in k ? k.column : "")).join("_"),
        "idx"
      ),
      unique: false,
      method: "btree",
      keys,
      include: [],
      nullsNotDistinct: false,
    })),
  })
  const asc = (...columns: string[]): PhysicalIndexKey[] =>
    columns.map((column) => ({ column }))
  const desc = (column: string): PhysicalIndexKey => ({
    column,
    order: "desc",
  })
  return [
    table(
      "rights_versions",
      "rightsVersions",
      [
        column("scope_kind_id", "uuid"),
        column("scope", "uuid"),
        column("version", "bigint", true, { default: "0" }),
      ],
      ["scope_kind_id", "scope"]
    ),
    table(
      "rights_journal",
      "rightsJournal",
      [
        column("id", "uuid", true, { default: "gen_random_uuid()" }),
        column("seq", "bigint", true, {
          identity: {
            generation: "always",
            sequence: "rights_journal_seq_seq",
          },
        }),
        column("xid", "bigint"),
        column("at", "timestamp with time zone", true, { default: "now()" }),
        column("scope_kind_id", "uuid"),
        column("scope", "uuid"),
        column("actor", "uuid", false),
        column("reason", "text"),
        column("action", "text", false),
        column("object", "text"),
        column("relation", "text"),
        column("operation", "text"),
        column("row_id", "uuid"),
        column("parent_id", "uuid", false),
        column("before", "jsonb", false),
        column("after", "jsonb", false),
      ],
      ["id"],
      [
        // Перший образ рядка в транзакції.
        asc("xid", "relation", "row_id", "seq"),
        // Журнал скоупу новіші першими (`rights_journal_of`, Р2d2-12) — без
        // повного перебору з сортуванням.
        [...asc("scope_kind_id", "scope"), desc("at"), desc("seq")],
      ]
    ),
    table(
      "rights_tx_actor",
      "rightsTxActor",
      [
        column("xid", "bigint"),
        column("actor", "uuid", false),
        column("level", "text", false),
        column("level_id", "uuid", false),
        column("scope", "uuid", false),
        column("container", "uuid", false),
        column("object", "text", false),
        column("action", "text", false),
        column("extent", "text", false),
        column("dimension_id", "uuid", false),
        column("full_access", "boolean"),
      ],
      undefined,
      [asc("xid")]
    ),
    table(
      "rights_tx_pending",
      "rightsTxPending",
      [
        column("xid", "bigint"),
        column("kind", "text"),
        column("key", "uuid"),
        column("scope_kind_id", "uuid"),
        column("scope", "uuid", false),
        column("maintenance", "boolean"),
      ],
      ["xid", "kind", "scope_kind_id", "key"]
    ),
  ]
}
