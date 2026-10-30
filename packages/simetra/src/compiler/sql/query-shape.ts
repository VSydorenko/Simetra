import type { Node } from "libpg-query"
import { hasEffectiveEmptySearchPath, routineLanguage } from "./closed-forms"
import type { SqlParser } from "./parse"
import type { VerbatimUnit } from "./units"

/** Конструкція SQL голови поза дозвільною межею (`sql.head-not-allowed`). */
export type HeadConstruct =
  | "language"
  | "searchPath"
  | "setting"
  | "sqlBody"
  | "query"
  | "statement"
  | "call"
  | "relation"
  | "unqualified"
  | "operator"
  | "unread"

/** Причина форми функції-запиту; `detail` — ім'я налаштування `setting`. */
export interface ShapeProblem {
  construct: HeadConstruct
  detail?: string
}

/** Вузли дерева, якими `SELECT` змінює дані. */
const WRITING_STATEMENTS: Readonly<Record<string, string>> = {
  InsertStmt: "INSERT",
  UpdateStmt: "UPDATE",
  DeleteStmt: "DELETE",
  MergeStmt: "MERGE",
}

/**
 * Перший побічний ефект у дереві `SELECT`, якщо він є: оператор, що змінює
 * дані (у `WITH` будь-якого рівня), `SELECT … INTO` чи блокування рядків у
 * будь-якому підзапиті.
 */
export function sideEffectOf(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = sideEffectOf(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const node = value as Record<string, unknown>
  for (const [key, child] of Object.entries(node)) {
    const writing = WRITING_STATEMENTS[key]
    if (writing !== undefined) return `${writing} is not allowed`
    if (key === "intoClause") return "SELECT INTO is not allowed"
    if (key === "lockingClause" && Array.isArray(child) && child.length > 0) {
      return "FOR UPDATE and FOR SHARE are not allowed"
    }
    const found = sideEffectOf(child)
    if (found !== undefined) return found
  }
  return undefined
}

interface DefElem {
  defname?: string
  arg?: {
    List?: { items?: { String?: { sval?: string } }[] }
    VariableSetStmt?: { kind?: string; name?: string }
  }
}

interface FunctionNode {
  options?: { DefElem?: DefElem }[]
  sql_body?: unknown
}

/** Рядкове тіло `LANGUAGE sql`: перший рядок опції `AS`. */
export function sqlBodyText(
  unit: Pick<VerbatimUnit, "tree">
): string | undefined {
  const fn = (unit.tree as { CreateFunctionStmt?: FunctionNode })
    .CreateFunctionStmt
  return (fn?.options ?? []).find((o) => o.DefElem?.defname === "as")?.DefElem
    ?.arg?.List?.items?.[0]?.String?.sval
}

/**
 * Усе, чим функція виходить за форму функції-запиту (спека прав §5.3), у порядку
 * виправлення: мова `sql`, рядкове тіло (тіло стандарту SQL зв'язує імена
 * під час створення з `search_path` сесії), ефективний порожній
 * `search_path`, жодної іншої опції `SET` (опція `SET request.jwt.claims`
 * ланки підмінила б claims на час її виконання) і тіло — рівно один `SELECT`
 * без побічних ефектів. Виклики й відношення тут не судяться.
 */
export function queryFunctionProblems(
  unit: VerbatimUnit,
  units: readonly VerbatimUnit[],
  parse: SqlParser
): ShapeProblem[] {
  const fn = (unit.tree as { CreateFunctionStmt?: FunctionNode })
    .CreateFunctionStmt
  if (fn === undefined || unit.class !== "function") {
    return [{ construct: "language" }]
  }
  const problems: ShapeProblem[] = []
  const language = routineLanguage(unit.tree as Node)
  if (language !== "sql") problems.push({ construct: "language" })
  else if (fn.sql_body !== undefined) problems.push({ construct: "sqlBody" })
  if (!hasEffectiveEmptySearchPath(unit, units)) {
    problems.push({ construct: "searchPath" })
  }
  for (const option of fn.options ?? []) {
    const set =
      option.DefElem?.defname === "set"
        ? option.DefElem.arg?.VariableSetStmt
        : undefined
    // `RESET` значення не ставить; `RESET ALL` скидає й шлях, а це вже
    // `searchPath` згорнутих опцій.
    if (
      set === undefined ||
      set.kind === "VAR_RESET" ||
      set.kind === "VAR_RESET_ALL" ||
      set.name?.toLowerCase() === "search_path"
    ) {
      continue
    }
    problems.push({ construct: "setting", detail: set.name ?? "" })
  }
  if (language !== "sql" || fn.sql_body !== undefined) return problems
  const body = sqlBodyText(unit)
  const parsed = body === undefined ? undefined : parse(body)
  if (parsed === undefined || !parsed.ok) {
    problems.push({ construct: "unread" })
    return problems
  }
  const [only, ...rest] = parsed.statements
  if (
    only === undefined ||
    rest.length > 0 ||
    !("SelectStmt" in only.stmt) ||
    sideEffectOf(only.stmt) !== undefined
  ) {
    problems.push({ construct: "query" })
  }
  return problems
}

/**
 * Перша причина, з якої функція не є функцією-запитом, чи `undefined`:
 * промоція переносить у модуль виду лише функцію-запит (спека промоції §9.4).
 */
export function queryFunctionShape(
  unit: VerbatimUnit,
  units: readonly VerbatimUnit[],
  parse: SqlParser
): HeadConstruct | undefined {
  return queryFunctionProblems(unit, units, parse)[0]?.construct
}
