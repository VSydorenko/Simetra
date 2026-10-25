import type { Node } from "libpg-query"
import type { PhysicalTable } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { isDeclaredTable } from "../stages/model"
import { closedModuleOwners, routineLanguage } from "./closed-forms"
import { literalDynamicText } from "./command-context"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import {
  bodyStatementTargets,
  isStatementKey,
  statementTargets,
  type UnitTarget,
} from "./unit-target"
import type { VerbatimUnit } from "./units"

/**
 * Таблиці видів знімка — усі, чий об'єкт не є прийнятою таблицею: основна,
 * ТЧ, похідна таблиця регістра, системні довідники прав. `qualified` —
 * `схема.ім'я`, `byName` — ім'я → кваліфіковані імена таблиць з ним,
 * `bySchema` — схема → кваліфіковані імена її таблиць виду.
 */
export interface KindTables {
  qualified: ReadonlySet<string>
  byName: ReadonlyMap<string, readonly string[]>
  bySchema: ReadonlyMap<string, readonly string[]>
}

export function kindTables(
  objects: readonly ParsedObject[],
  tables: readonly PhysicalTable[]
): KindTables {
  // Прийнятість — факт реєстру (`isDeclaredTable`), не назва виду: таблицю
  // прийнятого об'єкта описує файл, і її борг належить їй самій.
  const kindObjects = new Set(
    objects.filter((o) => !isDeclaredTable(o)).map((o) => o.id ?? "")
  )
  const qualified = new Set<string>()
  const byName = new Map<string, string[]>()
  const bySchema = new Map<string, string[]>()
  for (const table of tables) {
    if (!kindObjects.has(table.origin.objectId)) continue
    const key = `${table.schema}.${table.name}`
    qualified.add(key)
    byName.set(table.name, [...(byName.get(table.name) ?? []), key])
    bySchema.set(table.schema, [...(bySchema.get(table.schema) ?? []), key])
  }
  return { qualified, byName, bySchema }
}

/**
 * Таблиця виду, яку називає ціль; `own` — схема одиниці. Некваліфіковане ім'я
 * судиться fail-closed: рендер не задає `search_path`, а функція може
 * виконуватися з будь-яким, тож Postgres розв'яже ім'я за шляхом сесії, а не
 * за схемою файлу, — таблиця виду з тим самим ім'ям у будь-якій схемі
 * підходить. Ціль `kind: "schema"` (оператор над схемою цілком) — кожна
 * таблиця виду схеми.
 */
function kindTableNamed(
  target: UnitTarget,
  own: string,
  tables: KindTables
): string | undefined {
  if (target.kind === "schema") return tables.bySchema.get(target.schema)?.[0]
  const name = target.object ?? ""
  if (target.schema !== "") {
    const key = `${target.schema}.${name}`
    return tables.qualified.has(key) ? key : undefined
  }
  const mine = `${own}.${name}`
  if (tables.qualified.has(mine)) return mine
  return tables.byName.get(name)?.[0]
}

/**
 * Таблиця виду, на якій висить дослівна політика чи тригер одиниці;
 * `undefined` — одиниця іншого класу чи ціль поза таблицями видів. Ціль —
 * з дерева розбору (`statementTargets`), а не з тексту; некваліфіковане ім'я
 * — fail-closed (`kindTableNamed`).
 */
export function kindTableOf(
  unit: Pick<VerbatimUnit, "class" | "schema" | "tree">,
  tables: KindTables
): string | undefined {
  if (unit.class !== "policy" && unit.class !== "trigger") return undefined
  for (const target of statementTargets(unit.tree as Node, "")) {
    const table = kindTableNamed(target, unit.schema, tables)
    if (table !== undefined) return table
  }
  return undefined
}

/** Оператор тіла функції, що змінює таблицю виду, і ця таблиця. */
export interface BodyKindTable {
  table: string
  /** Вузол оператора в дереві розбору: `TruncateStmt`, `CreatePolicyStmt`… */
  statement: string
}

/**
 * Перший оператор тіла функції чи процедури, чия ціль
 * (`bodyStatementTargets`) — таблиця виду (Р2c1-15); інший клас чи тіло без
 * такого оператора — `undefined`. Судяться оператори, які тіло виконує
 * (`bodyTrees`), і вкладені в них.
 */
export function bodyKindTable(
  unit: Pick<VerbatimUnit, "class" | "schema" | "sql" | "tree">,
  tables: KindTables,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): BodyKindTable | undefined {
  if (unit.class !== "function" && unit.class !== "procedure") return undefined
  if (tables.qualified.size === 0) return undefined
  const tree = unit.tree as Node
  for (const stmt of statementsOf([
    tree,
    ...bodyTrees(tree, unit.sql, parse, plpgsql),
  ])) {
    for (const target of bodyStatementTargets(stmt, "")) {
      const table = kindTableNamed(target, unit.schema, tables)
      if (table !== undefined)
        return { table, statement: Object.keys(stmt)[0] ?? "" }
    }
  }
  return undefined
}

/** Кожен вузол оператора дерева в порядку обходу, вкладені — теж. */
function statementsOf(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(statementsOf)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [
    ...(isStatementKey(key) ? [{ [key]: child } as Node] : []),
    ...statementsOf(child),
  ])
}

interface DefElemNode {
  DefElem?: { defname?: string; arg?: unknown }
}

/** Рядкове значення опції: `List` рядків (`AS` функції) чи рядок. */
function optionText(
  options: readonly DefElemNode[] | undefined,
  name: string
): string | undefined {
  const arg = (options ?? []).find((o) => o.DefElem?.defname === name)?.DefElem
    ?.arg as
    | {
        String?: { sval?: string }
        List?: { items?: { String?: { sval?: string } }[] }
      }
    | undefined
  return arg?.String?.sval ?? arg?.List?.items?.[0]?.String?.sval
}

/**
 * Оператори рядкового тіла функції чи процедури: тіло `LANGUAGE sql`,
 * оператори plpgsql і текст кожного літерального `EXECUTE`; вкладене
 * визначення функції й блок `DO` — їхні тіла, рекурсивно: створена тілом
 * функція й блок виконуються так само, як саме тіло. Тіло `BEGIN ATOMIC` уже
 * в дереві оператора. Тіло іншої мови, нелітеральний `EXECUTE` і нерозбірний
 * текст тут не читаються: закритий код таких функцій не досягає (`reach.ts`,
 * Р2c1-5), а в боргу це наявна межа статичного судження.
 */
function bodyTrees(
  tree: Node,
  sql: string,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Node[] {
  const fn = (
    tree as {
      CreateFunctionStmt?: { options?: DefElemNode[]; sql_body?: unknown }
    }
  ).CreateFunctionStmt
  if (fn === undefined || fn.sql_body !== undefined) return []
  const language = routineLanguage(tree)
  if (language === "sql") {
    const body = optionText(fn.options, "as")
    return body === undefined ? [] : textTrees(body, parse, plpgsql)
  }
  return language === "plpgsql" ? plpgsqlTrees(sql, parse, plpgsql) : []
}

/** Оператори тіла plpgsql: запити (`parseMode` 0) і літеральні `EXECUTE`. */
function plpgsqlTrees(
  createFunction: string,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Node[] {
  const body = plpgsql(createFunction)
  if (!body.ok || body.fn === undefined) return []
  return body.fn.statements.flatMap((statement) =>
    statement.expressions.flatMap((e) => {
      // Вираз (`parseMode` > 0) — значення: оператора поза DML він не несе.
      const text =
        e.role === "dynamic"
          ? literalDynamicText(e.query, parse)
          : e.parseMode === 0
            ? e.query
            : undefined
      return text === undefined ? [] : textTrees(text, parse, plpgsql)
    })
  )
}

function textTrees(
  text: string,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Node[] {
  const parsed = parse(text)
  if (!parsed.ok) return []
  return parsed.statements.flatMap(({ stmt, start, end }) => [
    stmt,
    ...bodyTrees(stmt, text.slice(start, end), parse, plpgsql),
    ...doTrees(stmt, parse, plpgsql),
  ])
}

/**
 * Тіло блоку `DO` plpgsql. Порт plpgsql розбирає лише `CREATE FUNCTION`, тож
 * блок обгортається функцією з тим самим тілом — рядком із подвоєними
 * лапками, що дає Postgres рівно той самий текст.
 */
function doTrees(stmt: Node, parse: SqlParser, plpgsql: PlpgsqlParser): Node[] {
  const args = (stmt as { DoStmt?: { args?: DefElemNode[] } }).DoStmt?.args
  const body = optionText(args, "as")
  const language = optionText(args, "language")?.toLowerCase() ?? "plpgsql"
  if (body === undefined || language !== "plpgsql") return []
  return plpgsqlTrees(
    `CREATE FUNCTION do_block() RETURNS void LANGUAGE plpgsql AS '${body.replaceAll("'", "''")}'`,
    parse,
    plpgsql
  )
}

/**
 * Дослівна політика чи тригер на таблиці виду (Р2c1-1, спека прав §6.1) —
 * помилка в будь-якому файлі, зокрема в модулі боргу прийнятої таблиці й
 * навіть перелічена в `sql-debt.json`: ізоляцію таблиці виду розширює лише
 * право (дія, об'єкт), а реакцію на зміну рядка — підписка. Дослівна
 * політика відкрила б рядки повз права, а тригер бачив би запис команди й
 * крок даних копій. Модуль виду ці класи вже відмовляє
 * (`sql.statement-not-allowed`, `kindModule`), тож там друга діагностика —
 * шум.
 *
 * Тіло функції чи процедури в будь-якому файлі, зокрема в модулі виду й у
 * закритій оболонці, таблиці виду не змінює (Р2c1-15, форма
 * `functionBody`): лише DML і `LOCK`. Інакше тіло під час виконання зробило б
 * те, що заборонено дослівним одиницям (політика, тригер, грант), або обійшло
 * б RLS і перевірки платформи (`TRUNCATE`, `ALTER TABLE … DISABLE ROW LEVEL
 * SECURITY`). Модуль виду функцію приймає, тож там ця діагностика єдина.
 */
export function checkKindTableVerbatim(
  objects: readonly ParsedObject[],
  tables: readonly PhysicalTable[],
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Diagnostic[] {
  const kind = kindTables(objects, tables)
  const closed = closedModuleOwners(objects)
  return units.flatMap((unit) => {
    const body = bodyKindTable(unit, kind, parse, plpgsql)
    if (body !== undefined) {
      return [
        diagnostic("sql.kind-table-verbatim", unit.file, "", {
          identity: unit.identity,
          function: `${unit.schema}.${unit.name}`,
          table: body.table,
          form: "functionBody",
          statement: body.statement,
          line: unit.line,
        }),
      ]
    }
    if (unit.ownerFile !== undefined && closed.has(unit.ownerFile)) return []
    const table = kindTableOf(unit, kind)
    if (table === undefined) return []
    return [
      diagnostic("sql.kind-table-verbatim", unit.file, "", {
        identity: unit.identity,
        table,
        form: unit.class,
        line: unit.line,
      }),
    ]
  })
}
