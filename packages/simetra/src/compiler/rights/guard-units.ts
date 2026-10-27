import {
  PLATFORM_SCHEMA,
  PROVIDER_LOGIN_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  quoteIdent,
  type DatabaseProvider,
  type PhysicalSnapshot,
  type PhysicalTable,
  KIND_REGISTRY,
} from "simetra/model"
import {
  qualified,
  type Contracts,
  type QualifiedName,
  type RightsCatalogContract,
} from "../contracts"
import { compareStrings } from "../diagnostics"
import { dollarTag } from "../movement-functions"
import type { CreationNode } from "../sql/dependencies"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import { functionIdentity, generatedUnit, type SqlUnit } from "../sql/units"
import { sqlLiteral } from "../stages/model"
import type { ParsedObject } from "../stages/files"
import { COMMAND_FUNCTIONS } from "./command-units"
import { RIGHTS_FUNCTIONS, ZERO_UUID, hasRightsFunctions } from "./functions"
import { generatedTableFunctionName } from "./generated-names"
import { rightsGuardNames } from "./guard-names"

type GuardContracts = Pick<
  Contracts,
  | "roles"
  | "users"
  | "membershipSources"
  | "membership"
  | "rightsCatalogs"
  | "accessDimensions"
  | "rights"
>

type CatalogKind = "role" | "delta" | "assignment"
interface CatalogTable {
  table: PhysicalTable
  kind: CatalogKind
  catalog: RightsCatalogContract
  key: string
  scope?: string
  parent?: string
  object: string
}

const q = quoteIdent
const platform = (name: string): QualifiedName => ({
  schema: PLATFORM_SCHEMA,
  name,
})
const ref = (name: QualifiedName) => qualified(name)
const tableName = (table: PhysicalTable): QualifiedName => ({
  schema: table.schema,
  name: table.name,
})
const unitNode = (name: QualifiedName): CreationNode => ({
  type: "unit",
  identity: functionIdentity(name.schema, name.name, []),
})

/** Restricts maintenance mode to trusted database login roles. */
export function maintenanceSql(provider: DatabaseProvider): string {
  const logins = PROVIDER_LOGIN_ROLES[provider].map(sqlLiteral).join(", ")
  return `coalesce(current_setting(${sqlLiteral(RIGHTS_MAINTENANCE_SETTING)}, true) = 'on', false) AND session_user::text <> ALL (ARRAY[${logins}]::text[])`
}

function column(table: PhysicalTable, standard: string): string {
  const found = table.columns.find(
    (entry) => entry.origin.standard === standard
  )
  if (found === undefined)
    throw new Error(
      `internal: ${table.schema}.${table.name} has no ${standard} column`
    )
  return found.name
}

function scopeColumn(table: PhysicalTable): string | undefined {
  return table.columns.find((entry) => entry.origin.scopeKindId !== undefined)
    ?.name
}

function tableOf(
  physical: PhysicalSnapshot,
  name: QualifiedName
): PhysicalTable {
  const found = physical.tables.find(
    (table) => table.schema === name.schema && table.name === name.name
  )
  if (found === undefined)
    throw new Error(`internal: missing rights table ${ref(name)}`)
  return found
}

function catalogTables(
  contracts: GuardContracts,
  physical: PhysicalSnapshot
): CatalogTable[] {
  const labels = new Map(
    contracts.rights.map((right) => [right.objectId, right.kindLabel])
  )
  return contracts.rightsCatalogs.flatMap((catalog) => {
    const role = tableOf(physical, catalog.roles.table)
    const delta = tableOf(physical, catalog.roles.delta)
    const assignment = tableOf(physical, catalog.assignments.table)
    return [
      {
        table: role,
        kind: "role",
        catalog,
        key: column(role, "ref"),
        scope: scopeColumn(role),
        object: labels.get(catalog.roles.objectId) ?? role.name,
      },
      {
        table: delta,
        kind: "delta",
        catalog,
        key: column(delta, "ref"),
        scope: scopeColumn(delta),
        parent: column(delta, "parent"),
        object: labels.get(catalog.roles.objectId) ?? role.name,
      },
      {
        table: assignment,
        kind: "assignment",
        catalog,
        key: column(assignment, "ref"),
        scope: scopeColumn(assignment),
        object: labels.get(catalog.assignments.objectId) ?? assignment.name,
      },
    ]
  })
}

const labels = {
  rights: "simetra_rights",
  snapshot: "simetra_rights_snapshot",
  truncate: "simetra_rights_truncate",
  id: "simetra_rights_id",
  check: "rights_tx_check",
} as const

function functionName(table: QualifiedName, label: string): QualifiedName {
  const found = rightsGuardNames(table).find(
    (entry) =>
      entry.function.name === generatedTableFunctionName(table.name, label)
  )
  if (found === undefined)
    throw new Error(`internal: unknown rights guard ${label}`)
  return found.function
}

function triggerName(table: QualifiedName, label: string): string {
  const name = generatedTableFunctionName(table.name, label)
  const found = rightsGuardNames(table).find((entry) => entry.trigger === name)
  if (found === undefined)
    throw new Error(`internal: unknown rights trigger ${label}`)
  return found.trigger
}

function definer(fn: QualifiedName, returns: string, body: string): string {
  const tag = dollarTag(body)
  return `CREATE OR REPLACE FUNCTION ${ref(fn)}() RETURNS ${returns} LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' SET row_security = off AS ${tag}\n${body}\n${tag};`
}

function refusal(detail: string, table?: PhysicalTable): string {
  return `RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'command.forbidden', DETAIL = ${sqlLiteral(detail)}${table === undefined ? "" : `, TABLE = ${sqlLiteral(table.name)}`};`
}

/**
 * Ім'я відношення в журналі: його пише тригер і за ним читає перший образ
 * перевірка; один форматер, бо два розійшлися б і образ «до» загубився б.
 */
function journalRelation(table: PhysicalTable): string {
  return `${table.schema}.${table.name}`
}

function scopeSql(config: CatalogTable, alias: string): [string, string] {
  return [
    sqlLiteral(
      config.catalog.level.level === "scope"
        ? config.catalog.level.scopeKindId
        : ZERO_UUID
    ) + "::uuid",
    config.scope === undefined
      ? `${sqlLiteral(ZERO_UUID)}::uuid`
      : `${alias}.${q(config.scope)}`,
  ]
}

function transitionSql(
  config: CatalogTable,
  operation: "INSERT" | "UPDATE" | "DELETE"
): string {
  const old = operation !== "INSERT"
  const next = operation !== "DELETE"
  const source =
    operation === "INSERT"
      ? "new_rows n"
      : operation === "DELETE"
        ? "old_rows o"
        : `old_rows o FULL JOIN new_rows n ON n.${q(config.key)} = o.${q(config.key)}`
  const key =
    next && old
      ? `coalesce(n.${q(config.key)}, o.${q(config.key)})`
      : `${next ? "n" : "o"}.${q(config.key)}`
  const [scopeKind, oldScope] = scopeSql(config, "o")
  const [, newScope] = scopeSql(config, "n")
  const scope =
    next && old
      ? `coalesce(${newScope}, ${oldScope})`
      : next
        ? newScope
        : oldScope
  const parent =
    config.parent === undefined
      ? "NULL::uuid"
      : next && old
        ? `coalesce(n.${q(config.parent)}, o.${q(config.parent)})`
        : `${next ? "n" : "o"}.${q(config.parent)}`
  const before = old ? "to_jsonb(o)" : "NULL::jsonb"
  const after = next ? "to_jsonb(n)" : "NULL::jsonb"
  const rows = `SELECT ${scopeKind} AS scope_kind_id, ${scope} AS scope, ${key} AS row_id, ${parent} AS parent_id, ${before} AS before, ${after} AS after FROM ${source}`
  const versionRows =
    operation === "UPDATE"
      ? `SELECT ${scopeKind} AS scope_kind_id, ${oldScope} AS scope FROM old_rows o UNION SELECT ${scopeKind}, ${newScope} FROM new_rows n`
      : `SELECT ${scopeKind} AS scope_kind_id, ${scope} AS scope FROM ${source}`
  const relation = journalRelation(config.table)
  return [
    `PERFORM ${ref(RIGHTS_FUNCTIONS.bump)}(s.scope_kind_id, s.scope) FROM (SELECT DISTINCT r.scope_kind_id, r.scope FROM (${versionRows}) r) s;`,
    `INSERT INTO ${ref(platform("rights_journal"))} (xid, scope_kind_id, scope, actor, reason, action, object, relation, operation, row_id, parent_id, before, after)`,
    `SELECT txid_current(), r.scope_kind_id, r.scope, CASE WHEN v_maintenance THEN NULL ELSE ${ref(platform("current_user_id"))}() END, CASE WHEN v_maintenance THEN 'maintenance' ELSE 'command' END, v_action, ${sqlLiteral(config.object)}, ${sqlLiteral(relation)}, ${sqlLiteral(operation)}, r.row_id, r.parent_id, r.before, r.after FROM (${rows}) r;`,
  ].join("\n")
}

function catalogBody(config: CatalogTable, provider: DatabaseProvider): string {
  const branches = (["INSERT", "UPDATE", "DELETE"] as const).map(
    (operation, index) =>
      `${index === 0 ? "IF" : "ELSIF"} TG_OP = '${operation}' THEN\n${transitionSql(
        config,
        operation
      )
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}`
  )
  return [
    "DECLARE",
    "  v_action text;",
    "  v_maintenance boolean;",
    "BEGIN",
    `  v_maintenance := (${maintenanceSql(provider)});`,
    `  SELECT c.action INTO v_action FROM ${ref(COMMAND_FUNCTIONS.current)}() c;`,
    `  IF v_action IS NULL AND NOT v_maintenance THEN ${refusal("rights-context", config.table)} END IF;`,
    `  ${branches.join("\n  ")}\n  END IF;`,
    "  RETURN NULL;",
    "END",
  ].join("\n")
}

function truncateBody(table: PhysicalTable): string {
  return `BEGIN\n  ${refusal("rights-context", table)}\n  RETURN NULL;\nEND`
}

function eventRows(
  operation: "INSERT" | "UPDATE" | "DELETE",
  alias: string,
  source: "old" | "new"
): string[] {
  if (source === "old" && operation === "INSERT") return []
  if (source === "new" && operation === "DELETE") return []
  return [`SELECT ${alias}.* FROM ${source}_rows ${alias}`]
}

function bumpRows(
  operation: "INSERT" | "UPDATE" | "DELETE",
  scopeKindId: string,
  scope?: string
): string {
  const rows = [
    ...eventRows(operation, "r", "old"),
    ...eventRows(operation, "r", "new"),
  ].join(" UNION ALL ")
  const value =
    scope === undefined ? `${sqlLiteral(ZERO_UUID)}::uuid` : `r.${q(scope)}`
  return `PERFORM ${ref(RIGHTS_FUNCTIONS.bump)}(${sqlLiteral(scopeKindId)}::uuid, s.scope) FROM (SELECT DISTINCT ${value} AS scope FROM (${rows}) r) s;`
}

function memberEventBody(
  member: Contracts["membership"][number],
  operation: "INSERT" | "UPDATE" | "DELETE"
): string {
  return [
    "BEGIN",
    `  ${bumpRows(operation, member.scopeKindId, member.scopeColumn)}`,
    "  RETURN NULL; END",
  ].join("\n")
}

/** Builds platform guards for rights tables and their access dependencies. */
export function buildRightsGuardUnits(
  contracts: GuardContracts,
  physical: PhysicalSnapshot,
  objects: readonly Pick<ParsedObject, "id" | "kind">[],
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  if (
    contracts.rightsCatalogs.length === 0 ||
    !hasRightsFunctions(contracts, provider)
  )
    return []
  const units: SqlUnit[] = []
  const add = (
    sql: string,
    ownerObjectId?: string,
    requires?: readonly CreationNode[]
  ) => {
    units.push({
      ...generatedUnit(sql, PLATFORM_SCHEMA, parse),
      module,
      generator: "rightsGuards",
      ...(ownerObjectId === undefined ? {} : { ownerObjectId }),
      ...(requires === undefined ? {} : { requires }),
    })
  }
  const addFunction = (
    name: QualifiedName,
    body: string,
    ownerObjectId?: string,
    requires?: readonly CreationNode[]
  ) => {
    add(definer(name, "trigger", body), ownerObjectId, requires)
    for (const sql of executeGrants(`${ref(name)}()`, [], provider))
      add(sql, ownerObjectId)
  }
  const addTruncate = (table: PhysicalTable) => {
    const name = tableName(table)
    const fn = functionName(name, labels.truncate)
    addFunction(fn, truncateBody(table), table.origin.objectId)
    add(
      `CREATE TRIGGER ${q(triggerName(name, labels.truncate))} BEFORE TRUNCATE ON ${ref(name)} FOR EACH STATEMENT EXECUTE FUNCTION ${ref(fn)}();`,
      table.origin.objectId
    )
  }
  for (const config of catalogTables(contracts, physical)) {
    const table = tableName(config.table)
    const owner = config.table.origin.objectId
    const fn = functionName(table, labels.rights)
    addFunction(fn, catalogBody(config, provider), owner, [
      unitNode(COMMAND_FUNCTIONS.current),
      {
        type: "unit",
        identity: `function:${ref(RIGHTS_FUNCTIONS.bump)}(uuid,uuid)`,
      },
      { type: "table", schema: PLATFORM_SCHEMA, name: "rights_journal" },
    ])
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const transition =
        operation === "INSERT"
          ? "REFERENCING NEW TABLE AS new_rows"
          : operation === "DELETE"
            ? "REFERENCING OLD TABLE AS old_rows"
            : "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows"
      add(
        `CREATE TRIGGER ${q(triggerName(table, `${labels.rights}_${operation.toLowerCase()}`))} AFTER ${operation} ON ${ref(table)} ${transition} FOR EACH STATEMENT EXECUTE FUNCTION ${ref(fn)}();`,
        owner
      )
    }
    addTruncate(config.table)
  }
  for (const member of contracts.membership.filter((value) =>
    contracts.rightsCatalogs.some(
      (catalog) =>
        catalog.level.level === "scope" &&
        catalog.level.scopeKindId === value.scopeKindId
    )
  )) {
    const table = tableOf(physical, member.table)
    const name = tableName(table)
    const owner = table.origin.objectId
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const label = `simetra_rights_members_${operation.toLowerCase()}`
      const fn = functionName(name, label)
      const transition =
        operation === "INSERT"
          ? "REFERENCING NEW TABLE AS new_rows"
          : operation === "DELETE"
            ? "REFERENCING OLD TABLE AS old_rows"
            : "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows"
      addFunction(fn, memberEventBody(member, operation), owner, [
        {
          type: "unit",
          identity: `function:${ref(RIGHTS_FUNCTIONS.bump)}(uuid,uuid)`,
        },
      ])
      add(
        `CREATE TRIGGER ${q(triggerName(name, label))} AFTER ${operation} ON ${ref(name)} ${transition} FOR EACH STATEMENT EXECUTE FUNCTION ${ref(fn)}();`,
        owner
      )
    }
    addTruncate(table)
  }
  if (contracts.users !== undefined)
    addTruncate(tableOf(physical, contracts.users.table))
  const relations = new Set<string>()
  for (const dimension of contracts.accessDimensions) {
    if (!("relation" in dimension.values)) continue
    const relation = dimension.values.relation
    const key = `${relation.table.schema}.${relation.table.name}`
    if (relations.has(key)) continue
    relations.add(key)
    const table = physical.tables.find(
      (candidate) =>
        candidate.schema === relation.table.schema &&
        candidate.name === relation.table.name &&
        candidate.origin.objectId === relation.objectId &&
        candidate.origin.part === undefined
    )
    if (
      table === undefined ||
      !objects.some(
        (object) =>
          object.id === relation.objectId &&
          !KIND_REGISTRY[object.kind].declared
      )
    )
      continue
    const scope = table.columns.find(
      (entry) => entry.origin.scopeKindId !== undefined
    )
    const kind = scope?.origin.scopeKindId ?? ZERO_UUID
    const name = tableName(table)
    const fn = functionName(name, "simetra_rights_relation")
    const body = [
      "BEGIN",
      ...(["INSERT", "UPDATE", "DELETE"] as const).map(
        (operation, index) =>
          `  ${index === 0 ? "IF" : "ELSIF"} TG_OP = '${operation}' THEN\n    ${bumpRows(operation, kind, scope?.name)}`
      ),
      "  END IF;",
      "  RETURN NULL; END",
    ].join("\n")
    addFunction(fn, body, table.origin.objectId, [
      {
        type: "unit",
        identity: `function:${ref(RIGHTS_FUNCTIONS.bump)}(uuid,uuid)`,
      },
    ])
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const label = `simetra_rights_relation_${operation.toLowerCase()}`
      const transition =
        operation === "INSERT"
          ? "REFERENCING NEW TABLE AS new_rows"
          : operation === "DELETE"
            ? "REFERENCING OLD TABLE AS old_rows"
            : "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows"
      add(
        `CREATE TRIGGER ${q(triggerName(name, label))} AFTER ${operation} ON ${ref(name)} ${transition} FOR EACH STATEMENT EXECUTE FUNCTION ${ref(fn)}();`,
        table.origin.objectId
      )
    }
    addTruncate(table)
  }
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}
