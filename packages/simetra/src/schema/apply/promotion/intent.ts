import type { PromotionRecord } from "simetra/compiler"
import { quoteIdent, type PhysicalSnapshot } from "simetra/model"
import type { LockedTable } from "../../engine"
import { intentStep, type PlanStep } from "../steps"
import { tableKey } from "../table-key"

/**
 * Намір перейменувань промоції (рішення 2 плану П3-2a): кроки платформи, що
 * на копії й на цілі виконуються до diff двигуна. Двигун з `renames: "off"`
 * перетворив би перейменування на DROP+CREATE, тобто на тиху втрату даних.
 */
export interface RenameIntent {
  steps: Omit<PlanStep, "id">[]
  /**
   * `tableKey` нового імені → `tableKey` старого, лише для перейменованих
   * таблиць: блокування, класи й власники звертаються до цілі, де таблиця
   * ще має старе ім'я.
   */
  tablesNewToOld: ReadonlyMap<string, string>
  /**
   * `JSON.stringify([схема, нова таблиця, тимчасове ім'я])` → початкове ім'я
   * об'єкта. Лише імена, що доживають до кроків двигуна: через них класи
   * видалень бачать об'єкт під початковим ім'ям.
   */
  tempNames: ReadonlyMap<string, string>
}

interface Rename {
  from: string
  to: string
}

/** Крок перейменування разом із записом, якого він стосується. */
interface Move<T> extends Rename {
  of: T
}

const qualified = (schema: string, name: string): string =>
  `${quoteIdent(schema)}.${quoteIdent(name)}`

/**
 * Порядок перейменувань в одному просторі імен: ім'я, зайняте об'єктом, що
 * сам перейменовується, звільняється раніше. Цикл (обмін) розривається
 * тимчасовим ім'ям — воно до кінця наміру знову зникає.
 */
function ordered<T extends Rename>(
  renames: readonly T[],
  temp: () => string
): Move<T>[] {
  const pending = renames
    .filter((r) => r.from !== r.to)
    .map((r) => ({ from: r.from, to: r.to, of: r }))
  const out: Move<T>[] = []
  while (pending.length > 0) {
    const free = pending.findIndex(
      (r) => !pending.some((other) => other !== r && other.from === r.to)
    )
    if (free >= 0) {
      out.push(pending.splice(free, 1)[0]!)
      continue
    }
    // Кожне цільове ім'я зайняте іншим перейменуванням — цикл; першого в
    // порядку запису відводимо вбік, і ланцюжок розв'язується
    const first = pending[0]!
    const aside = temp()
    out.push({ from: first.from, to: aside, of: first.of })
    first.from = aside
  }
  return out
}

/** Лічильник `<префікс><n>` від 1: детермінований у порядку запису. */
function counter(prefix: string): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}

/**
 * Намір перейменувань за записом промоції. Пари «старе → нове» запис несе з
 * ідентичностей (T2 звірив їх із marker і бажаною моделлю), тож намір не
 * зіставляє імена. Порядок: таблиці, далі колонки кожної таблиці. Вилучена
 * колонка, чиє ім'я потрібне бажаній таблиці, відходить на
 * `simetra_retired_<n>`: інакше двигун побачив би «наявну» колонку з
 * потрібним ім'ям і змінив би їй тип, віддавши її дані новому реквізиту.
 */
export function renameIntent(
  record: PromotionRecord,
  desired: Pick<PhysicalSnapshot, "tables">
): RenameIntent {
  const steps: Omit<PlanStep, "id">[] = []
  const tablesNewToOld = new Map<string, string>()
  const tempNames = new Map<string, string>()
  const tmp = counter("simetra_tmp_")
  const retiredName = counter("simetra_retired_")

  // Блокування — у старих іменах: раннер бере їх до першого кроку
  const oldByNew = new Map<string, LockedTable>()
  for (const t of record.tables)
    oldByNew.set(tableKey(t.schema, t.to), { schema: t.schema, name: t.from })
  const lockOf = (schema: string, table: string): LockedTable[] => [
    oldByNew.get(tableKey(schema, table)) ?? { schema, name: table },
  ]

  // Таблиці перейменовуються в межах своєї схеми: простір імен — `pg_class`
  // схеми
  const schemas = [...new Set(record.tables.map((t) => t.schema))]
  for (const schema of schemas) {
    const renames = ordered(
      record.tables.filter((t) => t.schema === schema),
      tmp
    )
    for (const r of renames)
      steps.push(
        intentStep(
          `ALTER TABLE ${qualified(schema, r.from)} RENAME TO ${quoteIdent(r.to)}`,
          [{ schema, name: r.of.from }]
        )
      )
  }
  for (const t of record.tables)
    if (t.from !== t.to)
      tablesNewToOld.set(tableKey(t.schema, t.to), tableKey(t.schema, t.from))

  for (const t of record.tables) {
    const target = desired.tables.find((d) => isTableOf(d, t.id))
    // Запис звірено з бажаною моделлю за ідентичністю ще до наміру: таблиці
    // одиниці, якої бажаний стан не має, бути не може
    if (target === undefined)
      throw new Error(
        `promotion table ${t.id} has no table in the desired state`
      )
    const wanted = new Set(target.columns.map((c) => c.name))
    const alter = `ALTER TABLE ${qualified(t.schema, t.to)} RENAME COLUMN`
    const lock = lockOf(t.schema, t.to)

    for (const r of record.retired) {
      if (r.schema !== t.schema || r.table !== t.from || !wanted.has(r.column))
        continue
      const aside = retiredName()
      steps.push(
        intentStep(
          `${alter} ${quoteIdent(r.column)} TO ${quoteIdent(aside)}`,
          lock
        )
      )
      tempNames.set(JSON.stringify([t.schema, t.to, aside]), r.column)
    }

    const columns = record.columns.filter(
      (c) => c.schema === t.schema && c.table === t.to
    )
    for (const r of ordered(columns, tmp))
      steps.push(
        intentStep(
          `${alter} ${quoteIdent(r.from)} TO ${quoteIdent(r.to)}`,
          lock
        )
      )
  }
  return { steps, tablesNewToOld, tempNames }
}

/**
 * Таблиця одиниці в бажаному стані — за ідентичністю: основна таблиця
 * об'єкта чи таблиця його ТЧ, без похідних частин.
 */
function isTableOf(
  table: PhysicalSnapshot["tables"][number],
  id: string
): boolean {
  const { objectId, tabularSectionId, part } = table.origin
  return part === undefined && (tabularSectionId ?? objectId) === id
}

/** Намір із додатковими тимчасовими іменами (канонічні імена, рішення 4). */
export function withTempNames(
  intent: RenameIntent,
  more: ReadonlyMap<string, string>
): RenameIntent {
  return { ...intent, tempNames: new Map([...intent.tempNames, ...more]) }
}
