import type { Expr } from "./ast"

/**
 * Обходить усі вузли виразу в порядку появи (спершу вузол, потім операнди).
 * Єдиний обхід AST: окремі рекурсії в стадіях компілятора розходилися б
 * при появі нового виду вузла.
 */
export function walkExpr(expr: Expr, visit: (node: Expr) => void): void {
  visit(expr)
  switch (expr.type) {
    case "unary":
      walkExpr(expr.operand, visit)
      return
    case "binary":
      walkExpr(expr.left, visit)
      walkExpr(expr.right, visit)
      return
    default:
      return
  }
}
