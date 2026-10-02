import type { Fact, FactBase, StableId } from "@supabase/pg-delta"
import type { SqlParser } from "simetra/compiler"
import type {
  CatalogColumn,
  CatalogEnumType,
  CatalogTable,
  PgQualifiedName,
} from "simetra/model"
import {
  parseConstraintDefinition,
  parseIndexDefinition,
} from "./map-definitions"

/**
 * Властивість факту, якої модель каталогу не виражає: адаптер робить із неї
 * діагностику `engine.unrepresentable`, а не мовчки її губить (план E2a,
 * рішення 5).
 */
export interface MappingIssue {
  object: StableId
  property: string
  detail: string
}

/** Ключі payload, які мапер читає; решта (крім службових `_…`) — невідомі. */
const KNOWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  table: [
    "persistence",
    "rowSecurity",
    "forceRowSecurity",
    "replicaIdentity",
    "replicaIdentityIndex",
    "partitionKey",
    "partitionBound",
    "parentTable",
    "reloptions",
  ],
  column: ["type", "notNull", "identity", "collation", "generatedExpr"],
  default: ["expr"],
  constraint: ["def", "type", "validated"],
  index: ["def", "valid", "attachedTo"],
  type: ["variant", "values"],
}

/**
 * Невідомий ключ payload — гучна помилка: закріплена версія двигуна його не
 * має, а нова могла додати властивість, яку модель тихо загубила б.
 */
export function unknownKeys(fact: Fact, issues: MappingIssue[]): void {
  const known = KNOWN_KEYS[fact.id.kind] ?? []
  for (const key of Object.keys(fact.payload)) {
    if (key.startsWith("_") || known.includes(key)) continue
    issues.push({
      object: fact.id,
      property: key,
      detail: "the pinned engine version has no such property",
    })
  }
}

function text(value: unknown): string {
  if (typeof value !== "string")
    throw new Error(`pg-delta fact field is not a string: ${String(value)}`)
  return value
}

/** Частини кваліфікованого імені з лапками (`pg_catalog."C"`); `""` — лапка. */
function nameParts(qualified: string): string[] {
  const parts: string[] = []
  let current = ""
  let quoted = false
  for (let i = 0; i < qualified.length; i++) {
    const ch = qualified[i]!
    if (quoted && ch === '"' && qualified[i + 1] === '"') {
      current += '"'
      i++
    } else if (ch === '"') {
      quoted = !quoted
    } else if (ch === "." && !quoted) {
      parts.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

/** Колляція у формі знімка: `pg_catalog."C"` → `{ name: "C" }`. */
function collationOf(value: string): PgQualifiedName {
  const parts = nameParts(value)
  const name = parts.at(-1) ?? ""
  const schema = parts.length > 1 ? parts.at(-2) : undefined
  return schema === undefined || schema === "pg_catalog"
    ? { name }
    : { schema, name }
}

/** Найбільше значення identity-послідовності за замовчуванням для типу колонки. */
const IDENTITY_MAX: Readonly<Record<string, string>> = {
  smallint: "32767",
  integer: "2147483647",
  bigint: "9223372036854775807",
}

interface IdentityPayload {
  generation: string
  sequence: { schema: string; name: string } | null
  options: {
    increment: string
    start: string
    minValue: string
    maxValue: string
    cache: string
    cycle: boolean
  } | null
}

/**
 * Identity у формі знімка — режим і ім'я послідовності; параметри
 * послідовності знімок не має, тож нетипові для типу колонки — гучна помилка.
 */
function identityOf(
  column: Fact,
  table: { schema: string },
  type: string,
  issues: MappingIssue[]
): CatalogColumn["identity"] {
  const identity = column.payload.identity as IdentityPayload | null
  if (identity === null || identity === undefined) return undefined
  const generation =
    identity.generation === "a"
      ? "always"
      : identity.generation === "d"
        ? "byDefault"
        : undefined
  if (generation === undefined || identity.sequence === null) {
    issues.push({
      object: column.id,
      property: "identity",
      detail: `identity ${JSON.stringify(identity)} has no generation or sequence`,
    })
    return undefined
  }
  if (identity.sequence.schema !== table.schema)
    issues.push({
      object: column.id,
      property: "identity.sequence",
      detail: `sequence ${identity.sequence.schema}.${identity.sequence.name} is outside the table schema`,
    })
  const o = identity.options
  const typical =
    o === null ||
    (o.increment === "1" &&
      o.start === "1" &&
      o.minValue === "1" &&
      o.maxValue === IDENTITY_MAX[type] &&
      o.cache === "1" &&
      !o.cycle)
  if (!typical)
    issues.push({
      object: column.id,
      property: "identity.options",
      detail: `sequence options ${JSON.stringify(o)} are not the defaults for ${type}`,
    })
  return { generation, sequence: identity.sequence.name }
}

/** Текст коментаря-сателіта об'єкта, якщо він є. */
function commentOf(view: FactBase, target: StableId): string | undefined {
  const comment = view.get({ kind: "comment", target })
  return comment === undefined ? undefined : text(comment.payload.text)
}

function mapColumn(
  view: FactBase,
  column: Fact,
  table: { schema: string; name: string },
  issues: MappingIssue[]
): CatalogColumn {
  unknownKeys(column, issues)
  const p = column.payload
  if (p._partitionKey === true)
    issues.push({
      object: column.id,
      property: "partitionKey",
      detail: "column is part of a partition key",
    })
  const name = "name" in column.id ? column.id.name : ""
  const type = text(p.type)
  const defaultFact = view.get({
    kind: "default",
    schema: table.schema,
    table: table.name,
    name,
  })
  if (defaultFact !== undefined) unknownKeys(defaultFact, issues)
  const identity = identityOf(column, table, type, issues)
  const comment = commentOf(view, column.id)
  return {
    name,
    type,
    notNull: p.notNull === true,
    ...(defaultFact === undefined
      ? {}
      : { default: text(defaultFact.payload.expr) }),
    ...(identity === undefined ? {} : { identity }),
    ...(typeof p.generatedExpr === "string"
      ? { generated: { expression: p.generatedExpr } }
      : {}),
    ...(typeof p.collation === "string"
      ? { collation: collationOf(p.collation) }
      : {}),
    ...(comment === undefined ? {} : { comment }),
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const byName = <T extends { name: string }>(items: T[]): T[] =>
  items.sort((a, b) => compare(a.name, b.name))

/** Властивості таблиці, яких знімок не має: лише типове значення — не помилка. */
function tableProperties(fact: Fact, issues: MappingIssue[]): void {
  const p = fact.payload
  if (p.persistence !== "p")
    issues.push({
      object: fact.id,
      property: "persistence",
      detail: `persistence "${String(p.persistence)}" (unlogged or temporary) has no field in the catalog model`,
    })
  for (const key of [
    "partitionKey",
    "partitionBound",
    "parentTable",
    "reloptions",
  ]) {
    if (p[key] !== null && p[key] !== undefined)
      issues.push({
        object: fact.id,
        property: key,
        detail: `${JSON.stringify(p[key])} has no field in the catalog model`,
      })
  }
}

/**
 * Таблиця моделі з факту двигуна і його дочірніх фактів: колонки за
 * `_position`, обмеження з `def`, індекси (окрім індексів PK/UNIQUE — окремих
 * фактів у них немає), коментарі. `REPLICA IDENTITY` — не поле, а одиниця
 * (рішення за спайком, 3), її мапить `map-units`.
 */
export function mapTable(
  view: FactBase,
  fact: Fact,
  parse: SqlParser,
  issues: MappingIssue[]
): CatalogTable {
  unknownKeys(fact, issues)
  tableProperties(fact, issues)
  const id = fact.id as { schema: string; name: string }
  const table = { schema: id.schema, name: id.name }
  const children = view.childrenOf(fact.id)
  const columns = children
    .filter((c) => c.id.kind === "column")
    .sort((a, b) => Number(a.payload._position) - Number(b.payload._position))
    .map((c) => mapColumn(view, c, table, issues))
  const p = fact.payload
  const result: CatalogTable = {
    schema: table.schema,
    name: table.name,
    rowLevelSecurity:
      p.rowSecurity !== true
        ? "off"
        : p.forceRowSecurity === true
          ? "forced"
          : "enabled",
    columns,
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
  }
  const comment = commentOf(view, fact.id)
  if (comment !== undefined) result.comment = comment
  for (const child of children) {
    if (child.id.kind === "constraint") constraint(child)
    else if (child.id.kind === "index") index(child)
  }
  byName(result.uniques)
  byName(result.checks)
  byName(result.foreignKeys)
  byName(result.indexes)
  return result

  function constraint(child: Fact): void {
    unknownKeys(child, issues)
    const name = "name" in child.id ? child.id.name : ""
    // NOT VALID — властивість факту, а не лише тексту: обмеження в модель не
    // йде, бо знімок вимагає перевірених рядків
    if (child.payload.validated !== true) {
      issues.push({
        object: child.id,
        property: "validated",
        detail: "constraint is NOT VALID",
      })
      return
    }
    const parsed = parseConstraintDefinition(
      parse,
      table,
      name,
      text(child.payload.def)
    )
    switch (parsed.type) {
      case "primaryKey":
        result.primaryKey = parsed.value
        return
      case "unique":
        result.uniques.push(parsed.value)
        return
      case "check":
        result.checks.push(parsed.value)
        return
      case "foreignKey":
        result.foreignKeys.push(parsed.value)
        return
      case "unrepresentable":
        issues.push({
          object: child.id,
          property: "def",
          detail: parsed.reason,
        })
    }
  }

  function index(child: Fact): void {
    unknownKeys(child, issues)
    if (child.payload.valid !== true)
      issues.push({
        object: child.id,
        property: "valid",
        detail: "index is invalid (a failed concurrent build)",
      })
    if (
      child.payload.attachedTo !== null &&
      child.payload.attachedTo !== undefined
    )
      issues.push({
        object: child.id,
        property: "attachedTo",
        detail: "index is a partition of a partitioned index",
      })
    const parsed = parseIndexDefinition(parse, text(child.payload.def))
    if (parsed.type === "unrepresentable") {
      issues.push({ object: child.id, property: "def", detail: parsed.reason })
      return
    }
    result.indexes.push(parsed.value)
  }
}

/**
 * Енам-тип моделі; складені й діапазонні типи модель і мова одиниць не
 * виражають — гучна помилка.
 */
export function mapEnumType(
  fact: Fact,
  issues: MappingIssue[]
): CatalogEnumType | undefined {
  unknownKeys(fact, issues)
  const id = fact.id as { schema: string; name: string }
  if (fact.payload.variant !== "enum") {
    issues.push({
      object: fact.id,
      property: "variant",
      detail: `type variant "${String(fact.payload.variant)}" has no field or unit class in the catalog model`,
    })
    return undefined
  }
  const values = fact.payload.values
  return {
    schema: id.schema,
    name: id.name,
    values: Array.isArray(values) ? values.map(text) : [],
  }
}
