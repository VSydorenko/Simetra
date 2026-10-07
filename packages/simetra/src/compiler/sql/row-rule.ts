import type { Node } from "libpg-query"
import {
  quoteIdent,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import type { RowRule } from "./units"

/** Оператори порівняння атома правила рядка. */
const COMPARISONS: ReadonlySet<string> = new Set([
  "=",
  "<>",
  "<",
  "<=",
  ">",
  ">=",
])

/** Порівняння колонки з літералом: лише рівність, бо порядок літерала — тип бази. */
const LITERAL_COMPARISONS: ReadonlySet<string> = new Set(["=", "<>"])

type AConst = Extract<Node, { A_Const: unknown }>["A_Const"]

/**
 * Закрита граматика правила рядка (спека промоції §9.4): булева комбінація
 * атомів над власними колонками таблиці. Обхід — білим списком вузлів, а не
 * чорним: будь-яка конструкція поза граматикою (функція, підзапит, приведення,
 * колонка іншої таблиці) названа, тож правило не протягне в CHECK того, чого
 * рамка не перевіряє. `columns` — фізичне ім'я колонки → її тип знімка;
 * повертає назву забороненої конструкції.
 */
export function rowRuleProblem(
  expr: Node,
  columns: ReadonlyMap<string, string>
): string | undefined {
  if ("BoolExpr" in expr) {
    for (const arg of expr.BoolExpr.args ?? []) {
      const found = rowRuleProblem(arg, columns)
      if (found !== undefined) return found
    }
    return undefined
  }
  if ("NullTest" in expr) {
    const arg = expr.NullTest.arg
    return arg === undefined ? "NullTest" : columnProblem(arg, columns)
  }
  if (!("A_Expr" in expr)) return nodeName(expr)
  const { kind, name, lexpr, rexpr } = expr.A_Expr
  if (lexpr === undefined || rexpr === undefined) return "A_Expr"
  if (kind === "AEXPR_IN") {
    const items = "List" in rexpr ? (rexpr.List.items ?? []) : []
    const literal = items.find((item) => literalOf(item) === undefined)
    if (items.length === 0) return nodeName(rexpr)
    if (literal !== undefined) return nodeName(literal)
    return columnProblem(lexpr, columns)
  }
  if (kind !== "AEXPR_OP") return kind ?? "A_Expr"
  const op = operatorOf(name)
  if (op === undefined || !COMPARISONS.has(op)) return `operator ${op ?? ""}`
  const count = numNonnullsArgs(lexpr)
  if (count !== undefined) {
    for (const arg of count) {
      const found = columnProblem(arg, columns)
      if (found !== undefined) return found
    }
    const bound = literalOf(rexpr)
    return bound?.ival === undefined
      ? "num_nonnulls bound not an integer"
      : undefined
  }
  const left = columnProblem(lexpr, columns)
  if (left !== undefined) return left
  if (literalOf(rexpr) !== undefined) {
    return LITERAL_COMPARISONS.has(op)
      ? undefined
      : `operator ${op} with a literal`
  }
  const right = columnProblem(rexpr, columns)
  if (right !== undefined) return right
  // Різні типи порівнювались би неявним приведенням бази — тобто правилом,
  // якого граматика не бачить.
  return columns.get(columnName(lexpr)!) === columns.get(columnName(rexpr)!)
    ? undefined
    : "column type mismatch"
}

/**
 * Канонічний текст правила, що пройшло `rowRuleProblem`: знімок і хеш не
 * залежать від форматування файлу, як дерево одиниці без позицій. Вкладена
 * булева комбінація завжди в дужках — структура дерева читається однозначно.
 */
export function rowRuleExpression(expr: Node): string {
  if ("BoolExpr" in expr) {
    const { boolop, args = [] } = expr.BoolExpr
    const operand = (arg: Node) =>
      "BoolExpr" in arg && arg.BoolExpr.boolop !== "NOT_EXPR"
        ? `(${rowRuleExpression(arg)})`
        : rowRuleExpression(arg)
    if (boolop === "NOT_EXPR") return `NOT ${operand(args[0]!)}`
    return args.map(operand).join(boolop === "AND_EXPR" ? " AND " : " OR ")
  }
  if ("NullTest" in expr) {
    const { arg, nulltesttype } = expr.NullTest
    return `${rowRuleExpression(arg!)} ${nulltesttype === "IS_NOT_NULL" ? "IS NOT NULL" : "IS NULL"}`
  }
  if ("ColumnRef" in expr) return quoteIdent(columnName(expr)!)
  if ("A_Const" in expr) return literalText(expr.A_Const)
  if ("FuncCall" in expr) {
    return `num_nonnulls(${(expr.FuncCall.args ?? []).map(rowRuleExpression).join(", ")})`
  }
  if ("A_Expr" in expr) {
    const { kind, name, lexpr, rexpr } = expr.A_Expr
    const left = rowRuleExpression(lexpr!)
    if (kind === "AEXPR_IN") {
      const items = "List" in rexpr! ? (rexpr.List.items ?? []) : []
      const op = operatorOf(name) === "<>" ? "NOT IN" : "IN"
      return `${left} ${op} (${items.map(rowRuleExpression).join(", ")})`
    }
    return `${left} ${operatorOf(name)} ${rowRuleExpression(rexpr!)}`
  }
  return ""
}

/**
 * Вкладає правила рядка модулів видів у фізичний знімок як CHECK таблиць з
 * походженням (спека П2 §8.3): одна правда про таблицю для рендера, хешу й
 * `explain`. Правило — лише на таблиці свого об'єкта (`origin.objectId`) і
 * лише над її колонками; ім'я не може повторити обмеження таблиці, бо Postgres
 * тримає імена обмежень таблиці в одному просторі.
 */
export function embedRowRules(
  physical: PhysicalSnapshot,
  rules: readonly RowRule[],
  ownerIdOf: (ownerFile: string) => string | undefined
): { physical: PhysicalSnapshot; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const added = new Map<PhysicalTable, PhysicalTable["checks"]>()
  for (const rule of rules) {
    const objectId =
      rule.ownerFile === undefined ? undefined : ownerIdOf(rule.ownerFile)
    const table = physical.tables.find(
      (t) => t.schema === rule.schema && t.name === rule.table
    )
    const at = { table: `${rule.schema}.${rule.table}`, line: rule.line }
    if (table === undefined || table.origin.objectId !== objectId) {
      diagnostics.push(
        diagnostic("sql.row-rule-foreign-table", rule.file, "", at)
      )
      continue
    }
    const columns = new Map(table.columns.map((c) => [c.name, c.type]))
    const construct = rowRuleProblem(rule.expr, columns)
    if (construct !== undefined) {
      diagnostics.push(
        diagnostic("sql.row-rule-grammar", rule.file, "", {
          ...at,
          construct,
        })
      )
      continue
    }
    const checks = added.get(table) ?? []
    const taken = [
      table.primaryKey?.name,
      ...table.uniques.map((u) => u.name),
      ...table.checks.map((c) => c.name),
      ...table.foreignKeys.map((f) => f.name),
      ...checks.map((c) => c.name),
    ]
    if (taken.includes(rule.name)) {
      diagnostics.push(
        diagnostic("sql.row-rule-name-taken", rule.file, "", {
          ...at,
          name: rule.name,
        })
      )
      continue
    }
    checks.push({
      name: rule.name,
      expression: rowRuleExpression(rule.expr),
      origin: { rowRule: { file: rule.file } },
    })
    added.set(table, checks)
  }
  return {
    physical: {
      ...physical,
      tables: physical.tables.map((table) => {
        const checks = added.get(table)
        return checks === undefined
          ? table
          : {
              ...table,
              checks: [...table.checks, ...checks].sort((a, b) =>
                compareStrings(a.name, b.name)
              ),
            }
      }),
    },
    diagnostics,
  }
}

function nodeName(node: Node): string {
  return Object.keys(node)[0] ?? "unknown"
}

function operatorOf(name: readonly Node[] | undefined): string | undefined {
  const [only, ...rest] = name ?? []
  return only !== undefined && rest.length === 0 && "String" in only
    ? only.String.sval
    : undefined
}

/** Некваліфікована колонка; інакше — `undefined`. */
function columnName(node: Node): string | undefined {
  if (!("ColumnRef" in node)) return undefined
  const fields = node.ColumnRef.fields ?? []
  const only = fields[0]
  return fields.length === 1 && only !== undefined && "String" in only
    ? (only.String.sval ?? "")
    : undefined
}

function columnProblem(
  node: Node,
  columns: ReadonlyMap<string, string>
): string | undefined {
  if (!("ColumnRef" in node)) return nodeName(node)
  const name = columnName(node)
  if (name === undefined) return "qualified column"
  return columns.has(name) ? undefined : "unknown column"
}

/** Аргументи `num_nonnulls(…)` у простій формі виклику; інакше — `undefined`. */
function numNonnullsArgs(node: Node): Node[] | undefined {
  if (!("FuncCall" in node)) return undefined
  const call = node.FuncCall
  const names = (call.funcname ?? []).map((n) =>
    "String" in n ? n.String.sval : undefined
  )
  const plain =
    call.agg_order === undefined &&
    call.agg_filter === undefined &&
    call.over === undefined &&
    call.agg_star !== true &&
    call.agg_distinct !== true &&
    call.func_variadic !== true
  return plain &&
    names.length === 1 &&
    names[0] === "num_nonnulls" &&
    (call.args ?? []).length > 0
    ? call.args
    : undefined
}

/** Літерал правила: без бітових рядків, бо їхній текст — окрема граматика. */
function literalOf(node: Node): AConst | undefined {
  if (!("A_Const" in node)) return undefined
  return node.A_Const.bsval === undefined ? node.A_Const : undefined
}

function literalText(value: AConst): string {
  // Нульові значення libpg-query пропускає: `{ ival: {} }` — це 0.
  if (value.isnull === true) return "NULL"
  if (value.ival !== undefined) return String(value.ival.ival ?? 0)
  if (value.fval !== undefined) return value.fval.fval ?? "0"
  if (value.boolval !== undefined) {
    return value.boolval.boolval === true ? "true" : "false"
  }
  return `'${(value.sval?.sval ?? "").replaceAll("'", "''")}'`
}
