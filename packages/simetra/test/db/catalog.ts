import type pg from "pg"
import type {
  PgQualifiedName,
  PhysicalTable,
  RowLevelSecurity,
} from "../../src/model"

type FkAction = PhysicalTable["foreignKeys"][number]["onDelete"]

/**
 * Форма каталогу Postgres для звірки з фізичним знімком (спека §8.3). Лише для
 * тестів: власна інтроспекція в продукті заборонена спекою §9.
 *
 * Усе відсортоване (за кодовими точками, не за локаллю): однакова база дає
 * однакову форму. Поля `schema` — справжні імена; у текстах (`type`, `default`,
 * `definition`, `expression`) ім'я схеми з аргументу `readCatalog` замінене на
 * `PLACEHOLDER`, тож дві схеми з однаковим вмістом порівнюються рівними.
 */
export interface CatalogShape {
  enumTypes: CatalogEnumType[]
  tables: CatalogTable[]
  functions: CatalogFunction[]
}

export interface CatalogEnumType {
  schema: string
  name: string
  /** За `enumsortorder`. */
  values: string[]
  comment?: string
}

export interface CatalogTable {
  schema: string
  name: string
  comment?: string
  rowLevelSecurity: RowLevelSecurity
  /** За порядком оголошення (`attnum`). */
  columns: CatalogColumn[]
  /** За назвою. */
  constraints: CatalogConstraint[]
  /** За назвою; включає індекси, що стоять за PK/UNIQUE. */
  indexes: CatalogIndex[]
}

export interface CatalogColumn {
  name: string
  /** `format_type()`. */
  type: string
  notNull: boolean
  /** `pg_get_expr` значення за замовчуванням; у генерованої колонки немає. */
  default?: string
  identity?: { generation: "always" | "byDefault"; sequence: string }
  generated?: { expression: string }
  /** Лише колляція, що відрізняється від колляції типу. */
  collation?: PgQualifiedName
  comment?: string
}

export type CatalogConstraintType =
  "primaryKey" | "unique" | "check" | "foreignKey" | "exclusion"

export interface CatalogConstraint {
  name: string
  type: CatalogConstraintType
  /** `pg_get_constraintdef`. */
  definition: string
  /** Колонки обмеження за порядком `conkey`; у CHECK на рівні таблиці порожньо. */
  columns: string[]
  deferrable: boolean
  initiallyDeferred: boolean
  /** Індекс, що стоїть за PK/UNIQUE/EXCLUDE (`conindid`). */
  index?: string
  /** Ціль і дії FK — структурою, без розбору `definition`. */
  references?: {
    schema: string
    table: string
    columns: string[]
    onDelete: FkAction
    onUpdate: FkAction
  }
  comment?: string
}

/**
 * Елемент ключа індексу. Як у знімку, значення за замовчуванням (`ASC`,
 * типове розташування `NULL`) не пишуться.
 */
export type CatalogIndexKey = ({ column: string } | { expression: string }) & {
  order?: "desc"
  nulls?: "first" | "last"
}

export interface CatalogIndex {
  name: string
  /** `pg_get_indexdef`. */
  definition: string
  unique: boolean
  /** `pg_am.amname`. */
  method: string
  keys: CatalogIndexKey[]
  /** Неключові колонки `INCLUDE`. */
  include: string[]
  /** `pg_get_expr(indpred)` часткового індексу. */
  where?: string
  nullsNotDistinct: boolean
  /** PK/UNIQUE/EXCLUDE тієї самої таблиці, що володіє індексом. */
  constraint?: string
}

export interface CatalogFunction {
  schema: string
  name: string
  /** `pg_get_function_identity_arguments`. */
  arguments: string
  /** `pg_get_function_result`. */
  result: string
  comment?: string
}

export const SCHEMA_PLACEHOLDER = "<schema>"

const CONSTRAINT_TYPES: Record<string, CatalogConstraintType> = {
  p: "primaryKey",
  u: "unique",
  c: "check",
  f: "foreignKey",
  x: "exclusion",
}

const FK_ACTIONS: Record<string, FkAction> = {
  a: "noAction",
  r: "restrict",
  c: "cascade",
  n: "setNull",
  d: "setDefault",
}

const byCodePoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Замінює `schema.` і `"schema".` на плейсхолдер у тексті з каталогу. */
export function normalizer(schemas: string[]): (text: string) => string {
  const alternatives = schemas.map(
    (schema) => `"${escapeRegExp(schema)}"|(?<![\\w"$])${escapeRegExp(schema)}`
  )
  if (alternatives.length === 0) return (text) => text
  const pattern = new RegExp(`(?:${alternatives.join("|")})\\.`, "g")
  return (text) => text.replace(pattern, `${SCHEMA_PLACEHOLDER}.`)
}

/** Лишає ключ лише тоді, коли значення є: `toEqual` і знімок без `undefined`. */
function optional<K extends string, V>(
  key: K,
  value: V | null | undefined
): { [P in K]?: V } {
  return value === null || value === undefined
    ? {}
    : ({ [key]: value } as { [P in K]: V })
}

interface TableRow {
  oid: string
  schema: string
  name: string
  comment: string | null
  rls: boolean
  force_rls: boolean
}

interface ColumnRow {
  table_oid: string
  name: string
  type: string
  not_null: boolean
  default_expr: string | null
  identity: string
  generated: string
  sequence: string | null
  collation_schema: string | null
  collation_name: string | null
  comment: string | null
}

interface ConstraintRow {
  table_oid: string
  name: string
  type: string
  definition: string
  columns: string[]
  deferrable: boolean
  deferred: boolean
  index: string | null
  ref_schema: string | null
  ref_table: string | null
  ref_columns: string[] | null
  on_delete: string
  on_update: string
  comment: string | null
}

interface IndexRow {
  oid: string
  table_oid: string
  name: string
  definition: string
  unique: boolean
  method: string
  key_count: number
  predicate: string | null
  nulls_not_distinct: boolean
  constraint: string | null
}

interface IndexKeyRow {
  index_oid: string
  position: number
  column: string | null
  expression: string
  option: number | null
}

// Біти `pg_index.indoption` (INDOPTION_DESC, INDOPTION_NULLS_FIRST).
const INDOPTION_DESC = 1
const INDOPTION_NULLS_FIRST = 2

/** Ключ індексу у формі знімка: напрям і `NULLS` лише відмінні від типових. */
function indexKey(
  key: IndexKeyRow,
  text: (value: string) => string
): CatalogIndexKey {
  const option = key.option ?? 0
  const desc = (option & INDOPTION_DESC) !== 0
  const nullsFirst = (option & INDOPTION_NULLS_FIRST) !== 0
  return {
    ...(key.column !== null
      ? { column: key.column }
      : { expression: text(key.expression) }),
    ...(desc ? { order: "desc" as const } : {}),
    // Типово `NULLS LAST` для ASC і `NULLS FIRST` для DESC.
    ...(nullsFirst !== desc
      ? { nulls: nullsFirst ? ("first" as const) : ("last" as const) }
      : {}),
  }
}

export async function readCatalog(
  client: pg.Client,
  schemas: string[]
): Promise<CatalogShape> {
  const normalize = normalizer(schemas)
  const text = (value: string): string => normalize(value)

  const tables = await client.query<TableRow>(
    `SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name,
            obj_description(c.oid, 'pg_class') AS comment,
            c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
      ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`,
    [schemas]
  )

  const columns = await client.query<ColumnRow>(
    `SELECT a.attrelid::text AS table_oid, a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null,
            pg_get_expr(d.adbin, d.adrelid) AS default_expr,
            a.attidentity::text AS identity, a.attgenerated::text AS generated,
            (SELECT s.relname FROM pg_depend dep
               JOIN pg_class s ON s.oid = dep.objid AND s.relkind = 'S'
              WHERE dep.refobjid = a.attrelid AND dep.refobjsubid = a.attnum
                AND dep.deptype = 'i') AS sequence,
            CASE WHEN a.attcollation <> t.typcollation THEN cn.nspname END
              AS collation_schema,
            CASE WHEN a.attcollation <> t.typcollation THEN col.collname END
              AS collation_name,
            col_description(a.attrelid, a.attnum) AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_collation col ON col.oid = a.attcollation
       LEFT JOIN pg_namespace cn ON cn.oid = col.collnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attrelid, a.attnum`,
    [schemas]
  )

  const constraints = await client.query<ConstraintRow>(
    `SELECT k.conrelid::text AS table_oid, k.conname AS name,
            k.contype::text AS type,
            pg_get_constraintdef(k.oid) AS definition,
            ARRAY(SELECT a.attname::text
                    FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                    JOIN pg_attribute a
                      ON a.attrelid = k.conrelid AND a.attnum = u.attnum
                   ORDER BY u.ord) AS columns,
            k.condeferrable AS deferrable, k.condeferred AS deferred,
            CASE WHEN k.contype IN ('p', 'u', 'x') THEN ic.relname END
              AS index,
            fn.nspname AS ref_schema, fc.relname AS ref_table,
            CASE WHEN k.contype = 'f' THEN
              ARRAY(SELECT a.attname::text
                      FROM unnest(k.confkey) WITH ORDINALITY u(attnum, ord)
                      JOIN pg_attribute a
                        ON a.attrelid = k.confrelid AND a.attnum = u.attnum
                     ORDER BY u.ord)
            END AS ref_columns,
            k.confdeltype::text AS on_delete, k.confupdtype::text AS on_update,
            obj_description(k.oid, 'pg_constraint') AS comment
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_class ic ON ic.oid = k.conindid
       LEFT JOIN pg_class fc ON fc.oid = k.confrelid
       LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
        AND k.contype IN ('p', 'u', 'c', 'f', 'x')
      ORDER BY k.conname COLLATE "C"`,
    [schemas]
  )

  const indexes = await client.query<IndexRow>(
    `SELECT i.indexrelid::text AS oid, i.indrelid::text AS table_oid,
            ic.relname AS name,
            pg_get_indexdef(i.indexrelid) AS definition,
            i.indisunique AS unique, am.amname AS method,
            i.indnkeyatts::int AS key_count,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            i.indnullsnotdistinct AS nulls_not_distinct,
            (SELECT k.conname FROM pg_constraint k
              WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid
                AND k.contype IN ('p', 'u', 'x')) AS constraint
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_am am ON am.oid = ic.relam
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
      ORDER BY ic.relname COLLATE "C"`,
    [schemas]
  )

  // Позиції ключа: колонка (`indkey` ≠ 0) чи вираз; `indoption` є лише в
  // ключових позицій, `INCLUDE` іде після них.
  const indexKeys = await client.query<IndexKeyRow>(
    `SELECT i.indexrelid::text AS index_oid, p.n::int AS position,
            a.attname::text AS column,
            pg_get_indexdef(i.indexrelid, p.n, true) AS expression,
            CASE WHEN p.n <= i.indnkeyatts
              THEN i.indoption[p.n - 1]::int END AS option
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL generate_series(1, i.indnatts) p(n)
       LEFT JOIN pg_attribute a
         ON a.attrelid = i.indrelid AND a.attnum = i.indkey[p.n - 1]
        AND i.indkey[p.n - 1] <> 0
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
      ORDER BY i.indexrelid, p.n`,
    [schemas]
  )

  const enums = await client.query<{
    schema: string
    name: string
    values: string[]
    comment: string | null
  }>(
    `SELECT n.nspname AS schema, t.typname AS name,
            array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values,
            obj_description(t.oid, 'pg_type') AS comment
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = ANY($1)
      GROUP BY n.nspname, t.typname, t.oid
      ORDER BY n.nspname COLLATE "C", t.typname COLLATE "C"`,
    [schemas]
  )

  const functions = await client.query<{
    schema: string
    name: string
    arguments: string
    result: string
    comment: string | null
  }>(
    `SELECT n.nspname AS schema, p.proname AS name,
            pg_get_function_identity_arguments(p.oid) AS arguments,
            pg_get_function_result(p.oid) AS result,
            obj_description(p.oid, 'pg_proc') AS comment
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($1) AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                         WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY n.nspname COLLATE "C", p.proname COLLATE "C",
               pg_get_function_identity_arguments(p.oid) COLLATE "C"`,
    [schemas]
  )

  return {
    enumTypes: enums.rows.map((row) => ({
      schema: row.schema,
      name: row.name,
      values: row.values,
      ...optional("comment", row.comment),
    })),
    tables: tables.rows.map((table) => ({
      schema: table.schema,
      name: table.name,
      ...optional("comment", table.comment),
      rowLevelSecurity: table.force_rls
        ? "forced"
        : table.rls
          ? "enabled"
          : "off",
      columns: columns.rows
        .filter((column) => column.table_oid === table.oid)
        .map((column): CatalogColumn => {
          const generated = column.generated === "s"
          return {
            name: column.name,
            type: text(column.type),
            notNull: column.not_null,
            ...(generated
              ? {
                  generated: {
                    expression: text(column.default_expr ?? ""),
                  },
                }
              : optional(
                  "default",
                  column.default_expr === null
                    ? null
                    : text(column.default_expr)
                )),
            ...(column.identity === "a" || column.identity === "d"
              ? {
                  identity: {
                    generation:
                      column.identity === "a"
                        ? ("always" as const)
                        : ("byDefault" as const),
                    sequence: column.sequence ?? "",
                  },
                }
              : {}),
            ...(column.collation_name === null
              ? {}
              : {
                  collation: {
                    ...(column.collation_schema === null ||
                    column.collation_schema === "pg_catalog"
                      ? {}
                      : { schema: column.collation_schema }),
                    name: column.collation_name,
                  },
                }),
            ...optional("comment", column.comment),
          }
        }),
      constraints: constraints.rows
        .filter((constraint) => constraint.table_oid === table.oid)
        .map((constraint) => ({
          name: constraint.name,
          type: CONSTRAINT_TYPES[constraint.type] ?? "check",
          definition: text(constraint.definition),
          columns: constraint.columns,
          deferrable: constraint.deferrable,
          initiallyDeferred: constraint.deferred,
          ...optional("index", constraint.index),
          ...(constraint.type === "f"
            ? {
                references: {
                  schema: constraint.ref_schema ?? "",
                  table: constraint.ref_table ?? "",
                  columns: constraint.ref_columns ?? [],
                  onDelete: FK_ACTIONS[constraint.on_delete] ?? "noAction",
                  onUpdate: FK_ACTIONS[constraint.on_update] ?? "noAction",
                },
              }
            : {}),
          ...optional("comment", constraint.comment),
        }))
        .sort((a, b) => byCodePoint(a.name, b.name)),
      indexes: indexes.rows
        .filter((index) => index.table_oid === table.oid)
        .map((index): CatalogIndex => {
          const positions = indexKeys.rows.filter(
            (key) => key.index_oid === index.oid
          )
          return {
            name: index.name,
            definition: text(index.definition),
            unique: index.unique,
            method: index.method,
            keys: positions
              .filter((key) => key.position <= index.key_count)
              .map((key) => indexKey(key, text)),
            include: positions
              .filter((key) => key.position > index.key_count)
              .map((key) => key.column ?? text(key.expression)),
            ...optional(
              "where",
              index.predicate === null ? null : text(index.predicate)
            ),
            nullsNotDistinct: index.nulls_not_distinct,
            ...optional("constraint", index.constraint),
          }
        })
        .sort((a, b) => byCodePoint(a.name, b.name)),
    })),
    functions: functions.rows.map((fn) => ({
      schema: fn.schema,
      name: fn.name,
      arguments: text(fn.arguments),
      result: text(fn.result),
      ...optional("comment", fn.comment),
    })),
  }
}
