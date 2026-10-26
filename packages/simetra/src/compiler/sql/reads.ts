import type { Node } from "libpg-query"
import { hasEffectiveEmptySearchPath, routineLanguage } from "./closed-forms"
import {
  isBuiltinSetConfig,
  literalDynamicText,
  literalText,
} from "./command-context"
import { unitCalls, unitRelations, type ReferencedName } from "./dependencies"
import { attributeNames, expressionTexts, singleArgument } from "./heads"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import type { VerbatimUnit } from "./units"

/*
 * Обхід читань для `sql.definer-reads-rls` (Р2c1-8, Р2c1-13): які таблиці
 * читає одиниця сама й через функції та подання моделі, яких досягає. Межу
 * довіри коду, що виконується посеред команди, судить суддя голів
 * (`heads.ts`), тож тут немає ні класифікації викликів, ні недосудності:
 * кожна недосудна форма тіла (інша мова, нелітеральний `EXECUTE`,
 * непрочитаний текст) — помилка раннього блоку (Р2c1-37).
 */

/** Класи простору `pg_proc`, у які розв'язується виклик. */
const ROUTINES: ReadonlySet<string> = new Set([
  "function",
  "procedure",
  "aggregate",
])
/** Класи з тілом, яке виконується; агрегат лише називає функції-складові. */
const BODIES: ReadonlySet<string> = new Set(["function", "procedure"])
const VIEWS: ReadonlySet<string> = new Set(["view", "materializedView"])

/**
 * Посилання одиниці. `bound` — ім'я зв'язано під час створення з
 * `search_path` сесії (значення аргументів за замовчуванням, тіло `BEGIN
 * ATOMIC`, подання), а не з `search_path` функції під час виконання.
 * `attribute` — запис `x.f`, яким Postgres кличе `f(x)`.
 */
interface Reference extends ReferencedName {
  space: "proc" | "rel" | "attribute"
  bound: boolean
}

interface Analysis {
  refs: Reference[]
  /**
   * Одиниця сама змінює `search_path` (`SET`, `RESET`, `set_config`): далі в
   * її тілі некваліфіковане ім'я розв'язується вже не за шляхом `CREATE`.
   */
  pathWrite: boolean
}

interface FunctionTree {
  options?: { DefElem?: { defname?: string; arg?: unknown } }[]
  sql_body?: unknown
}

/**
 * Функції, процедури, агрегати й подання моделі, яких одиниця досягає
 * викликами (зокрема записом `x.f`) і читанням подань; сама одиниця не
 * входить. Некваліфіковане ім'я з ефективним порожнім шляхом одиниці — лише
 * вбудоване, інакше — кожна одиниця моделі з таким ім'ям (fail-closed).
 */
export function reachableUnits(
  head: VerbatimUnit,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): VerbatimUnit[] {
  const routines = units.filter((u) => ROUTINES.has(u.class))
  const views = units.filter((u) => VIEWS.has(u.class))
  const reached: VerbatimUnit[] = []
  const visited = new Set<string>([head.identity])
  const queue: VerbatimUnit[] = [head]
  const enqueue = (unit: VerbatimUnit) => {
    if (visited.has(unit.identity)) return
    visited.add(unit.identity)
    reached.push(unit)
    queue.push(unit)
  }
  for (let unit = queue.shift(); unit !== undefined; unit = queue.shift()) {
    const analysis = analyze(unit, parse, plpgsql)
    const emptyPath = emptyPathOf(unit, analysis, units)
    for (const ref of analysis.refs) {
      const empty = emptyPath && !ref.bound
      if (ref.schema === undefined && empty) continue
      const pool = ref.space === "rel" ? views : routines
      for (const target of pool) {
        if (
          target.name === ref.name &&
          (ref.schema === undefined || target.schema === ref.schema) &&
          (ref.space !== "attribute" || singleArgument(target))
        ) {
          enqueue(target)
        }
      }
    }
  }
  return reached
}

/**
 * Порожній `search_path` під час виконання тіла: ефективний порожній шлях
 * функції, якого тіло саме не змінює.
 */
function emptyPathOf(
  unit: VerbatimUnit,
  analysis: Analysis,
  units: readonly VerbatimUnit[]
): boolean {
  return (
    BODIES.has(unit.class) &&
    !analysis.pathWrite &&
    hasEffectiveEmptySearchPath(unit, units)
  )
}

/**
 * Відношення, які одиниця читає чи пише, з того самого розбору, що й обхід
 * (тіло `sql`, вирази plpgsql, текст літерального `EXECUTE`, визначення
 * подання): два прочитання одного тіла розійшлися б. Некваліфіковане ім'я,
 * яке з порожнім `search_path` може назвати лише `pg_catalog` чи `pg_temp`,
 * не входить; решта некваліфікованих — без схеми (збіг у будь-якій схемі,
 * fail-closed): шлях, за яким Postgres їх розв'яже, статично не відомий.
 */
export function relationReads(
  unit: VerbatimUnit,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): ReferencedName[] {
  const analysis = analyze(unit, parse, plpgsql)
  const empty = emptyPathOf(unit, analysis, units)
  return analysis.refs.flatMap((ref): ReferencedName[] => {
    if (ref.space !== "rel") return []
    if (ref.schema === undefined)
      return empty && !ref.bound ? [] : [{ name: ref.name }]
    return [{ schema: ref.schema, name: ref.name }]
  })
}

function analyze(
  unit: VerbatimUnit,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Analysis {
  if (BODIES.has(unit.class)) return analyzeBody(unit, parse, plpgsql)
  return {
    refs: treeReferences(unit.tree, parse, true),
    pathWrite: writesSearchPath(unit.tree),
  }
}

function analyzeBody(
  unit: VerbatimUnit,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Analysis {
  const fn = (unit.tree as { CreateFunctionStmt?: FunctionTree })
    .CreateFunctionStmt
  if (fn === undefined) return { refs: [], pathWrite: false }
  const options = fn.options ?? []
  // Усе, крім рядкового тіла, зв'язано під час створення: значення
  // аргументів за замовчуванням і тіло `BEGIN ATOMIC` (`sql_body`).
  const refs = treeReferences(
    {
      CreateFunctionStmt: {
        ...fn,
        options: options.filter((o) => o.DefElem?.defname !== "as"),
      },
    },
    parse,
    true
  )
  let pathWrite = false
  // Текст тіла, що виконується з `search_path` функції; нерозбірний текст
  // уже відмовляє ранній блок (Р2c1-37).
  const read = (text: string) => {
    const parsed = parse(text)
    if (!parsed.ok) return
    for (const s of parsed.statements) {
      refs.push(...treeReferences(s.stmt, parse, false))
      pathWrite ||= writesSearchPath(s.stmt)
    }
  }
  const language = routineLanguage(unit.tree as Node)
  if (language === "sql") {
    if (fn.sql_body !== undefined) return { refs, pathWrite }
    const body = (
      options.find((o) => o.DefElem?.defname === "as")?.DefElem?.arg as
        { List?: { items?: { String?: { sval?: string } }[] } } | undefined
    )?.List?.items?.[0]?.String?.sval
    if (body !== undefined) read(body)
    return { refs, pathWrite }
  }
  if (language !== "plpgsql") return { refs, pathWrite }
  const body = plpgsql(unit.sql)
  if (!body.ok || body.fn === undefined) return { refs, pathWrite }
  for (const statement of body.fn.statements) {
    for (const e of statement.expressions) {
      if (e.role === "dynamic") {
        // Літеральний текст — звичайний SQL, лише записаний рядком.
        const text = literalDynamicText(e.query, parse)
        if (text !== undefined) read(text)
        continue
      }
      for (const text of expressionTexts(e) ?? []) read(text)
    }
  }
  return { refs, pathWrite }
}

/**
 * Чи оператор змінює `search_path`: `SET`/`RESET search_path`, `RESET ALL`
 * чи вбудований `set_config` з ім'ям `search_path` або нелітеральним ім'ям
 * (fail-closed).
 */
function writesSearchPath(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(writesSearchPath)
  if (typeof value !== "object" || value === null) return false
  const node = value as Record<string, unknown>
  const set = node.VariableSetStmt as { kind?: string; name?: string }
  if (
    set !== undefined &&
    (set.kind === "VAR_RESET_ALL" || set.name?.toLowerCase() === "search_path")
  ) {
    return true
  }
  const call = node.FuncCall as
    | { funcname?: { String?: { sval?: string } }[]; args?: unknown[] }
    | undefined
  if (call !== undefined && isBuiltinSetConfig(call.funcname)) {
    const name = literalText(call.args?.[0])
    if (name === undefined || name.toLowerCase() === "search_path") return true
  }
  return Object.values(node).some(writesSearchPath)
}

function treeReferences(
  tree: unknown,
  parse: SqlParser,
  bound: boolean
): Reference[] {
  const unit = { tree }
  return [
    ...unitCalls(unit, parse).map((r): Reference => ({
      ...r,
      space: "proc",
      bound,
    })),
    ...unitRelations(unit, parse).map((r): Reference => ({
      ...r,
      space: "rel",
      bound,
    })),
    ...attributeNames(tree).map((name): Reference => ({
      name,
      space: "attribute",
      bound,
    })),
  ]
}
