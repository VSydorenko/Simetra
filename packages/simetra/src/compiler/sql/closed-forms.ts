import type { Node } from "libpg-query"
import { KIND_REGISTRY, type Project } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { commandContextWrite } from "./command-context"
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

function emptySearchPath(options: readonly DefElem[]): boolean {
  // Останній `SET search_path` перемагає, як і в Postgres.
  const set = options
    .filter(
      (o) =>
        o.defname === "set" && o.arg?.VariableSetStmt?.name === "search_path"
    )
    .at(-1)?.arg?.VariableSetStmt
  const args = set?.args ?? []
  return (
    set?.kind === "VAR_SET_VALUE" &&
    args.length === 1 &&
    args[0]!.A_Const?.sval?.sval === ""
  )
}

/**
 * Функція з `SET search_path = ''` (останній `SET` перемагає): лише тоді
 * некваліфіковане ім'я в її тілі не може розв'язатися в чужу схему.
 */
export function hasEmptySearchPath(tree: Node): boolean {
  const fn = createFunction(tree)
  return fn !== undefined && emptySearchPath(functionOptions(fn).options)
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
 * (`sql.command-context-write`) судиться інакше: функції модулів видів і
 * спільних `sql/`-файлів — усі, крім боргового SQL прийнятих таблиць;
 * обробники підписок і функції множини — будь-де.
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
  // Борговий SQL прийнятих таблиць `CustomTable` поза перевіркою контексту
  // команди (відоме обмеження до 2c); решта — спільні `sql/`-файли й модулі
  // видів: функція закритого модуля чи обробник може викликати допоміжну
  // функцію спільного файлу, тож межа довіри (Р2b1-19a) охоплює їх усі.
  // Обробник підписки й функція множини боргом не бувають, хоч би де лежав
  // файл (спека промоції §9.4): у модулі таблиці боргу їх теж судимо.
  const debtOwners = new Set(
    objects
      .filter((o) => KIND_REGISTRY[o.kind].sqlModule === "debt")
      .map((o) => o.file)
  )
  const ruled = ruledFunctions(objects, project)
  for (const unit of units) {
    if (closed(unit) || !FUNCTION_CLASSES.has(unit.class)) continue
    if (
      unit.ownerFile !== undefined &&
      debtOwners.has(unit.ownerFile) &&
      !ruled.has(unit.identity)
    ) {
      continue
    }
    const write = commandContextWrite(
      unit.tree as Node,
      unit.sql,
      parse,
      plpgsql
    )
    if (write !== undefined) {
      found.push(
        diagnostic("sql.command-context-write", unit.file, "", {
          name: `${unit.schema}.${unit.name}`,
          form: write,
        })
      )
    }
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
        ? commandContextWrite(shellUnit.tree, unit.sql, parse, plpgsql)
        : undefined
    if (write !== undefined) {
      found.push(
        diagnostic("sql.command-context-write", unit.file, "", {
          name: `${unit.schema}.${unit.name}`,
          form: write,
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
