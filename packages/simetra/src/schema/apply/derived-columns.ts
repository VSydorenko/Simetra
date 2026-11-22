import type { Node } from "libpg-query"
import type { SqlParser } from "simetra/compiler"
import {
  quoteIdent,
  type CatalogModel,
  type PhysicalColumn,
  type PhysicalTable,
} from "simetra/model"
import type { EngineAction, EngineObjectRef } from "../engine"

/**
 * Похідна колонка платформи (спека П2 §5, «Поля пошуку»): нормалізована
 * колонка поля пошуку, чиє значення обчислює база з колонки-джерела. Факт
 * знімка (`origin.searchOf`), а не ім'я колонки.
 */
const isDerived = (column: Pick<PhysicalColumn, "origin">): boolean =>
  column.origin.searchOf !== undefined

const columnKey = (schema: string, table: string, column: string): string =>
  `${schema}\0${table}\0${column}`

/**
 * Ключі похідних колонок знімків: зняти таку колонку не означає втратити
 * дані — значення знову обчислить база, якщо поле повернеться в пошук.
 */
export function derivedColumnKeys(
  ...snapshots: readonly (readonly PhysicalTable[] | undefined)[]
): ReadonlySet<string> {
  return new Set(
    snapshots.flatMap((tables) =>
      (tables ?? []).flatMap((t) =>
        t.columns
          .filter(isDerived)
          .map((c) => columnKey(t.schema, t.name, c.name))
      )
    )
  )
}

/** Дія знімає лише похідні колонки (і нічого іншого з даними). */
export function destroysOnlyDerived(
  destroyed: readonly EngineObjectRef[],
  dataKinds: number,
  derived: ReadonlySet<string>
): boolean {
  const columns = destroyed.filter((r) => r.kind === "column")
  return (
    columns.length > 0 &&
    columns.length === dataKinds &&
    columns.every((r) =>
      derived.has(columnKey(r.schema, r.table ?? "", r.name))
    )
  )
}

/** Колонки, яким оператори дії змінюють тип: `[схема, таблиця, колонка]`. */
function typeChanges(stmts: readonly Node[]): [string, string, string][] {
  return stmts.flatMap((stmt): [string, string, string][] => {
    if (!("AlterTableStmt" in stmt)) return []
    const { relation, cmds } = stmt.AlterTableStmt
    if (relation?.relname === undefined) return []
    return (cmds ?? []).flatMap((node): [string, string, string][] =>
      "AlterTableCmd" in node &&
      node.AlterTableCmd.subtype === "AT_AlterColumnType" &&
      node.AlterTableCmd.name !== undefined
        ? [
            [
              relation.schemaname ?? "",
              relation.relname!,
              node.AlterTableCmd.name,
            ],
          ]
        : []
    )
  })
}

/** Синтетична дія над таблицею: та сама форма, що в дій двигуна. */
function tableAction(
  table: PhysicalTable,
  sql: string,
  o: { rewriteRisk?: boolean; destroyed?: EngineObjectRef[] } = {}
): EngineAction {
  return {
    sql,
    verb: "alter",
    produces: [],
    consumes: [],
    destroys: [],
    produced: [],
    destroyed: o.destroyed ?? [],
    consumed: [],
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: [{ schema: table.schema, name: table.name }],
    lockClass: "accessExclusive",
    dataLoss: false,
    rewriteRisk: o.rewriteRisk === true,
  }
}

/**
 * Postgres не змінює тип колонки, яку читає згенерована колонка (0A000), а
 * двигун похідну колонку навколо зміни типу не перебудовує. Тож платформа
 * сама знімає похідну колонку перед зміною типу джерела й створює її (з
 * індексом) знову після: значення перераховує база, втрати даних немає.
 * Похідну колонку дає бажаний знімок (`origin.searchOf`); перебудовується
 * лише та, що вже є в живій цілі.
 */
export function aroundTypeChanges<A extends EngineAction>(
  actions: readonly A[],
  desired: readonly PhysicalTable[],
  live: CatalogModel,
  parse: SqlParser
): (A | EngineAction)[] {
  const q = quoteIdent
  return actions.flatMap((action): (A | EngineAction)[] => {
    const result = parse(action.sql)
    if (!result.ok) return [action]
    const before: EngineAction[] = []
    const after: EngineAction[] = []
    for (const [schema, name, source] of typeChanges(
      result.statements.map((s) => s.stmt)
    )) {
      const table = desired.find(
        (t) => t.name === name && (schema === "" || t.schema === schema)
      )
      if (table === undefined) continue
      const present = live.tables.find(
        (t) => t.schema === table.schema && t.name === table.name
      )
      const relation = `${q(table.schema)}.${q(table.name)}`
      for (const column of table.columns) {
        if (column.origin.searchOf !== source || column.generated === undefined)
          continue
        if (!present?.columns.some((c) => c.name === column.name)) continue
        before.push(
          tableAction(
            table,
            `ALTER TABLE ${relation} DROP COLUMN ${q(column.name)}`,
            {
              destroyed: [
                {
                  kind: "column",
                  schema: table.schema,
                  table: table.name,
                  name: column.name,
                },
              ],
            }
          )
        )
        after.push(
          tableAction(
            table,
            `ALTER TABLE ${relation} ADD COLUMN ${q(column.name)} ${column.type} GENERATED ALWAYS AS (${column.generated.expression}) STORED`,
            { rewriteRisk: true }
          )
        )
        for (const index of table.indexes) {
          const [key] = index.keys
          if (
            index.keys.length !== 1 ||
            key === undefined ||
            !("column" in key) ||
            key.column !== column.name
          )
            continue
          const opclass =
            key.opclass === undefined
              ? ""
              : ` ${key.opclass.schema === undefined ? "" : `${q(key.opclass.schema)}.`}${q(key.opclass.name)}`
          after.push(
            tableAction(
              table,
              `CREATE INDEX ${q(index.name)} ON ${relation} USING ${index.method} (${q(column.name)}${opclass})`
            )
          )
        }
      }
    }
    return [...before, action, ...after]
  })
}
