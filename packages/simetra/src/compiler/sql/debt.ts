import type { Node } from "libpg-query"
import { KIND_REGISTRY } from "simetra/model"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { closedShellProblem } from "./closed-forms"
import type { VerbatimUnit } from "./units"

/**
 * Ідентичності одиниць боргу (план промоції 2b, рішення 12), відсортовані:
 * дослівна одиниця модуля виду з фактом `sqlModule: "debt"` чи спільного
 * `sql/`, що не є функцією в закритій оболонці. Функція в оболонці боргом не
 * є ніде: це цільова форма, а не виняток. Модуль виду 1С сюди не входить — у
 * ньому решта класів уже помилка, а не борг. Одиниця зламаного власника (його
 * немає серед об'єктів) вид не має, тож і боргом не рахується: причину
 * назвав сам власник.
 */
export function debtUnits(
  units: readonly VerbatimUnit[],
  objects: readonly ParsedObject[]
): string[] {
  const isDebt = debtPredicate(objects)
  return [...new Set(units.filter(isDebt).map((unit) => unit.identity))].sort(
    compareStrings
  )
}

function debtPredicate(
  objects: readonly ParsedObject[]
): (unit: VerbatimUnit) => boolean {
  const debtOwners = new Set(
    objects
      .filter((o) => KIND_REGISTRY[o.kind].sqlModule === "debt")
      .map((o) => o.file)
  )
  return (unit) =>
    (unit.ownerFile === undefined || debtOwners.has(unit.ownerFile)) &&
    !(
      unit.class === "function" &&
      closedShellProblem(unit.tree as Node) === undefined
    )
}

/**
 * Ратчет боргу: одиниця боргу, якої немає в `sql-debt.json`, — помилка в
 * місці самої одиниці. Перелік пише лише `introspect`, тож новий борг не
 * з'являється мовчки: ні новим оператором у спільному файлі, ні переносом
 * оператора з модуля виду в `sql/`.
 */
export function checkDebt(
  units: readonly VerbatimUnit[],
  objects: readonly ParsedObject[],
  listed: readonly string[]
): Diagnostic[] {
  const accepted = new Set(listed)
  const isDebt = debtPredicate(objects)
  return units
    .filter((unit) => isDebt(unit) && !accepted.has(unit.identity))
    .map((unit) =>
      diagnostic("sql.debt-grows", unit.file, "", {
        identity: unit.identity,
        line: unit.line,
      })
    )
}
