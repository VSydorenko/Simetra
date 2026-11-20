import type { Project } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import {
  closedModuleOwners,
  ruledFunctions,
  settingsTargets,
} from "./closed-forms"
import type { DeclaredFunction } from "./declarations"
import { headLinks } from "./heads"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import { inputArgumentTypes, type VerbatimUnit } from "./units"

/**
 * Функції, оболонку яких судить платформа: голови — функції закритих
 * модулів, обробники підписок і функції множини (`ruledFunctions`), функції
 * значень вимірів доступу — і кожна їхня ланка (`headLinks`, спека прав §5.3),
 * а також задекларовані функції в будь-якому файлі (`declared`, спека
 * декларацій функцій §5.1): їхні викликачі покладаються на ту саму оболонку.
 */
export function judgedFunctionIdentities(
  objects: readonly ParsedObject[],
  project: Project | undefined,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  declared: readonly DeclaredFunction[]
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
  models: ReadonlySet<string>
): Diagnostic[] {
  const judged = judgedFunctionIdentities(
    objects,
    project,
    units,
    parse,
    plpgsql,
    declared
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

interface AlterTarget {
  AlterFunctionStmt?: {
    func?: {
      objname?: { String?: { sval?: string } }[]
      objargs?: { TypeName?: TypeNode }[]
      args_unspecified?: boolean
    }
  }
}

interface TypeNode {
  names?: { String?: { sval?: string } }[]
  arrayBounds?: unknown[]
  pct_type?: boolean
}

/**
 * Канонічний вигляд типу для порівняння сигнатур: обидва боки розібрані тим
 * самим розбирачем, тож `int` і `integer` вже `pg_catalog.int4`; модифікатори
 * типу (`varchar(10)`) на тип аргументу не впливають. `%TYPE` не прочитати.
 */
function typeKey(type: TypeNode | undefined): string | undefined {
  if (type === undefined || type.pct_type === true) return undefined
  const names = (type.names ?? []).map((n) => n.String?.sval ?? "")
  const bare = names[0] === "pg_catalog" ? names.slice(1) : names
  if (bare.length === 0) return undefined
  return `${bare.join(".")}${"[]".repeat(type.arrayBounds?.length ?? 0)}`
}

/**
 * Чи `ALTER FUNCTION` (`settings`) діє на функцію чи процедуру моделі `fn`:
 * та сама схема застосунку, те саме ім'я й типи аргументів. Сигнатуру не
 * прочитати (без списку аргументів, `%TYPE`) — не збіг, тобто помилка.
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
  const target = (settings.tree as AlterTarget).AlterFunctionStmt?.func
  const names = (target?.objname ?? []).map((n) => n.String?.sval)
  if (
    target === undefined ||
    target.args_unspecified === true ||
    names.length !== 2 ||
    names[0] !== fn.schema ||
    names[1] !== fn.name
  )
    return false
  const created = (
    fn.tree as {
      CreateFunctionStmt?: Parameters<typeof inputArgumentTypes>[0]
    }
  ).CreateFunctionStmt
  if (created === undefined) return false
  const own = inputArgumentTypes(created).map((t) =>
    typeKey(t as TypeNode | undefined)
  )
  const altered = (target.objargs ?? []).map((a) => typeKey(a.TypeName))
  return (
    own.length === altered.length &&
    own.every((key, i) => key !== undefined && key === altered[i])
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
