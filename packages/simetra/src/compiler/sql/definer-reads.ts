import {
  PROVIDER_API_ROLES,
  type PhysicalSnapshot,
  type Project,
} from "simetra/model"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import { grantTargetKeys, ownsTarget } from "../function-execute"
import type { ParsedObject } from "../stages/files"
import { functionSettingsOf, ruledFunctions } from "./closed-forms"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import { reachableUnits, relationReads } from "./reads"
import { functionIdentity, type VerbatimUnit } from "./units"

/** Що читає повз права викликача: функція, подання чи матеріалізоване подання. */
export type DefinerReadsForm = "function" | "view" | "materializedView"

const PUBLIC = "PUBLIC"

/**
 * Клас «RPC читання повз RLS» (платформна спека §6.7, Р21, Р30):
 * дослівна одиниця, яку роль API може викликати чи читати, виконує
 * читання від імені власника, а не викликача, і читає таблицю під RLS сама чи
 * через досяжні функції й подання. Тоді рядки, яких права викликача не
 * відкривають, видно повз модель прав. Форми:
 * - функція з `SECURITY DEFINER` (у `CREATE` чи окремим `ALTER FUNCTION`) і
 *   дієвим `EXECUTE` для ролі API — незалежно від закритої оболонки: типова
 *   така RPC якраз має форму `STABLE SECURITY DEFINER SET search_path = ''`;
 * - подання без `security_invoker` з дієвим `SELECT` для ролі API: воно читає
 *   від імені власника;
 * - матеріалізоване подання з дієвим `SELECT` — завжди: його рядки зберіг
 *   власник під час `REFRESH`, а читача RLS не обмежує зовсім.
 * Обробники й функції множини (`ruledFunctions`), функції значень виміру й
 * тригерні функції не судяться: це не RPC — тригерну функцію Postgres кличе
 * лише тригером, функції множини й виміру — політика від імені запиту, і
 * читати повз RLS їм належить за задумом (обмеження їхніх тіл судять власні
 * правила стадії 5). Власника одиниці статично не видно (власник без обходу RLS
 * нічого не відкриває), а подання може саме фільтрувати рядки функціями прав,
 * тож це попередження, а не помилка. Недосудних форм тіла (нелітеральний
 * `EXECUTE`, інша мова, непрочитаний текст) стадія 5 не бачить: їх відмовляє
 * ранній блок (спека прав §6.1).
 */
export function checkDefinerReads(
  objects: readonly ParsedObject[],
  project: Project,
  physical: PhysicalSnapshot,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Diagnostic[] {
  const rlsTables = physical.tables.filter((t) => t.rowLevelSecurity !== "off")
  const skipped = new Set([
    ...ruledFunctions(objects, project),
    ...dimensionFunctions(project),
  ])
  const grants = grantFacts(units, parse)
  const roles = PROVIDER_API_ROLES[project.database.provider]
  const apiRoles = [roles.user, roles.anonymous]
  const found: Diagnostic[] = []
  for (const unit of units) {
    const form = formOf(unit, units, skipped)
    if (form === undefined) continue
    const privileged = privilegedRoles(
      targetOf(unit),
      form === "function" ? "execute" : "select",
      grants,
      apiRoles
    )
    if (!privileged.some((role) => role !== PUBLIC)) continue
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

/** Ідентичності функцій значень вимірів доступу. */
function dimensionFunctions(project: Project): string[] {
  return project.accessDimensions.flatMap((dimension) => {
    if (!("function" in dimension.values)) return []
    const { schema = project.defaultSchema, name } = dimension.values.function
    return [functionIdentity(schema, name, [])]
  })
}

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
  if (unit.class !== "function" || skipped.has(unit.identity)) return undefined
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
  if (unit.class === "function") {
    // `ON FUNCTION f` без аргументів — кожне перевантаження, як `ownsTarget`.
    const own = new Set([`function|${unit.identity.slice("function:".length)}`])
    return (key) => ownsTarget(own, key)
  }
  const own = `table|${unit.schema}.${unit.name}`
  return (key) => key === own
}

/** Дослівний `GRANT`/`REVOKE` на функцію чи відношення. */
interface GrantFact {
  keys: readonly string[]
  grant: boolean
  /** `REVOKE GRANT OPTION FOR` — сам привілей лишається. */
  optionOnly: boolean
  /** Отримувачі: `PUBLIC` чи ім'я ролі. */
  roles: ReadonlySet<string>
  /** Привілеї; порожньо — `ALL`. `columns` — лише на колонки. */
  privileges: readonly { name: string; columns: boolean }[]
}

interface GrantTree {
  is_grant?: boolean
  grant_option?: boolean
  grantees?: { RoleSpec?: { roletype?: string; rolename?: string } }[]
  privileges?: { AccessPriv?: { priv_name?: string; cols?: unknown[] } }[]
}

function grantFacts(
  units: readonly VerbatimUnit[],
  parse: SqlParser
): GrantFact[] {
  return units.flatMap((unit) => {
    const stmt = (unit.tree as { GrantStmt?: GrantTree }).GrantStmt
    const keys = grantTargetKeys(unit, parse)
    if (stmt === undefined || keys.length === 0) return []
    const grant = stmt.is_grant === true
    return [
      {
        keys,
        grant,
        optionOnly: !grant && stmt.grant_option === true,
        roles: new Set(
          (stmt.grantees ?? []).flatMap(({ RoleSpec: spec }) =>
            spec?.roletype === "ROLESPEC_PUBLIC"
              ? [PUBLIC]
              : spec?.roletype === "ROLESPEC_CSTRING" &&
                  spec.rolename !== undefined
                ? [spec.rolename]
                : []
          )
        ),
        privileges: (stmt.privileges ?? []).map(({ AccessPriv: priv }) => ({
          name: priv?.priv_name ?? "all",
          columns: (priv?.cols ?? []).length > 0,
        })),
      },
    ]
  })
}

/**
 * Хто може мати привілей (платформна спека §6.7): `PUBLIC` — без явного відкликання від
 * `PUBLIC` чи з явним грантом йому (Postgres дає `PUBLIC` `EXECUTE` функцій);
 * роль API — так само щодо себе, або через `PUBLIC` (провайдер дає ролям API
 * привілеї типовими привілеями схеми). Типові привілеї не моделюються, а
 * порядок операторів — теж (грант перемагає): для попередження надлишок
 * безпечніший за пропуск. Відкликання лише на колонки чи лише права передачі
 * привілею не прибирає.
 */
function privilegedRoles(
  target: (key: string) => boolean,
  privilege: "execute" | "select",
  grants: readonly GrantFact[],
  apiRoles: readonly string[]
): string[] {
  const covers = (fact: GrantFact) =>
    fact.privileges.length === 0 ||
    fact.privileges.some(
      (p) =>
        (p.name === privilege || p.name === "all") && (fact.grant || !p.columns)
    )
  const facts = grants.filter((f) => f.keys.some(target) && covers(f))
  const granted = (role: string) =>
    facts.some((f) => f.grant && f.roles.has(role))
  const revoked = (role: string) =>
    facts.some((f) => !f.grant && !f.optionOnly && f.roles.has(role))
  const publicHas = granted(PUBLIC) || !revoked(PUBLIC)
  return [
    ...(publicHas ? [PUBLIC] : []),
    ...apiRoles.filter((role) => publicHas || granted(role) || !revoked(role)),
  ]
}
