import type { Node } from "libpg-query"
import { PLATFORM_SCHEMA, type Project } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { PLATFORM_READ_FUNCTIONS } from "../platform/names"
import type { ParsedObject } from "../stages/files"
import {
  closedModuleOwners,
  closedShellProblem,
  routineLanguage,
  ruledFunctions,
} from "./closed-forms"
import { literalDynamicText } from "./command-context"
import { textCalls, unitCalls, type ReferencedName } from "./dependencies"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import { splitAssignment } from "./rewrite/plpgsql-body"
import { isStatementKey } from "./unit-target"
import type { VerbatimUnit } from "./units"

/** Подання моделі, що може бути ціллю `REFRESH` чи DML тіла. */
export type ModelView = Pick<VerbatimUnit, "class" | "schema" | "name" | "tree">

/** Подання й матеріалізовані подання серед одиниць моделі. */
export function modelViews(
  units: readonly Pick<VerbatimUnit, "class" | "schema" | "name" | "tree">[]
): ModelView[] {
  return units.filter(
    (u) => u.class === "view" || u.class === "materializedView"
  )
}

/**
 * Оператор тіла поза переліком і рядок від початку тексту одиниці (1 —
 * перший рядок). `statement` — вузол дерева розбору або `language`,
 * `nonLiteralExecute`, `unread`.
 */
export interface BodyProblem {
  statement: string
  line: number
}

/** Оператор, який тіло виконує, і його рядок від початку тексту одиниці. */
export interface ExecutedStatement {
  stmt: Node
  line: number
}

/**
 * Усе, що виконує тіло функції чи процедури: оператори (рядкове тіло
 * `LANGUAGE sql`, `BEGIN ATOMIC`, оператори plpgsql, текст літерального
 * `EXECUTE`, блоки `DO` і тіла функцій, визначених у тілі, — рекурсивно, з
 * вкладеними операторами) і тексти виразів plpgsql як `SELECT`. `problem` —
 * перша частина тіла, яку статично не прочитати: мова поза `sql`/`plpgsql`,
 * нелітеральний `EXECUTE`, нерозбірний чи непрочитаний портом текст.
 */
export interface RoutineBody {
  statements: ExecutedStatement[]
  values: { text: string; line: number }[]
  problem?: BodyProblem
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

/** Кожен вузол оператора дерева в порядку обходу, вкладені — теж. */
export function statementsOf(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(statementsOf)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [
    ...(isStatementKey(key) ? [{ [key]: child } as Node] : []),
    ...statementsOf(child),
  ])
}

/** Кількість переходів рядка до позиції `index` тексту. */
function linesBefore(text: string, index: number): number {
  return index <= 0 ? 0 : text.slice(0, index).split("\n").length - 1
}

/**
 * Тіло одиниці `tree` з текстом `sql`; не функція й не процедура — порожнє
 * тіло. Нічого не пропускається мовчки: те, чого обхід не прочитав, —
 * `problem`, бо судження тіла дозвільне.
 */
export function routineBody(
  tree: Node,
  sql: string,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): RoutineBody {
  const out: RoutineBody = { statements: [], values: [] }
  new BodyWalker(parse, plpgsql, out).routine(tree, sql, 1)
  return out
}

class BodyWalker {
  constructor(
    private readonly parse: SqlParser,
    private readonly plpgsql: PlpgsqlParser,
    private readonly out: RoutineBody
  ) {}

  private fail(statement: string, line: number): void {
    this.out.problem ??= { statement, line }
  }

  routine(tree: Node, sql: string, at: number): void {
    const fn = (
      tree as {
        CreateFunctionStmt?: { options?: DefElemNode[]; sql_body?: unknown }
      }
    ).CreateFunctionStmt
    if (fn === undefined) return
    // Тіло стандарту SQL уже в дереві оператора.
    if (fn.sql_body !== undefined) {
      this.statement(fn.sql_body, undefined, at)
      return
    }
    const language = routineLanguage(tree)
    const body = optionText(fn.options, "as")
    const bodyAt =
      body === undefined ? at : at + linesBefore(sql, sql.indexOf(body))
    if (language === "sql") {
      if (body === undefined) this.fail("unread", at)
      else this.text(body, bodyAt)
      return
    }
    if (language === "plpgsql") {
      this.plpgsqlBody(sql, bodyAt)
      return
    }
    this.fail("language", at)
  }

  /** Оператор і вкладені в нього; `text` — його текст, коли він відомий. */
  private statement(stmt: unknown, text: string | undefined, at: number) {
    const nodes = statementsOf(stmt)
    for (const node of nodes) this.out.statements.push({ stmt: node, line: at })
    for (const node of nodes) {
      if ("DoStmt" in node) this.doBlock(node, at)
      // Функція, створена тілом, виконується так само, як саме тіло.
      else if (
        "CreateFunctionStmt" in node &&
        text !== undefined &&
        node === nodes[0]
      )
        this.routine(node, text, at)
    }
  }

  private text(text: string, at: number): void {
    const parsed = this.parse(text)
    if (!parsed.ok) {
      this.fail("unread", at)
      return
    }
    for (const { stmt, start, end } of parsed.statements) {
      this.statement(
        stmt,
        text.slice(start, end),
        at + linesBefore(text, start)
      )
    }
  }

  /**
   * Тіло plpgsql: `bodyAt` — рядок відкривного `$тег$`, від якого рахує
   * порт. Оператори SQL (`parseMode` 0) і текст літерального `EXECUTE` —
   * оператори тіла; решта виразів — значення, які читаються як `SELECT`.
   */
  private plpgsqlBody(createFunction: string, bodyAt: number): void {
    const body = this.plpgsql(createFunction)
    if (!body.ok || body.fn === undefined) {
      this.fail("unread", bodyAt)
      return
    }
    const [unread] = body.fn.unreadLines
    if (unread !== undefined) this.fail("unread", bodyAt + unread - 1)
    for (const statement of body.fn.statements) {
      for (const e of statement.expressions) {
        const line = bodyAt + e.lineno - 1
        if (e.role === "dynamic") {
          const text = literalDynamicText(e.query, this.parse)
          if (text === undefined) this.fail("nonLiteralExecute", line)
          else this.text(text, line)
          continue
        }
        if (e.parseMode === 0) {
          this.text(e.query, line)
          continue
        }
        const texts = valueTexts(e.query, e.parseMode)
        if (texts === undefined || texts.some((t) => !this.parse(t).ok)) {
          this.fail("unread", line)
          continue
        }
        for (const text of texts) this.out.values.push({ text, line })
      }
    }
  }

  /**
   * Тіло блоку `DO` plpgsql. Порт plpgsql розбирає лише `CREATE FUNCTION`,
   * тож блок обгортається функцією з тим самим тілом — рядком із
   * подвоєними лапками, що дає Postgres рівно той самий текст.
   */
  private doBlock(stmt: Node, at: number): void {
    const args = (stmt as { DoStmt?: { args?: DefElemNode[] } }).DoStmt?.args
    const body = optionText(args, "as")
    const language = optionText(args, "language")?.toLowerCase() ?? "plpgsql"
    if (language !== "plpgsql") {
      this.fail("language", at)
      return
    }
    if (body === undefined) {
      this.fail("unread", at)
      return
    }
    this.plpgsqlBody(
      `CREATE FUNCTION do_block() RETURNS void LANGUAGE plpgsql AS '${body.replaceAll("'", "''")}'`,
      at
    )
  }
}

/**
 * Тексти виразу plpgsql як `SELECT`: значення, а в присвоєння й ціль —
 * індекс `a[f()] := …` теж обчислюється. Нерозбірна межа присвоєння —
 * `undefined` (fail-closed).
 */
function valueTexts(query: string, parseMode: number): string[] | undefined {
  if (parseMode < 3) return [`SELECT ${query}`]
  const split = splitAssignment(query, parseMode - 2)
  if (split === undefined) return undefined
  return [
    `SELECT ${query.slice(split.valueStart)}`,
    `SELECT ${query.slice(0, split.targetEnd)}`,
  ]
}

/**
 * Оператори, які тіло виконує без умов (Р2c1-37): рядки під RLS і правами
 * таблиці (DML судить Правило 1 окремо), блокування, налаштування сесії
 * (захищені судить `commandContextWrite`), виклик процедури, сповіщення,
 * блок `DO`, тіло якого судиться тим самим переліком, і `RETURN` тіла
 * стандарту SQL — лише вираз, як `SELECT`.
 */
const ALLOWED_STATEMENTS: ReadonlySet<string> = new Set([
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "LockStmt",
  "VariableSetStmt",
  "CallStmt",
  "NotifyStmt",
  "DoStmt",
  "ReturnStmt",
])

interface RangeVarLike {
  schemaname?: string
  relname?: string
  relpersistence?: string
}

interface IntoClauseLike {
  rel?: RangeVarLike
  onCommit?: string
}

/** Тимчасова таблиця, що зникає з транзакцією: її ім'я — інакше `undefined`. */
function droppedAtCommit(into: IntoClauseLike | undefined): string | undefined {
  return into?.rel?.relpersistence === "t" && into.onCommit === "ONCOMMIT_DROP"
    ? into.rel.relname
    : undefined
}

/**
 * Перший оператор тіла функції чи процедури поза дозвільним переліком
 * (Р2c1-37); інший клас чи тіло лише з дозволених — `undefined`. Межа тіла
 * дозвільна (власник, Ф-7): денайліст за ціллю пропускав `ALTER DATABASE …
 * SET`, `CREATE VIEW` під час виконання, `TRUNCATE … CASCADE`, `CREATE OR
 * REPLACE` голови, а кожна нова форма мови була б новим обходом. Тимчасова
 * таблиця — лише з `ON COMMIT DROP` і без батька: та, що пережила б
 * транзакцію, затіняла б у сесії пулу відношення й типи некваліфікованими
 * іменами, а дочірня підмішала б рядки в читання батька. `DROP` — лише
 * тимчасової таблиці того самого тіла, `REFRESH` — лише кваліфікованого
 * матеріалізованого подання моделі.
 */
export function bodyStatementProblem(
  unit: Pick<VerbatimUnit, "class" | "sql" | "tree">,
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  views: readonly ModelView[]
): BodyProblem | undefined {
  if (unit.class !== "function" && unit.class !== "procedure") return undefined
  const body = routineBody(unit.tree as Node, unit.sql, parse, plpgsql)
  if (body.problem !== undefined) return body.problem
  const temporary = new Set<string>()
  for (const { stmt, line } of body.statements) {
    const [key] = Object.keys(stmt)
    if (key === undefined || ALLOWED_STATEMENTS.has(key)) continue
    const node = (stmt as Record<string, unknown>)[key] as Record<
      string,
      unknown
    >
    const created = temporaryTable(key, node)
    if (created !== undefined) {
      temporary.add(created)
      continue
    }
    if (key === "SelectStmt" && node.intoClause === undefined) continue
    if (key === "DropStmt" && dropsTemporary(node, temporary)) continue
    if (key === "RefreshMatViewStmt" && refreshesModelView(node, views))
      continue
    return { statement: key, line }
  }
  return undefined
}

/** Ім'я тимчасової таблиці, яку дозволено створити оператору, чи `undefined`. */
function temporaryTable(
  key: string,
  node: Record<string, unknown>
): string | undefined {
  if (key === "CreateTableAsStmt")
    return node.objtype === "OBJECT_TABLE"
      ? droppedAtCommit(node.into as IntoClauseLike | undefined)
      : undefined
  if (key === "SelectStmt")
    return droppedAtCommit(node.intoClause as IntoClauseLike | undefined)
  if (key !== "CreateStmt") return undefined
  if (node.inhRelations !== undefined || node.partbound !== undefined)
    return undefined
  return droppedAtCommit({
    rel: node.relation as RangeVarLike | undefined,
    onCommit: node.oncommit as string | undefined,
  })
}

/** `DROP TABLE` лише тимчасових таблиць, створених тим самим тілом. */
function dropsTemporary(
  node: Record<string, unknown>,
  temporary: ReadonlySet<string>
): boolean {
  if (node.removeType !== "OBJECT_TABLE") return false
  const objects = (node.objects ?? []) as Node[]
  return objects.every((object) => {
    const names = ("List" in object ? (object.List.items ?? []) : [object]).map(
      (n) => ("String" in n ? (n.String.sval ?? "") : "")
    )
    const [schema, name] = names.length === 2 ? names : [undefined, names[0]]
    return (
      names.length <= 2 &&
      (schema === undefined || schema === "pg_temp") &&
      name !== undefined &&
      temporary.has(name)
    )
  })
}

/** Кваліфіковане матеріалізоване подання моделі. */
function refreshesModelView(
  node: Record<string, unknown>,
  views: readonly ModelView[]
): boolean {
  const relation = node.relation as RangeVarLike | undefined
  return views.some(
    (v) =>
      v.class === "materializedView" &&
      relation?.schemaname !== undefined &&
      v.schema === relation.schemaname &&
      v.name === relation.relname
  )
}

/**
 * Тіло будь-якої функції чи процедури в будь-якому файлі, борг включно
 * (Р2c1-37), — дозвільний перелік операторів; інакше помилка
 * `sql.function-body-statement`. Функцію закритого модуля, обробник підписки
 * й функцію множини, чию оболонку відмовляють власні правила (`sql.closed-shell`,
 * `subscription.handler-not-closed`, `scope.set-function-signature`: мова,
 * динамічний SQL, нерозбірне тіло), тут не судять — друга діагностика була б
 * шумом; з чинною оболонкою судяться їхні оператори, а непрочитане тіло
 * лишається судді голів.
 */
export function checkFunctionBodies(
  objects: readonly ParsedObject[],
  project: Project | undefined,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Diagnostic[] {
  const views = modelViews(units)
  const closed = closedModuleOwners(objects)
  const ruled = ruledFunctions(objects, project)
  return units.flatMap((unit) => {
    const shelled =
      (unit.ownerFile !== undefined && closed.has(unit.ownerFile)) ||
      (unit.class === "function" && ruled.has(unit.identity))
    if (
      shelled &&
      closedShellProblem(
        { tree: unit.tree as Node, sql: unit.sql },
        plpgsql
      ) !== undefined
    )
      return []
    const problem = bodyStatementProblem(unit, parse, plpgsql, views)
    if (problem === undefined) return []
    if (shelled && SHELL_PROBLEMS.has(problem.statement)) return []
    return [
      diagnostic("sql.function-body-statement", unit.file, "", {
        function: `${unit.schema}.${unit.name}`,
        statement: problem.statement,
        line: unit.line + problem.line - 1,
      }),
    ]
  })
}

/** Що в закритій оболонці судять її правила й суддя голів, а не перелік. */
const SHELL_PROBLEMS: ReadonlySet<string> = new Set([
  "language",
  "nonLiteralExecute",
  "unread",
])

/** Класи, що не виконують виразів: ціль гранту чи коментаря — не виклик. */
const INERT_CLASSES: ReadonlySet<VerbatimUnit["class"]> = new Set([
  "grant",
  "comment",
  "defaultPrivileges",
])

/** Виклики одиниці: дерево, а для функції — усе, що виконує її тіло. */
function callsOf(
  unit: VerbatimUnit,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): ReferencedName[] {
  const calls = unitCalls(unit, parse)
  if (unit.class !== "function" && unit.class !== "procedure") return calls
  const body = routineBody(unit.tree as Node, unit.sql, parse, plpgsql)
  return [
    ...calls,
    ...body.statements.flatMap(({ stmt }) => unitCalls({ tree: stmt }, parse)),
    ...body.values.flatMap(({ text }) => textCalls(text, parse)),
  ]
}

/**
 * Виклик функції схеми платформи з SQL застосунку (Р2c1-38): дозволено лише
 * поіменний перелік, що читає (`PLATFORM_READ_FUNCTIONS`). Решта функцій
 * платформи пишуть її таблиці чи ідентичності (`provision_user` прив'язував
 * би чужу ідентичність із боргової `SECURITY DEFINER`-функції), а виклик —
 * не ціль, тож Правило 1 його не бачить. Судиться кожна одиниця в будь-якому
 * файлі, борг включно: подання, політика, CHECK домену й `DEFAULT` теж
 * виконують вираз.
 */
export function checkPlatformCalls(
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Diagnostic[] {
  const allowed = new Set(
    PLATFORM_READ_FUNCTIONS.map((f) => `${f.schema}.${f.name}`)
  )
  return units.flatMap((unit) => {
    if (INERT_CLASSES.has(unit.class)) return []
    const called = new Set(
      callsOf(unit, parse, plpgsql)
        .filter((c) => c.schema === PLATFORM_SCHEMA)
        .map((c) => `${c.schema}.${c.name}`)
        .filter((name) => !allowed.has(name))
    )
    return [...called].map((name) =>
      diagnostic("sql.platform-function-call", unit.file, "", {
        unit: unit.identity,
        function: name,
        line: unit.line,
      })
    )
  })
}
