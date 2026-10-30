import type { PhysicalTable } from "simetra/model"
import type { RightsContract } from "../contracts"
import { renderCondition, rightsPredicates } from "../rights/predicates"

/** Змінна рядка ядра: стан під замком рядка чи стан «після» запису. */
export type CommandRow = "v_old" | "v_new"

/**
 * Предикати права дії над змінною рядка ядра (спека П4 §6.7): той самий будівник
 * `rightsPredicates`, що й політики запису, лише з кваліфікатором рядка, тож
 * перевірка ядра й RLS не можуть розійтися другою реалізацією формули. Дія —
 * літерал функції ядра, а не `command_action()`: контекст звірено раніше
 * (спека П4 §6.6), а літерал не залежить від того, що поставив T3. Один рядок — AND
 * умов одного предиката.
 */
export function rightsCheckPredicates(
  contract: RightsContract,
  action: string,
  main: PhysicalTable,
  row: CommandRow
): string[] {
  return rightsPredicates(contract, action, main).map((predicate) =>
    predicate.conditions.map((c) => renderCondition(c, row)).join(" AND ")
  )
}

/**
 * Перевірка права ядра — OR предикатів, як OR `PERMISSIVE`-політик. Без
 * предикатів — `false`: порожній OR не має бути дозволом (fail-closed). Ядро
 * вживає її лише як `IF (…) IS NOT TRUE`, бо носій `NULL` дає `NULL`, і
 * `IF NOT (…)` пропустив би запис до сирого `42501` RLS.
 */
export function rightsCheck(
  contract: RightsContract,
  action: string,
  main: PhysicalTable,
  row: CommandRow
): string {
  const predicates = rightsCheckPredicates(contract, action, main, row)
  if (predicates.length === 0) return "false"
  return predicates.map((p) => `(${p})`).join(" OR ")
}
