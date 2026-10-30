import {
  RIGHTS_COLUMNS,
  deletionMarkColumn,
  quoteIdent,
  type AttributeCase,
  type PhysicalSnapshot,
  type PhysicalTable,
  type StandardColumnDef,
} from "simetra/model"
import {
  qualified,
  type Contracts,
  type QualifiedName,
  type RightsLevelKey,
} from "../contracts"
import { sqlLiteral } from "../stages/model"
import { standardColumn } from "../standard-column"
import { ZERO_UUID, sourceConditions } from "./functions"

type HolderContracts = Pick<
  Contracts,
  "membership" | "membershipSources" | "users"
>

function tableOf(
  physical: Pick<PhysicalSnapshot, "tables">,
  name: QualifiedName
): PhysicalTable {
  const found = physical.tables.find(
    (table) => table.schema === name.schema && table.name === name.name
  )
  if (found === undefined)
    throw new Error(`internal: missing rights table ${qualified(name)}`)
  return found
}

/** Return direct, active holder candidates so callers can apply their own full-access role set. */
export function effectiveHolderRows(
  catalog: { level: RightsLevelKey; assignments: { table: QualifiedName } },
  contracts: HolderContracts,
  physical: Pick<PhysicalSnapshot, "tables">,
  attributeCase: AttributeCase
): string {
  const table = tableOf(physical, catalog.assignments.table)
  const q = quoteIdent
  // Колонки — за визначенням реєстру в стилі проєкту (Рб1-1).
  const a = (def: StandardColumnDef) =>
    `a.${q(standardColumn(table, def, attributeCase).name)}`
  const R = RIGHTS_COLUMNS
  const scope = table.columns.find(
    (column) => column.origin.scopeKindId !== undefined
  )?.name
  const member = contracts.membership.find(
    (value) =>
      catalog.level.level === "scope" &&
      value.scopeKindId === catalog.level.scopeKindId
  )
  const source = contracts.membershipSources.find(
    (value) =>
      catalog.level.level === "scope" &&
      value.scopeKindId === catalog.level.scopeKindId
  )
  if (
    catalog.level.level === "scope" &&
    member === undefined &&
    source === undefined
  ) {
    return "SELECT NULL::uuid AS scope, NULL::uuid AS actor, NULL::uuid AS archetype WHERE false"
  }
  const actor =
    member !== undefined
      ? `m.${q(member.userColumn)}`
      : source !== undefined
        ? `m.${q(source.user)}`
        : a(R.subject)
  const join =
    member !== undefined
      ? `JOIN ${qualified(member.table)} m ON m.${q(member.keyColumn)} = ${a(R.subject)} AND m.${q(member.scopeColumn)} = a.${q(scope!)}`
      : source !== undefined
        ? `JOIN ${qualified(source.table)} m ON m.${q(source.member)} = ${a(R.subject)} AND m.${q(source.scope)} = a.${q(scope!)}${source.active === undefined ? "" : ` AND m.${q(source.active)} IS TRUE`}${sourceConditions(
            "m",
            source.where
          )
            .map((condition) => ` AND ${condition}`)
            .join("")}`
        : ""
  const valid =
    contracts.users === undefined
      ? ""
      : `JOIN ${qualified(contracts.users.table)} u ON u.${q(contracts.users.keyColumn)} = ${actor} AND NOT u.${q(contracts.users.invalidColumn)}`
  return [
    `SELECT ${scope === undefined ? `${sqlLiteral(ZERO_UUID)}::uuid` : `a.${q(scope)}`} AS scope, ${actor} AS actor, ${a(R.archetype)} AS archetype FROM ${qualified(catalog.assignments.table)} a`,
    join,
    valid,
    `WHERE ${a(R.customRole)} IS NULL AND NOT ${a(deletionMarkColumn())} AND ${actor} IS NOT NULL`,
  ]
    .filter(Boolean)
    .join("\n")
}
