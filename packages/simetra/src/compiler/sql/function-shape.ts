import type { Node } from "libpg-query"
import { closedShellProblem } from "./closed-forms"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import { functionIdentity, type VerbatimUnit } from "./units"

/*
 * Форма функцій, які викликає політика (функція множини скоупу, функція
 * значень виміру, обробник підписки): підпис і закрита форма читаються з
 * дерева розбору. Окремий модуль, щоб стадія 5 і перевірки прав ділили ці
 * правила без циклу імпортів.
 */
export interface FunctionNode {
  parameters?: unknown[]
  /** Тіло стандарту SQL (`BEGIN ATOMIC`, `RETURN`): без рядка `AS`. */
  sql_body?: unknown
  returnType?: {
    names?: { String?: { sval?: string } }[]
    setof?: boolean
    arrayBounds?: unknown[]
  }
  options?: {
    DefElem?: {
      defname?: string
      arg?: {
        String?: { sval?: string }
        Boolean?: { boolval?: boolean }
        List?: { items?: { String?: { sval?: string } }[] }
      }
    }
  }[]
}

/**
 * Функція без аргументів, що повертає `[SETOF] <тип>` (лише ім'я,
 * `pg_catalog.` — допустимий префікс): спільна частина підпису функції
 * множини й обробника підписки. Повертає вузол функції або причину.
 */
function nullaryReturning(
  tree: Node,
  returns: { type: string; setof: boolean }
): FunctionNode | string {
  const fn = (tree as { CreateFunctionStmt?: FunctionNode }).CreateFunctionStmt
  if (fn === undefined) return "it is not a function"
  const modes = (fn.parameters ?? []).map(
    (p) =>
      (p as { FunctionParameter?: { mode?: string } }).FunctionParameter?.mode
  )
  if (modes.includes("FUNC_PARAM_TABLE")) return "it returns a table"
  if (modes.some((m) => m === "FUNC_PARAM_OUT" || m === "FUNC_PARAM_INOUT")) {
    return "it has OUT parameters"
  }
  if (modes.length > 0) return "it takes arguments"
  const returned = fn.returnType
  const names = (returned?.names ?? []).map((n) => n.String?.sval)
  const matches =
    names.length > 0 &&
    names[names.length - 1] === returns.type &&
    (names.length === 1 || (names.length === 2 && names[0] === "pg_catalog")) &&
    (returned?.setof === true) === returns.setof &&
    (returned?.arrayBounds ?? []).length === 0
  if (!matches) {
    return `it does not return ${returns.setof ? "SETOF " : ""}${returns.type}`
  }
  return fn
}

/**
 * Функція `<схема>.<ім'я>` без аргументів серед SQL-одиниць: `undefined` —
 * функції з таким ім'ям немає, рядок — причина невідповідності підпису.
 */
export function nullaryFunction(
  units: readonly VerbatimUnit[],
  schema: string,
  name: string,
  returns: { type: string; setof: boolean }
): FunctionNode | string | undefined {
  const sameName = units.filter(
    (u) => u.class === "function" && u.schema === schema && u.name === name
  )
  if (sameName.length === 0) return undefined
  const exact = sameName.find(
    (u) => u.identity === functionIdentity(schema, name, [])
  )
  return exact === undefined
    ? "it takes arguments"
    : nullaryReturning(exact.tree as Node, returns)
}

/** Чим функція множини виходить за закриту форму (`params.reason`). */
export type SetFunctionReason =
  "language" | "security" | "searchPath" | "unqualified"

/**
 * Функція множини — `LANGUAGE sql SECURITY DEFINER SET search_path = ''` із
 * відношеннями, кваліфікованими схемою: RLS-політики викликають її над
 * таблицями з RLS, тож виклик від імені користувача зациклив би політику, а
 * порожній search_path не лишає простору для підміни імен. Оболонку
 * `search_path` читає спільний `closedShellProblem`, щоб не дублювати його.
 * Тіло, яке не розбирається, не перевіряється: його відхилить тіньова база.
 */
export function setFunctionClosedProblem(
  fn: FunctionNode,
  units: readonly VerbatimUnit[],
  schema: string,
  name: string,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): SetFunctionReason | undefined {
  const option = (key: string) =>
    (fn.options ?? []).map((o) => o.DefElem).filter((o) => o?.defname === key)
  const language = option("language")[0]?.arg?.String?.sval?.toLowerCase()
  if (language !== "sql") return "language"
  if (option("security")[0]?.arg?.Boolean?.boolval !== true) return "security"
  const unit = units.find(
    (u) => u.identity === functionIdentity(schema, name, [])
  )
  // Мова тут уже `sql`, тож динамічного SQL не буває: `plpgsql` лише проходить
  // у спільну сигнатуру оболонки.
  if (
    unit !== undefined &&
    closedShellProblem({ tree: unit.tree as Node, sql: unit.sql }, plpgsql) ===
      "searchPath"
  ) {
    return "searchPath"
  }
  return bodyHasUnqualifiedRelation(fn, parse) ? "unqualified" : undefined
}

/**
 * Тіло `LANGUAGE sql` називає відношення без схеми. Тіло, яке не
 * розбирається, не перевіряється: його відхилить тіньова база.
 */
export function bodyHasUnqualifiedRelation(
  fn: FunctionNode,
  parse: SqlParser
): boolean {
  // `AS` — список рядків; для `LANGUAGE sql` перший і є тілом.
  const body = (fn.options ?? [])
    .map((o) => o.DefElem)
    .find((o) => o?.defname === "as")?.arg?.List?.items?.[0]?.String?.sval
  if (body === undefined) return false
  const parsed = parse(body)
  if (!parsed.ok) return false
  return hasUnqualifiedRelation(
    parsed.statements.map((s) => s.stmt),
    new Set()
  )
}

/**
 * Некваліфіковане відношення в дереві: `RangeVar` без схеми, ім'я якого не CTE
 * в області видимості. Виклики функцій (`auth.uid()`) — не `RangeVar`.
 */
function hasUnqualifiedRelation(
  value: unknown,
  ctes: ReadonlySet<string>
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasUnqualifiedRelation(item, ctes))
  }
  if (typeof value !== "object" || value === null) return false
  const node = value as Record<string, unknown>
  const clause = node.withClause as
    { ctes?: { CommonTableExpr?: { ctename?: string } }[] } | undefined
  const visible =
    clause === undefined
      ? ctes
      : new Set([
          ...ctes,
          ...(clause.ctes ?? []).flatMap((c) =>
            c.CommonTableExpr?.ctename === undefined
              ? []
              : [c.CommonTableExpr.ctename]
          ),
        ])
  if (
    typeof node.relname === "string" &&
    node.schemaname === undefined &&
    !visible.has(node.relname)
  ) {
    return true
  }
  return Object.values(node).some((child) =>
    hasUnqualifiedRelation(child, visible)
  )
}

/** Функція множини читає дані, тож мусить бути STABLE. */
export function volatilityProblem(fn: FunctionNode): string | undefined {
  const volatility = (fn.options ?? [])
    .map((o) => o.DefElem)
    .find((o) => o?.defname === "volatility")?.arg?.String?.sval
  // Без ключового слова Postgres бере VOLATILE.
  return volatility === "stable" ? undefined : "it is not STABLE"
}
