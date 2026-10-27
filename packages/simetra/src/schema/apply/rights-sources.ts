import {
  qualified,
  roleTableJoin,
  rightsDomainRows,
  rightsLevelOf,
  effectiveHolderRows,
  sourceConditions,
  type AssignmentSourceContract,
  type Contracts,
  type QualifiedName,
  type RightsLevelKey,
} from "simetra/compiler"
import { quoteIdent, type PhysicalSnapshot } from "simetra/model"
import { z } from "zod"
import type { EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import type { ApplyTransaction } from "./port"
import { withLocalSettings } from "./settings"

/**
 * Скільки таблиць називає відмова доступу й скільки невідомих ключів —
 * попередження джерела; решту дає кількість. Те саме число, що відмова
 * власників плану.
 */
export const RIGHTS_SOURCE_LIMIT = 20

/** Що план прочитав на цілі про прийняті джерела прав (Р2d1-10, Р2d1-11). */
export interface RightsSourceFacts {
  /** Таблиці, які є на цілі; `owned` — роль застосування читає кожен рядок. */
  owners: { table: string; owned: boolean }[]
  /** Джерела призначень, чиї ключі прочитано: ключі поза `sourceKeys`. */
  unknownKeys: { source: string; keys: string[]; more: number }[]
  fullAccess: { scope: string; before: number; after: number }[]
  orphans: { customRoles: string[]; assignments: string[]; more: number }
}

/** Вхід читача: таблиці без повторів і джерела призначень з відомими ключами. */
export interface RightsSourceInput {
  tables: QualifiedName[]
  assignments: { source: AssignmentSourceContract; keys: string[] }[]
  catalogs: RightsCatalogInput[]
  desiredRoles: { id: string; storage: string; fullAccess: boolean }[]
  domain: {
    roleId: string
    object: string
    action: string
    extent: string
    dimensionId: string | null
  }[]
}

interface RightsCatalogInput {
  level: RightsLevelKey
  roles: QualifiedName
  delta: QualifiedName
  assignments: QualifiedName
  holdersSql: string
  holderTables: QualifiedName[]
  columns: {
    roles: Record<string, string>
    delta: Record<string, string>
    assignments: Record<string, string>
  }
}

const named = z.object({ schema: z.string(), name: z.string() })
const level = z.discriminatedUnion("level", [
  z.object({ level: z.literal("global") }),
  z.object({ level: z.literal("scope"), scopeKindId: z.string() }),
])
const appliedRightsSchema = z.object({
  contracts: z.object({
    rightsCatalogs: z.array(
      z.object({
        level,
        roles: z.object({ table: named, delta: named }),
        assignments: z.object({ table: named }),
      })
    ),
    membership: z.array(
      z.object({
        scopeKindId: z.string(),
        table: named,
        keyColumn: z.string(),
        scopeColumn: z.string(),
        userColumn: z.string(),
      })
    ),
    membershipSources: z.array(
      z.object({
        scopeKindId: z.string(),
        table: named,
        member: z.string(),
        scope: z.string(),
        user: z.string(),
        active: z.string().optional(),
        where: z.array(
          z.union([
            z.object({ column: z.string(), isNull: z.boolean() }),
            z.object({
              column: z.string(),
              equals: z.union([z.string(), z.boolean(), z.number()]),
              type: z.enum(["text", "uuid", "boolean", "integer"]),
            }),
          ])
        ),
      })
    ),
    users: z
      .object({
        table: named,
        keyColumn: z.string(),
        invalidColumn: z.string(),
      })
      .optional(),
  }),
  physical: z.object({
    tables: z.array(
      z.object({
        schema: z.string(),
        name: z.string(),
        columns: z.array(
          z.object({
            name: z.string(),
            origin: z.object({
              standard: z.string().optional(),
              scopeKindId: z.string().optional(),
            }),
          })
        ),
      })
    ),
  }),
})

const tableText = (t: QualifiedName) => `${t.schema}.${t.name}`

/**
 * Вхід читача з контрактів: таблиці-джерела членства й призначень і таблиці
 * ролей (Р2d1-17) — кожна рівно раз; відомі ключі джерела — `sourceKeys` усіх
 * ролей, що його називають.
 */
export function rightsSourceInput(
  contracts: Pick<
    Contracts,
    | "membership"
    | "membershipSources"
    | "assignmentSources"
    | "roles"
    | "rightsCatalogs"
    | "rights"
    | "users"
  >,
  physical: PhysicalSnapshot,
  applied?: unknown
): RightsSourceInput {
  const tables = new Map<string, QualifiedName>()
  const add = (t: QualifiedName) => {
    if (!tables.has(tableText(t))) tables.set(tableText(t), t)
  }
  for (const source of contracts.membershipSources) add(source.table)
  for (const source of contracts.assignmentSources) {
    add(source.table)
    if (source.roleTable !== undefined) add(source.roleTable.table)
  }
  const columns = (
    source: {
      tables: {
        schema: string
        name: string
        columns: {
          name: string
          origin: { standard?: string; scopeKindId?: string }
        }[]
      }[]
    },
    table: QualifiedName,
    names: readonly string[]
  ) => {
    const found = source.tables.find(
      (candidate) =>
        candidate.schema === table.schema && candidate.name === table.name
    )
    if (found === undefined)
      throw new Error(`missing physical table ${tableText(table)}`)
    return Object.fromEntries(
      names
        .map((name) => {
          const column = found.columns.find(
            (candidate) => candidate.origin.standard === name
          )
          if (column === undefined)
            throw new Error(
              `missing standard column ${name} on ${tableText(table)}`
            )
          return [name, column.name]
        })
        .concat(
          found.columns
            .filter((column) => column.origin.scopeKindId !== undefined)
            .slice(0, 1)
            .map((column) => ["scope", column.name])
        )
    )
  }
  const old =
    applied === undefined ? undefined : appliedRightsSchema.parse(applied)
  const catalogInput = (
    catalog: {
      level: RightsLevelKey
      roles: { table: QualifiedName; delta: QualifiedName }
      assignments: { table: QualifiedName }
    },
    source: {
      tables: {
        schema: string
        name: string
        columns: {
          name: string
          origin: { standard?: string; scopeKindId?: string }
        }[]
      }[]
    },
    holders: Pick<Contracts, "membership" | "membershipSources" | "users">
  ): RightsCatalogInput => {
    const scopeKindId =
      catalog.level.level === "scope" ? catalog.level.scopeKindId : undefined
    return {
      level: catalog.level,
      roles: catalog.roles.table,
      delta: catalog.roles.delta,
      assignments: catalog.assignments.table,
      holdersSql: effectiveHolderRows(
        catalog,
        holders,
        source as Pick<PhysicalSnapshot, "tables">
      ),
      holderTables: [
        ...(scopeKindId !== undefined
          ? [
              holders.membership.find(
                (entry) => entry.scopeKindId === scopeKindId
              )?.table,
              holders.membershipSources.find(
                (entry) => entry.scopeKindId === scopeKindId
              )?.table,
            ]
              .filter((table): table is QualifiedName => table !== undefined)
              .slice(0, 1)
          : []),
        ...(holders.users === undefined ? [] : [holders.users.table]),
      ],
      columns: {
        roles: columns(source, catalog.roles.table, [
          "ref",
          "archetype",
          "deletionMark",
        ]),
        delta: columns(source, catalog.roles.delta, [
          "ref",
          "parent",
          "object",
          "action",
          "extent",
          "dimension",
        ]),
        assignments: columns(source, catalog.assignments.table, [
          "ref",
          "archetype",
          "customRole",
          "deletionMark",
        ]),
      },
    }
  }
  const oldCatalogs = (old?.contracts.rightsCatalogs ?? []).map((catalog) =>
    catalogInput(
      catalog,
      old!.physical,
      old!.contracts as unknown as Pick<
        Contracts,
        "membership" | "membershipSources" | "users"
      >
    )
  )
  const desiredCatalogs = contracts.rightsCatalogs.map((catalog) =>
    catalogInput(catalog, physical, contracts)
  )
  const catalogs = [...oldCatalogs]
  for (const catalog of desiredCatalogs) {
    if (
      !catalogs.some(
        (existing) =>
          tableText(existing.assignments) === tableText(catalog.assignments)
      )
    )
      catalogs.push(catalog)
  }
  for (const catalog of catalogs) {
    for (const table of [
      catalog.roles,
      catalog.delta,
      catalog.assignments,
      ...catalog.holderTables,
    ])
      add(table)
  }
  return {
    tables: [...tables.values()],
    assignments: contracts.assignmentSources.map((source) => ({
      source,
      keys: contracts.roles.flatMap((role) =>
        role.sourceKeys
          .filter((k) => k.sourceId === source.sourceId)
          .map((k) => k.key)
      ),
    })),
    catalogs,
    desiredRoles: contracts.roles.map((role) => ({
      id: role.roleId,
      storage: storageKey(rightsLevelOf(role.assignedOn, contracts)),
      fullAccess: role.fullAccess,
    })),
    domain: rightsDomainRows(contracts),
  }
}

const storageKey = (level: RightsLevelKey | undefined) =>
  level === undefined
    ? "none"
    : level.level === "global"
      ? "global"
      : `scope:${level.scopeKindId}`

/**
 * Запит ключів ролей джерела, яких немає серед відомих (`$1`, масив тексту).
 * З'єднання з таблицею ролей і умови `where` — ті самі, що в гілці джерела
 * `rights_mine` (Р2d1-18, спільний `sourceConditions`): рядок, який функції
 * прав не читають як призначення, план не називає. `columns` — колонки, які
 * запит читає: колонку, якої на цілі ще немає, додасть DDL плану, і читати
 * тоді нічого (Р2d1-11).
 */
export function unknownKeysQuery(source: AssignmentSourceContract): {
  sql: string
  columns: { table: QualifiedName; column: string }[]
} {
  const src = (column: string) => `src.${quoteIdent(column)}`
  const { roleTable } = source
  const key =
    roleTable === undefined
      ? src(source.role)
      : `sr.${quoteIdent(roleTable.key)}`
  // З'єднання — те саме, що в гілці джерела `rights_mine` (Р2d1-18)
  const join = roleTableJoin(source)
  const conditions = [
    `${key} IS NOT NULL`,
    ...(source.active === undefined ? [] : [`${src(source.active)} IS TRUE`]),
    ...sourceConditions("src", source.where),
    `NOT (${key}::text = ANY ($1::text[]))`,
  ]
  const sql = [
    `SELECT k.key AS unknown_key, pg_catalog.count(*) OVER () AS total`,
    `FROM (`,
    `  SELECT DISTINCT ${key}::text AS key`,
    `  FROM ${qualified(source.table)} src`,
    ...join.map((line) => `  ${line}`),
    `  WHERE ${conditions.join("\n    AND ")}`,
    `) k`,
    `ORDER BY k.key COLLATE "C"`,
    `LIMIT ${RIGHTS_SOURCE_LIMIT}`,
  ].join("\n")
  const columns = [
    ...[
      source.role,
      ...(source.active === undefined ? [] : [source.active]),
      ...source.where.map((c) => c.column),
    ].map((column) => ({ table: source.table, column })),
    ...(roleTable === undefined
      ? []
      : [
          roleTable.id,
          roleTable.key,
          ...roleTable.where.map((c) => c.column),
        ].map((column) => ({ table: roleTable.table, column }))),
  ]
  const seen = new Set<string>()
  return {
    sql,
    columns: columns.filter((c) => {
      const id = `${tableText(c.table)}.${c.column}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    }),
  }
}

/**
 * Доступ ролі застосування до таблиць (Р2d1-10). Функції прав —
 * `SECURITY DEFINER` і виконуються від свого власника — ролі застосування
 * (`current_user` цієї транзакції). RLS таблиці Postgres пропускає лише для
 * ролі з правами власника (зокрема успадкованими через членство), з
 * `BYPASSRLS` чи суперкористувача; `BYPASSRLS` власника таблиці, коли функцією
 * володіє інша роль, нічого не дає. Без `SELECT` чи `USAGE` на схемі функції
 * гучно падали б на кожному виклику. Таблиця шукається за іменем у каталозі,
 * а не `to_regclass`: той на схемі без `USAGE` кидає `42501`, а така таблиця —
 * відмова, не відсутність. Таблиці, якої немає, рядка немає: її створить план.
 */
const OWNERS_SQL = `SELECT t.table_schema, t.table_name,
  pg_catalog.has_schema_privilege(CURRENT_USER, n.oid, 'USAGE')
  AND pg_catalog.has_table_privilege(CURRENT_USER, c.oid, 'SELECT')
  AND (NOT c.relrowsecurity
    OR pg_catalog.pg_has_role(CURRENT_USER, c.relowner, 'USAGE')
    OR r.rolbypassrls
    OR r.rolsuper) AS source_owned
FROM ROWS FROM (pg_catalog.unnest($1::text[]), pg_catalog.unnest($2::text[]))
  WITH ORDINALITY AS t(table_schema, table_name, i)
JOIN pg_catalog.pg_namespace n ON n.nspname = t.table_schema
JOIN pg_catalog.pg_class c
  ON c.relnamespace = n.oid
 AND c.relname = t.table_name
JOIN pg_catalog.pg_roles r ON r.rolname = CURRENT_USER
ORDER BY t.i`

/** Колонки, які є на цілі (`pg_attribute`, без знятих і системних). */
const COLUMNS_SQL = `SELECT t.table_schema, t.table_name, t.column_name AS source_column
FROM ROWS FROM (pg_catalog.unnest($1::text[]), pg_catalog.unnest($2::text[]), pg_catalog.unnest($3::text[]))
  AS t(table_schema, table_name, column_name)
JOIN pg_catalog.pg_namespace n ON n.nspname = t.table_schema
JOIN pg_catalog.pg_class c
  ON c.relnamespace = n.oid
 AND c.relname = t.table_name
JOIN pg_catalog.pg_attribute a
  ON a.attrelid = c.oid
 AND a.attname = t.column_name
 AND a.attnum > 0
 AND NOT a.attisdropped`

const FULL_ACCESS_EXISTS_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'simetra' AND p.proname = 'rights_full_access_roles'
    AND p.pronargs = 0
) AS present`

interface CatalogRow extends Record<string, unknown> {
  id: string
  scope: string | null
  archetype: string | null
  custom_role: string | null
  deleted: boolean
}

interface DeltaRow extends Record<string, unknown> {
  id: string
  parent: string
  object: string
  action: string
  extent: string
  dimension: string | null
}

interface HolderRow extends Record<string, unknown> {
  scope: string
  actor: string
  archetype: string
}

const column = (columns: Record<string, string>, name: string) =>
  quoteIdent(columns[name]!)

function catalogSql(
  catalog: RightsCatalogInput,
  kind: "roles" | "assignments" | "delta"
): string {
  const table = catalog[kind]
  const cols = catalog.columns[kind]
  const c = (name: string) => column(cols, name)
  const scope = catalog.level.level === "global" ? "NULL::uuid" : c("scope")
  if (kind === "delta")
    return [
      `SELECT ${c("ref")} AS id, ${c("parent")} AS parent,`,
      `  ${c("object")} AS object, ${c("action")} AS action,`,
      `  ${c("extent")} AS extent, ${c("dimension")} AS dimension`,
      `FROM ${qualified(table)}`,
    ].join("\n")
  return [
    `SELECT ${c("ref")} AS id, ${scope} AS scope, ${c("archetype")} AS archetype,`,
    `  ${kind === "roles" ? "NULL::uuid" : c("customRole")} AS custom_role,`,
    `  ${c("deletionMark")} AS deleted`,
    `FROM ${qualified(table)}`,
  ].join("\n")
}

function scopeKey(level: RightsLevelKey, scope: string | null): string {
  return level.level === "global"
    ? "global"
    : `scope:${level.scopeKindId}:${scope ?? ""}`
}

function collectRightsFacts(
  input: RightsSourceInput,
  catalogRows: {
    catalog: RightsCatalogInput
    roles: CatalogRow[]
    assignments: CatalogRow[]
    delta: DeltaRow[]
    holders: HolderRow[]
  }[],
  previous:
    | { role_id: string; storage: string; storage_id: string | null }[]
    | undefined
): Pick<RightsSourceFacts, "fullAccess" | "orphans"> {
  const beforeRoles = new Set(
    previous?.map(
      (role) =>
        `${role.role_id}|${role.storage === "global" ? "global" : `scope:${role.storage_id}`}`
    )
  )
  const desired = new Map(input.desiredRoles.map((role) => [role.id, role]))
  const domain = new Set(
    input.domain.map((row) =>
      JSON.stringify([
        row.roleId,
        row.object,
        row.action,
        row.extent,
        row.dimensionId,
      ])
    )
  )
  const fullAccess = new Map<
    string,
    { scope: string; before: number; after: number }
  >()
  const customRoles: string[] = []
  const assignments: string[] = []
  for (const {
    catalog,
    roles,
    assignments: assigned,
    delta,
    holders,
  } of catalogRows) {
    const storage = storageKey(catalog.level)
    const customs = new Map(
      roles.filter((role) => !role.deleted).map((role) => [role.id, role])
    )
    for (const role of roles) {
      if (role.deleted) continue
      const desiredRole = desired.get(role.archetype ?? "")
      if (desiredRole === undefined || desiredRole.storage !== storage)
        customRoles.push(role.id)
    }
    for (const row of delta) {
      const parent = customs.get(row.parent)
      if (parent === undefined) continue
      const key = JSON.stringify([
        parent.archetype,
        row.object,
        row.action,
        row.extent,
        row.dimension,
      ])
      if (!domain.has(key)) customRoles.push(row.id)
    }
    for (const row of assigned) {
      if (row.deleted) continue
      if (
        row.custom_role === null &&
        desired.get(row.archetype ?? "")?.storage !== storage
      )
        assignments.push(row.id)
    }
    for (const row of holders) {
      const key = scopeKey(catalog.level, row.scope)
      const count = fullAccess.get(key) ?? { scope: key, before: 0, after: 0 }
      if (beforeRoles?.has(`${row.archetype}|${storage}`)) count.before++
      const next = desired.get(row.archetype)
      if (next?.fullAccess && next.storage === storage) count.after++
      fullAccess.set(key, count)
    }
  }
  const sortedRoles = [...new Set(customRoles)].sort()
  const sortedAssignments = [...new Set(assignments)].sort()
  const limitedRoles = sortedRoles.slice(0, RIGHTS_SOURCE_LIMIT)
  const limitedAssignments = sortedAssignments.slice(
    0,
    RIGHTS_SOURCE_LIMIT - limitedRoles.length
  )
  return {
    fullAccess:
      previous === undefined
        ? []
        : [...fullAccess.values()].sort((a, b) =>
            a.scope.localeCompare(b.scope)
          ),
    orphans: {
      customRoles: limitedRoles,
      assignments: limitedAssignments,
      more:
        sortedRoles.length +
        sortedAssignments.length -
        limitedRoles.length -
        limitedAssignments.length,
    },
  }
}

/**
 * Факти джерел прав з цілі — у транзакції `tx` (читальна транзакція
 * `dbs.reader`, Р2a1-2). Ключі читаються лише з джерел, чиї таблиця й
 * таблиця ролей є на цілі й доступні (інакше з'єднання впало б `42501`) і
 * мають кожну читану колонку; дані — під `row_security = off`: на RLS, яку
 * роль не обходить, це гучна помилка, а не тихий нуль рядків.
 */
export async function readRightsSourceFacts(
  tx: ApplyTransaction,
  input: RightsSourceInput
): Promise<RightsSourceFacts> {
  const empty = {
    fullAccess: [],
    orphans: { customRoles: [], assignments: [], more: 0 },
  }
  if (input.tables.length === 0)
    return { owners: [], unknownKeys: [], ...empty }
  const owners = (
    await tx.query<{
      table_schema: string
      table_name: string
      source_owned: boolean
    }>(OWNERS_SQL, [
      input.tables.map((t) => t.schema),
      input.tables.map((t) => t.name),
    ])
  ).map((row) => ({
    table: `${row.table_schema}.${row.table_name}`,
    owned: row.source_owned,
  }))
  const readable = new Set(owners.filter((o) => o.owned).map((o) => o.table))
  const candidates = input.assignments
    .filter(
      ({ source }) =>
        readable.has(tableText(source.table)) &&
        (source.roleTable === undefined ||
          readable.has(tableText(source.roleTable.table)))
    )
    .map((entry) => ({ ...entry, query: unknownKeysQuery(entry.source) }))
  const asked = candidates.flatMap((c) => c.query.columns)
  const present =
    candidates.length === 0
      ? new Set<string>()
      : new Set(
          (
            await tx.query<{
              table_schema: string
              table_name: string
              source_column: string
            }>(COLUMNS_SQL, [
              asked.map((c) => c.table.schema),
              asked.map((c) => c.table.name),
              asked.map((c) => c.column),
            ])
          ).map(
            (row) =>
              `${row.table_schema}.${row.table_name}.${row.source_column}`
          )
        )
  const ready = candidates.filter((c) =>
    c.query.columns.every((col) =>
      present.has(`${tableText(col.table)}.${col.column}`)
    )
  )
  const unknownKeys = await withLocalSettings(
    tx,
    [{ name: "row_security", value: "off" }],
    async () => {
      const found: RightsSourceFacts["unknownKeys"] = []
      for (const { source, keys, query } of ready) {
        const rows = await tx.query<{
          unknown_key: string
          total: string | number
        }>(query.sql, [keys])
        found.push({
          source: source.name,
          keys: rows.map((r) => r.unknown_key),
          more: rows.length === 0 ? 0 : Number(rows[0]!.total) - rows.length,
        })
      }
      return found
    }
  )
  const rights = await withLocalSettings(
    tx,
    [{ name: "row_security", value: "off" }],
    async () => {
      const [exists] = await tx.query<{ present: boolean }>(
        FULL_ACCESS_EXISTS_SQL
      )
      const previous = exists?.present
        ? await tx.query<{
            role_id: string
            storage: string
            storage_id: string | null
          }>(
            "SELECT role_id, storage, storage_id FROM simetra.rights_full_access_roles()"
          )
        : undefined
      const rows = []
      for (const catalog of input.catalogs) {
        if (
          ![catalog.roles, catalog.delta, catalog.assignments].every((table) =>
            readable.has(tableText(table))
          )
        )
          continue
        rows.push({
          catalog,
          roles: await tx.query<CatalogRow>(catalogSql(catalog, "roles")),
          assignments: await tx.query<CatalogRow>(
            catalogSql(catalog, "assignments")
          ),
          delta: await tx.query<DeltaRow>(catalogSql(catalog, "delta")),
          holders: catalog.holderTables.every((table) =>
            readable.has(tableText(table))
          )
            ? await tx.query<HolderRow>(catalog.holdersSql)
            : [],
        })
      }
      return collectRightsFacts(input, rows, previous)
    }
  )
  return { owners, unknownKeys, ...rights }
}

/**
 * Відмова доступу (Р2d1-10) — таблиці, яких роль застосування не читає
 * повністю; попередження (Р2d1-11) — на кожне джерело з невідомими ключами.
 */
export function rightsSourceDiagnostics(facts: RightsSourceFacts): {
  refusal?: EngineDiagnostic
  warnings: EngineDiagnostic[]
} {
  const denied = facts.owners.filter((o) => !o.owned).map((o) => o.table)
  const warnings = facts.unknownKeys
    .filter((u) => u.keys.length > 0)
    .map((u) =>
      applyDiagnostic("plan.rights-source-unknown-keys", "warning", {
        source: u.source,
        keys: u.keys.join(", "),
        more: u.more,
      })
    )
  if (
    facts.orphans.customRoles.length > 0 ||
    facts.orphans.assignments.length > 0
  )
    warnings.push(
      applyDiagnostic("plan.rights-orphans", "warning", {
        customRoles: facts.orphans.customRoles.join(", "),
        assignments: facts.orphans.assignments.join(", "),
        more: facts.orphans.more,
      })
    )
  const lost = facts.fullAccess.filter(
    (row) => row.before > 0 && row.after === 0
  )
  if (lost.length > 0)
    return {
      refusal: applyDiagnostic("plan.rights-full-access-lost", "error", {
        scopes: lost
          .slice(0, RIGHTS_SOURCE_LIMIT)
          .map((row) => row.scope)
          .concat(
            lost.length > RIGHTS_SOURCE_LIMIT
              ? [`… (+${lost.length - RIGHTS_SOURCE_LIMIT})`]
              : []
          )
          .join(", "),
      }),
      warnings,
    }
  if (denied.length === 0) return { warnings }
  const rest = denied.length - RIGHTS_SOURCE_LIMIT
  return {
    refusal: applyDiagnostic("plan.rights-source-access", "error", {
      tables: denied
        .slice(0, RIGHTS_SOURCE_LIMIT)
        .concat(rest > 0 ? [`… (+${rest})`] : [])
        .join(", "),
    }),
    warnings,
  }
}
