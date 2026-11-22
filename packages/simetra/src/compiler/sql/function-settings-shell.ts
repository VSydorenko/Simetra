import type { Project } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import {
  closedModuleOwners,
  pinnedSettingProblem,
  ruledFunctions,
  settingsTargets,
} from "./closed-forms"
import type { DeclaredFunction } from "./declarations"
import { headLinks } from "./heads"
import { identityKey, keyIdentity } from "./identity"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import type { PolicyFunctions } from "./policy-functions"
import type { VerbatimUnit } from "./units"

/**
 * Функції, оболонку яких судить платформа: голови — функції закритих
 * модулів, обробники підписок, функції множини й функції політик
 * (`ruledFunctions`), функції значень вимірів доступу — і кожна їхня ланка (`headLinks`, спека прав §5.3),
 * а також задекларовані функції в будь-якому файлі (`declared`, спека
 * декларацій функцій §5.1): їхні викликачі покладаються на ту саму оболонку.
 */
export function judgedFunctionIdentities(
  objects: readonly ParsedObject[],
  project: Project | undefined,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  declared: readonly DeclaredFunction[],
  policies: PolicyFunctions
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
    ...ruledFunctions(objects, project, policies),
    ...headLinks(objects, project, units, parse, plpgsql, policies).map(
      (u) => u.identity
    ),
    ...declared.map((d) => d.unit.identity),
  ])
}

interface SettingsAction {
  DefElem?: {
    defname?: string
    arg?: { VariableSetStmt?: { kind?: string; name?: string } }
  }
}

/**
 * Окремий `ALTER FUNCTION` на функцію, якої застосунок не створив (ціль не є
 * функцією моделі), — теж помилка (`target: "notModel"`), як і на функцію,
 * оболонку якої судить платформа.
 *
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
  plpgsql: PlpgsqlParser,
  declared: readonly DeclaredFunction[],
  models: ReadonlySet<string>,
  policies: PolicyFunctions
): Diagnostic[] {
  const judged = judgedFunctionIdentities(
    objects,
    project,
    units,
    parse,
    plpgsql,
    declared,
    policies
  )
  const functions = units.filter((u) => judged.has(u.identity))
  return units.flatMap((unit) => {
    if (unit.class !== "functionSettings") return []
    // Ціль, що не є функцією моделі (згенерована функція запису, функція
    // платформи, функція провайдера), форму якої тримає платформа: `ALTER
    // FUNCTION` змінив би її повз генератор, тож це помилка в будь-якому файлі.
    // Функція моделі — лише в схемі застосунку (`modelCallNames`, без схем
    // провайдера й `pg_catalog`), за кваліфікованим іменем і з тією самою
    // сигнатурою: некваліфіковане ім'я DDL розв'язує шлях пошуку сесії, а інша
    // сигнатура чи однойменна приманка в схемі провайдера — інша функція.
    const modelTarget = units.some((u) => altersModelFunction(unit, u, models))
    // Судиму функцію ловить збіг за ім'ям (будь-яка схема, без типів): помилка
    // оболонки без `notModel`, як і було.
    const judgedTarget = functions.some((fn) => settingsTargets(unit, fn))
    if (!modelTarget || judgedTarget) {
      return [
        diagnostic("sql.function-settings-shell", unit.file, "", {
          function: `${unit.schema}.${unit.name}`,
          setting: firstSetting(unit),
          ...(modelTarget || judgedTarget ? {} : { target: "notModel" }),
        }),
      ]
    }
    return []
  })
}

/**
 * Чи `ALTER FUNCTION` (`settings`) діє на функцію чи процедуру моделі `fn`:
 * схема застосунку (`modelCallNames`), кваліфіковане ім'я й та сама
 * канонічна сигнатура — ідентичність `functionSettings:` ALTER-а збігається з
 * ідентичністю `function:` функції після префікса (типи резолвляться за
 * моделлю одним нормалізатором `units.ts`). Без списку аргументів ідентичність
 * не має сигнатури — не збіг, тобто помилка.
 */
function altersModelFunction(
  settings: VerbatimUnit,
  fn: VerbatimUnit,
  models: ReadonlySet<string>
): boolean {
  if (
    (fn.class !== "function" && fn.class !== "procedure") ||
    !models.has(`${fn.schema}.${fn.name}`)
  )
    return false
  const target = (
    settings.tree as {
      AlterFunctionStmt?: { func?: { objname?: unknown[] } }
    }
  ).AlterFunctionStmt?.func
  // Некваліфіковане ім'я DDL розв'язує шлях пошуку сесії, а не схема файлу.
  if ((target?.objname ?? []).length !== 2) return false
  return (
    settings.identity ===
    keyIdentity("functionSettings", identityKey(fn.identity))
  )
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

/**
 * `sql.head-settings` (клас ремонту) на кожному корені голови — функції
 * множини скоупу, функції значень виміру, функції політики (спека декларацій
 * функцій §5.8), — чий `CREATE FUNCTION` не фіксує кожне налаштування
 * `HEAD_PINNED_SETTINGS` рівно в його значення. Клас ремонту: база, яку
 * прийняли зворотною генерацією, ще не має цих опцій, а `fix` їх не вигадує —
 * їх дописує автор.
 */
export function checkHeadSettings(
  heads: readonly VerbatimUnit[],
  units: readonly VerbatimUnit[]
): Diagnostic[] {
  return heads.flatMap((unit) => {
    const problem = pinnedSettingProblem(unit, units)
    if (problem === undefined) return []
    return [
      diagnostic("sql.head-settings", unit.file, "", {
        schema: unit.schema,
        name: unit.name,
        function: `${unit.schema}.${unit.name}`,
        line: unit.line,
        setting: problem.setting,
        expected: problem.expected,
        problem: problem.problem,
        ...(problem.actual === undefined ? {} : { actual: problem.actual }),
      }),
    ]
  })
}
