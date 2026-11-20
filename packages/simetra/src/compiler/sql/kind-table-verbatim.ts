import type { Diagnostic } from "../diagnostics"
import { diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import type { DatabaseProvider, PhysicalTable } from "simetra/model"
import { closedModuleOwners } from "./closed-forms"
import { kindTables } from "./kind-tables"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import type { VerbatimUnit } from "./units"
import { writePaths, type WritePath } from "./write-paths"

/**
 * Дослівна політика чи тригер на таблиці виду (спека прав §6.1) —
 * помилка в будь-якому файлі, зокрема в модулі боргу прийнятої таблиці й
 * навіть перелічена в `sql-debt.json`: ізоляцію таблиці виду розширює лише
 * право (дія, об'єкт), а реакцію на зміну рядка — підписка. Дослівна
 * політика відкрила б рядки повз права, а тригер бачив би запис команди й
 * крок даних копій. Модуль виду ці класи вже відмовляє
 * (`sql.statement-not-allowed`, `kindModule`), тож там друга діагностика —
 * шум.
 *
 * Тіло функції чи процедури в будь-якому файлі, зокрема в модулі виду й у
 * закритій оболонці, у таблицю виду не пише (Правило 1, спека прав §6.1, форма
 * `functionBody`): таблицю виду пишуть лише ядро команд, оболонка проведення
 * й тригери платформи, а DML застосунку обійшов би права, рухи й перевірки
 * команди. Що ще тіло може виконувати, судить дозвільний перелік операторів
 * (`sql.function-body-statement`, спека прав §6.1). Модуль виду функцію приймає, тож
 * там ця діагностика єдина. `provider` дає таблицю джерела ідентичностей
 * (`ruleOneTables`).
 */
export function checkKindTableVerbatim(
  objects: readonly ParsedObject[],
  tables: readonly PhysicalTable[],
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  provider: DatabaseProvider | undefined
): Diagnostic[] {
  const kind = kindTables(objects, tables)
  const closed = closedModuleOwners(objects)
  return writePaths(units, { kind, provider, parse, plpgsql }).flatMap(
    (path) => {
      const { unit } = path
      // Модуль виду приймає лише функції: решту форм він уже відмовляє
      // (`sql.statement-not-allowed`, `kindModule`), друга діагностика — шум.
      if (
        path.form !== "functionBody" &&
        path.form !== "sequence" &&
        unit.ownerFile !== undefined &&
        closed.has(unit.ownerFile)
      )
        return []
      return [pathDiagnostic(path)]
    }
  )
}

function pathDiagnostic({
  unit,
  form,
  target,
  roles,
  statement,
}: WritePath): Diagnostic {
  const params: Record<string, string | number> = {
    identity: unit.identity,
    table: target,
    form,
    line: unit.line,
  }
  if (form === "functionBody" || form === "sequence") {
    // Виклик послідовності стоїть і в поданні, домені, політиці: «функцією»
    // названа лише функція чи процедура.
    if (unit.class === "function" || unit.class === "procedure")
      params.function = `${unit.schema}.${unit.name}`
    params.statement = statement ?? ""
  } else if (form !== "policy" && form !== "trigger") {
    params.roles = roles.join(", ")
  }
  return diagnostic("sql.kind-table-verbatim", unit.file, "", params)
}
