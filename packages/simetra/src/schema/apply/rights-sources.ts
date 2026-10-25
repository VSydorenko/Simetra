import {
  qualified,
  roleTableJoin,
  sourceConditions,
  type AssignmentSourceContract,
  type Contracts,
  type QualifiedName,
} from "simetra/compiler"
import { quoteIdent } from "simetra/model"
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
}

/** Вхід читача: таблиці без повторів і джерела призначень з відомими ключами. */
export interface RightsSourceInput {
  tables: QualifiedName[]
  assignments: { source: AssignmentSourceContract; keys: string[] }[]
}

const tableText = (t: QualifiedName) => `${t.schema}.${t.name}`

/**
 * Вхід читача з контрактів: таблиці-джерела членства й призначень і таблиці
 * ролей (Р2d1-17) — кожна рівно раз; відомі ключі джерела — `sourceKeys` усіх
 * ролей, що його називають.
 */
export function rightsSourceInput(
  contracts: Pick<
    Contracts,
    "membershipSources" | "assignmentSources" | "roles"
  >
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
  }
}

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
  if (input.tables.length === 0) return { owners: [], unknownKeys: [] }
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
  if (candidates.length === 0) return { owners, unknownKeys: [] }

  const asked = candidates.flatMap((c) => c.query.columns)
  const present = new Set(
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
    ).map((row) => `${row.table_schema}.${row.table_name}.${row.source_column}`)
  )
  const ready = candidates.filter((c) =>
    c.query.columns.every((col) =>
      present.has(`${tableText(col.table)}.${col.column}`)
    )
  )
  if (ready.length === 0) return { owners, unknownKeys: [] }

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
  return { owners, unknownKeys }
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
