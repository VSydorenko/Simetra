import type { Node } from "libpg-query"
import {
  KIND_REGISTRY,
  PLATFORM_SETTING_PREFIX,
  PROVIDER_SCHEMAS,
  PROVIDER_SQL_TEXT_FUNCTIONS,
  type DatabaseProvider,
  type Project,
} from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { commandContextWrite, type CommandContextHit } from "./command-context"
import { isExpressionUnit } from "./expression-calls"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import {
  FUNCTION_CLASSES,
  functionIdentity,
  type RowRule,
  type VerbatimUnit,
} from "./units"

/** Чим функція виходить за закриту оболонку (спека промоції §9.4). */
export type ClosedShellProblem =
  "language" | "volatility" | "searchPath" | "dynamicSql" | "body"

/** Одиниця, чию оболонку судять: дерево `CREATE FUNCTION` і його текст. */
export interface ShellUnit {
  tree: Node
  sql: string
}

interface DefElem {
  defname?: string
  arg?: {
    String?: { sval?: string }
    Boolean?: { boolval?: boolean }
    List?: { items?: { String?: { sval?: string } }[] }
    VariableSetStmt?: {
      kind?: string
      name?: string
      args?: { A_Const?: { sval?: { sval?: string } } }[]
    }
  }
}

interface FunctionNode {
  is_procedure?: boolean
  options?: { DefElem?: DefElem }[]
  sql_body?: unknown
}

/** `CREATE FUNCTION` дерева; інший оператор чи процедура — `undefined`. */
function createFunction(tree: Node): FunctionNode | undefined {
  const fn = (tree as { CreateFunctionStmt?: FunctionNode }).CreateFunctionStmt
  return fn === undefined || fn.is_procedure === true ? undefined : fn
}

function functionOptions(fn: FunctionNode) {
  const options = (fn.options ?? []).flatMap((o) =>
    o.DefElem === undefined ? [] : [o.DefElem]
  )
  return {
    options,
    option: (name: string) =>
      options.filter((o) => o.defname === name).at(-1)?.arg,
  }
}

function functionLanguage(fn: FunctionNode): string | undefined {
  // Тіло стандарту SQL (`RETURN …`, `BEGIN ATOMIC`) без LANGUAGE — це `sql`.
  return (
    functionOptions(fn).option("language")?.String?.sval?.toLowerCase() ??
    (fn.sql_body === undefined ? undefined : "sql")
  )
}

/**
 * Мова `CREATE FUNCTION`/`CREATE PROCEDURE` у нижньому регістрі; інший
 * оператор чи мова без імені — `undefined`. Одне правило для оболонки й
 * переписувача, щоб вони не розходились у тому, яке тіло перед ними.
 */
export function routineLanguage(tree: Node): string | undefined {
  const fn = (tree as { CreateFunctionStmt?: FunctionNode }).CreateFunctionStmt
  return fn === undefined ? undefined : functionLanguage(fn)
}

type SetOption = NonNullable<NonNullable<DefElem["arg"]>["VariableSetStmt"]>

/** Опція `SET … = ''` — порожній список схем. */
function setsEmptyValue(set: SetOption | undefined): boolean {
  const args = set?.args ?? []
  return (
    set?.kind === "VAR_SET_VALUE" &&
    args.length === 1 &&
    args[0]!.A_Const?.sval?.sval === ""
  )
}

/**
 * Порожній `search_path` після опцій самого `CREATE`, згорнутих по черзі, як
 * це робить Postgres (`update_proconfig_value`): ім'я налаштування нечутливе
 * до регістру, опція `RESET ALL` прибирає все задане до неї, перемагає
 * останнє. Без цього `SET search_path = '' RESET ALL` чи пізніший
 * `SET "SEARCH_PATH" = 'public'` лишали б оболонці, ланці виміру й обходу
 * уявний порожній шлях (Р2c1-10 (б)).
 */
function foldedEmptySearchPath(options: readonly DefElem[]): boolean {
  let empty = false
  for (const option of options) {
    const set =
      option.defname === "set" ? option.arg?.VariableSetStmt : undefined
    if (set?.kind === "VAR_RESET_ALL") empty = false
    else if (set?.name?.toLowerCase() === "search_path") {
      empty = setsEmptyValue(set)
    }
  }
  return empty
}

/**
 * Функція з `SET search_path = ''` після згортання опцій `CREATE`
 * (`foldedEmptySearchPath`): лише тоді некваліфіковане ім'я в її тілі не
 * може розв'язатися в чужу схему.
 */
export function hasEmptySearchPath(tree: Node): boolean {
  const fn = createFunction(tree)
  return fn !== undefined && foldedEmptySearchPath(functionOptions(fn).options)
}

interface AlterFunctionNode {
  func?: {
    objname?: { String?: { sval?: string } }[]
    args_unspecified?: boolean
  }
  actions?: { DefElem?: DefElem }[]
}

function alterFunction(tree: unknown): AlterFunctionNode | undefined {
  return (tree as { AlterFunctionStmt?: AlterFunctionNode } | undefined)
    ?.AlterFunctionStmt
}

/**
 * Чи одиниця `functionSettings` (`ALTER FUNCTION`) діє на функцію чи
 * процедуру `fn`: за `схема.ім'я`, без типів аргументів (fail-closed).
 * Сигнатуру ідентичності компілятор зводить не так, як Postgres: `%TYPE` не
 * розгортає, а некваліфікований тип поза моделлю лишає як є, тож `ALTER` з
 * іншим написанням типу тієї самої функції `pg_proc` виходив би з-під
 * перевірки. Перевантаження компілятор не розрізняє й в обході досяжності, а
 * в закритих модулях їх заборонено (`sql.function-overload`). Некваліфіковане
 * ім'я — у будь-якій схемі: рендер не задає `search_path`, тож Postgres
 * розв'яже його за шляхом сесії, а не за схемою файлу (як `kindTableOf`).
 */
export function settingsTargets(
  settings: Pick<VerbatimUnit, "tree">,
  fn: Pick<VerbatimUnit, "class" | "schema" | "name">
): boolean {
  if (fn.class !== "function" && fn.class !== "procedure") return false
  const alter = alterFunction(settings.tree)
  const names = (alter?.func?.objname ?? []).map((n) => n.String?.sval)
  return (
    names.at(-1) === fn.name &&
    (names.length === 1 || names.at(-2) === fn.schema)
  )
}

/** Одиниці `ALTER FUNCTION` функції чи процедури (Р2c1-10 (б)). */
export function functionSettingsOf(
  fn: VerbatimUnit,
  units: readonly VerbatimUnit[]
): VerbatimUnit[] {
  return units.filter(
    (u) => u.class === "functionSettings" && settingsTargets(u, fn)
  )
}

/**
 * Ефективний порожній `search_path` (Р2c1-10 (б)): його задає сам `CREATE`
 * (функції чи процедури) після згортання всіх його опцій
 * (`foldedEmptySearchPath`), і жодна одиниця `ALTER FUNCTION` цієї функції не
 * зачіпає `search_path` (`SET`, `RESET`, `FROM CURRENT`) і не робить `RESET
 * ALL`. Порядок одиниць не моделюється (fail-closed): окремий `ALTER … RESET
 * search_path` інакше змінив би розв'язання імен під час виконання повз
 * статичне судження. Закрита оболонка й ланка виміру (`hasEmptySearchPath`)
 * судять лише сам `CREATE` за тим самим згортанням: окремий `ALTER FUNCTION`
 * на судиму функцію — окрема помилка (`function-settings-shell.ts`).
 */
export function hasEffectiveEmptySearchPath(
  unit: VerbatimUnit,
  units: readonly VerbatimUnit[]
): boolean {
  const fn = (unit.tree as { CreateFunctionStmt?: FunctionNode })
    .CreateFunctionStmt
  if (fn === undefined || !foldedEmptySearchPath(functionOptions(fn).options)) {
    return false
  }
  return functionSettingsOf(unit, units).every((settings) => {
    const alter = alterFunction(settings.tree)
    if (alter === undefined) return false
    return !(alter.actions ?? []).some((action) => {
      const set =
        action.DefElem?.defname === "set"
          ? action.DefElem.arg?.VariableSetStmt
          : undefined
      return (
        set !== undefined &&
        (set.kind === "VAR_RESET_ALL" ||
          set.name?.toLowerCase() === "search_path")
      )
    })
  })
}

/**
 * Закрита оболонка функції (спека П2 §3, «Дослівний SQL»): мова `sql` чи
 * `plpgsql`, явна волатильність, `SECURITY DEFINER` лише з `SET search_path
 * = ''`. Оболонка — те, що компілятор може перевірити статично: тіло лишається
 * кодом застосунку, а мова C чи неявна `VOLATILE` ховали б від рамки те, що
 * функція робить. Тіло plpgsql має розбиратися і не виконувати динамічний
 * SQL: рядок, зібраний під час виконання, не бачить ні граф залежностей, ні
 * рамка. Парсер plpgsql кличеться лише для `LANGUAGE plpgsql`: на тілі
 * `LANGUAGE sql … BEGIN ATOMIC` він аварійно завершується, і кожне тіло
 * стандарту SQL хибно вважалося б нерозбірним. Не функція (процедура, інший
 * оператор) — `undefined`: оболонка описує лише `CREATE FUNCTION`.
 */
export function closedShellProblem(
  unit: ShellUnit,
  plpgsql: PlpgsqlParser
): ClosedShellProblem | undefined {
  const fn = createFunction(unit.tree)
  if (fn === undefined) return undefined
  const { options, option } = functionOptions(fn)
  const language = functionLanguage(fn)
  if (language !== "sql" && language !== "plpgsql") return "language"
  if (option("volatility") === undefined) return "volatility"
  if (
    option("security")?.Boolean?.boolval === true &&
    !foldedEmptySearchPath(options)
  ) {
    return "searchPath"
  }
  if (language !== "plpgsql") return undefined
  const body = plpgsql(unit.sql)
  if (!body.ok) return "body"
  if (body.fn !== undefined && body.fn.dynamicSqlLines.length > 0) {
    return "dynamicSql"
  }
  return undefined
}

/**
 * Рядок у файлі першого динамічного оператора тіла plpgsql: `unitLine` —
 * рядок першого токена оператора у файлі. Парсер рахує від рядка з
 * відкривним `$тег$`, тож додається зсув тіла в тексті оператора. Тіло в
 * лапках з подвоєнням `''` у тексті не знаходиться — тоді лічба від рядка
 * початку оператора, що лише раніша за істинний.
 */
export function firstDynamicSqlLine(
  unit: ShellUnit,
  unitLine: number,
  plpgsql: PlpgsqlParser
): number | undefined {
  const fn = createFunction(unit.tree)
  if (fn === undefined || functionLanguage(fn) !== "plpgsql") return undefined
  const parsed = plpgsql(unit.sql)
  const first = parsed.ok ? parsed.fn?.dynamicSqlLines[0] : undefined
  if (first === undefined) return undefined
  const body = functionOptions(fn).option("as")?.List?.items?.[0]?.String?.sval
  const at = body === undefined ? -1 : unit.sql.indexOf(body)
  const before = at < 0 ? 0 : unit.sql.slice(0, at).split("\n").length - 1
  return unitLine + before + first - 1
}

/**
 * Запис, що зачіпає налаштування платформи неминуче: ім'я з її префіксом
 * (нечутливе до регістру, як у Postgres), оператор `RESET ALL` (`*`) чи
 * запис у `pg_settings`, ім'я в якому статично не перевірити (Р2b1-19a).
 * `session_replication_role` — теж платформи (Р2c1-40): `replica` вимикає її
 * тригери (носії, ефекти, механіка, RI), а в сесії пулу — і для чужих команд,
 * тож у боргу він помилка, а не попередження.
 */
export function platformWrite(hit: CommandContextHit): boolean {
  const setting = hit.setting?.toLowerCase()
  return (
    hit.form === "settingsTable" ||
    setting === "*" ||
    setting === "session_replication_role" ||
    setting?.startsWith(PLATFORM_SETTING_PREFIX) === true
  )
}

/**
 * Ідентичності функцій без аргументів, які оголошують метадані: обробники
 * підписок і функції множини видів скоупу. Обидві мають власні правила
 * оболонки (стадія 5), тож не є ні боргом, ні винятком із ратчета.
 */
export function ruledFunctions(
  objects: readonly ParsedObject[],
  project: Project | undefined
): ReadonlySet<string> {
  if (project === undefined) return new Set()
  const declared = [
    ...objects.flatMap((o) => {
      const spec = KIND_REGISTRY[o.kind].subscription?.(o.data)
      return spec === undefined ? [] : [spec.handler]
    }),
    // Згенерована функція множини (`membership`) — не дослівна одиниця.
    ...project.scopeKinds.flatMap((kind) =>
      typeof kind.setFunction === "string" ? [] : [kind.setFunction]
    ),
  ]
  return new Set(
    declared.map((fn) =>
      functionIdentity(fn.schema ?? project.defaultSchema, fn.name, [])
    )
  )
}

/**
 * Файли об'єктів, чий вид має факт `sqlModule: "closed"`: модуль такого
 * об'єкта приймає лише закриті форми. Вид — з `ownerFile` стадії 1, тож
 * перевірка не чекає моделі стадії 3.
 */
export function closedModuleOwners(
  objects: readonly ParsedObject[]
): ReadonlySet<string> {
  return new Set(
    objects
      .filter((o) => KIND_REGISTRY[o.kind].sqlModule === "closed")
      .map((o) => o.file)
  )
}

/**
 * Схема, куди `CREATE EXTENSION` ставить свої об'єкти (опція `SCHEMA`);
 * без неї — `undefined`: розширення стає в першу схему `search_path` сесії,
 * яка статично не відома.
 */
export function extensionSchema(tree: unknown): string | undefined {
  const options = (
    tree as {
      CreateExtensionStmt?: {
        options?: {
          DefElem?: { defname?: string; arg?: { String?: { sval?: string } } }
        }[]
      }
    }
  ).CreateExtensionStmt?.options
  return options?.find((o) => o.DefElem?.defname === "schema")?.DefElem?.arg
    ?.String?.sval
}

/**
 * Схеми застосунку, куди боргові розширення ставлять функції (Р2c1-35):
 * явна `SCHEMA` поза схемами провайдера; `all` — є розширення без `SCHEMA`,
 * тож воно могло стати в будь-яку схему застосунку.
 */
export function extensionSchemas(
  units: readonly VerbatimUnit[],
  provider: DatabaseProvider
): { all: boolean; schemas: ReadonlySet<string> } {
  const allowed = new Set(PROVIDER_SCHEMAS[provider])
  const schemas = new Set<string>()
  let all = false
  for (const unit of units) {
    if (unit.class !== "extension") continue
    const schema = extensionSchema(unit.tree)
    if (schema === undefined) all = true
    else if (!allowed.has(schema)) schemas.add(schema)
  }
  return { all, schemas }
}

/**
 * Виклик, що виконує текст SQL, у функції чи процедурі судить дозвільний
 * перелік тіла (`sql.function-body-statement`, Р2c1-50) — помилкою скрізь,
 * борг включно; тут він дав би другу діагностику того самого виклику. Так
 * само кожен виклик подання чи політики (`set_config`, виконання тексту SQL)
 * судить дозвільний перелік виразів (`sql.expression-call-not-allowed`,
 * Р2c1-55): тут лишається лише запис у `pg_settings`.
 */
function judgedElsewhere(
  unit: Pick<VerbatimUnit, "class">,
  hit: CommandContextHit
): boolean {
  if (isExpressionUnit(unit)) return CALL_FORMS.has(hit.form)
  return (
    hit.form === "dynamicText" &&
    (unit.class === "function" || unit.class === "procedure")
  )
}

/** Форми запису сесії, які дає лише виклик функції в виразі. */
const CALL_FORMS: ReadonlySet<CommandContextHit["form"]> = new Set([
  "setConfig",
  "nonLiteral",
  "dynamicText",
])

/**
 * Модуль об'єкта виду з фактом `sqlModule: "closed"` приймає лише функції в
 * закритій оболонці без перевантажень і правила рядка; блоки запиту рухів
 * вирізано до розбору, тож одиницями вони не стають. Решта класів —
 * `sql.statement-not-allowed` з підказкою властивості, що їх заміщує. Модуль
 * `debt` і спільні `sql/` за формою не звужуються: це борг, його ратчет —
 * окремо; правило рядка поза модулем виду — помилка, бо воно належить таблиці
 * об'єкта, а таблиці боргу описані власними полями. Контекст команди
 * (`sql.command-context-write`) судиться інакше: кожна одиниця модулів видів
 * і спільних `sql/`-файлів, обробники підписок і функції множини — будь-де;
 * одиниця боргу (`isDebt` — `debtPredicate` ратчета) — лише платформним
 * префіксом, решта її записів — попередження `sql.debt-session-write`
 * (Р2c1-6, Р2c1-14). Функції провайдера `provider`, що виконують текст SQL,
 * судяться формою `dynamicText` (Р2c1-32); без проєкту провайдера немає. У
 * функції чи процедурі цю форму судить перелік тіла (`judgedElsewhere`).
 */
export function checkSqlModules(
  objects: readonly ParsedObject[],
  units: readonly VerbatimUnit[],
  rowRules: readonly RowRule[],
  isDebt: (unit: VerbatimUnit) => boolean,
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  provider: DatabaseProvider | undefined
): Diagnostic[] {
  const textFunctions: ReadonlySet<string> = new Set(
    provider === undefined ? [] : PROVIDER_SQL_TEXT_FUNCTIONS[provider]
  )
  const owners = closedModuleOwners(objects)
  const closed = (unit: { ownerFile?: string }) =>
    unit.ownerFile !== undefined && owners.has(unit.ownerFile)
  // Перевантаження рахуються серед усіх функцій схеми (простір `pg_proc`:
  // функції, процедури, агрегати), а не лише модуля: інакше друга сигнатура
  // в спільному файлі чи процедура з тим самим ім'ям обходила б заборону.
  const functionsByName = new Map<string, number>()
  for (const unit of units) {
    if (!FUNCTION_CLASSES.has(unit.class)) continue
    const key = `${unit.schema}.${unit.name}`
    functionsByName.set(key, (functionsByName.get(key) ?? 0) + 1)
  }
  const found: Diagnostic[] = []
  for (const rule of rowRules) {
    if (closed(rule)) continue
    found.push(
      diagnostic("sql.row-rule-outside-module", rule.file, "", {
        table: `${rule.schema}.${rule.table}`,
        line: rule.line,
      })
    )
  }
  // Кожна одиниця спільних `sql/`-файлів і модулів видів, не лише функції
  // (Р2b1-22): функція закритого модуля чи обробник може викликати допоміжну
  // функцію спільного файлу, а подання, домен чи політика виконують свій
  // вираз у сесії команди, тож межа довіри (Р2b1-19a) охоплює їх усі.
  for (const unit of units) {
    if (closed(unit)) continue
    const writes = commandContextWrite(
      unit.tree as Node,
      unit.sql,
      parse,
      plpgsql,
      textFunctions
    ).filter((hit) => !judgedElsewhere(unit, hit))
    if (writes.length === 0) continue
    const name = unit.schema === "" ? unit.name : `${unit.schema}.${unit.name}`
    if (!isDebt(unit)) {
      found.push(
        diagnostic("sql.command-context-write", unit.file, "", {
          name,
          form: writes[0]!.form,
        })
      )
      continue
    }
    // Одиниця боргу — модуля прийнятої таблиці чи спільного `sql/`-файлу
    // (Р2c1-6, Р2c1-14) — судиться контекстом команди м'якше. Платформний
    // префікс несе контекст команди й режим обслуговування прав — у чужому
    // боргу його бути не може, тож запис туди (зокрема `RESET ALL` і запис у
    // `pg_settings`, що зачіпають його неминуче) — помилка. Зміна ролі чи
    // claims може лишатися, доки одиниця — борг: голова кличе лише
    // функції-запити, а запис сесії в них неможливий (`sql.head-not-allowed`,
    // Р2c1-18), новий же неперелічений борг — `sql.debt-grows`, тож
    // попередження дістає лише прийнятий борг реальної бази, якого голова
    // не кличе. Борг — рівно те, що рахує ратчет
    // (`debtPredicate`): функція в закритій оболонці, обробник і функція
    // множини боргом не бувають, тож їхній запис — помилка вище. Судяться всі
    // записи одиниці: помилка не ховається за попередженням.
    const platform = writes.find(platformWrite)
    const hit = platform ?? writes[0]!
    found.push(
      diagnostic(
        platform === undefined
          ? "sql.debt-session-write"
          : "sql.command-context-write",
        unit.file,
        "",
        {
          name,
          form: hit.form,
          ...(hit.setting === undefined ? {} : { setting: hit.setting }),
          ...(platform === undefined ? {} : { unit: "debt" }),
        }
      )
    )
  }
  // Розширення лише в схемах провайдера (Р2c1-35): функція розширення в
  // схемі застосунку перевантажила б функцію-запит з тим самим ім'ям. Поза
  // боргом такої одиниці не буває — модуль виду `CREATE EXTENSION` відмовляє
  // вище, а одиниця спільного файлу — борг, — тож це попередження.
  const providerSchemas: ReadonlySet<string> = new Set(
    provider === undefined ? [] : PROVIDER_SCHEMAS[provider]
  )
  for (const unit of units) {
    if (provider === undefined || unit.class !== "extension" || closed(unit))
      continue
    const schema = extensionSchema(unit.tree)
    if (schema !== undefined && providerSchemas.has(schema)) continue
    found.push(
      diagnostic("sql.debt-extension-schema", unit.file, "", {
        extension: unit.name,
        ...(schema === undefined ? {} : { schema }),
      })
    )
  }
  for (const unit of units) {
    if (!closed(unit)) continue
    if (unit.class !== "function") {
      found.push(
        diagnostic("sql.statement-not-allowed", unit.file, "", {
          statement: Object.keys(unit.tree as object)[0] ?? "unknown",
          line: unit.line,
          detail: "kindModule",
          class: unit.class,
        })
      )
      continue
    }
    const shellUnit = { tree: unit.tree as Node, sql: unit.sql }
    const problem = closedShellProblem(shellUnit, plpgsql)
    if (problem !== undefined) {
      // Для динамічного SQL автору потрібен рядок самого оператора, а не
      // початку функції: тіло буває на сотню рядків.
      const line =
        problem === "dynamicSql"
          ? (firstDynamicSqlLine(shellUnit, unit.line, plpgsql) ?? unit.line)
          : unit.line
      found.push(
        diagnostic("sql.closed-shell", unit.file, "", {
          function: `${unit.schema}.${unit.name}`,
          line,
          problem,
        })
      )
    }
    // Контекст команди ставить лише `runCommand` (Р2b1-19): SQL застосунку
    // виконується посеред оператора команди, і змінений ним контекст побачили
    // б політики наступних рядків. Оболонка, що не пройшла, тіла не гарантує.
    const write =
      problem === undefined
        ? commandContextWrite(
            shellUnit.tree,
            unit.sql,
            parse,
            plpgsql,
            textFunctions
          ).find((hit) => !judgedElsewhere(unit, hit))
        : undefined
    if (write !== undefined) {
      found.push(
        diagnostic("sql.command-context-write", unit.file, "", {
          name: `${unit.schema}.${unit.name}`,
          form: write.form,
        })
      )
    }
    if ((functionsByName.get(`${unit.schema}.${unit.name}`) ?? 0) > 1) {
      found.push(
        diagnostic("sql.function-overload", unit.file, "", {
          function: `${unit.schema}.${unit.name}`,
          identity: unit.identity,
          line: unit.line,
        })
      )
    }
  }
  return found
}
