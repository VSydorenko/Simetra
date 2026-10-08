import type { Node } from "libpg-query"
import { KIND_REGISTRY, type Project } from "simetra/model"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { closedShellProblem } from "./closed-forms"
import { functionIdentity, type VerbatimUnit } from "./units"

/**
 * Ідентичності одиниць боргу (план промоції 2b, рішення 12), відсортовані:
 * дослівна одиниця модуля виду з фактом `sqlModule: "debt"` чи спільного
 * `sql/`, що не є функцією в закритій оболонці. Функція в оболонці боргом не
 * є ніде: це цільова форма, а не виняток. Модуль виду 1С сюди не входить — у
 * ньому решта класів уже помилка, а не борг. Одиниця зламаного власника (його
 * немає серед об'єктів) вид не має, тож і боргом не рахується: причину
 * назвав сам власник. Обробник підписки й функція множини скоупу боргом не
 * бувають теж (рішення 8): їхню оболонку перевіряють власні правила стадії 5,
 * і `sql.debt-grows` лише сховав би конкретнішу діагностику.
 */
export function debtUnits(
  units: readonly VerbatimUnit[],
  objects: readonly ParsedObject[],
  project: Project | undefined
): string[] {
  const isDebt = debtPredicate(objects, project)
  return [...new Set(units.filter(isDebt).map((unit) => unit.identity))].sort(
    compareStrings
  )
}

function debtPredicate(
  objects: readonly ParsedObject[],
  project: Project | undefined
): (unit: VerbatimUnit) => boolean {
  const debtOwners = new Set(
    objects
      .filter((o) => KIND_REGISTRY[o.kind].sqlModule === "debt")
      .map((o) => o.file)
  )
  const ruled = ruledFunctions(objects, project)
  return (unit) =>
    (unit.ownerFile === undefined || debtOwners.has(unit.ownerFile)) &&
    !(unit.class === "function" && ruled.has(unit.identity)) &&
    !(
      unit.class === "function" &&
      closedShellProblem(unit.tree as Node) === undefined
    )
}

/**
 * Ідентичності функцій без аргументів, які оголошують метадані: обробники
 * підписок і функції множини видів скоупу. Обидві мають власні правила
 * оболонки (стадія 5), тож не є ні боргом, ні винятком із ратчета.
 */
function ruledFunctions(
  objects: readonly ParsedObject[],
  project: Project | undefined
): ReadonlySet<string> {
  if (project === undefined) return new Set()
  const declared = [
    ...objects.flatMap((o) => {
      const spec = KIND_REGISTRY[o.kind].subscription?.(o.data)
      return spec === undefined ? [] : [spec.handler]
    }),
    ...project.scopeKinds.map((kind) => kind.setFunction),
  ]
  return new Set(
    declared.map((fn) =>
      functionIdentity(fn.schema ?? project.defaultSchema, fn.name, [])
    )
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
  project: Project | undefined,
  listed: readonly string[]
): Diagnostic[] {
  const accepted = new Set(listed)
  const isDebt = debtPredicate(objects, project)
  return units
    .filter((unit) => isDebt(unit) && !accepted.has(unit.identity))
    .map((unit) =>
      diagnostic("sql.debt-grows", unit.file, "", {
        identity: unit.identity,
        line: unit.line,
      })
    )
}
