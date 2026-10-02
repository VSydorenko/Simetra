import { diagnostic, type Diagnostic } from "simetra/compiler"
import {
  logicalTypeOf,
  type CatalogColumn,
  type CatalogEnumType,
  type CatalogTable,
  type PgQualifiedName,
  type PhysicalIndexKey,
} from "simetra/model"
import type { ExistingObject } from "./identity"

type Json = Record<string, unknown>

/** Логічні імена згенерованої таблиці: об'єкт і колонки за фізичним іменем. */
export interface TableNames {
  object: string
  columns: ReadonlyMap<string, string>
}

export interface TablesContext {
  defaultSchema: string
  /** Згенеровані таблиці за `schema.name`; решта цілей FK — зовнішні. */
  tables: ReadonlyMap<string, TableNames>
  /** Згенеровані енам-типи: `schema.name` → логічне ім'я. */
  enums: ReadonlyMap<string, string>
}

const qualified = (schema: string, name: string) => `${schema}.${name}`

// Поля, які генератор уміє виразити. Поле поза ними (нова властивість моделі
// каталогу, EXCLUDE) — гучна помилка: інакше файл мовчки його загубив би.
const TABLE_FIELDS: ReadonlySet<string> = new Set([
  "schema",
  "name",
  "comment",
  "rowLevelSecurity",
  "columns",
  "primaryKey",
  "uniques",
  "checks",
  "foreignKeys",
  "indexes",
])
const COLUMN_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "type",
  "notNull",
  "default",
  "identity",
  "generated",
  "collation",
  "comment",
])

/**
 * Невиражене таблицею (план E2b, рішення 8): поле поза формою `CustomTable`
 * і таблиця без колонок (`CustomTable` вимагає хоч одну).
 */
export function unrepresentableTable(table: CatalogTable): Diagnostic[] {
  const object = qualified(table.schema, table.name)
  const found = (o: string, property: string, detail: string) =>
    diagnostic("introspect.unrepresentable", "", "", {
      object: o,
      property,
      detail,
    })
  const result: Diagnostic[] = []
  for (const key of Object.keys(table).sort())
    if (!TABLE_FIELDS.has(key))
      result.push(found(object, key, "CustomTable has no field for it"))
  if (table.columns.length === 0)
    result.push(
      found(object, "columns", "CustomTable needs at least one column")
    )
  for (const column of table.columns)
    for (const key of Object.keys(column).sort())
      if (!COLUMN_FIELDS.has(key))
        result.push(
          found(
            `${object}.${column.name}`,
            key,
            "a CustomTable column has no field for it"
          )
        )
  return result
}

/** PgEnum вимагає хоч одне значення; порожній енам-тип Postgres дозволяє. */
export function unrepresentableEnum(type: CatalogEnumType): Diagnostic[] {
  return type.values.length > 0
    ? []
    : [
        diagnostic("introspect.unrepresentable", "", "", {
          object: qualified(type.schema, type.name),
          property: "values",
          detail: "PgEnum needs at least one value",
        }),
      ]
}

/**
 * Типові класи операторів (`pg_opclass.opcdefault`) для типів, яких
 * найчастіше торкаються індекси: явний типовий клас дав би другу форму
 * знімка (борг F). Тип поза переліком лишає клас як є — це не втрата, лише
 * зайве поле.
 */
const DEFAULT_OPCLASSES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  btree: {
    smallint: "int2_ops",
    integer: "int4_ops",
    bigint: "int8_ops",
    numeric: "numeric_ops",
    real: "float4_ops",
    "double precision": "float8_ops",
    text: "text_ops",
    "character varying": "text_ops",
    uuid: "uuid_ops",
    boolean: "bool_ops",
    date: "date_ops",
    "time without time zone": "time_ops",
    "timestamp without time zone": "timestamp_ops",
    "timestamp with time zone": "timestamptz_ops",
    interval: "interval_ops",
    bytea: "bytea_ops",
    jsonb: "jsonb_ops",
  },
  gin: { jsonb: "jsonb_ops" },
}

const DEFAULT_COLLATION = "default"

const isDefaultCollation = (c: PgQualifiedName | undefined) =>
  c !== undefined && c.schema === undefined && c.name === DEFAULT_COLLATION

const sameName = (a: PgQualifiedName, b: PgQualifiedName | undefined) =>
  b !== undefined && a.schema === b.schema && a.name === b.name

function isDefaultOpclass(
  method: string,
  opclass: PgQualifiedName,
  column: CatalogColumn | undefined
): boolean {
  if (column === undefined || opclass.schema !== undefined) return false
  // Модифікатор типу клас операторів не змінює: `varchar(20)` — `varchar`.
  const base = column.type.replace(/\(.*\)$/, "")
  return DEFAULT_OPCLASSES[method]?.[base] === opclass.name
}

/** Тип колонки (рішення плану 5): логічний, посилання на PgEnum або `Raw`. */
function columnType(type: string, ctx: TablesContext): Json {
  const enumSet = new Set(ctx.enums.keys())
  const enumRef = (schema: string, name: string) => ({
    type: "PgEnum",
    enum: { kind: "PgEnum", name: ctx.enums.get(qualified(schema, name))! },
  })
  const form = logicalTypeOf(type, enumSet)
  if (form.form === "logical") return { ...form.value }
  if (form.form === "enum") return enumRef(form.schema, form.name)
  // Масив енаму T0 лишає сирим, а PgEnum виражає його прапорцем `array`.
  if (type.endsWith("[]")) {
    const element = logicalTypeOf(type.slice(0, -2), enumSet)
    if (element.form === "enum")
      return { ...enumRef(element.schema, element.name), array: true }
  }
  return { type: "Raw", pgType: type }
}

function column(
  c: CatalogColumn,
  name: string,
  ctx: TablesContext,
  existing: Json | undefined
): Json {
  return {
    ...(typeof existing?.id === "string" ? { id: existing.id } : {}),
    name,
    physicalName: c.name,
    ...(existing?.title !== undefined ? { title: existing.title } : {}),
    ...(c.notNull ? { notNull: true } : {}),
    ...(c.default !== undefined ? { default: c.default } : {}),
    ...(c.identity !== undefined ? { identity: c.identity.generation } : {}),
    ...(c.generated !== undefined ? { generated: c.generated } : {}),
    ...(c.collation !== undefined && !isDefaultCollation(c.collation)
      ? { collation: c.collation }
      : {}),
    ...(c.comment !== undefined ? { comment: c.comment } : {}),
    ...columnType(c.type, ctx),
  }
}

/** Логічні імена колонок таблиці; колонка без імені вже названа діагностикою. */
function logical(names: TableNames, physical: readonly string[]): string[] {
  return physical.map((p) => names.columns.get(p) ?? p)
}

function foreignKey(
  fk: CatalogTable["foreignKeys"][number],
  names: TableNames,
  ctx: TablesContext
): Json {
  const { schema, table, columns } = fk.references
  const target = ctx.tables.get(qualified(schema, table))
  return {
    name: fk.name,
    columns: logical(names, fk.columns),
    references:
      target === undefined
        ? { external: { schema, table, columns } }
        : {
            object: { kind: "CustomTable", name: target.object },
            columns: logical(target, columns),
          },
    ...(fk.onDelete !== "noAction" ? { onDelete: fk.onDelete } : {}),
    ...(fk.onUpdate !== "noAction" ? { onUpdate: fk.onUpdate } : {}),
    ...(fk.deferrable !== "no" ? { deferrable: fk.deferrable } : {}),
  }
}

function indexKey(
  key: PhysicalIndexKey,
  method: string,
  names: TableNames,
  columns: ReadonlyMap<string, CatalogColumn>
): Json {
  const own = "column" in key ? columns.get(key.column) : undefined
  const { opclass, collation } = key
  // Колляція ключа, рівна колляції колонки, — та сама, що без неї.
  const columnCollation =
    own === undefined
      ? undefined
      : (own.collation ?? { name: DEFAULT_COLLATION })
  return {
    ...("column" in key
      ? { column: names.columns.get(key.column) ?? key.column }
      : { expression: key.expression }),
    ...(key.order !== undefined ? { order: key.order } : {}),
    ...(key.nulls !== undefined ? { nulls: key.nulls } : {}),
    ...(opclass !== undefined && !isDefaultOpclass(method, opclass, own)
      ? { opclass }
      : {}),
    ...(collation !== undefined &&
    !(own !== undefined && sameName(collation, columnCollation))
      ? { collation }
      : {}),
  }
}

/**
 * Опис `CustomTable` з таблиці каталогу: імена обмежень явні, фізичні імена —
 * поточні, значення за замовчуванням схеми файлу не пишуться (рішення 8).
 * З наявного опису беруться id і те, чого база не знає (заголовки, скоуп).
 */
export function customTableData(
  table: CatalogTable,
  names: TableNames,
  ctx: TablesContext,
  existing: ExistingObject | undefined
): Json {
  const raw = existing?.raw
  const byName = new Map(table.columns.map((c) => [c.name, c]))
  const scopeColumn = scopeColumnOf(existing, names)
  return {
    ...(typeof raw?.id === "string" ? { id: raw.id } : {}),
    kind: "CustomTable",
    name: names.object,
    physicalName: table.name,
    ...(table.schema !== ctx.defaultSchema ? { schema: table.schema } : {}),
    ...pick(raw, ["scope", "title", "description"]),
    ...(table.comment !== undefined ? { comment: table.comment } : {}),
    columns: table.columns.map((c) =>
      column(c, names.columns.get(c.name)!, ctx, existing?.columns.get(c.name))
    ),
    ...(table.primaryKey !== undefined
      ? {
          primaryKey: {
            name: table.primaryKey.name,
            columns: logical(names, table.primaryKey.columns),
            ...(table.primaryKey.deferrable !== undefined
              ? { deferrable: table.primaryKey.deferrable }
              : {}),
          },
        }
      : {}),
    ...nonEmpty(
      "uniques",
      table.uniques.map((u) => ({
        name: u.name,
        columns: logical(names, u.columns),
        ...(u.nullsNotDistinct ? { nullsNotDistinct: true } : {}),
        ...(u.deferrable !== undefined ? { deferrable: u.deferrable } : {}),
      }))
    ),
    ...nonEmpty("checks", table.checks),
    ...nonEmpty(
      "foreignKeys",
      table.foreignKeys.map((fk) => foreignKey(fk, names, ctx))
    ),
    ...nonEmpty(
      "indexes",
      table.indexes.map((index) => ({
        name: index.name,
        ...(index.unique ? { unique: true } : {}),
        ...(index.method !== "btree" ? { method: index.method } : {}),
        keys: index.keys.map((key) =>
          indexKey(key, index.method, names, byName)
        ),
        ...nonEmpty("include", logical(names, index.include)),
        ...(index.where !== undefined ? { where: index.where } : {}),
        ...(index.nullsNotDistinct ? { nullsNotDistinct: true } : {}),
      }))
    ),
    ...(scopeColumn !== undefined ? { scopeColumn } : {}),
    ...(table.rowLevelSecurity !== "off"
      ? { rowLevelSecurity: table.rowLevelSecurity }
      : {}),
  }
}

/** Опис `PgEnum`: значення — мітки в порядку бази. */
export function pgEnumData(
  type: CatalogEnumType,
  name: string,
  defaultSchema: string,
  existing: ExistingObject | undefined
): Json {
  const raw = existing?.raw
  return {
    ...(typeof raw?.id === "string" ? { id: raw.id } : {}),
    kind: "PgEnum",
    name,
    physicalName: type.name,
    ...(type.schema !== defaultSchema ? { schema: type.schema } : {}),
    ...pick(raw, ["title", "description"]),
    values: type.values,
  }
}

/**
 * Скоуп-колонку база не знає: її назвав автор. Вона лишається, доки колонка з
 * тим самим фізичним іменем є в таблиці.
 */
function scopeColumnOf(
  existing: ExistingObject | undefined,
  names: TableNames
): string | undefined {
  const declared = existing?.raw.scopeColumn
  if (typeof declared !== "string") return undefined
  for (const [physical, c] of existing!.columns)
    if (c.name === declared) return names.columns.get(physical)
  return undefined
}

function pick(raw: Json | undefined, keys: readonly string[]): Json {
  if (raw === undefined) return {}
  return Object.fromEntries(
    keys.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])
  )
}

function nonEmpty(key: string, items: readonly unknown[]): Json {
  return items.length > 0 ? { [key]: items } : {}
}
