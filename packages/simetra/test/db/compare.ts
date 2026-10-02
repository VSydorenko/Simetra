import { expect } from "vitest"
import type {
  PhysicalIndexKey,
  PhysicalSnapshot,
  PhysicalTable,
} from "../../src/model"
import {
  normalizer,
  type CatalogConstraint,
  type CatalogIndexKey,
  type CatalogShape,
  type CatalogTable,
} from "./catalog"

type Deferral = "no" | "deferrable" | "initiallyDeferred"

const byName = <T extends { name: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

const deferralOf = (constraint: CatalogConstraint): Deferral =>
  constraint.initiallyDeferred
    ? "initiallyDeferred"
    : constraint.deferrable
      ? "deferrable"
      : "no"

/**
 * Ключ індексу для звірки: вираз — лише на наявність, бо його канонічну форму
 * дає Postgres (спека §9), а знімок тримає авторську. Клас операторів і
 * колляцію ключа каталог тут не читає — вони поза звіркою E1.
 */
function keyShape(key: PhysicalIndexKey | CatalogIndexKey) {
  return {
    ...("column" in key ? { column: key.column } : { expression: true }),
    order: key.order === "desc" ? "desc" : "asc",
    ...(key.nulls !== undefined ? { nulls: key.nulls } : {}),
  }
}

/** Порівнювана форма таблиці знімка: імена й структура, вирази — наявністю. */
function snapshotShape(table: PhysicalTable, normalize: (s: string) => string) {
  return {
    comment: table.comment,
    rowLevelSecurity: table.rowLevelSecurity,
    columns: table.columns.map((column) => ({
      name: column.name,
      type: normalize(column.type),
      notNull: column.notNull,
      default: column.default !== undefined,
      identity: column.identity,
      generated: column.generated !== undefined,
      collation: column.collation,
      comment: column.comment,
    })),
    primaryKey:
      table.primaryKey === undefined
        ? undefined
        : {
            name: table.primaryKey.name,
            columns: table.primaryKey.columns,
            deferrable: table.primaryKey.deferrable ?? "no",
          },
    uniques: byName(table.uniques).map((unique) => ({
      name: unique.name,
      columns: unique.columns,
      nullsNotDistinct: unique.nullsNotDistinct,
      deferrable: unique.deferrable ?? "no",
    })),
    checks: byName(table.checks).map((check) => check.name),
    foreignKeys: byName(table.foreignKeys).map((fk) => ({
      name: fk.name,
      columns: fk.columns,
      references: fk.references,
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
      deferrable: fk.deferrable,
    })),
    indexes: byName(table.indexes).map((index) => ({
      name: index.name,
      unique: index.unique,
      method: index.method,
      keys: index.keys.map(keyShape),
      include: index.include,
      where: index.where !== undefined,
      nullsNotDistinct: index.nullsNotDistinct,
    })),
  }
}

/** Та сама форма з каталогу; індекси PK/UNIQUE — частина обмежень, не знімка. */
function catalogShape(table: CatalogTable) {
  const ofType = (type: CatalogConstraint["type"]) =>
    table.constraints.filter((constraint) => constraint.type === type)
  const [primaryKey, ...extraKeys] = ofType("primaryKey")
  expect(extraKeys).toEqual([])
  const indexOf = (constraint: CatalogConstraint) =>
    table.indexes.find((index) => index.name === constraint.index)
  return {
    comment: table.comment,
    rowLevelSecurity: table.rowLevelSecurity,
    columns: table.columns.map((column) => ({
      name: column.name,
      type: column.type,
      notNull: column.notNull,
      default: column.default !== undefined,
      identity: column.identity,
      generated: column.generated !== undefined,
      collation: column.collation,
      comment: column.comment,
    })),
    primaryKey:
      primaryKey === undefined
        ? undefined
        : {
            name: primaryKey.name,
            columns: primaryKey.columns,
            deferrable: deferralOf(primaryKey),
          },
    uniques: byName(ofType("unique")).map((unique) => ({
      name: unique.name,
      columns: unique.columns,
      nullsNotDistinct: indexOf(unique)?.nullsNotDistinct,
      deferrable: deferralOf(unique),
    })),
    checks: byName(ofType("check")).map((check) => check.name),
    foreignKeys: byName(ofType("foreignKey")).map((fk) => ({
      name: fk.name,
      columns: fk.columns,
      references: fk.references && {
        schema: fk.references.schema,
        table: fk.references.table,
        columns: fk.references.columns,
      },
      onDelete: fk.references?.onDelete,
      onUpdate: fk.references?.onUpdate,
      deferrable: deferralOf(fk),
    })),
    // Каталог інших типів обмежень (EXCLUDE) знімок не має — вони б тут
    // вилізли розбіжністю імен.
    others: ofType("exclusion").map((constraint) => constraint.name),
    indexes: byName(
      table.indexes.filter((index) => index.constraint === undefined)
    ).map((index) => ({
      name: index.name,
      unique: index.unique,
      method: index.method,
      keys: index.keys.map(keyShape),
      include: index.include,
      where: index.where !== undefined,
      nullsNotDistinct: index.nullsNotDistinct,
    })),
  }
}

/**
 * Asserts that the catalog read after deploying a desired state matches the
 * physical snapshot it was rendered from: the same tables and enum types,
 * and per table the same columns in order, keys, checks, foreign keys,
 * indexes and RLS. Expression texts are compared by presence only, since
 * Postgres owns their canonical form.
 */
export function expectCatalogMatchesSnapshot(
  catalog: CatalogShape,
  physical: PhysicalSnapshot
): void {
  const schemas = [
    ...new Set([
      ...physical.tables.map((table) => table.schema),
      ...physical.enumTypes.map((type) => type.schema),
    ]),
  ]
  const normalize = normalizer(schemas)
  const key = (item: { schema: string; name: string }) =>
    `${item.schema}.${item.name}`

  expect(catalog.tables.map(key).sort()).toEqual(
    physical.tables.map(key).sort()
  )
  // Порядок типів — за (схема, ім'я) з обох боків: звіряється вміст, а не
  // порядок обходу; порядок значень усередині типу — частина звірки.
  const enumShape = (
    types: { schema: string; name: string; values: string[] }[]
  ) =>
    types
      .map(({ schema, name, values }) => ({ schema, name, values }))
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  expect(enumShape(catalog.enumTypes)).toEqual(enumShape(physical.enumTypes))

  for (const table of physical.tables) {
    const found = catalog.tables.find((t) => key(t) === key(table))!
    expect(catalogShape(found), key(table)).toEqual({
      ...snapshotShape(table, normalize),
      others: [],
    })
  }
}
