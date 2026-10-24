import { carrierBackfillStatements, type QualifiedName } from "simetra/compiler"
import {
  type CarrierCopyOf,
  type PhysicalColumn,
  type PhysicalSnapshot,
} from "simetra/model"
import { stepId, type PlanStep } from "./steps"
import { tableKey } from "./table-key"

/** Таблиця з копіями носіїв, які ще не живі й чекають кроку даних плану. */
export interface PendingCarrierCopies {
  table: QualifiedName
  columns: string[]
}

const sameCopy = (a: CarrierCopyOf, b: CarrierCopyOf | undefined): boolean =>
  b !== undefined &&
  a.table.schema === b.table.schema &&
  a.table.name === b.table.name &&
  a.column === b.column &&
  a.through === b.through

/**
 * Копії носіїв бажаного стану, яким потрібен крок даних плану (Р2a2-11,
 * Р2b2-1): тригер носіїв виводить копію лише на запис рядка, тож без кроку
 * наявні рядки лишилися б з порожньою копією — і політики читання за нею їх
 * не бачили б, або, гірше, бачили б за чужим значенням.
 *
 * Копія вже жива, лише коли в знімку останнього застосування (`applied`,
 * marker цілі) та сама колонка — копія з тим самим `copyOf`: тоді тригери її
 * підтримували. Одна лише наявність колонки з тим самим ім'ям не рахується:
 * видалений реквізит ТЧ `assignee_id` з даними чи прийнята колонка промоції
 * дали б старі значення за копію. Таблиця, яку план створює (`created` —
 * ідентичності `table:<схема>.<ім'я>` з `produces` дій двигуна), рядків не
 * має. `oldName` — ім'я таблиці на цілі, коли воно інше (промоція, `applied`
 * у старих іменах): ним таблицю лише шукають у `applied`, а повертають у
 * бажаному імені (Р2b2-6) — крок копій іде після кроків двигуна, коли
 * таблиця вже перейменована.
 */
export function pendingCarrierCopies(
  desired: Pick<PhysicalSnapshot, "tables">,
  applied: Pick<PhysicalSnapshot, "tables"> | undefined,
  created: ReadonlySet<string>,
  oldName: (table: QualifiedName) => QualifiedName = (table) => table
): PendingCarrierCopies[] {
  const appliedTables = new Map(
    (applied?.tables ?? []).map((t) => [tableKey(t.schema, t.name), t])
  )
  const pending: PendingCarrierCopies[] = []
  for (const table of desired.tables) {
    const copies = table.columns.filter(
      (c): c is PhysicalColumn & { origin: { copyOf: CarrierCopyOf } } =>
        c.origin.copyOf !== undefined
    )
    if (copies.length === 0) continue
    if (created.has(`table:${table.schema}.${table.name}`)) continue
    const live = oldName({ schema: table.schema, name: table.name })
    const before = appliedTables.get(tableKey(live.schema, live.name))
    const columns = copies
      .filter(
        (c) =>
          !sameCopy(
            c.origin.copyOf,
            before?.columns.find((b) => b.name === c.name)?.origin.copyOf
          )
      )
      .map((c) => c.name)
    if (columns.length > 0)
      pending.push({
        table: { schema: table.schema, name: table.name },
        columns,
      })
  }
  return pending
}

/**
 * Кроки даних копій носіїв (Р2b2-1): по одному на оператор
 * `carrierBackfillStatements`, з id від `offset` — кроки копій стоять після
 * кроків наміру й двигуна. Замок `SHARE ROW EXCLUSIVE` на залежній таблиці й
 * джерелі (Р2b2-5): чужа зміна носія власника між читанням кроку й `COMMIT`
 * лишила б застарілу копію, коли тригер поширення не перестворюється цим
 * планом. Таблиці — у бажаних іменах, як у кроках двигуна; слід перекладає їх
 * у вихідні. Крок генерується незалежно від наявності рядків (Р2b2-7): план
 * не читає ціль, а на порожній таблиці крок пише нуль рядків.
 */
export function carrierBackfillSteps(
  desired: Pick<PhysicalSnapshot, "tables">,
  pending: readonly PendingCarrierCopies[],
  offset: number
): PlanStep[] {
  return carrierBackfillStatements(desired, pending).map((s, i) => ({
    id: stepId(offset + i),
    origin: "carriers",
    sql: s.sql,
    verb: "alter",
    class: "dataStep",
    lockClass: "shareRowExclusive",
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: [
      { schema: s.table.schema, name: s.table.name },
      { schema: s.source.schema, name: s.source.name },
    ],
    produces: [],
    consumes: [],
    destroys: [],
    produced: [],
    destroyed: [],
    consumed: [],
    dataLoss: false,
    rewriteRisk: false,
    guards: [],
  }))
}
