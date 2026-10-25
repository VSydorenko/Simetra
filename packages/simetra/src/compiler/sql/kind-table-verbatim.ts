import type { Node } from "libpg-query"
import type { PhysicalTable } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { isDeclaredTable } from "../stages/model"
import { closedModuleOwners } from "./closed-forms"
import { statementTargets } from "./unit-target"
import type { VerbatimUnit } from "./units"

/**
 * Таблиці видів знімка — усі, чий об'єкт не є прийнятою таблицею: основна,
 * ТЧ, похідна таблиця регістра, системні довідники прав. `qualified` —
 * `схема.ім'я`, `byName` — ім'я → кваліфіковані імена таблиць з ним.
 */
export interface KindTables {
  qualified: ReadonlySet<string>
  byName: ReadonlyMap<string, readonly string[]>
}

export function kindTables(
  objects: readonly ParsedObject[],
  tables: readonly PhysicalTable[]
): KindTables {
  // Прийнятість — факт реєстру (`isDeclaredTable`), не назва виду: таблицю
  // прийнятого об'єкта описує файл, і її борг належить їй самій.
  const kindObjects = new Set(
    objects.filter((o) => !isDeclaredTable(o)).map((o) => o.id ?? "")
  )
  const qualified = new Set<string>()
  const byName = new Map<string, string[]>()
  for (const table of tables) {
    if (!kindObjects.has(table.origin.objectId)) continue
    const key = `${table.schema}.${table.name}`
    qualified.add(key)
    byName.set(table.name, [...(byName.get(table.name) ?? []), key])
  }
  return { qualified, byName }
}

/**
 * Таблиця виду, на якій висить дослівна політика чи тригер одиниці;
 * `undefined` — одиниця іншого класу чи ціль поза таблицями видів. Ціль —
 * з дерева розбору (`statementTargets`), а не з тексту. Некваліфіковане ім'я
 * судиться fail-closed: рендер не задає `search_path`, тож Postgres
 * розв'яже його за шляхом сесії, а не за схемою файлу, — таблиця виду з тим
 * самим ім'ям у будь-якій схемі робить одиницю забороненою.
 */
export function kindTableOf(
  unit: Pick<VerbatimUnit, "class" | "schema" | "tree">,
  tables: KindTables
): string | undefined {
  if (unit.class !== "policy" && unit.class !== "trigger") return undefined
  for (const target of statementTargets(unit.tree as Node, "")) {
    const name = target.object ?? ""
    if (target.schema !== "") {
      const key = `${target.schema}.${name}`
      if (tables.qualified.has(key)) return key
      continue
    }
    const own = `${unit.schema}.${name}`
    if (tables.qualified.has(own)) return own
    const elsewhere = tables.byName.get(name)?.[0]
    if (elsewhere !== undefined) return elsewhere
  }
  return undefined
}

/**
 * Дослівна політика чи тригер на таблиці виду (Р2c1-1, спека прав §6.1) —
 * помилка в будь-якому файлі, зокрема в модулі боргу прийнятої таблиці й
 * навіть перелічена в `sql-debt.json`: ізоляцію таблиці виду розширює лише
 * право (дія, об'єкт), а реакцію на зміну рядка — підписка. Дослівна
 * політика відкрила б рядки повз права, а тригер бачив би запис команди й
 * крок даних копій. Модуль виду ці класи вже відмовляє
 * (`sql.statement-not-allowed`, `kindModule`), тож там друга діагностика —
 * шум.
 */
export function checkKindTableVerbatim(
  objects: readonly ParsedObject[],
  tables: readonly PhysicalTable[],
  units: readonly VerbatimUnit[]
): Diagnostic[] {
  const kind = kindTables(objects, tables)
  const closed = closedModuleOwners(objects)
  return units.flatMap((unit) => {
    if (unit.ownerFile !== undefined && closed.has(unit.ownerFile)) return []
    const table = kindTableOf(unit, kind)
    if (table === undefined) return []
    return [
      diagnostic("sql.kind-table-verbatim", unit.file, "", {
        identity: unit.identity,
        table,
        form: unit.class,
        line: unit.line,
      }),
    ]
  })
}
