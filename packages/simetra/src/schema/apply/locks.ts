import type { PlanStep } from "./steps"
import { tableKey } from "./table-key"

/** Режим блокування наперед: лише ці два раннер бере до кроків. */
export const TABLE_LOCK_MODES = [
  "accessExclusive",
  "shareRowExclusive",
] as const

/**
 * Таблиця, яку раннер блокує до кроків, з режимом. Окремий тип плану:
 * `LockedTable` кроку режиму не несе, бо режим кроку дає його `lockClass`.
 */
export interface TableLock {
  schema: string
  name: string
  mode: (typeof TABLE_LOCK_MODES)[number]
}

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/**
 * Блокування плану (рішення 9 плану П3-2a). Блокування береться до першого
 * кроку, тож лише вихідні імена: кроки двигуна, зняті після наміру, називають
 * перейменовану таблицю новим іменем, якого на цілі ще немає, і `LOCK` дав би
 * хибне «ціль змінилась». Кроки наміру вже несуть старі імена — їх не
 * перекладаємо: при обміні імен старе ім'я одного — нове ім'я іншого.
 *
 * Цілі FK таблиць одиниці поза одиницею — `shareRowExclusive`: перевірка FK
 * під час кроків бере його сама, і посеред кроків це було б очікування з
 * ризиком взаємоблокування. Таблиця в обох — сильніший режим.
 *
 * Порядок детермінований (режим, потім схема й ім'я за кодовими одиницями),
 * а не порядок плану: два застосування з різними планами блокують спільні
 * таблиці в одному порядку і не чекають одне одного навхрест.
 */
export function planLocks(p: {
  steps: readonly PlanStep[]
  /** `tableKey` нового імені → старого; тотожна (порожня) без промоції. */
  newToOld: ReadonlyMap<string, string>
  foreignKeyTargets: readonly { schema: string; name: string }[]
}): TableLock[] {
  const locks = new Map<string, TableLock>()
  for (const step of p.steps) {
    if (step.lockClass !== "accessExclusive") continue
    for (const table of step.lockedTables) {
      const key = tableKey(table.schema, table.name)
      const old = step.origin === "engine" ? p.newToOld.get(key) : undefined
      const [schema, name] =
        old === undefined
          ? [table.schema, table.name]
          : (JSON.parse(old) as [string, string])
      locks.set(tableKey(schema, name), {
        schema,
        name,
        mode: "accessExclusive",
      })
    }
  }
  for (const { schema, name } of p.foreignKeyTargets) {
    const key = tableKey(schema, name)
    if (!locks.has(key))
      locks.set(key, { schema, name, mode: "shareRowExclusive" })
  }
  return [...locks.values()].sort(
    (a, b) =>
      TABLE_LOCK_MODES.indexOf(a.mode) - TABLE_LOCK_MODES.indexOf(b.mode) ||
      byCodeUnit(a.schema, b.schema) ||
      byCodeUnit(a.name, b.name)
  )
}
