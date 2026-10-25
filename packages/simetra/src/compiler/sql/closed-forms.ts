import type { Node } from "libpg-query"
import {
  KIND_REGISTRY,
  PLATFORM_SETTING_PREFIX,
  type Project,
} from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { commandContextWrite, type CommandContextHit } from "./command-context"
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

function emptySearchPath(options: readonly DefElem[]): boolean {
  // Останній `SET search_path` перемагає, як і в Postgres.
  return setsEmptyValue(
    options
      .filter(
        (o) =>
          o.defname === "set" && o.arg?.VariableSetStmt?.name === "search_path"
      )
      .at(-1)?.arg?.VariableSetStmt
  )
}

/**
 * Порожній `search_path` після опцій самого `CREATE`, згорнутих по черзі, як
 * це робить Postgres (`update_proconfig_value`): ім'я налаштування нечутливе
 * до регістру, опція `RESET ALL` прибирає все задане до неї, перемагає
 * останнє. Без цього `SET search_path = '' RESET ALL` чи пізніший
 * `SET "SEARCH_PATH" = 'public'` лишали б обходу уявний порожній шлях.
 * `emptySearchPath` закритої оболонки не змінюється (Р2c1-10 (б)).
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
 * Функція з `SET search_path = ''` (останній `SET` перемагає): лише тоді
 * некваліфіковане ім'я в її тілі не може розв'язатися в чужу схему.
 */
export function hasEmptySearchPath(tree: Node): boolean {
  const fn = createFunction(tree)
  return fn !== undefined && emptySearchPath(functionOptions(fn).options)
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
 * процедуру `fn`. Ідентичності без префікса класу збігаються
 * (`function:<схема.ім'я(типи)>` ↔ `functionSettings:<схема.ім'я(типи)>`);
 * `ALTER` без аргументів — кожне перевантаження з цим ім'ям, як `ownsTarget`.
 * Некваліфіковане ім'я — у будь-якій схемі (fail-closed): рендер не задає
 * `search_path`, тож Postgres розв'яже його за шляхом сесії, а не за схемою
 * файлу (як `kindTableOf`).
 */
export function settingsTargets(
  settings: Pick<VerbatimUnit, "identity" | "tree">,
  fn: Pick<VerbatimUnit, "class" | "identity" | "name">
): boolean {
  if (fn.class !== "function" && fn.class !== "procedure") return false
  const alter = alterFunction(settings.tree)
  const names = (alter?.func?.objname ?? []).map((n) => n.String?.sval)
  if (names.length === 1) return names[0] === fn.name
  const target = settings.identity.slice("functionSettings:".length)
  const key = fn.identity.slice(fn.class.length + 1)
  return (
    target === key || (!target.endsWith(")") && key.startsWith(`${target}(`))
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
 * статичне судження. `hasEmptySearchPath` лишається правилом однієї одиниці
 * для закритої оболонки.
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
    !emptySearchPath(options)
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
 */
function platformWrite(hit: CommandContextHit): boolean {
  return (
    hit.form === "settingsTable" ||
    hit.setting === "*" ||
    hit.setting?.toLowerCase().startsWith(PLATFORM_SETTING_PREFIX) === true
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
 * Модуль об'єкта виду з фактом `sqlModule: "closed"` приймає лише функції в
 * закритій оболонці без перевантажень і правила рядка; блоки запиту рухів
 * вирізано до розбору, тож одиницями вони не стають. Решта класів —
 * `sql.statement-not-allowed` з підказкою властивості, що їх заміщує. Модуль
 * `debt` і спільні `sql/` за формою не звужуються: це борг, його ратчет —
 * окремо; правило рядка поза модулем виду — помилка, бо воно належить таблиці
 * об'єкта, а таблиці боргу описані власними полями. Контекст команди
 * (`sql.command-context-write`) судиться інакше: кожна одиниця модулів видів
 * і спільних `sql/`-файлів, обробники підписок і функції множини — будь-де;
 * борговий SQL прийнятих таблиць — лише платформним префіксом, решта його
 * записів — попередження `sql.debt-session-write` (Р2c1-6).
 */
export function checkSqlModules(
  objects: readonly ParsedObject[],
  project: Project | undefined,
  units: readonly VerbatimUnit[],
  rowRules: readonly RowRule[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Diagnostic[] {
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
  // Обробник підписки й функція множини боргом не бувають, хоч би де лежав
  // файл (спека промоції §9.4): у модулі таблиці боргу їх теж судимо.
  const debtOwners = new Set(
    objects
      .filter((o) => KIND_REGISTRY[o.kind].sqlModule === "debt")
      .map((o) => o.file)
  )
  const ruled = ruledFunctions(objects, project)
  for (const unit of units) {
    if (closed(unit)) continue
    const writes = commandContextWrite(
      unit.tree as Node,
      unit.sql,
      parse,
      plpgsql
    )
    if (writes.length === 0) continue
    const name = unit.schema === "" ? unit.name : `${unit.schema}.${unit.name}`
    const debt =
      unit.ownerFile !== undefined &&
      debtOwners.has(unit.ownerFile) &&
      !ruled.has(unit.identity)
    if (!debt) {
      found.push(
        diagnostic("sql.command-context-write", unit.file, "", {
          name,
          form: writes[0]!.form,
        })
      )
      continue
    }
    // Борговий SQL прийнятої таблиці (Р2c1-6) уперше судиться контекстом
    // команди. Платформний префікс несе контекст команди й режим
    // обслуговування прав — у чужому боргу його бути не може, тож запис туди
    // (зокрема `RESET ALL` і запис у `pg_settings`, що зачіпають його
    // неминуче) — помилка. Зміну ролі чи claims реальна база в боргу має
    // (`SET ROLE` у службовій функції): прийом не ламається, а закритий код
    // такої функції не досягає (`sql.command-context-reach`). Судяться всі
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
          ...(platform === undefined ? {} : { module: "debt" }),
        }
      )
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
        ? commandContextWrite(shellUnit.tree, unit.sql, parse, plpgsql)[0]
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
