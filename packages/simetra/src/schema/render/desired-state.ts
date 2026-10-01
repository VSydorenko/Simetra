import type { CompiledModel } from "simetra/compiler"
import { quoteIdent } from "simetra/model"
import {
  renderComments,
  renderEnumType,
  renderForeignKeys,
  renderIndexes,
  renderRowLevelSecurity,
  renderTable,
  type RenderedStatement,
} from "./statements"

/** The whole desired database state: ordered statements and their script. */
export interface DesiredState {
  statements: RenderedStatement[]
  /** The statements joined with a blank line. */
  sql: string
}

// `public` існує завжди, схеми провайдера створює він сам: наш `CREATE SCHEMA`
// для них або зайвий, або вимагав би прав, яких у застосунку немає.
const UNMANAGED_SCHEMAS: ReadonlySet<string> = new Set([
  "public",
  "auth",
  "storage",
  "realtime",
  "extensions",
])

/**
 * Renders the complete desired state of a compiled model: schemas first, then
 * enum types, tables and SQL units in `creationOrder`, and every foreign key
 * last, so a reference to a table created later (or to a provider table)
 * always resolves. Pure and deterministic: the same model yields the same
 * bytes.
 */
export function renderDesiredState(
  model: Pick<CompiledModel, "physical" | "sqlUnits" | "creationOrder">
): DesiredState {
  const { physical, sqlUnits, creationOrder } = model
  const tables = new Map(
    physical.tables.map((table) => [`${table.schema}.${table.name}`, table])
  )
  const enumTypes = new Map(
    physical.enumTypes.map((type) => [`${type.schema}.${type.name}`, type])
  )
  const units = new Map(sqlUnits.map((unit) => [unit.identity, unit]))

  // Одиниці без власної схеми (гранти, коментарі, розширення) мають порожню
  // схему — її не створюємо.
  const schemas = [
    ...new Set([
      ...physical.tables.map((table) => table.schema),
      ...physical.enumTypes.map((type) => type.schema),
      ...sqlUnits.map((unit) => unit.schema),
    ]),
  ]
    .filter((schema) => schema !== "" && !UNMANAGED_SCHEMAS.has(schema))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const statements: RenderedStatement[] = schemas.map((schema) => ({
    kind: "schema",
    object: schema,
    sql: `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)};`,
  }))

  for (const node of creationOrder) {
    if (node.type === "enumType") {
      const type = enumTypes.get(`${node.schema}.${node.name}`)
      if (!type)
        throw new Error(
          `creationOrder names unknown enum type ${node.schema}.${node.name}`
        )
      statements.push(renderEnumType(type))
    } else if (node.type === "table") {
      const table = tables.get(`${node.schema}.${node.name}`)
      if (!table)
        throw new Error(
          `creationOrder names unknown table ${node.schema}.${node.name}`
        )
      statements.push(
        ...renderTable(table),
        ...renderIndexes(table),
        ...renderRowLevelSecurity(table),
        ...renderComments(table)
      )
    } else {
      const unit = units.get(node.identity)
      if (!unit)
        throw new Error(`creationOrder names unknown unit ${node.identity}`)
      // Оператор одиниці дослівний, але скрипт склеюється з `;`: додаємо
      // її, якщо парсер відрізав текст до крапки з комою.
      const text = unit.sql.trimEnd()
      statements.push({
        kind: "unit",
        object: unit.identity,
        sql: text.endsWith(";") ? text : `${text};`,
      })
    }
  }

  for (const table of physical.tables) {
    statements.push(...renderForeignKeys(table))
  }

  return { statements, sql: statements.map((s) => s.sql).join("\n\n") }
}
