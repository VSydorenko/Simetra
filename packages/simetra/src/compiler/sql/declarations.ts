import {
  PROVIDER_API_ROLES,
  PROVIDER_OWNER_ROLES,
  type DatabaseProvider,
  type GrantPurpose,
  type Project,
  type SqlFunctionDeclaration,
} from "simetra/model"
import {
  compareStrings,
  diagnostic,
  type Diagnostic,
  type RuleCode,
} from "../diagnostics"
import type { RightsContract } from "../contracts"
import type { ParsedFunctionsFile, ParsedObject } from "../stages/files"
import { platformFormSources } from "./closed-forms"
import { ON_BEHALF_OF_USER, isSecurityDefiner } from "./definer-reads"
import { qualifiedName } from "./identity"
import { FUNCTION_CLASSES, type VerbatimUnit } from "./units"

/**
 * Функція, яку називає декларація: пара `(schema, name)` після підстановки
 * `defaultSchema`. Пара, а не зклеєний `схема.ім'я`: ідентифікатори в лапках
 * можуть містити крапку, і `"a.b".c` та `a."b.c"` — різні функції (Р7).
 */
export interface DeclaredFunctionKey {
  schema: string
  name: string
}

/** Декларація, що резолвилась в одну дослівну одиницю `CREATE FUNCTION`. */
export interface DeclaredFunction {
  declaration: SqlFunctionDeclaration
  /** Файл `.functions.json`. */
  file: string
  /** JSON-pointer запису у файлі. */
  pointer: string
  /** Дослівна одиниця `CREATE FUNCTION` сусіднього `.sql`. */
  unit: VerbatimUnit
  key: DeclaredFunctionKey
}

interface DeclarationEntry {
  declaration: SqlFunctionDeclaration
  file: string
  sqlFile: string
  pointer: string
  key: DeclaredFunctionKey
}

const sameKey = (
  unit: Pick<VerbatimUnit, "schema" | "name">,
  key: DeclaredFunctionKey
) => unit.schema === key.schema && unit.name === key.name

function entriesOf(
  functionsFiles: readonly ParsedFunctionsFile[],
  defaultSchema: string
): DeclarationEntry[] {
  return functionsFiles.flatMap((file) =>
    file.functions.map((declaration, index) => ({
      declaration,
      file: file.file,
      sqlFile: file.sqlFile,
      pointer: `/functions/${index}`,
      key: {
        schema: declaration.function.schema ?? defaultSchema,
        name: declaration.function.name,
      },
    }))
  )
}

/** Одиниці простору імен функцій Postgres (`pg_proc`) з цією парою. */
function sameNamed(
  key: DeclaredFunctionKey,
  units: readonly VerbatimUnit[]
): VerbatimUnit[] {
  return units.filter((u) => FUNCTION_CLASSES.has(u.class) && sameKey(u, key))
}

/**
 * Єдина одиниця, яку називає декларація: `CREATE FUNCTION` сусіднього `.sql`
 * без інших одиниць з тією самою парою в просторі `pg_proc` (функцій,
 * процедур, агрегатів у будь-якому файлі). Інакше `undefined`: декларація
 * розрізняє функцію лише ім'ям, тож перевантаження її не резолвить.
 */
function resolve(
  entry: DeclarationEntry,
  units: readonly VerbatimUnit[]
): VerbatimUnit | undefined {
  const named = sameNamed(entry.key, units)
  const [only] = named
  return named.length === 1 &&
    only!.class === "function" &&
    only!.file === entry.sqlFile
    ? only
    : undefined
}

/**
 * Декларації, що резолвились у функцію сусіднього `.sql` (спека декларацій
 * функцій §5.1). Нерезолвлена декларація сюди не входить: її причину називає
 * `checkDeclarations`.
 */
export function declaredFunctions(
  functionsFiles: readonly ParsedFunctionsFile[],
  units: readonly VerbatimUnit[],
  defaultSchema: string
): DeclaredFunction[] {
  return entriesOf(functionsFiles, defaultSchema).flatMap((entry) => {
    const unit = resolve(entry, units)
    return unit === undefined
      ? []
      : [
          {
            declaration: entry.declaration,
            file: entry.file,
            pointer: entry.pointer,
            unit,
            key: entry.key,
          },
        ]
  })
}

/** Форма платформи: функція, призначення якої задають метадані. */
export type PlatformForm = "setFunction" | "subscriptionHandler" | "dimension"

/**
 * Призначення `EXECUTE` кожної форми платформи: їх виводить генератор
 * (`buildFunctionExecuteUnits`), а перехід декларації у форму (Р12) порівнює
 * з ними викликачів. Функцію множини кличе політика від імені запиту (ролі
 * користувача, сервісна й команд); обробник — тригер, функцію значень виміру
 * — тіло `rights_dimension_values*` від власника, тож обом не потрібна жодна
 * роль API.
 */
export const PLATFORM_FORM_PURPOSES: Readonly<
  Record<PlatformForm, readonly GrantPurpose[]>
> = {
  setFunction: ["user", "service", "command"],
  subscriptionHandler: [],
  dimension: [],
}

export interface PlatformFormFunction {
  function: DeclaredFunctionKey
  form: PlatformForm
  purposes: readonly GrantPurpose[]
}

/**
 * Функції форм платформи (спека декларацій функцій §5.3) — проєкція
 * `platformFormSources`. Ключ — `qualifiedName` пари `(schema, name)` за
 * правилом ідентичності, а не сире склеювання: `"a.b".c` і `a."b.c"` — дві
 * різні форми (Р7). Одна функція в кількох формах — перша форма переліку, як
 * у генераторі.
 */
export function platformFormFunctions(
  objects: readonly ParsedObject[],
  project: Project | undefined
): ReadonlyMap<string, PlatformFormFunction> {
  const forms = new Map<string, PlatformFormFunction>()
  for (const source of platformFormSources(objects, project)) {
    const key = qualifiedName(source.function.schema, source.function.name)
    if (forms.has(key)) continue
    forms.set(key, {
      ...source,
      purposes: PLATFORM_FORM_PURPOSES[source.form],
    })
  }
  return forms
}

/**
 * Правила резолву декларацій (спека декларацій функцій §5.1, §5.7): функції
 * немає в сусідньому `.sql` (`target-missing`), вона має перевантаження
 * (`overload`), її декларують два записи — в одному файлі після підстановки
 * `defaultSchema` чи в різних (`duplicate`), вона — форма платформи
 * (`platform-form`). Кожна діагностика — на запис файлу `.functions.json`.
 * `unparsed` — `.sql`, які не розібрано: їхні одиниці неповні, тож
 * відсутність цілі там не судиться.
 */
export function checkDeclarations(
  functionsFiles: readonly ParsedFunctionsFile[],
  units: readonly VerbatimUnit[],
  objects: readonly ParsedObject[],
  project: Project | undefined,
  unparsed: ReadonlySet<string>
): Diagnostic[] {
  if (project === undefined) return []
  const forms = [...platformFormFunctions(objects, project).values()]
  const seen = new Map<string, DeclarationEntry>()
  const found: Diagnostic[] = []
  for (const entry of entriesOf(functionsFiles, project.defaultSchema)) {
    const at = (code: RuleCode, extra: Record<string, string | number> = {}) =>
      found.push(
        diagnostic(code, entry.file, entry.pointer, {
          schema: entry.key.schema,
          name: entry.key.name,
          function: `${entry.key.schema}.${entry.key.name}`,
          ...extra,
        })
      )
    // Дубль судиться за парою після підстановки `defaultSchema`: записане
    // значення різне (`{ name }` і `{ schema, name }`), а функція та сама.
    const key = qualifiedName(entry.key.schema, entry.key.name)
    const first = seen.get(key)
    if (first === undefined) seen.set(key, entry)
    else at("sql.declaration-duplicate", { first: first.file + first.pointer })
    const form = forms.find((f) => sameKey(f.function, entry.key))
    if (form !== undefined) {
      at("sql.declaration-platform-form", { form: form.form })
    }
    const named = sameNamed(entry.key, units)
    if (named.length > 1) {
      at("sql.declaration-overload", { count: named.length })
    } else if (
      !unparsed.has(entry.sqlFile) &&
      !named.some((u) => u.class === "function" && u.file === entry.sqlFile)
    ) {
      at("sql.declaration-target-missing", { sqlFile: entry.sqlFile })
    }
  }
  return found
}

/**
 * Правила викликачів задекларованої definer-функції (спека декларацій функцій
 * §5.1): функцію, що виконується від власника, кличе роль, яка діє від імені
 * користувача (`user`, `command` — хук команди з id від клієнта), тож без
 * названої перевірки вона обійшла б RLS — `sql.declaration-check-missing`.
 * Перевірку з `check` доводить лише запобіжник у формі `guardOf` (Д2); до
 * нього довести її нічим, тож `check` — ще не доказ:
 * `sql.declaration-check-not-applied` з причиною `guardUnavailable` (Р3,
 * fail-closed). Роль без сесії перевірки користувача не має зовсім —
 * `sql.declaration-anonymous-definer`. Invoker-функція виконується з правами
 * викликача, тож її викликачі не судяться; лише `service` — теж: сервісна
 * роль не діє від імені користувача.
 */
export function checkDeclaredCallers(
  declared: readonly DeclaredFunction[],
  units: readonly VerbatimUnit[]
): Diagnostic[] {
  return declared.flatMap(({ declaration, file, pointer, unit, key }) => {
    if (!isSecurityDefiner(unit, units)) return []
    const at = (code: RuleCode, extra: Record<string, string> = {}) =>
      diagnostic(code, file, pointer, {
        schema: key.schema,
        name: key.name,
        function: `${key.schema}.${key.name}`,
        ...extra,
      })
    return [
      ...(declaration.callers.includes("anonymous")
        ? [at("sql.declaration-anonymous-definer")]
        : []),
      ...(!declaration.callers.some((c) => ON_BEHALF_OF_USER.has(c))
        ? []
        : declaration.check === undefined
          ? [at("sql.declaration-check-missing")]
          : // Шов Д2: доказ `guardOf` замінює цю причину.
            [
              at("sql.declaration-check-not-applied", {
                reason: "guardUnavailable",
              }),
            ]),
    ]
  })
}

/**
 * Схеми, типові привілеї яких на функції ставить сам провайдер від своєї
 * ролі-власника (керована `public` Supabase, платформна спека §6.9): такий ADP
 * — не SQL застосунку. ACL кожної функції там тримає похідний `REVOKE` від
 * `PUBLIC` і ролей API поза викликачами, тож майбутній функції він нічого не
 * відкриває.
 */
const PROVIDER_DEFAULT_PRIVILEGE_SCHEMAS: Readonly<
  Record<DatabaseProvider, readonly string[]>
> = { supabase: ["public"], postgres: [] }

interface DefaultPrivilegesTree {
  options?: {
    DefElem?: {
      defname?: string
      arg?: {
        List?: {
          items?: {
            String?: { sval?: string }
            RoleSpec?: { roletype?: string; rolename?: string }
          }[]
        }
      }
    }
  }[]
  action?: {
    is_grant?: boolean
    objtype?: string
    grantees?: { RoleSpec?: { roletype?: string; rolename?: string } }[]
  }
}

/**
 * `ALTER DEFAULT PRIVILEGES … GRANT … ON FUNCTIONS` (Postgres розбирає
 * `ON ROUTINES` у той самий `OBJECT_FUNCTION`) у SQL застосунку — помилка
 * `sql.default-privileges-execute` (спека декларацій функцій §5.1, Р15): він
 * дав би `EXECUTE` майбутнім функціям повз виведені гранти, а `EXECUTE`
 * виводить лише платформа. `REVOKE` лише звужує, тож не судиться. Виняток —
 * ADP ролі-власника провайдера в його керованій схемі
 * (`PROVIDER_DEFAULT_PRIVILEGE_SCHEMAS`) власнику й ролям API: без `FOR ROLE`
 * ADP діє для ролі, що застосовує схему, тобто для власника. Ключ класу ремонту (Р7): `schema` —
 * схеми `IN SCHEMA` через кому (порожньо — глобальний ADP), `name` —
 * ідентичність одиниці ADP: вона несе й тип об'єктів, напрям, отримувачів і
 * привілеї, тож два різні ADP на ту саму схему й роль не зливаються в один
 * ключ, і мутація, що додала другий, — нова помилка класу.
 */
export function checkDefaultPrivilegesExecute(
  units: readonly VerbatimUnit[],
  provider: DatabaseProvider
): Diagnostic[] {
  return units.flatMap((unit) => {
    const stmt = (
      unit.tree as { AlterDefaultPrivilegesStmt?: DefaultPrivilegesTree }
    ).AlterDefaultPrivilegesStmt
    if (
      unit.class !== "defaultPrivileges" ||
      stmt?.action?.is_grant !== true ||
      stmt.action.objtype !== "OBJECT_FUNCTION"
    )
      return []
    const items = (name: string) =>
      (stmt.options ?? []).flatMap(({ DefElem: e }) =>
        e?.defname === name ? (e.arg?.List?.items ?? []) : []
      )
    const schemas = items("schemas").map((i) => i.String?.sval ?? "")
    // Роль поза `ROLESPEC_CSTRING` (`CURRENT_USER`…) — порожнє ім'я: не
    // власник (fail-closed).
    const roles = items("roles").map((i) =>
      i.RoleSpec?.roletype === "ROLESPEC_CSTRING"
        ? (i.RoleSpec.rolename ?? "")
        : ""
    )
    const managed = PROVIDER_DEFAULT_PRIVILEGE_SCHEMAS[provider]
    const owner = PROVIDER_OWNER_ROLES[provider]
    // Отримувачі пресету — власник і ролі API: їх `EXECUTE` на
    // недекларованій definer-функції судить `checkDefinerReads` (типові
    // привілеї ролей API він рахує сам). Роль команд такого запасу не має —
    // її типові привілеї правило не рахує, — тож ADP їй чи іншій ролі
    // винятком не є.
    const presetRoles = new Set<string>([
      owner,
      ...Object.values(PROVIDER_API_ROLES[provider]).filter(
        (role): role is string => typeof role === "string"
      ),
    ])
    if (
      schemas.length > 0 &&
      schemas.every((schema) => managed.includes(schema)) &&
      roles.every((role) => role === owner) &&
      (stmt.action.grantees ?? []).every(
        ({ RoleSpec: spec }) =>
          spec?.roletype === "ROLESPEC_CSTRING" &&
          presetRoles.has(spec.rolename ?? "")
      )
    )
      return []
    return [
      diagnostic("sql.default-privileges-execute", unit.file, "", {
        schema: [...schemas].sort(compareStrings).join(","),
        name: unit.identity,
        line: unit.line,
      }),
    ]
  })
}

/** Причини `sql.declaration-check-form` (спека декларацій функцій §5.2). */
export type CheckFormReason =
  | "invoker"
  | "noRights"
  | "unknownAction"
  | "twoTargets"
  | "targetParameter"
  | "scopeUnscoped"
  | "createOnRow"
  | "createOnRoot"
  | "targetRequired"
  | "targetForbidden"

interface ParameterNode {
  FunctionParameter?: {
    name?: string
    mode?: string
    argType?: {
      names?: { String?: { sval?: string } }[]
      arrayBounds?: unknown[]
      setof?: boolean
    }
  }
}

/**
 * Параметр цілі — `IN`-параметр типу `uuid` з таким іменем: режим без слова
 * (`FUNC_PARAM_DEFAULT`) теж `IN`. Масив, `SETOF`, `OUT`, `INOUT` і `VARIADIC`
 * значення рядка не несуть.
 */
function hasUuidInParameter(unit: VerbatimUnit, name: string): boolean {
  const parameters = (
    unit.tree as { CreateFunctionStmt?: { parameters?: ParameterNode[] } }
  ).CreateFunctionStmt?.parameters
  return (parameters ?? []).some(({ FunctionParameter: p }) => {
    if (p?.name !== name) return false
    if (
      p.mode !== undefined &&
      p.mode !== "FUNC_PARAM_IN" &&
      p.mode !== "FUNC_PARAM_DEFAULT"
    )
      return false
    const names = (p.argType?.names ?? []).map((n) => n.String?.sval)
    return (
      (names.length === 1 ||
        (names.length === 2 && names[0] === "pg_catalog")) &&
      names[names.length - 1] === "uuid" &&
      (p.argType?.arrayBounds ?? []).length === 0 &&
      p.argType?.setof !== true
    )
  })
}

/**
 * Причина, з якої `check` декларації не відповідає об'єкту чи підпису
 * (спека декларацій функцій §5.2), або `undefined`. Перша спрацьована
 * причина — одна на декларацію.
 */
function checkFormReason(
  { declaration, unit }: DeclaredFunction,
  units: readonly VerbatimUnit[],
  objects: readonly ParsedObject[],
  rights: readonly RightsContract[]
): CheckFormReason | undefined {
  const check = declaration.check
  if (check === undefined) return undefined
  // Invoker-функцію вже обмежує RLS викликача: названа перевірка їй зайва.
  if (!isSecurityDefiner(unit, units)) return "invoker"
  const object = objects.find(
    (o) => o.kind === check.object.kind && o.name === check.object.name
  )
  const contract = rights.find((r) => r.objectId === object?.id)
  if (contract === undefined) return "noRights"
  const action = contract.actions.find((a) => a.name === check.action)
  if (action === undefined) return "unknownAction"
  if (check.row !== undefined && check.scope !== undefined) return "twoTargets"
  const target = check.row ?? check.scope
  if (target !== undefined && !hasUuidInParameter(unit, target))
    return "targetParameter"
  if (check.scope !== undefined && contract.scopeKindId === undefined)
    return "scopeUnscoped"
  const create = action.action === "create"
  if (create && check.row !== undefined) return "createOnRow"
  // Рядка створення ще немає, а `INSERT` кореня виду скоупу судить окрема
  // булева форма (спека прав Рх9): названа перевірка йому не відповідає.
  if (create && contract.root === true) return "createOnRoot"
  // Предикати дії читають носія рядка (скоуп, власність, вимір, контейнер):
  // без цілі судити нічого. `create` носія ще не має — для нього ціль `scope`.
  const carriers =
    contract.scopeKindId !== undefined ||
    contract.ownership.length > 0 ||
    contract.access.length > 0 ||
    contract.container === true ||
    contract.binding !== undefined
  if (target === undefined && carriers) return "targetRequired"
  if (target !== undefined && !carriers) return "targetForbidden"
  return undefined
}

/**
 * Суддя `check` над контрактами прав (спека декларацій функцій §5.2, Р1):
 * мітка виду й UUID кастомної дії існують лише там, тож перевірка стоїть
 * після `rightsContracts`. Помилка автора декларації, не клас ремонту.
 */
export function checkDeclaredChecks(
  declared: readonly DeclaredFunction[],
  units: readonly VerbatimUnit[],
  objects: readonly ParsedObject[],
  rights: readonly RightsContract[]
): Diagnostic[] {
  return declared.flatMap((entry) => {
    const reason = checkFormReason(entry, units, objects, rights)
    return reason === undefined
      ? []
      : [
          diagnostic("sql.declaration-check-form", entry.file, entry.pointer, {
            schema: entry.key.schema,
            name: entry.key.name,
            function: `${entry.key.schema}.${entry.key.name}`,
            reason,
          }),
        ]
  })
}
