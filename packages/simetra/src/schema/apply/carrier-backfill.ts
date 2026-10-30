import { carrierBackfillStatements, type QualifiedName } from "simetra/compiler"
import {
  type CarrierCopyOf,
  type PhysicalColumn,
  type PhysicalSnapshot,
} from "simetra/model"
import type { EngineAction } from "../engine/port"
import { stepId, type PlanStep } from "./steps"
import { tableKey } from "./table-key"

/** Таблиця з копіями носіїв, які ще не живі й чекають кроку даних плану. */
export interface PendingCarrierCopies {
  table: QualifiedName
  columns: string[]
  /**
   * Колонки з `columns`, що в знімку `applied` були звичайними колонками з
   * даними (спека прав §5.2): крок їх перезаписує, тож він `destructive` з дозволом.
   */
  overwrites: string[]
}

/**
 * Таблиці й колонки, які створюють дії двигуна плану, — з їхніх структурних
 * `produced` (рядкова ідентичність двигуна в T2 не відтворюється). Ключі —
 * `tableKey` і `columnKey`.
 */
export interface CreatedByPlan {
  tables: ReadonlySet<string>
  columns: ReadonlySet<string>
}

const columnKey = (schema: string, table: string, column: string): string =>
  JSON.stringify([schema, table, column])

export function createdByPlan(
  actions: readonly Pick<EngineAction, "produced">[]
): CreatedByPlan {
  const tables = new Set<string>()
  const columns = new Set<string>()
  for (const ref of actions.flatMap((a) => a.produced)) {
    if (ref.kind === "table" && ref.table === undefined)
      tables.add(tableKey(ref.schema, ref.name))
    if (ref.kind === "column" && ref.table !== undefined)
      columns.add(columnKey(ref.schema, ref.table, ref.name))
  }
  return { tables, columns }
}

const sameCopy = (a: CarrierCopyOf, b: CarrierCopyOf | undefined): boolean =>
  b !== undefined &&
  a.table.schema === b.table.schema &&
  a.table.name === b.table.name &&
  a.column === b.column &&
  a.through === b.through

/**
 * Копії носіїв бажаного стану, яким потрібен крок даних плану (спека прав §5.2,
 * спека промоції §7.2): тригер носіїв виводить копію лише на запис рядка, тож без кроку
 * наявні рядки лишилися б з порожньою копією — і політики читання за нею їх
 * не бачили б, або, гірше, бачили б за чужим значенням.
 *
 * Копія вже жива, лише коли в знімку останнього застосування (`applied`,
 * marker цілі) та сама колонка — копія з тим самим `copyOf`: тоді тригери її
 * підтримували. Але колонку, яку створює двигун цього плану (спека прав §5.2),
 * план і заповнює, хоч би що казав знімок: її могли зняти вручну й прийняти
 * дрейф, і двигун відтворить її порожньою. Колонка з тим самим ім'ям, що в
 * знімку копією не була (видалений реквізит ТЧ `assignee_id` з даними,
 * прийнята колонка, яку мапінг промоції не взяв), — теж очікувана копія, але
 * крок перезаписує її дані, тож вона йде в `overwrites` (спека прав §5.2). Таблиця,
 * яку план створює, рядків не має. `oldName` — ім'я таблиці на цілі, коли
 * воно інше (промоція, `applied` у старих іменах): ним таблицю лише шукають
 * у `applied`, а повертають у бажаному імені — крок копій іде після
 * кроків двигуна, коли таблиця вже перейменована.
 */
export function pendingCarrierCopies(
  desired: Pick<PhysicalSnapshot, "tables">,
  applied: Pick<PhysicalSnapshot, "tables"> | undefined,
  created: CreatedByPlan,
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
    if (created.tables.has(tableKey(table.schema, table.name))) continue
    const live = oldName({ schema: table.schema, name: table.name })
    const before = appliedTables.get(tableKey(live.schema, live.name))
    const columns: string[] = []
    const overwrites: string[] = []
    for (const c of copies) {
      const recreated = created.columns.has(
        columnKey(table.schema, table.name, c.name)
      )
      const was = before?.columns.find((b) => b.name === c.name)
      if (!recreated && sameCopy(c.origin.copyOf, was?.origin.copyOf)) continue
      columns.push(c.name)
      // Без знімка таблиці (спека прав §5.2) історії колонки не знаємо: невідоме —
      // дані
      if (
        !recreated &&
        (before === undefined ||
          (was !== undefined && was.origin.copyOf === undefined))
      )
        overwrites.push(c.name)
    }
    if (columns.length > 0)
      pending.push({
        table: { schema: table.schema, name: table.name },
        columns,
        overwrites,
      })
  }
  return pending
}

/**
 * Кроки даних копій носіїв (спека промоції §7.2): по одному на оператор
 * `carrierBackfillStatements`, з id від `offset` — кроки копій стоять після
 * кроків наміру й двигуна. Замок `SHARE ROW EXCLUSIVE` на залежній таблиці й
 * джерелі: чужа зміна носія власника між читанням кроку й `COMMIT`
 * лишила б застарілу копію, коли тригер поширення не перестворюється цим
 * планом. Таблиці — у бажаних іменах, як у кроках двигуна; слід перекладає їх
 * у вихідні. Крок генерується незалежно від наявності рядків: план
 * не читає ціль, а на порожній таблиці крок пише нуль рядків. Оператор, що
 * пише хоч одну колонку з `overwrites`, перезаписує чужі дані — він
 * `destructive` з `dataLoss` і просить дозволу (спека прав §5.2); оператор один на
 * зв'язок, тож розділити його на чисте заповнення й перезапис не можна.
 */
export function carrierBackfillSteps(
  desired: Pick<PhysicalSnapshot, "tables">,
  pending: readonly PendingCarrierCopies[],
  offset: number
): PlanStep[] {
  const overwrites = new Set(
    pending.flatMap((p) =>
      p.overwrites.map((c) => columnKey(p.table.schema, p.table.name, c))
    )
  )
  return carrierBackfillStatements(desired, pending).map((s, i): PlanStep => {
    const lossy = s.columns.some((c) =>
      overwrites.has(columnKey(s.table.schema, s.table.name, c))
    )
    return {
      id: stepId(offset + i),
      origin: "carriers",
      sql: s.sql,
      verb: "alter",
      class: lossy ? "destructive" : "dataStep",
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
      dataLoss: lossy,
      rewriteRisk: false,
      guards: [],
    }
  })
}
