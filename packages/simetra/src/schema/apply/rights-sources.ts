import {
  qualified,
  roleTableJoin,
  rightsDomainRows,
  rightsLevelOf,
  effectiveHolderRows,
  sourceConditions,
  standardColumn,
  type AssignmentSourceContract,
  type Contracts,
  type QualifiedName,
  type RightsLevelKey,
} from "simetra/compiler"
import {
  ATTRIBUTE_CASES,
  RIGHTS_COLUMNS,
  deletionMarkColumn,
  keyColumn,
  quoteIdent,
  tabularParentColumn,
  type AttributeCase,
  type PhysicalSnapshot,
  type StandardColumnDef,
} from "simetra/model"
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

/** Що план прочитав на цілі про прийняті джерела прав (спека прав §4.7). */
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
  /**
   * Таблиця призначень і кожна з `holderTables` лишаються в бажаній моделі
   * тією самою таблицею (спека прав Рх20): інакше носій, прочитаний з них, після
   * застосування зникне разом з таблицею.
   */
  holdersKept: boolean
  /** Корінь скоупу рівня зник з бажаної моделі — разом з усіма скоупами. */
  rootRemoved: boolean
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
const origin = z.object({
  objectId: z.string(),
  tabularSectionId: z.string().optional(),
  part: z.string().optional(),
})
const appliedRightsSchema = z.object({
  // Стиль застосованого знімка: його колонки несуть `origin.standard` у
  // стилі свого проєкту, а не бажаного. Немає — типовий camelCase.
  project: z
    .object({
      naming: z.object({ attributeCase: z.enum(ATTRIBUTE_CASES) }).optional(),
    })
    .optional(),
  scopeKinds: z.array(
    z.object({
      id: z.string(),
      root: z.union([
        z.object({ id: z.string() }),
        z.object({
          external: z.object({
            schema: z.string(),
            table: z.string(),
            column: z.string(),
          }),
        }),
      ]),
    })
  ),
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
        origin,
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
 * ролей (спека прав §4.7) — кожна рівно раз; відомі ключі джерела — `sourceKeys` усіх
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
  attributeCase: AttributeCase,
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
    defs: readonly StandardColumnDef[],
    style: AttributeCase
  ) => {
    const found = source.tables.find(
      (candidate) =>
        candidate.schema === table.schema && candidate.name === table.name
    )
    if (found === undefined)
      throw new Error(`missing physical table ${tableText(table)}`)
    return Object.fromEntries(
      defs
        .map((def) => [
          def.logicalName,
          // Ім'я в стилі знімка, з якого колонку читають.
          standardColumn(
            { name: tableText(table), columns: found.columns },
            def,
            style
          ).name,
        ])
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
    holders: Pick<Contracts, "membership" | "membershipSources" | "users">,
    style: AttributeCase
  ): Omit<RightsCatalogInput, "holdersKept" | "rootRemoved"> => {
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
        source as Pick<PhysicalSnapshot, "tables">,
        style
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
        roles: columns(
          source,
          catalog.roles.table,
          [KEY, R.archetype, DELETION],
          style
        ),
        delta: columns(
          source,
          catalog.roles.delta,
          [KEY, PARENT, R.object, R.action, R.extent, R.dimension],
          style
        ),
        assignments: columns(
          source,
          catalog.assignments.table,
          [KEY, R.archetype, R.customRole, DELETION],
          style
        ),
      },
    }
  }
  // Ідентичність таблиці — її походження в метаданих, як у звірці промоції
  // (`transition.ts`): фізичне ім'я промоція перепризначає, а таблиця нового
  // об'єкта з тим самим ім'ям — інша таблиця, і її рядки інші
  const identity = (o: z.infer<typeof origin>) =>
    JSON.stringify([o.objectId, o.tabularSectionId ?? null, o.part ?? null])
  const desiredTables = new Set(physical.tables.map((t) => identity(t.origin)))
  const kept = (table: QualifiedName) => {
    const was = old!.physical.tables.find(
      (t) => t.schema === table.schema && t.name === table.name
    )
    return was !== undefined && desiredTables.has(identity(was.origin))
  }
  const oldCatalogs = (old?.contracts.rightsCatalogs ?? []).map(
    (catalog): RightsCatalogInput => {
      const input = catalogInput(
        catalog,
        old!.physical,
        old!.contracts as unknown as Pick<
          Contracts,
          "membership" | "membershipSources" | "users"
        >,
        old!.project?.naming?.attributeCase ?? "camelCase"
      )
      const root =
        catalog.level.level === "scope"
          ? old!.scopeKinds.find(
              (kind) =>
                catalog.level.level === "scope" &&
                kind.id === catalog.level.scopeKindId
            )?.root
          : undefined
      return {
        ...input,
        holdersKept: [input.assignments, ...input.holderTables].every(kept),
        // Корінь-об'єкт без основної таблиці в бажаній моделі — план знімає
        // таблицю коренів, а з нею кожен скоуп рівня: перевірки для такого
        // скоупу немає, як на COMMIT, коли корінь видалено (спека прав §7). Зовнішній
        // корінь план не знімає
        rootRemoved:
          root !== undefined &&
          "id" in root &&
          !desiredTables.has(identity({ objectId: root.id })),
      }
    }
  )
  const desiredCatalogs = contracts.rightsCatalogs.map(
    (catalog): RightsCatalogInput => ({
      ...catalogInput(catalog, physical, contracts, attributeCase),
      holdersKept: true,
      rootRemoved: false,
    })
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
 * `rights_mine` (спека прав §4.7, спільний `sourceConditions`): рядок, який функції
 * прав не читають як призначення, план не називає. `columns` — колонки, які
 * запит читає: колонку, якої на цілі ще немає, додасть DDL плану, і читати
 * тоді нічого (спека прав §4.7).
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
  // З'єднання — те саме, що в гілці джерела `rights_mine` (спека прав §4.7)
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
 * Доступ ролі застосування до таблиць (спека прав §4.7). Функції прав —
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

// Визначення стандартних колонок з реєстру.
const R = RIGHTS_COLUMNS
const KEY = keyColumn(false)
const PARENT = tabularParentColumn()
const DELETION = deletionMarkColumn()

function catalogSql(
  catalog: RightsCatalogInput,
  kind: "roles" | "assignments" | "delta"
): string {
  const table = catalog[kind]
  const cols = catalog.columns[kind]
  // Ключі запису колонок — канонічні імена визначень реєстру.
  const c = (def: StandardColumnDef) => column(cols, def.logicalName)
  const scope =
    catalog.level.level === "global" ? "NULL::uuid" : column(cols, "scope")
  if (kind === "delta")
    return [
      `SELECT ${c(KEY)} AS id, ${c(PARENT)} AS parent,`,
      `  ${c(R.object)} AS object, ${c(R.action)} AS action,`,
      `  ${c(R.extent)} AS extent, ${c(R.dimension)} AS dimension`,
      `FROM ${qualified(table)}`,
    ].join("\n")
  return [
    `SELECT ${c(KEY)} AS id, ${scope} AS scope, ${c(R.archetype)} AS archetype,`,
    `  ${kind === "roles" ? "NULL::uuid" : c(R.customRole)} AS custom_role,`,
    `  ${c(DELETION)} AS deleted`,
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
    if (catalog.rootRemoved) continue
    for (const row of holders) {
      const key = scopeKey(catalog.level, row.scope)
      const count = fullAccess.get(key) ?? { scope: key, before: 0, after: 0 }
      if (beforeRoles?.has(`${row.archetype}|${storage}`)) count.before++
      const next = desired.get(row.archetype)
      if (catalog.holdersKept && next?.fullAccess && next.storage === storage)
        count.after++
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
 * `dbs.reader`). Ключі читаються лише з джерел, чиї таблиця й
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
  // Довідники прав, які роль застосування не читає, уже дали відмову
  // доступу (`owners`); без жодного читаного довідника архетипи «до» не
  // потрібні, а функція схеми `simetra` для чужої ролі впала б сирим `42501`.
  const catalogs = input.catalogs.filter((catalog) =>
    [catalog.roles, catalog.delta, catalog.assignments].every((table) =>
      readable.has(tableText(table))
    )
  )
  const rights = await withLocalSettings(
    tx,
    [{ name: "row_security", value: "off" }],
    async () => {
      const [exists] =
        catalogs.length === 0
          ? []
          : await tx.query<{ present: boolean }>(FULL_ACCESS_EXISTS_SQL)
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
      for (const catalog of catalogs) {
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
 * Відмова доступу (спека прав §4.7) — таблиці, яких роль застосування не читає
 * повністю; попередження (спека прав §4.7) — на кожне джерело з невідомими ключами.
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
