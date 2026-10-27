import {
  quoteIdent,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import {
  qualified,
  type Contracts,
  type QualifiedName,
  type RightsLevelKey,
} from "../contracts"
import { sqlLiteral } from "../stages/model"
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

function standard(table: PhysicalTable, name: string): string {
  const found = table.columns.find((column) => column.origin.standard === name)
  if (found === undefined)
    throw new Error(
      `internal: ${table.schema}.${table.name} has no ${name} column`
    )
  return found.name
}

/** Return direct, active holder candidates so callers can apply their own full-access role set. */
export function effectiveHolderRows(
  catalog: { level: RightsLevelKey; assignments: { table: QualifiedName } },
  contracts: HolderContracts,
  physical: Pick<PhysicalSnapshot, "tables">
): string {
  const table = tableOf(physical, catalog.assignments.table)
  const q = quoteIdent
  const a = (name: string) => `a.${q(standard(table, name))}`
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
        : a("subject")
  const join =
    member !== undefined
      ? `JOIN ${qualified(member.table)} m ON m.${q(member.keyColumn)} = ${a("subject")} AND m.${q(member.scopeColumn)} = a.${q(scope!)}`
      : source !== undefined
        ? `JOIN ${qualified(source.table)} m ON m.${q(source.member)} = ${a("subject")} AND m.${q(source.scope)} = a.${q(scope!)}${source.active === undefined ? "" : ` AND m.${q(source.active)} IS TRUE`}${sourceConditions(
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
    `SELECT ${scope === undefined ? `${sqlLiteral(ZERO_UUID)}::uuid` : `a.${q(scope)}`} AS scope, ${actor} AS actor, ${a("archetype")} AS archetype FROM ${qualified(catalog.assignments.table)} a`,
    join,
    valid,
    `WHERE ${a("customRole")} IS NULL AND NOT ${a("deletionMark")} AND ${actor} IS NOT NULL`,
  ]
    .filter(Boolean)
    .join("\n")
}
