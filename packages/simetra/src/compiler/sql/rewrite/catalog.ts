import type { Node, RangeFunction, TypeName } from "libpg-query"
import { strings } from "./nodes"

/**
 * Доведення типів каталогу: константа вбудованого типу й відома скалярна
 * функція каталогу не несуть рядка промотованої таблиці.
 */

/**
 * Функції каталогу, що повертають множину скалярів: їхній рядок — одна
 * колонка, промотованої таблиці в ньому немає.
 */
const SCALAR_SET_FUNCTIONS: ReadonlySet<string> = new Set([
  "generate_series",
  "generate_subscripts",
  "regexp_split_to_table",
  "string_to_table",
  "unnest",
])

/**
 * Ім'я першої функції в `FROM`; `scalar` — відома скалярна функція каталогу.
 * `tableNames` — імена таблиць моделі: їхній рядковий тип — не тип каталогу.
 */
export function functionName(
  fn: RangeFunction,
  tableNames: ReadonlySet<string>
): { name: string; scalar: boolean } | undefined {
  const first = fn.functions?.[0]
  if (first === undefined || !("List" in first)) return undefined
  const call = first.List.items?.[0]
  if (call === undefined || !("FuncCall" in call)) return undefined
  const names = (call.FuncCall.funcname ?? []).flatMap((n) =>
    "String" in n && n.String.sval !== undefined ? [n.String.sval] : []
  )
  const name = names.at(-1)
  if (name === undefined) return undefined
  // Функція каталогу доводить форму лише над константами типів каталогу:
  // перевантаження застосунку (`app.generate_series(app.t[])` за
  // `search_path`) Postgres обирає за типом аргументу.
  const args = call.FuncCall.args ?? []
  const scalar =
    (names.length === 1 || names[0] === "pg_catalog") &&
    SCALAR_SET_FUNCTIONS.has(name) &&
    (name !== "unnest" || args.length === 1) &&
    call.FuncCall.agg_star !== true &&
    call.FuncCall.func_variadic !== true &&
    args.every((a) => isConstant(a, tableNames))
  return { name, scalar }
}

/**
 * Вбудовані скалярні типи, як їх пише дерево (`integer` — `pg_catalog.int4`).
 * Решта імен — тип застосунку чи рядковий тип таблиці, тож не доведені.
 */
const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  "bool",
  "int2",
  "int4",
  "int8",
  "float4",
  "float8",
  "numeric",
  "money",
  "text",
  "varchar",
  "bpchar",
  "char",
  "name",
  "bytea",
  "date",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
  "interval",
  "uuid",
  "json",
  "jsonb",
  "xml",
  "bit",
  "varbit",
  "inet",
  "cidr",
  "macaddr",
  "oid",
  "regclass",
  "regtype",
  "tsvector",
  "tsquery",
])

/**
 * Константа типу каталогу: число чи логічний літерал, приведення константи
 * до вбудованого типу (`'x'::text`, `'{1}'::int[]`), `ARRAY[…]` таких і
 * оператор над ними. Будь-який інший вузол — не доведений: рядковий літерал
 * без приведення має тип `unknown`, і перевантаження обирає Postgres.
 */
export function isConstant(
  node: Node,
  tableNames: ReadonlySet<string>
): boolean {
  if ("A_Const" in node) {
    const c = node.A_Const
    return (
      c.ival !== undefined ||
      c.fval !== undefined ||
      c.boolval !== undefined ||
      c.bsval !== undefined
    )
  }
  if ("TypeCast" in node) {
    const { arg, typeName } = node.TypeCast
    return (
      arg !== undefined &&
      isBuiltinType(typeName, tableNames) &&
      ("A_Const" in arg || isConstant(arg, tableNames))
    )
  }
  if ("A_ArrayExpr" in node) {
    // Літерали без типу в `ARRAY[…]` Postgres зводить до `text[]`.
    return (node.A_ArrayExpr.elements ?? []).every(
      (e) => "A_Const" in e || isConstant(e, tableNames)
    )
  }
  if ("A_Expr" in node && node.A_Expr.kind === "AEXPR_OP") {
    const { lexpr, rexpr } = node.A_Expr
    return (
      (lexpr === undefined || isConstant(lexpr, tableNames)) &&
      rexpr !== undefined &&
      isConstant(rexpr, tableNames)
    )
  }
  return false
}

/** Некваліфікований чи `pg_catalog` вбудований тип, не ім'я таблиці моделі. */
export function isBuiltinType(
  typeName: TypeName | undefined,
  tableNames: ReadonlySet<string>
): boolean {
  const names = strings(typeName?.names ?? [])
  const last = names?.at(-1)
  return (
    names !== undefined &&
    last !== undefined &&
    typeName?.pct_type !== true &&
    (names.length === 1 || (names.length === 2 && names[0] === "pg_catalog")) &&
    BUILTIN_TYPES.has(last) &&
    !tableNames.has(last)
  )
}
