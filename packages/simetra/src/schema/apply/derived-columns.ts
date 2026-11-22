import type { Node } from "libpg-query"
import type { SqlParser } from "simetra/compiler"
import {
  quoteIdent,
  type CatalogModel,
  type PhysicalTable,
} from "simetra/model"
import type { EngineAction, EngineObjectRef } from "../engine"
import { renderColumn, renderIndexes } from "../render/statements"

/**
 * Дія, що знімає лише похідну колонку платформи (нормалізовану колонку поля
 * пошуку, спека П2 §5): значення обчислює база з колонки-джерела, тож це не
 * втрата даних. Позначку ставить `planDerivedColumns`, читає класифікатор.
 */
export type DerivedDrop = EngineAction & { derived: true }

export const isDerivedDrop = (action: EngineAction): action is DerivedDrop =>
  "derived" in action && action.derived === true

/** Імена вихідного стану дій (копії після наміру) → імена знімка marker. */
export interface DerivedNames {
  table: (t: { schema: string; name: string }) => {
    schema: string
    name: string
  }
  column: (table: { schema: string; name: string }, column: string) => string
}

/** Похідна колонка вихідного стану дій, з колонкою-джерелом, в іменах дій. */
interface LiveDerived {
  schema: string
  table: string
  column: string
  source: string
  /** Індекси вихідного стану, ключ яких читає похідну колонку. */
  indexes: string[]
}

/**
 * Похідні колонки вихідного стану: колонка є в моделі, від якої двигун
 * будував дії, а знімок marker (останній застосований стан) несе її
 * походження `origin.searchOf`. Факт знімка, а не ім'я колонки; під
 * промоцією знімок у старих іменах, тож імена зводяться через `names`.
 */
function liveDerived(
  live: CatalogModel,
  applied: readonly PhysicalTable[],
  names: DerivedNames
): LiveDerived[] {
  return live.tables.flatMap((table) => {
    const at = { schema: table.schema, name: table.name }
    const old = names.table(at)
    const snapshot = applied.find(
      (t) => t.schema === old.schema && t.name === old.name
    )
    if (snapshot === undefined) return []
    const oldOf = (column: string) => names.column(at, column)
    return table.columns.flatMap((column): LiveDerived[] => {
      const origin = snapshot.columns.find((c) => c.name === oldOf(column.name))
        ?.origin.searchOf
      if (origin === undefined) return []
      const source = table.columns.find((c) => oldOf(c.name) === origin)?.name
      if (source === undefined) return []
      return [
        {
          schema: table.schema,
          table: table.name,
          column: column.name,
          source,
          indexes: table.indexes
            .filter((i) =>
              i.keys.some((k) => "column" in k && k.column === column.name)
            )
            .map((i) => i.name),
        },
      ]
    })
  })
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

const sameRef = (ref: EngineObjectRef, d: LiveDerived) =>
  ref.schema === d.schema &&
  ((ref.kind === "column" && ref.table === d.table && ref.name === d.column) ||
    (ref.kind === "index" && d.indexes.includes(ref.name)))

/** Синтетична дія над таблицею: та сама форма, що в дій двигуна. */
function tableAction(
  table: { schema: string; name: string },
  sql: string,
  o: {
    rewriteRisk?: boolean
    destroyed?: EngineObjectRef[]
    lockClass?: string
  } = {}
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
    lockClass: o.lockClass ?? "accessExclusive",
    dataLoss: false,
    rewriteRisk: o.rewriteRisk === true,
  }
}

/** Оператор рендерера без завершальної `;`: SQL дій двигуна її не несе. */
const statementOf = (sql: string) => sql.replace(/;$/, "")

/**
 * Повторне створення похідної колонки й її індексів з бажаного знімка — тими
 * самими рендерерами, що й бажаний стан, тож кожна властивість колонки й
 * індексу йде за одним правилом. Зняття колонки знімає кожен індекс, що її
 * читає, тож створюються знову всі такі індекси.
 */
function rebuild(table: PhysicalTable, column: string): EngineAction[] {
  const relation = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
  const derived = table.columns.find((c) => c.name === column)!
  const indexes = table.indexes.filter((i) =>
    i.keys.some((k) => "column" in k && k.column === column)
  )
  return [
    tableAction(
      table,
      `ALTER TABLE ${relation} ADD COLUMN ${renderColumn(table, derived)}`,
      { rewriteRisk: true }
    ),
    // CREATE INDEX бере SHARE: читання таблиці він не блокує
    ...renderIndexes({ ...table, indexes }).map((index) =>
      tableAction(table, statementOf(index.sql), { lockClass: "share" })
    ),
  ]
}

/**
 * Життєвий цикл похідних колонок платформи в плані (спека П2 §5, «Поля
 * пошуку») — одне правило для обох гілок плану (без промоції й з нею), на
 * рівні дій двигуна до класифікації:
 * - зняття похідної колонки позначається `DerivedDrop` — не `destructive`;
 * - Postgres не змінює тип колонки, яку читає згенерована (0A000), тож
 *   зняття похідної колонки (разом з її індексом) стоїть перед першою зміною
 *   типу її джерела: власне зняття двигуна переноситься туди, а якщо колонка
 *   лишається в бажаному стані, план знімає її сам і після зміни типу
 *   створює знову з індексом — значення перераховує база.
 * `live` — модель, від якої двигун будував дії; `applied` — знімок marker
 * (без нього похідних колонок у вихідному стані немає); `desired` — бажаний
 * знімок; `names` — імена дій → імена знімка marker.
 */
export function planDerivedColumns<A extends EngineAction>(
  actions: readonly A[],
  facts: {
    live: CatalogModel
    applied: readonly PhysicalTable[] | undefined
    desired: readonly PhysicalTable[]
    names: DerivedNames
    parse: SqlParser
  }
): (A | EngineAction)[] {
  if (facts.applied === undefined) return [...actions]
  const derived = liveDerived(facts.live, facts.applied, facts.names)
  if (derived.length === 0) return [...actions]
  // Позначка — лише дії, що знімає з колонок тільки похідні; чи немає в
  // неї іншої втрати, судить класифікатор
  let list: (A | EngineAction)[] = actions.map((action) => {
    const columns = action.destroyed.filter((r) => r.kind === "column")
    return columns.length > 0 &&
      columns.every((r) => derived.some((d) => sameRef(r, d)))
      ? ({ ...action, derived: true } as DerivedDrop)
      : action
  })
  const changesTypeOf = (action: EngineAction, d: LiveDerived) => {
    const parsed = facts.parse(action.sql)
    return (
      parsed.ok &&
      typeChanges(parsed.statements.map((s) => s.stmt)).some(
        ([schema, table, column]) =>
          (schema === "" || schema === d.schema) &&
          table === d.table &&
          column === d.source
      )
    )
  }
  for (const d of derived) {
    const alter = list.findIndex((a) => changesTypeOf(a, d))
    if (alter < 0) continue
    const drops = list.filter((a) => a.destroyed.some((r) => sameRef(r, d)))
    if (drops.length > 0) {
      // Власне зняття двигуна — перед зміною типу, у його порядку
      const rest = list.filter((a) => !drops.includes(a))
      const at = rest.indexOf(list[alter]!)
      list = [...rest.slice(0, at), ...drops, ...rest.slice(at)]
      continue
    }
    const table = facts.desired.find(
      (t) => t.schema === d.schema && t.name === d.table
    )
    const wanted = table?.columns.find(
      (c) =>
        c.name === d.column &&
        c.origin.searchOf === d.source &&
        c.generated !== undefined
    )
    if (table === undefined || wanted === undefined) continue
    const relation = `${quoteIdent(d.schema)}.${quoteIdent(d.table)}`
    const drop: DerivedDrop = {
      ...tableAction(
        table,
        `ALTER TABLE ${relation} DROP COLUMN ${quoteIdent(d.column)}`,
        {
          destroyed: [
            {
              kind: "column",
              schema: d.schema,
              table: d.table,
              name: d.column,
            },
          ],
        }
      ),
      derived: true,
    }
    list = [
      ...list.slice(0, alter),
      drop,
      list[alter]!,
      ...rebuild(table, d.column),
      ...list.slice(alter + 1),
    ]
  }
  return list
}
