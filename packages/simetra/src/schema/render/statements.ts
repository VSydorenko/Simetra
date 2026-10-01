import {
  quoteIdent,
  type PgQualifiedName,
  type PhysicalColumn,
  type PhysicalEnumType,
  type PhysicalIndexKey,
  type PhysicalTable,
} from "simetra/model"

/** One rendered DDL statement, terminated with `;`. */
export interface RenderedStatement {
  kind:
    | "schema"
    | "enumType"
    | "table"
    | "foreignKey"
    | "index"
    | "rowLevelSecurity"
    | "comment"
    | "unit"
  /** `schema.name` of the object the statement belongs to (unit identity for units). */
  object: string
  sql: string
}

const qualified = (schema: string, name: string) =>
  `${quoteIdent(schema)}.${quoteIdent(name)}`

const identList = (names: readonly string[]) => names.map(quoteIdent).join(", ")

// Схема `pg_catalog` у знімку опущена: ім'я без схеми Postgres сам шукає там.
const qualifiedName = ({ schema, name }: PgQualifiedName) =>
  schema === undefined ? quoteIdent(name) : qualified(schema, name)

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

const DEFERRABLE_SQL = {
  deferrable: "DEFERRABLE",
  initiallyDeferred: "DEFERRABLE INITIALLY DEFERRED",
} as const

const FK_ACTION_SQL = {
  noAction: "NO ACTION",
  restrict: "RESTRICT",
  cascade: "CASCADE",
  setNull: "SET NULL",
  setDefault: "SET DEFAULT",
} as const

function renderColumn(table: PhysicalTable, column: PhysicalColumn): string {
  const parts = [quoteIdent(column.name), column.type]
  if (column.collation) parts.push(`COLLATE ${qualifiedName(column.collation)}`)
  if (column.identity) {
    const mode =
      column.identity.generation === "always" ? "ALWAYS" : "BY DEFAULT"
    // Ім'я послідовності закріплене явно: його обирає компілятор, і каталог
    // має збігтися зі знімком, а не з вибором Postgres.
    parts.push(
      `GENERATED ${mode} AS IDENTITY (SEQUENCE NAME ${qualified(table.schema, column.identity.sequence)})`
    )
  }
  if (column.generated) {
    parts.push(`GENERATED ALWAYS AS (${column.generated.expression}) STORED`)
  }
  if (column.default !== undefined) parts.push(`DEFAULT ${column.default}`)
  if (column.notNull) parts.push("NOT NULL")
  return parts.join(" ")
}

/**
 * Renders `CREATE TABLE` with columns, primary key, unique and check
 * constraints. Foreign keys are rendered separately (`renderForeignKeys`) so
 * they can be added after every table exists.
 */
export function renderTable(table: PhysicalTable): RenderedStatement[] {
  const object = `${table.schema}.${table.name}`
  const lines = table.columns.map((column) => renderColumn(table, column))
  if (table.primaryKey) {
    const pk = table.primaryKey
    lines.push(
      [
        `CONSTRAINT ${quoteIdent(pk.name)} PRIMARY KEY (${identList(pk.columns)})`,
        pk.deferrable && DEFERRABLE_SQL[pk.deferrable],
      ]
        .filter(Boolean)
        .join(" ")
    )
  }
  for (const unique of table.uniques) {
    lines.push(
      [
        `CONSTRAINT ${quoteIdent(unique.name)} UNIQUE`,
        unique.nullsNotDistinct && "NULLS NOT DISTINCT",
        `(${identList(unique.columns)})`,
        unique.deferrable && DEFERRABLE_SQL[unique.deferrable],
      ]
        .filter(Boolean)
        .join(" ")
    )
  }
  for (const check of table.checks) {
    lines.push(
      `CONSTRAINT ${quoteIdent(check.name)} CHECK (${check.expression})`
    )
  }
  return [
    {
      kind: "table",
      object,
      sql: `CREATE TABLE ${qualified(table.schema, table.name)} (\n  ${lines.join(",\n  ")}\n);`,
    },
  ]
}

function renderIndexKey(key: PhysicalIndexKey): string {
  const parts = [
    "column" in key ? quoteIdent(key.column) : `(${key.expression})`,
  ]
  if (key.collation) parts.push(`COLLATE ${qualifiedName(key.collation)}`)
  if (key.opclass) parts.push(qualifiedName(key.opclass))
  if (key.order) parts.push(key.order === "asc" ? "ASC" : "DESC")
  if (key.nulls)
    parts.push(key.nulls === "first" ? "NULLS FIRST" : "NULLS LAST")
  return parts.join(" ")
}

/** Renders `CREATE INDEX` for every index of the table, in snapshot order. */
export function renderIndexes(table: PhysicalTable): RenderedStatement[] {
  return table.indexes.map((index) => {
    const sql = [
      `CREATE${index.unique ? " UNIQUE" : ""} INDEX ${quoteIdent(index.name)}`,
      `ON ${qualified(table.schema, table.name)}`,
      `USING ${index.method}`,
      `(${index.keys.map(renderIndexKey).join(", ")})`,
      index.include.length > 0 && `INCLUDE (${identList(index.include)})`,
      index.nullsNotDistinct && "NULLS NOT DISTINCT",
      index.where !== undefined && `WHERE ${index.where}`,
    ]
      .filter(Boolean)
      .join(" ")
    return {
      kind: "index" as const,
      object: `${table.schema}.${index.name}`,
      sql: `${sql};`,
    }
  })
}

/** Renders `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` for every foreign key. */
export function renderForeignKeys(table: PhysicalTable): RenderedStatement[] {
  return table.foreignKeys.map((fk) => {
    const sql = [
      `ALTER TABLE ${qualified(table.schema, table.name)}`,
      `ADD CONSTRAINT ${quoteIdent(fk.name)}`,
      `FOREIGN KEY (${identList(fk.columns)})`,
      `REFERENCES ${qualified(fk.references.schema, fk.references.table)} (${identList(fk.references.columns)})`,
      `ON DELETE ${FK_ACTION_SQL[fk.onDelete]}`,
      `ON UPDATE ${FK_ACTION_SQL[fk.onUpdate]}`,
      fk.deferrable !== "no" && DEFERRABLE_SQL[fk.deferrable],
    ]
      .filter(Boolean)
      .join(" ")
    return {
      kind: "foreignKey" as const,
      object: `${table.schema}.${table.name}`,
      sql: `${sql};`,
    }
  })
}

/** Renders `CREATE TYPE … AS ENUM` with the values in their declared order. */
export function renderEnumType(type: PhysicalEnumType): RenderedStatement {
  return {
    kind: "enumType",
    object: `${type.schema}.${type.name}`,
    sql: `CREATE TYPE ${qualified(type.schema, type.name)} AS ENUM (${type.values.map(literal).join(", ")});`,
  }
}

/** Renders `ENABLE` and, for forced RLS, `FORCE ROW LEVEL SECURITY`; nothing when off. */
export function renderRowLevelSecurity(
  table: PhysicalTable
): RenderedStatement[] {
  if (table.rowLevelSecurity === "off") return []
  const target = qualified(table.schema, table.name)
  const modes =
    table.rowLevelSecurity === "forced" ? ["ENABLE", "FORCE"] : ["ENABLE"]
  return modes.map((mode) => ({
    kind: "rowLevelSecurity" as const,
    object: `${table.schema}.${table.name}`,
    sql: `ALTER TABLE ${target} ${mode} ROW LEVEL SECURITY;`,
  }))
}

/** Renders `COMMENT ON TABLE` and `COMMENT ON COLUMN` for the commented parts. */
export function renderComments(table: PhysicalTable): RenderedStatement[] {
  const target = qualified(table.schema, table.name)
  const object = `${table.schema}.${table.name}`
  const statements: RenderedStatement[] = []
  if (table.comment !== undefined) {
    statements.push({
      kind: "comment",
      object,
      sql: `COMMENT ON TABLE ${target} IS ${literal(table.comment)};`,
    })
  }
  for (const column of table.columns) {
    if (column.comment === undefined) continue
    statements.push({
      kind: "comment",
      object,
      sql: `COMMENT ON COLUMN ${target}.${quoteIdent(column.name)} IS ${literal(column.comment)};`,
    })
  }
  return statements
}
