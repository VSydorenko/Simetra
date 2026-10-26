import type { Node } from "libpg-query"
import { KIND_REGISTRY, SQL_DEBT_FILE, type Project } from "simetra/model"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { closedShellProblem, ruledFunctions } from "./closed-forms"
import { providerTextFunctions } from "./command-context"
import {
  bodyStatementProblem,
  modelViews,
  type ModelView,
} from "./function-body"
import {
  bodyKindTable,
  kindTableOf,
  ruleOneTables,
  type KindTables,
} from "./kind-table-verbatim"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import type { VerbatimUnit } from "./units"

/**
 * Ідентичності одиниць боргу (план промоції 2b, рішення 12), відсортовані:
 * дослівна одиниця модуля виду з фактом `sqlModule: "debt"` чи спільного
 * `sql/`, що не є функцією в закритій оболонці. Функція в оболонці боргом не є
 * ніде: це цільова форма, а не виняток. Динамічний SQL чи нерозбірне тіло
 * plpgsql виводить функцію з оболонки, тож вона стає боргом. Модуль виду 1С
 * сюди не входить — у ньому решта класів уже помилка, а не борг. Одиниця
 * зламаного власника (його немає серед об'єктів) вид не має, тож і боргом не
 * рахується: причину назвав сам власник. Обробник підписки й функція множини
 * скоупу боргом не бувають теж (рішення 8): їхню оболонку перевіряють власні
 * правила стадії 5, і `sql.debt-grows` лише сховав би конкретнішу діагностику.
 * Дослівна політика чи тригер на таблиці виду боргом не бувають теж (Р2c1-1):
 * це помилка `sql.kind-table-verbatim` у будь-якому файлі, тож підказка
 * «внести в борг» вела б не туди, а запис у переліку — застарілий. Так само
 * функція чи процедура, тіло якої пише таблицю виду (Правило 1, та сама
 * помилка з формою `functionBody`) чи виконує оператор поза дозвільним
 * переліком (`sql.function-body-statement`, Р2c1-37).
 */
export function debtUnits(
  units: readonly VerbatimUnit[],
  objects: readonly ParsedObject[],
  project: Project | undefined,
  kindTables: KindTables,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): string[] {
  const isDebt = debtPredicate(
    objects,
    project,
    kindTables,
    parse,
    plpgsql,
    modelViews(units)
  )
  return [...new Set(units.filter(isDebt).map((unit) => unit.identity))].sort(
    compareStrings
  )
}

/**
 * Чи одиниця — борг (план промоції 2b, рішення 12): одне правило для ратчета
 * й для судження запису сесії боргу (`checkSqlModules`, Р2c1-14), щоб
 * попередження не діставала одиниця, якої ратчет боргом не рахує. `views` —
 * подання моделі: через них DML досягає таблиці виду, і їх оновлює `REFRESH`.
 */
export function debtPredicate(
  objects: readonly ParsedObject[],
  project: Project | undefined,
  kindTables: KindTables,
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  views: readonly ModelView[]
): (unit: VerbatimUnit) => boolean {
  const debtOwners = new Set(
    objects
      .filter((o) => KIND_REGISTRY[o.kind].sqlModule === "debt")
      .map((o) => o.file)
  )
  const ruled = ruledFunctions(objects, project)
  const written = ruleOneTables(kindTables, project?.database.provider)
  const textFunctions = providerTextFunctions(project?.database.provider)
  return (unit) =>
    (unit.ownerFile === undefined || debtOwners.has(unit.ownerFile)) &&
    !(unit.class === "function" && ruled.has(unit.identity)) &&
    kindTableOf(unit, kindTables) === undefined &&
    bodyKindTable(unit, written, parse, plpgsql, views) === undefined &&
    bodyStatementProblem(unit, parse, plpgsql, views, textFunctions) ===
      undefined &&
    !(
      unit.class === "function" &&
      closedShellProblem(
        { tree: unit.tree as Node, sql: unit.sql },
        plpgsql
      ) === undefined
    )
}

/**
 * Ратчет боргу в обидва боки. Одиниця боргу, якої немає в `sql-debt.json`, —
 * `sql.debt-grows` у місці самої одиниці: перелік пише лише `introspect`, тож
 * новий борг не з'являється мовчки ні новим оператором у спільному файлі, ні
 * переносом оператора з модуля виду в `sql/`. Запис, що вже не є боргом
 * (одиниці немає або вона тепер у закритій формі), — `sql.debt-stale` у місці
 * запису: інакше перелік лишався б білим списком імен, під який згодом можна
 * повернути будь-яке тіло. Застарілий — рівно те, що прибирає `fix`. Коли
 * `.sql` не розібрано, одиниці неповні, і застарілість не судиться: інакше
 * справжні записи виглядали б застарілими. Дві групи окремо: застарілий запис
 * описує лише перелік, тож не мусить закривати подальші стадії.
 */
export function checkDebt(
  units: readonly VerbatimUnit[],
  objects: readonly ParsedObject[],
  project: Project | undefined,
  kindTables: KindTables,
  listed: readonly string[],
  unitsComplete: boolean,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): { grows: Diagnostic[]; stale: Diagnostic[] } {
  const accepted = new Set(listed)
  const isDebt = debtPredicate(
    objects,
    project,
    kindTables,
    parse,
    plpgsql,
    modelViews(units)
  )
  const debt = units.filter(isDebt)
  const grows = debt
    .filter((unit) => !accepted.has(unit.identity))
    .map((unit) =>
      diagnostic("sql.debt-grows", unit.file, "", {
        identity: unit.identity,
        line: unit.line,
      })
    )
  if (!unitsComplete) return { grows, stale: [] }
  const current = new Set(debt.map((unit) => unit.identity))
  const stale = listed.flatMap((identity, index) =>
    current.has(identity)
      ? []
      : [
          diagnostic("sql.debt-stale", SQL_DEBT_FILE, `/units/${index}`, {
            identity,
          }),
        ]
  )
  return { grows, stale }
}
