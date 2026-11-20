import {
  PROVIDER_API_ROLES,
  type GrantPurpose,
  type PhysicalSnapshot,
  type Project,
} from "simetra/model"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import { ownsTarget } from "../function-execute"
import type { ParsedObject } from "../stages/files"
import {
  closedModuleOwners,
  functionSettingsOf,
  platformFormSources,
} from "./closed-forms"
import type { DeclaredFunction } from "./declarations"
import { AGGREGATE_COMPONENTS } from "./dependencies"
import { grantRole } from "./execute-grants"
import { PUBLIC, grantFacts, privilegedRoles } from "./grant-facts"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import { reachableUnits, relationReads } from "./reads"
import { functionIdentity } from "./identity"
import { type VerbatimUnit } from "./units"

/** Що читає повз права викликача: функція, подання чи матеріалізоване подання. */
export type DefinerReadsForm = "function" | "view" | "materializedView"

/**
 * Клас «RPC читання повз RLS» (платформна спека §6.7, Р21, Р30):
 * дослівна одиниця, яку роль API може викликати чи читати, виконує
 * читання від імені власника, а не викликача, і читає таблицю під RLS сама чи
 * через досяжні функції й подання. Тоді рядки, яких права викликача не
 * відкривають, видно повз модель прав. Форми:
 * - функція з `SECURITY DEFINER` (у `CREATE` чи окремим `ALTER FUNCTION`) і
 *   дієвим `EXECUTE` для ролі API — незалежно від закритої оболонки: типова
 *   така RPC якраз має форму `STABLE SECURITY DEFINER SET search_path = ''`.
 *   Ця форма — помилка `sql.definer-caller-unchecked` (нижче), а не
 *   попередження;
 * - подання без `security_invoker` з дієвим `SELECT` для ролі API: воно читає
 *   від імені власника;
 * - матеріалізоване подання з дієвим `SELECT` — завжди: його рядки зберіг
 *   власник під час `REFRESH`, а читача RLS не обмежує зовсім.
 * Форми платформи (`platformFormSources`: функції множини, обробники, функції
 * значень виміру) й тригерні функції не судяться: це не RPC — тригерну функцію Postgres кличе
 * лише тригером, функції множини й виміру — політика від імені запиту, і
 * читати повз RLS їм належить за задумом (обмеження їхніх тіл судять власні
 * правила стадії 5). Власника одиниці статично не видно (власник без обходу RLS
 * нічого не відкриває), а подання може саме фільтрувати рядки функціями прав,
 * тож це попередження, а не помилка. Власник одиниці — роль застосування:
 * інший власник — відмова плану (`plan.owner-mismatch`), а гейт власника
 * вимагає `BYPASSRLS` (`plan.owner-not-bypassrls`). Тож `FORCE ROW LEVEL
 * SECURITY` таблиці читання від імені власника не обмежує, і таблиця з ним
 * судиться як будь-яка під RLS. Недосудних форм тіла (нелітеральний
 * `EXECUTE`, інша мова, непрочитаний текст) стадія 5 не бачить: їх відмовляє
 * ранній блок (спека прав §6.1).
 *
 * Функція з `SECURITY DEFINER`, яку може виконати роль API чи роль команд,
 * мусить сама перевіряти викликача, і назвати перевірку має декларація
 * (платформна спека §6.7, спека декларацій функцій §5.1). Недекларована така
 * функція в будь-якій одиниці SQL застосунку, борг включно, — помилка
 * `sql.definer-caller-unchecked` незалежно від того, що вона читає. Роль
 * команд діє від імені користувача, тож рахується теж, але лише через
 * `PUBLIC` чи явний грант: типових привілеїв провайдера вона не має.
 * Недекларовану функцію модуля виду правило не судить: її `EXECUTE` виводить
 * платформа з порожніми призначеннями. Агрегат над definer-складовою судиться
 * завжди: його `EXECUTE` декларація складової не обмежує. Задекларовану
 * definer-функцію з викликачами від імені користувача судять правила
 * декларацій (`checkDeclaredCallers`), а тут вона — попередження класу Р30 з
 * ролями викликачів: її ACL виводить платформа, тож дослівні гранти ролей не
 * рахуються. Перевірка обмежує виклик, а не обсяг прочитаного.
 */
export function checkDefinerReads(
  objects: readonly ParsedObject[],
  project: Project,
  physical: PhysicalSnapshot,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  declared: readonly DeclaredFunction[]
): Diagnostic[] {
  const rlsTables = physical.tables.filter((t) => t.rowLevelSecurity !== "off")
  const skipped = new Set(
    platformFormSources(objects, project).map((s) =>
      functionIdentity(s.function.schema, s.function.name, [])
    )
  )
  const modules = closedModuleOwners(objects)
  const declarations = new Map(declared.map((d) => [d.unit, d.declaration]))
  const grants = grantFacts(units, parse)
  const provider = project.database.provider
  const roles = PROVIDER_API_ROLES[provider]
  const apiRoles = [roles.user, roles.anonymous]
  const commandRole = grantRole("command", provider)
  const found: Diagnostic[] = []
  for (const unit of units) {
    const form = formOf(unit, units, skipped)
    if (form === undefined) continue
    const declaration = declarations.get(unit)
    let privileged: string[]
    if (declaration !== undefined) {
      if (!declaration.callers.some((c) => ON_BEHALF_OF_USER.has(c))) continue
      privileged = declaration.callers
        .map((caller) => grantRole(caller, provider))
        .filter((role): role is string => role !== null)
    } else {
      if (
        unit.class === "function" &&
        unit.ownerFile !== undefined &&
        modules.has(unit.ownerFile)
      )
        continue
      privileged = privilegedRoles(
        targetOf(unit),
        form === "function" ? "execute" : "select",
        grants,
        apiRoles,
        form === "function" && commandRole !== null ? [commandRole] : []
      )
      if (!privileged.some((role) => role !== PUBLIC)) continue
      if (form === "function") {
        found.push(
          diagnostic("sql.definer-caller-unchecked", unit.file, "", {
            schema: unit.schema,
            name: unit.name,
            function: `${unit.schema}.${unit.name}`,
            roles: privileged.join(", "),
            line: unit.line,
          })
        )
        continue
      }
    }
    // Перелік таблиць — те, чиї рядки одиниця віддає: її власні читання й
    // читання функцій і подань, яких вона досягає.
    const readers = [unit, ...reachableUnits(unit, units, parse, plpgsql)]
    const tables = new Set(
      readers.flatMap((reader) =>
        relationReads(reader, units, parse, plpgsql).flatMap((ref) =>
          rlsTables
            .filter(
              (t) =>
                t.name === ref.name &&
                (ref.schema === undefined || t.schema === ref.schema)
            )
            .map((t) => `${t.schema}.${t.name}`)
        )
      )
    )
    if (tables.size === 0) continue
    found.push(
      diagnostic("sql.definer-reads-rls", unit.file, "", {
        object: `${unit.schema}.${unit.name}`,
        form,
        tables: [...tables].sort(compareStrings).join(", "),
        roles: privileged.join(", "),
        line: unit.line,
      })
    )
  }
  return found
}

/**
 * Викликачі, що діють від імені користувача (спека прав §5.2): роль команд
 * виконує хук команди з id від клієнта.
 */
export const ON_BEHALF_OF_USER: ReadonlySet<GrantPurpose> =
  new Set<GrantPurpose>(["user", "command"])

interface DefElem {
  defname?: string
  arg?: {
    String?: { sval?: string }
    Integer?: { ival?: number }
    Boolean?: { boolval?: boolean }
  }
}

type Options = readonly { DefElem?: DefElem }[]

interface FunctionTree {
  returnType?: { names?: { String?: { sval?: string } }[] }
  options?: Options
}

/** Форма одиниці, що читає від імені власника; інша — `undefined`. */
function formOf(
  unit: VerbatimUnit,
  units: readonly VerbatimUnit[],
  skipped: ReadonlySet<string>
): DefinerReadsForm | undefined {
  if (unit.class === "materializedView") return "materializedView"
  if (unit.class === "view") {
    const view = (unit.tree as { ViewStmt?: { options?: Options } }).ViewStmt
    return securityInvoker(view?.options ?? []) ? undefined : "view"
  }
  if (unit.class === "aggregate")
    return definerComponent(unit, units) ? "function" : undefined
  // Процедуру з `SECURITY DEFINER` досягає `CALL` з функції, яку кличе роль
  // API, тож вона — та сама форма, що й функція.
  if (
    (unit.class !== "function" && unit.class !== "procedure") ||
    skipped.has(unit.identity)
  )
    return undefined
  const fn = (unit.tree as { CreateFunctionStmt?: FunctionTree })
    .CreateFunctionStmt
  if (fn === undefined || returnsTrigger(fn)) return undefined
  // Порядок `CREATE` і окремого `ALTER FUNCTION` не моделюється: `DEFINER` у
  // будь-якому з них — fail-closed.
  const definer =
    hasDefiner(fn.options ?? []) ||
    functionSettingsOf(unit, units).some((settings) =>
      hasDefiner(
        (settings.tree as { AlterFunctionStmt?: { actions?: Options } })
          .AlterFunctionStmt?.actions ?? []
      )
    )
  return definer ? "function" : undefined
}

/**
 * Чи складова агрегату — `SECURITY DEFINER`-функція моделі. `EXECUTE`
 * складової Postgres перевіряє в ролі власника агрегату, а не викликача, тож
 * роль API, якій дано агрегат, виконує складову від власника, навіть коли
 * саму функцію їй відкликано. Некваліфіковане ім'я — будь-яка схема
 * (fail-closed).
 */
function definerComponent(
  unit: VerbatimUnit,
  units: readonly VerbatimUnit[]
): boolean {
  const define = (
    unit.tree as {
      DefineStmt?: {
        definition?: {
          DefElem?: {
            defname?: string
            arg?: { TypeName?: { names?: { String?: { sval?: string } }[] } }
          }
        }[]
      }
    }
  ).DefineStmt
  const names = (define?.definition ?? []).flatMap(({ DefElem: e }) =>
    e !== undefined && AGGREGATE_COMPONENTS.has(e.defname ?? "")
      ? [(e.arg?.TypeName?.names ?? []).map((n) => n.String?.sval ?? "")]
      : []
  )
  return names.some((parts) => {
    const name = parts.at(-1)
    const schema = parts.length > 1 ? parts.at(-2) : undefined
    return units.some(
      (u) =>
        u.class === "function" &&
        u.name === name &&
        (schema === undefined || u.schema === schema) &&
        isSecurityDefiner(u, units)
    )
  })
}

/**
 * Чи функція чи процедура виконується від власника: `SECURITY DEFINER` у
 * `CREATE` чи в окремому `ALTER FUNCTION` (порядок не моделюється —
 * fail-closed).
 */
export function isSecurityDefiner(
  unit: VerbatimUnit,
  units: readonly VerbatimUnit[]
): boolean {
  if (unit.class !== "function" && unit.class !== "procedure") return false
  const fn = (unit.tree as { CreateFunctionStmt?: FunctionTree })
    .CreateFunctionStmt
  if (fn === undefined) return false
  return (
    hasDefiner(fn.options ?? []) ||
    functionSettingsOf(unit, units).some((settings) =>
      hasDefiner(
        (settings.tree as { AlterFunctionStmt?: { actions?: Options } })
          .AlterFunctionStmt?.actions ?? []
      )
    )
  )
}

/** Чи функція — тригерна: її кличе лише тригер. */
export function isTriggerFunction(unit: VerbatimUnit): boolean {
  const fn = (unit.tree as { CreateFunctionStmt?: FunctionTree })
    .CreateFunctionStmt
  return fn !== undefined && returnsTrigger(fn)
}

/** Чи подання читає й пише від імені викликача (`security_invoker`). */
export function isSecurityInvoker(unit: VerbatimUnit): boolean {
  const view = (unit.tree as { ViewStmt?: { options?: Options } }).ViewStmt
  return securityInvoker(view?.options ?? [])
}

/**
 * Чи `role` може виконати функцію чи процедуру за дослівними грантами:
 * через `PUBLIC` (Postgres дає йому `EXECUTE` за замовчуванням, тож діє
 * лише явний `REVOKE … FROM PUBLIC` без гранту `PUBLIC`) чи явним грантом
 * ролі. Типові привілеї відкликанням не рахуються: вони діють лише на
 * об'єкти, створені після них і названою роллю.
 */
export function executableBy(
  unit: VerbatimUnit,
  units: readonly VerbatimUnit[],
  role: string,
  parse: SqlParser
): boolean {
  const own = new Set([
    `function|${unit.identity.slice(unit.identity.indexOf(":") + 1)}`,
  ])
  return (
    privilegedRoles(
      (key) => ownsTarget(own, key),
      "execute",
      grantFacts(units, parse),
      []
    ).length > 0 || explicitGrant(own, units, role, parse)
  )
}

function explicitGrant(
  own: ReadonlySet<string>,
  units: readonly VerbatimUnit[],
  role: string,
  parse: SqlParser
): boolean {
  return grantFacts(units, parse).some(
    (fact) =>
      fact.grant &&
      fact.roles.has(role) &&
      fact.keys.some((key) => ownsTarget(own, key)) &&
      (fact.privileges.length === 0 ||
        fact.privileges.some((p) => p.name === "execute" || p.name === "all"))
  )
}

function hasDefiner(options: Options): boolean {
  return options.some(
    (o) =>
      o.DefElem?.defname === "security" &&
      o.DefElem.arg?.Boolean?.boolval === true
  )
}

/** Тригерну функцію Postgres не дає викликати напряму: це не RPC. */
function returnsTrigger(fn: FunctionTree): boolean {
  const names = (fn.returnType?.names ?? []).map((n) => n.String?.sval)
  const type = names.at(-1)
  return (
    (names.length === 1 || (names.length === 2 && names[0] === "pg_catalog")) &&
    (type === "trigger" || type === "event_trigger")
  )
}

/** Значення булевої опції, які Postgres читає як «так». */
const TRUE_VALUES: ReadonlySet<string> = new Set([
  "true",
  "t",
  "on",
  "yes",
  "y",
  "1",
])

/**
 * Подання читає від імені викликача, лише коли кожне `security_invoker` у
 * `WITH` — «так» (опція без значення теж): незнайоме значення — fail-closed.
 * Окремого `ALTER VIEW` у файлах `.sql` не буває (`sql.statement-not-allowed`),
 * тож опцію задає лише `CREATE VIEW`.
 */
function securityInvoker(options: Options): boolean {
  const values = options.flatMap((o) =>
    o.DefElem?.defname === "security_invoker" ? [o.DefElem.arg] : []
  )
  return (
    values.length > 0 &&
    values.every(
      (arg) =>
        arg === undefined ||
        arg.Integer?.ival === 1 ||
        TRUE_VALUES.has(arg.String?.sval?.toLowerCase() ?? "")
    )
  )
}

/** Чи ключ цілі гранту (`grantTargetKeys`) називає одиницю. */
function targetOf(unit: VerbatimUnit): (key: string) => boolean {
  if (
    unit.class === "function" ||
    unit.class === "procedure" ||
    unit.class === "aggregate"
  ) {
    // `ON FUNCTION f` без аргументів — кожне перевантаження, як `ownsTarget`;
    // грант процедури й агрегату має той самий ключ `function|`.
    const own = new Set([
      `function|${unit.identity.slice(unit.identity.indexOf(":") + 1)}`,
    ])
    return (key) => ownsTarget(own, key)
  }
  const own = `table|${unit.schema}.${unit.name}`
  return (key) => key === own
}
