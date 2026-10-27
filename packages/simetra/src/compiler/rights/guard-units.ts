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
import { fieldForeignKey, sqlLiteral } from "../stages/model"
import type { ParsedObject } from "../stages/files"
import { COMMAND_FUNCTIONS } from "./command-units"
import { RIGHTS_FUNCTIONS, ZERO_UUID, hasRightsFunctions } from "./functions"
import { generatedTableFunctionName } from "./generated-names"
import { rightsGuardNames } from "./guard-names"
import { effectiveHolderRows } from "./holders"

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
    pendingSql(config, operation),
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

/**
 * Знімок прав актора — до першої зміни командою в транзакції: перевірка
 * порівнює приріст саме з ним, інакше актор, що призначив собі роль чи додав
 * `allow` до своєї ролі, покрив би приріст власними новими правами.
 */
function snapshotBody(
  provider: DatabaseProvider,
  contracts: GuardContracts,
  physical: PhysicalSnapshot
): string {
  const actor = ref(platform("rights_tx_actor"))
  const currentUser = `${ref(platform("current_user_id"))}()`
  return [
    "DECLARE",
    "  v_action text;",
    "  v_actor uuid;",
    "BEGIN",
    `  SELECT c.action INTO v_action FROM ${ref(COMMAND_FUNCTIONS.current)}() c;`,
    `  IF v_action IS NULL OR (${maintenanceSql(provider)}) THEN RETURN NULL; END IF;`,
    `  v_actor := ${currentUser};`,
    `  IF EXISTS (SELECT 1 FROM ${actor} WHERE xid = txid_current()) THEN`,
    `    IF EXISTS (SELECT 1 FROM ${actor} WHERE xid = txid_current() AND actor IS DISTINCT FROM v_actor) THEN ${refusal("rights-context")} END IF;`,
    "    RETURN NULL;",
    "  END IF;",
    `  INSERT INTO ${actor} (xid, actor, full_access) VALUES (txid_current(), v_actor, false);`,
    `  INSERT INTO ${actor} (xid, actor, level, level_id, scope, container, object, action, extent, dimension_id, full_access)`,
    `  SELECT txid_current(), v_actor, r.level, r.level_id, r.scope, r.container, r.object, r.action, r.extent, r.dimension_id, false FROM ${ref(RIGHTS_FUNCTIONS.mine)}() r;`,
    ...contracts.rightsCatalogs.map((catalog) =>
      [
        `  INSERT INTO ${actor} (xid, actor, level, level_id, scope, full_access)`,
        `  SELECT txid_current(), v_actor, ${sqlLiteral(catalog.level.level)}, ${catalog.level.level === "scope" ? `${sqlLiteral(catalog.level.scopeKindId)}::uuid` : "NULL::uuid"}, h.scope, true`,
        `  FROM (${holderRows(catalog, contracts, physical)}) h WHERE h.actor = v_actor;`,
      ].join("\n")
    ),
    "  RETURN NULL;",
    "END",
  ].join("\n")
}

/**
 * Ключі одного оператора — одним `INSERT`: `ON CONFLICT` не зачіпає рядок
 * двічі (21000), а старий і новий образи рядка, перенесеного в інший скоуп,
 * дають той самий ключ. Тому ключі спершу зводяться за первинним ключем, і
 * скоуп береться з нового образу (`image = 0`), коли він є: перевірка читає
 * живий рядок. Ключ `holders` — сам скоуп, тож старий і новий скоупи
 * лишаються різними ключами й перевіряються обидва.
 */
function pendingInsert(rows: readonly string[], maintenance: string): string {
  return [
    `INSERT INTO ${ref(platform("rights_tx_pending"))} (xid, kind, key, scope_kind_id, scope, maintenance)`,
    `SELECT DISTINCT ON (k.kind, k.scope_kind_id, k.key) txid_current(), k.kind, k.key, k.scope_kind_id, k.scope, ${maintenance} FROM (${rows.join("\nUNION ALL\n")}) k`,
    "ORDER BY k.kind, k.scope_kind_id, k.key, k.image",
    "ON CONFLICT (xid, kind, scope_kind_id, key) DO UPDATE SET maintenance = rights_tx_pending.maintenance AND excluded.maintenance;",
  ].join("\n")
}

/** Ключ `actor`: перевірка на COMMIT прибирає знімок і в транзакції без інших ключів. */
function actorPending(): string {
  return `SELECT 'actor'::text AS kind, ${sqlLiteral(ZERO_UUID)}::uuid AS key, ${sqlLiteral(ZERO_UUID)}::uuid AS scope_kind_id, NULL::uuid AS scope, 0 AS image WHERE EXISTS (SELECT 1 FROM ${ref(platform("rights_tx_actor"))} WHERE xid = txid_current())`
}

function pendingSql(
  config: CatalogTable,
  operation: "INSERT" | "UPDATE" | "DELETE"
): string {
  const before = operation !== "INSERT"
  const after = operation !== "DELETE"
  const [kind] = scopeSql(config, "r")
  const events = [
    ...(before ? [`SELECT o.*, 1 AS image FROM old_rows o`] : []),
    ...(after ? [`SELECT n.*, 0 AS image FROM new_rows n`] : []),
  ].join(" UNION ALL ")
  const scope =
    config.scope === undefined
      ? `${sqlLiteral(ZERO_UUID)}::uuid`
      : `r.${q(config.scope)}`
  const roleKey =
    config.kind === "delta" ? `r.${q(config.parent!)}` : `r.${q(config.key)}`
  const kindKey = config.kind === "assignment" ? "assignment" : "role"
  const rows = [
    `SELECT ${sqlLiteral(kindKey)}::text AS kind, ${config.kind === "assignment" ? `r.${q(config.key)}` : roleKey} AS key, ${kind} AS scope_kind_id, ${scope} AS scope, r.image FROM (${events}) r`,
    ...(config.kind === "assignment"
      ? [
          `SELECT 'role'::text, r.${q(column(config.table, "customRole"))}, ${kind}, ${scope}, r.image FROM (${events}) r WHERE r.${q(column(config.table, "customRole"))} IS NOT NULL`,
        ]
      : []),
    // Ключ `holders` — від будь-якої зміни старого прямого рядка архетипу з
    // `fullAccess`, а не лише полів форми носія: надмножина не пропускає
    // випадків (Р2c2-22). Новий образ носія не прибирає — він не потрібен.
    ...(config.kind === "assignment" && before
      ? [
          `SELECT 'holders'::text, ${scope}, ${kind}, ${scope}, 1 FROM old_rows r WHERE r.${q(column(config.table, "customRole"))} IS NULL AND EXISTS (SELECT 1 FROM ${ref(RIGHTS_FUNCTIONS.fullAccessRoles)}() f WHERE f.role_id = r.${q(column(config.table, "archetype"))} AND f.storage_id IS NOT DISTINCT FROM ${config.catalog.level.level === "scope" ? kind : "NULL::uuid"})`,
        ]
      : []),
    actorPending(),
  ]
  return pendingInsert(rows, "v_maintenance")
}

/** Перший образ командної частини транзакції, а для незміненого рядка — живий стан. */
function stateRows(table: PhysicalTable, state: "before" | "after"): string {
  const name = ref(tableName(table))
  if (state === "after") return `SELECT to_jsonb(l) AS doc FROM ${name} l`
  const key = column(table, "ref")
  const relation = journalRelation(table)
  return [
    `SELECT CASE WHEN j.row_id IS NOT NULL THEN j.before ELSE to_jsonb(l) END AS doc FROM ${name} l`,
    `FULL JOIN (SELECT DISTINCT ON (row_id) row_id, before FROM ${ref(platform("rights_journal"))}`,
    `  WHERE xid = v_pending.xid AND reason = 'command' AND relation = ${sqlLiteral(relation)} ORDER BY row_id, seq) j`,
    `  ON j.row_id = l.${q(key)}`,
  ].join("\n")
}

function scopedDoc(table: PhysicalTable, alias: string): string {
  const scope = scopeColumn(table)
  return scope === undefined
    ? "TRUE"
    : `(${alias}.doc ->> ${sqlLiteral(scope)})::uuid = v_pending.scope`
}

function deltaArray(
  catalog: RightsCatalogContract,
  physical: PhysicalSnapshot,
  state: "before" | "after",
  roleId: string
): string {
  const table = tableOf(physical, catalog.roles.delta)
  const field = (name: string) => `d.doc ->> ${sqlLiteral(column(table, name))}`
  return [
    `SELECT coalesce(jsonb_agg(jsonb_build_object('object', ${field("object")}, 'action', ${field("action")}, 'extent', ${field("extent")}, 'dimension', ${field("dimension")}, 'effect', ${field("effect")})), '[]'::jsonb)`,
    `FROM (${stateRows(table, state)}) d WHERE d.doc IS NOT NULL AND (${field("parent")})::uuid = ${roleId} AND ${scopedDoc(table, "d")}`,
  ].join("\n")
}

function roleGrantSet(
  catalog: RightsCatalogContract,
  physical: PhysicalSnapshot,
  state: "before" | "after"
): string {
  const table = tableOf(physical, catalog.roles.table)
  const archetype = `r.doc ->> ${sqlLiteral(column(table, "archetype"))}`
  const id = `(r.doc ->> ${sqlLiteral(column(table, "ref"))})::uuid`
  return [
    `SELECT g.object, g.action, g.extent, g.dimension_id, m.level, m.level_id, ${catalog.level.level === "scope" ? "v_pending.scope" : "NULL::uuid"} AS scope, NULL::uuid AS container FROM (${stateRows(table, state)}) r`,
    `JOIN ${ref(RIGHTS_FUNCTIONS.roles)}() m ON m.role_id = (${archetype})::uuid`,
    `CROSS JOIN LATERAL ${ref(RIGHTS_FUNCTIONS.roleGrants)}(m.level, m.level_id, m.role_id, (${deltaArray(catalog, physical, state, id)})) g`,
    `WHERE r.doc IS NOT NULL AND ${id} = v_pending.key AND ${scopedDoc(table, "r")}`,
    `  AND NOT (r.doc ->> ${sqlLiteral(column(table, "deletionMark"))})::boolean`,
  ].join("\n")
}

function assignmentGrantSet(
  catalog: RightsCatalogContract,
  physical: PhysicalSnapshot,
  state: "before" | "after"
): string {
  const table = tableOf(physical, catalog.assignments.table)
  const roles = tableOf(physical, catalog.roles.table)
  const refColumn = sqlLiteral(column(table, "ref"))
  const custom = `(a.doc ->> ${sqlLiteral(column(table, "customRole"))})::uuid`
  const direct = `(a.doc ->> ${sqlLiteral(column(table, "archetype"))})::uuid`
  const archetype = `coalesce((r.doc ->> ${sqlLiteral(column(roles, "archetype"))})::uuid, ${direct})`
  const delta = `CASE WHEN ${custom} IS NULL THEN '[]'::jsonb ELSE (${deltaArray(catalog, physical, state, custom)}) END`
  return [
    `SELECT g.object, g.action, g.extent, g.dimension_id, m.level, m.level_id, ${catalog.level.level === "scope" ? `(${`a.doc ->> ${sqlLiteral(scopeColumn(table)!)}`})::uuid` : "NULL::uuid"} AS scope, (a.doc ->> ${sqlLiteral(column(table, "container"))})::uuid AS container FROM (${stateRows(table, state)}) a`,
    `LEFT JOIN (${stateRows(roles, state)}) r ON ${custom} IS NOT NULL AND (r.doc ->> ${sqlLiteral(column(roles, "ref"))})::uuid = ${custom} AND ${scopedDoc(roles, "r")}`,
    `JOIN ${ref(RIGHTS_FUNCTIONS.roles)}() m ON m.role_id = ${archetype}`,
    `CROSS JOIN LATERAL ${ref(RIGHTS_FUNCTIONS.roleGrants)}(m.level, m.level_id, m.role_id, ${delta}) g`,
    `WHERE a.doc IS NOT NULL AND (a.doc ->> ${refColumn})::uuid = v_pending.key AND ${scopedDoc(table, "a")}`,
    `  AND NOT (a.doc ->> ${sqlLiteral(column(table, "deletionMark"))})::boolean`,
    `  AND (${custom} IS NULL OR (r.doc IS NOT NULL AND NOT (r.doc ->> ${sqlLiteral(column(roles, "deletionMark"))})::boolean))`,
  ].join("\n")
}

function holderRows(
  catalog: RightsCatalogContract,
  contracts: GuardContracts,
  physical: PhysicalSnapshot
): string {
  return `SELECT h.scope, h.actor FROM (${effectiveHolderRows(catalog, contracts, physical)}) h JOIN ${ref(RIGHTS_FUNCTIONS.fullAccessRoles)}() f ON f.role_id = h.archetype AND f.storage_id IS NOT DISTINCT FROM ${catalog.level.level === "scope" ? `${sqlLiteral(catalog.level.scopeKindId)}::uuid` : "NULL::uuid"}`
}

/**
 * Існування кореня скоупу для ключа `holders`. Перевірка на COMMIT, а не на
 * операторі: скоуп, видалений цією ж транзакцією (призначення знято раніше
 * за корінь, `onRootDelete: "restrict"`), носія вже не потребує. Замок —
 * рядок версії скоупу, узятий першим кроком оператора, а не корінь: він
 * однаковий і для глобального рівня й не блокує FK-вставки тенанта (Р2c2-7).
 * Без FK скоупу на корінь винятку немає — перевірка безумовна.
 */
function rootExists(
  catalog: RightsCatalogContract,
  physical: PhysicalSnapshot
): string | undefined {
  if (catalog.level.level !== "scope") return undefined
  const table = tableOf(physical, catalog.assignments.table)
  const scope = scopeColumn(table)
  if (scope === undefined) return undefined
  const fk = fieldForeignKey(table, scope)
  if (fk === undefined) return undefined
  const index = fk.columns.indexOf(scope)
  return `EXISTS (SELECT 1 FROM ${ref({ schema: fk.references.schema, name: fk.references.table })} root WHERE root.${q(fk.references.columns[index]!)} = v_pending.scope)`
}

function assignmentBeforeSet(
  catalog: RightsCatalogContract,
  physical: PhysicalSnapshot
): string {
  const table = tableOf(physical, catalog.assignments.table)
  const id = sqlLiteral(column(table, "ref"))
  const same = ["subject", "container"].map((name) => {
    const field = sqlLiteral(column(table, name))
    return `(b.doc ->> ${field}) IS NOT DISTINCT FROM (a.doc ->> ${field})`
  })
  const scope = scopeColumn(table)
  if (scope !== undefined)
    same.push(
      `(b.doc ->> ${sqlLiteral(scope)}) IS NOT DISTINCT FROM (a.doc ->> ${sqlLiteral(scope)})`
    )
  return [
    `SELECT g.* FROM (${assignmentGrantSet(catalog, physical, "before")}) g`,
    `WHERE EXISTS (SELECT 1 FROM (${stateRows(table, "before")}) b JOIN (${stateRows(table, "after")}) a`,
    `  ON (b.doc ->> ${id}) = (a.doc ->> ${id}) WHERE (a.doc ->> ${id})::uuid = v_pending.key AND ${same.join(" AND ")})`,
  ].join("\n")
}

function escalationSql(
  after: string,
  before: string,
  catalog: RightsCatalogContract
): string {
  const actor = ref(platform("rights_tx_actor"))
  const storageKind =
    catalog.level.level === "scope"
      ? `${sqlLiteral(catalog.level.scopeKindId)}::uuid`
      : "NULL::uuid"
  return [
    "IF NOT v_pending.maintenance AND EXISTS (",
    `  SELECT 1 FROM ((${after}) EXCEPT (${before})) g`,
    `  WHERE NOT EXISTS (SELECT 1 FROM ${actor} s WHERE s.xid = v_pending.xid`,
    "    AND (",
    "      (g.level = 'global' AND s.level = 'global') OR",
    "      (g.level = 'scope' AND s.level = 'scope' AND s.level_id = g.level_id AND s.scope = g.scope) OR",
    `      (g.level = 'container' AND ((s.level = 'scope' AND s.level_id = ${storageKind} AND s.scope = g.scope) OR (s.level = 'container' AND s.level_id = g.level_id AND s.container = g.container)))`,
    "    )",
    "    AND (s.full_access OR (s.object = g.object AND s.action = g.action AND (s.extent = 'any' OR (s.extent = g.extent AND s.dimension_id IS NOT DISTINCT FROM g.dimension_id))))))",
    `THEN ${refusal("escalation")} END IF;`,
  ].join("\n")
}

function catalogCheck(
  catalog: RightsCatalogContract,
  contracts: GuardContracts,
  physical: PhysicalSnapshot
): string {
  const roles = tableOf(physical, catalog.roles.table)
  const assignments = tableOf(physical, catalog.assignments.table)
  const scope =
    catalog.level.level === "scope"
      ? `${sqlLiteral(catalog.level.scopeKindId)}::uuid`
      : `${sqlLiteral(ZERO_UUID)}::uuid`
  const roleId = `r.${q(column(roles, "ref"))}`
  const assignmentScope = scopeColumn(assignments)
  const roleScope = scopeColumn(roles)
  const sameRole =
    roleScope === undefined ? "TRUE" : `r.${q(roleScope)} = v_pending.scope`
  const sameAssignment =
    assignmentScope === undefined
      ? "TRUE"
      : `a.${q(assignmentScope)} = v_pending.scope`
  const root = rootExists(catalog, physical)
  return [
    `IF v_pending.scope_kind_id = ${scope} THEN`,
    "  IF v_pending.kind = 'role' THEN",
    `    IF EXISTS (SELECT 1 FROM ${ref(catalog.roles.table)} r WHERE ${roleId} = v_pending.key AND ${sameRole} AND r.${q(column(roles, "deletionMark"))})`,
    `       AND EXISTS (SELECT 1 FROM ${ref(catalog.assignments.table)} a WHERE a.${q(column(assignments, "customRole"))} = v_pending.key AND ${sameAssignment} AND NOT a.${q(column(assignments, "deletionMark"))})`,
    `    THEN ${refusal("role-in-use")} END IF;`,
    `    ${escalationSql(roleGrantSet(catalog, physical, "after"), roleGrantSet(catalog, physical, "before"), catalog)}`,
    "  ELSIF v_pending.kind = 'assignment' THEN",
    `    ${escalationSql(assignmentGrantSet(catalog, physical, "after"), assignmentBeforeSet(catalog, physical), catalog)}`,
    "  ELSIF v_pending.kind = 'holders' THEN",
    ...(root === undefined ? [] : [`    IF ${root} THEN`]),
    `    IF NOT EXISTS (SELECT 1 FROM (${holderRows(catalog, contracts, physical)}) h WHERE h.scope = v_pending.scope) THEN ${refusal("last-full-access")} END IF;`,
    ...(root === undefined ? [] : ["    END IF;"]),
    "  END IF;",
    "END IF;",
  ].join("\n")
}

/**
 * Перевірка на COMMIT судить результат транзакції, а не оператор: команда
 * створює роль і її `deny`-рядки окремими операторами, і проміжний стан дав
 * би хибну ескалацію. `SET CONSTRAINTS … IMMEDIATE` лише переносить перевірку
 * на кінець оператора (строгіше), а не вимикає її. Злиття `ON CONFLICT` нової
 * події не ставить, а подія несе першу версію рядка черги, тож рядок
 * перечитується за первинним ключем.
 */
function checkBody(
  contracts: GuardContracts,
  physical: PhysicalSnapshot
): string {
  return [
    "DECLARE",
    `  v_pending ${ref(platform("rights_tx_pending"))}%ROWTYPE;`,
    "BEGIN",
    `  SELECT * INTO v_pending FROM ${ref(platform("rights_tx_pending"))} p`,
    "  WHERE p.xid = NEW.xid AND p.kind = NEW.kind AND p.scope_kind_id = NEW.scope_kind_id AND p.key = NEW.key FOR UPDATE;",
    "  IF NOT FOUND THEN RETURN NULL; END IF;",
    ...contracts.rightsCatalogs.map((catalog) =>
      catalogCheck(catalog, contracts, physical)
    ),
    `  DELETE FROM ${ref(platform("rights_tx_pending"))} p WHERE p.xid = v_pending.xid AND p.kind = v_pending.kind AND p.scope_kind_id = v_pending.scope_kind_id AND p.key = v_pending.key;`,
    `  IF NOT EXISTS (SELECT 1 FROM ${ref(platform("rights_tx_pending"))} WHERE xid = v_pending.xid) THEN`,
    `    DELETE FROM ${ref(platform("rights_tx_actor"))} WHERE xid = v_pending.xid;`,
    "  END IF;",
    "  RETURN NULL;",
    "END",
  ].join("\n")
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

/**
 * Тригер оператора довідника членства. Повторна вставка під id, на який уже
 * посилаються призначення, — відмова завжди, і в режимі обслуговування: FK
 * `NO ACTION` перевіряється в кінці оператора, тож `DELETE … RETURNING` +
 * `INSERT` переписав би власника призначень без ключа `holders` (Р2c2-10a).
 * Зміна користувача без контексту команди — та сама незмінність, що для
 * команд (Р2c2-10b): боргова функція власника йде повз RLS; дозволено лише
 * самоприйняття порожнього рядка й режим обслуговування. Порівняння — за
 * ключем рядка: зміну самого ключа тримає row-level тригер `_id`.
 */
function memberEventBody(
  member: Contracts["membership"][number],
  contracts: GuardContracts,
  physical: PhysicalSnapshot,
  operation: "INSERT" | "UPDATE" | "DELETE",
  provider: DatabaseProvider
): string {
  const key = q(member.keyColumn)
  const scope = q(member.scopeColumn)
  const user = q(member.userColumn)
  const assignments = contracts.rightsCatalogs
    .filter(
      (catalog) =>
        catalog.level.level === "scope" &&
        catalog.level.scopeKindId === member.scopeKindId
    )
    .map((catalog) => {
      const table = catalog.assignments.table
      const actual = tableOf(physical, table)
      return `EXISTS (SELECT 1 FROM ${ref(table)} a WHERE a.${q(column(actual, "subject"))} = n.${key} AND a.${q(scopeColumn(actual)!)} = n.${scope})`
    })
  const repeated =
    operation === "INSERT" && assignments.length > 0
      ? `IF EXISTS (SELECT 1 FROM new_rows n WHERE ${assignments.join(" OR ")}) THEN ${refusal("rights-context")} END IF;`
      : ""
  // Самоприйняття порівнюється NULL-безпечно: поза командою власник часто
  // без claims (`current_user_id()` — NULL), і `=` дав би NULL замість
  // «не самоприйняття» — запрошений рядок заповнювався б ким завгодно.
  const changed =
    operation === "UPDATE"
      ? [
          `IF v_action IS NULL AND NOT v_maintenance AND EXISTS (SELECT 1 FROM old_rows o JOIN new_rows n ON n.${key} = o.${key}`,
          `  WHERE o.${user} IS DISTINCT FROM n.${user} AND NOT (o.${user} IS NULL AND n.${user} IS NOT DISTINCT FROM ${ref(platform("current_user_id"))}()`,
          `    AND NOT EXISTS (SELECT 1 FROM ${ref(member.table)} other WHERE other.${scope} = n.${scope} AND other.${user} = n.${user} AND other.${key} <> n.${key})))`,
          `THEN ${refusal("rights-context")} END IF;`,
        ].join("\n")
      : ""
  // Непорожній користувач змінився — носій міг зникнути; ключ ставиться в
  // будь-якому режимі: поза командою зміну вже відхилено вище, тож на
  // практиці це режим обслуговування (Р2c2-7).
  const holder =
    operation === "UPDATE"
      ? [
          `SELECT 'holders'::text AS kind, o.${scope} AS key, ${sqlLiteral(member.scopeKindId)}::uuid AS scope_kind_id, o.${scope} AS scope, 1 AS image`,
          `FROM old_rows o JOIN new_rows n ON n.${key} = o.${key} WHERE o.${user} IS NOT NULL AND o.${user} IS DISTINCT FROM n.${user}`,
        ].join("\n")
      : undefined
  return [
    "DECLARE v_action text; v_maintenance boolean;",
    "BEGIN",
    `  v_maintenance := (${maintenanceSql(provider)});`,
    `  SELECT c.action INTO v_action FROM ${ref(COMMAND_FUNCTIONS.current)}() c;`,
    repeated,
    changed,
    `  ${bumpRows(operation, member.scopeKindId, member.scopeColumn)}`,
    pendingInsert(
      [...(holder === undefined ? [] : [holder]), actorPending()],
      "v_maintenance"
    ),
    "  RETURN NULL; END",
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Тригер оператора «Користувачів» (Р2c2-10a, Р2c2-10b): повторна вставка
 * під id з членством чи глобальним призначенням — відмова завжди; без
 * контексту команди дозволено лише `invalid` `false → true` (платформне
 * видалення облікового запису) і режим обслуговування.
 */
function usersEventBody(
  users: NonNullable<Contracts["users"]>,
  contracts: GuardContracts,
  physical: PhysicalSnapshot,
  operation: "INSERT" | "UPDATE",
  provider: DatabaseProvider
): string {
  const key = q(users.keyColumn)
  const invalid = q(users.invalidColumn)
  const table = tableOf(physical, users.table)
  const kind = q(column(table, "userKind"))
  const repeated =
    operation === "INSERT"
      ? [
          ...contracts.membership.map(
            (member) =>
              `EXISTS (SELECT 1 FROM ${ref(member.table)} m WHERE m.${q(member.userColumn)} = n.${key})`
          ),
          ...contracts.rightsCatalogs
            .filter((catalog) => catalog.level.level === "global")
            .map((catalog) => {
              const assignment = tableOf(physical, catalog.assignments.table)
              return `EXISTS (SELECT 1 FROM ${ref(catalog.assignments.table)} a WHERE a.${q(column(assignment, "subject"))} = n.${key})`
            }),
        ]
      : []
  const update =
    operation === "UPDATE"
      ? [
          `IF v_action IS NULL AND NOT v_maintenance AND EXISTS (SELECT 1 FROM old_rows o JOIN new_rows n ON n.${key} = o.${key}`,
          ` WHERE o.${kind} IS DISTINCT FROM n.${kind} OR (o.${invalid} IS DISTINCT FROM n.${invalid} AND NOT (o.${invalid} = false AND n.${invalid} = true)))`,
          `THEN ${refusal("rights-context")} END IF;`,
        ].join("\n")
      : ""
  // Недійсність і вид користувача змінюють дієвих носіїв глобально, тож
  // кеш прав застаріває: версія підвищується раз на оператор і лише за
  // справжньої зміни (Р2c2-21). Нова вставка прав не дає — версії не чіпає.
  const bump =
    operation === "UPDATE"
      ? `IF EXISTS (SELECT 1 FROM old_rows o JOIN new_rows n ON n.${key} = o.${key} WHERE o.${invalid} IS DISTINCT FROM n.${invalid} OR o.${kind} IS DISTINCT FROM n.${kind}) THEN PERFORM ${ref(RIGHTS_FUNCTIONS.bump)}(${sqlLiteral(ZERO_UUID)}::uuid, ${sqlLiteral(ZERO_UUID)}::uuid); END IF;`
      : ""
  return [
    "DECLARE v_action text; v_maintenance boolean;",
    "BEGIN",
    `  v_maintenance := (${maintenanceSql(provider)});`,
    `  SELECT c.action INTO v_action FROM ${ref(COMMAND_FUNCTIONS.current)}() c;`,
    repeated.length === 0
      ? ""
      : `  IF EXISTS (SELECT 1 FROM new_rows n WHERE ${repeated.join(" OR ")}) THEN ${refusal("rights-context")} END IF;`,
    update,
    bump,
    "  RETURN NULL; END",
  ]
    .filter(Boolean)
    .join("\n")
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
  // Обмін id двох рядків одним `UPDATE` тригер оператора не бачить (множини
  // ключів старих і нових рядків однакові), а FK `NO ACTION` його пропускає;
  // тому окремий row-level тригер, без винятку режиму обслуговування (Р2c2-10b).
  const addIdGuard = (table: PhysicalTable, key: string) => {
    const name = tableName(table)
    const fn = functionName(name, labels.id)
    addFunction(fn, truncateBody(table), table.origin.objectId)
    add(
      `CREATE TRIGGER ${q(triggerName(name, labels.id))} BEFORE UPDATE OF ${q(key)} ON ${ref(name)} FOR EACH ROW WHEN (OLD.${q(key)} IS DISTINCT FROM NEW.${q(key)}) EXECUTE FUNCTION ${ref(fn)}();`,
      table.origin.objectId
    )
  }
  for (const config of catalogTables(contracts, physical)) {
    const table = tableName(config.table)
    const owner = config.table.origin.objectId
    const fn = functionName(table, labels.rights)
    const snapshot = functionName(table, labels.snapshot)
    addFunction(snapshot, snapshotBody(provider, contracts, physical), owner, [
      unitNode(COMMAND_FUNCTIONS.current),
      unitNode(RIGHTS_FUNCTIONS.mine),
      { type: "table", schema: PLATFORM_SCHEMA, name: "rights_tx_actor" },
    ])
    add(
      `CREATE TRIGGER ${q(triggerName(table, labels.snapshot))} BEFORE INSERT OR UPDATE OR DELETE ON ${ref(table)} FOR EACH STATEMENT EXECUTE FUNCTION ${ref(snapshot)}();`,
      owner
    )
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
    const snapshot = functionName(name, labels.snapshot)
    addFunction(snapshot, snapshotBody(provider, contracts, physical), owner, [
      unitNode(COMMAND_FUNCTIONS.current),
      unitNode(RIGHTS_FUNCTIONS.mine),
      { type: "table", schema: PLATFORM_SCHEMA, name: "rights_tx_actor" },
    ])
    add(
      `CREATE TRIGGER ${q(triggerName(name, labels.snapshot))} BEFORE INSERT OR UPDATE OR DELETE ON ${ref(name)} FOR EACH STATEMENT EXECUTE FUNCTION ${ref(snapshot)}();`,
      owner
    )
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const label = `simetra_rights_members_${operation.toLowerCase()}`
      const fn = functionName(name, label)
      const transition =
        operation === "INSERT"
          ? "REFERENCING NEW TABLE AS new_rows"
          : operation === "DELETE"
            ? "REFERENCING OLD TABLE AS old_rows"
            : "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows"
      addFunction(
        fn,
        memberEventBody(member, contracts, physical, operation, provider),
        owner,
        [
          unitNode(COMMAND_FUNCTIONS.current),
          {
            type: "unit",
            identity: `function:${ref(RIGHTS_FUNCTIONS.bump)}(uuid,uuid)`,
          },
        ]
      )
      add(
        `CREATE TRIGGER ${q(triggerName(name, label))} AFTER ${operation} ON ${ref(name)} ${transition} FOR EACH STATEMENT EXECUTE FUNCTION ${ref(fn)}();`,
        owner
      )
    }
    addIdGuard(table, member.keyColumn)
    addTruncate(table)
  }
  if (contracts.users !== undefined) {
    const users = contracts.users
    const table = tableOf(physical, users.table)
    const name = tableName(table)
    const owner = table.origin.objectId
    for (const operation of ["INSERT", "UPDATE"] as const) {
      const label = `simetra_rights_users_${operation.toLowerCase()}`
      const fn = functionName(name, label)
      const transition =
        operation === "INSERT"
          ? "REFERENCING NEW TABLE AS new_rows"
          : "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows"
      addFunction(
        fn,
        usersEventBody(users, contracts, physical, operation, provider),
        owner,
        [
          unitNode(COMMAND_FUNCTIONS.current),
          ...(operation === "UPDATE"
            ? [
                {
                  type: "unit" as const,
                  identity: `function:${ref(RIGHTS_FUNCTIONS.bump)}(uuid,uuid)`,
                },
              ]
            : []),
        ]
      )
      add(
        `CREATE TRIGGER ${q(triggerName(name, label))} AFTER ${operation} ON ${ref(name)} ${transition} FOR EACH STATEMENT EXECUTE FUNCTION ${ref(fn)}();`,
        owner
      )
    }
    addIdGuard(table, users.keyColumn)
    addTruncate(table)
  }
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
  const check = platform("rights_tx_check")
  addFunction(check, checkBody(contracts, physical), undefined, [
    { type: "table", schema: PLATFORM_SCHEMA, name: "rights_tx_pending" },
    { type: "table", schema: PLATFORM_SCHEMA, name: "rights_tx_actor" },
    { type: "table", schema: PLATFORM_SCHEMA, name: "rights_journal" },
  ])
  add(
    `CREATE CONSTRAINT TRIGGER ${q("rights_tx_pending_check")} AFTER INSERT ON ${ref(platform("rights_tx_pending"))} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${ref(check)}();`
  )
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}
