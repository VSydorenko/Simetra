import type { Project } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import {
  closedModuleOwners,
  ruledFunctions,
  settingsTargets,
} from "./closed-forms"
import { headLinks } from "./heads"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import type { VerbatimUnit } from "./units"

/**
 * Функції, оболонку яких судить платформа: голови — функції закритих
 * модулів, обробники підписок і функції множини (`ruledFunctions`), функції
 * значень вимірів доступу — і кожна їхня ланка (`headLinks`, спека прав §5.3).
 */
export function judgedFunctionIdentities(
  objects: readonly ParsedObject[],
  project: Project | undefined,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): ReadonlySet<string> {
  const closed = closedModuleOwners(objects)
  return new Set([
    ...units
      .filter(
        (u) =>
          u.class === "function" &&
          u.ownerFile !== undefined &&
          closed.has(u.ownerFile)
      )
      .map((u) => u.identity),
    ...ruledFunctions(objects, project),
    ...headLinks(objects, project, units, parse, plpgsql).map(
      (u) => u.identity
    ),
  ])
}

interface SettingsAction {
  DefElem?: {
    defname?: string
    arg?: { VariableSetStmt?: { kind?: string; name?: string } }
  }
}

/**
 * Окремий `ALTER FUNCTION` на функцію, оболонку якої судить платформа
 * (спека прав §5.3): волатильність, `SECURITY`, `search_path` і опції `SET` такої
 * функції задає лише `CREATE`, і їх судить відповідна перевірка — закрита
 * оболонка, обробник підписки, функція множини, функція виміру та її ланки.
 * Будь-яка дія окремого оператора послабила б оболонку повз цю перевірку
 * (`IMMUTABLE` на функції виміру, `SECURITY INVOKER` на функції множини,
 * `SET request.jwt.claims` на обробнику, скидання `search_path`), тож
 * помилка — на будь-яку, у будь-якому модулі чи спільному файлі. Один код
 * на клас: судимих функцій кілька видів, а виправлення одне — перенести
 * опцію в `CREATE`. Набір судимих функцій відомий до стадії 3, тож перевірка
 * стоїть у ранньому блоці поруч із `checkSqlModules`: у закритому модулі
 * автор бачить і відмову класу, і цю причину.
 */
export function checkFunctionSettingsShell(
  objects: readonly ParsedObject[],
  project: Project | undefined,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Diagnostic[] {
  const judged = judgedFunctionIdentities(
    objects,
    project,
    units,
    parse,
    plpgsql
  )
  const functions = units.filter((u) => judged.has(u.identity))
  return units.flatMap((unit) => {
    if (unit.class !== "functionSettings") return []
    if (!functions.some((fn) => settingsTargets(unit, fn))) return []
    return [
      diagnostic("sql.function-settings-shell", unit.file, "", {
        function: `${unit.schema}.${unit.name}`,
        setting: firstSetting(unit),
      }),
    ]
  })
}

/**
 * Ім'я першої дії `ALTER FUNCTION`: опція (`volatility`, `security`,
 * `strict`…), ім'я налаштування `SET`/`RESET` чи `*` для `RESET ALL`.
 */
function firstSetting(unit: VerbatimUnit): string {
  const action = (
    unit.tree as { AlterFunctionStmt?: { actions?: SettingsAction[] } }
  ).AlterFunctionStmt?.actions?.[0]?.DefElem
  if (action?.defname !== "set") return action?.defname ?? ""
  const set = action.arg?.VariableSetStmt
  return set?.kind === "VAR_RESET_ALL" ? "*" : (set?.name ?? "")
}
