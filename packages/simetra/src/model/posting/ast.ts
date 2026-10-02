/**
 * AST виразу конструктора рухів. Кожен вузол несе півінтервал [start, end) —
 * зміщення в рядку виразу, щоб діагностики вказували на точне місце.
 * Це не схема метаданих, тож тип написано вручну.
 */

/**
 * Межі токена імені всередині вузла: каскад перейменування заміняє рівно їх,
 * а межі вузла (`doc.x`, `sum(s.f)`) захопили б і синтаксис навколо.
 */
export interface Span {
  start: number
  end: number
}

export type BinaryOp =
  "+" | "-" | "*" | "/" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or"

export type Expr =
  | {
      type: "field"
      base: "doc" | "row"
      name: string
      fieldSpan: Span
      start: number
      end: number
    }
  | {
      type: "sum"
      section: string
      field: string
      sectionSpan: Span
      fieldSpan: Span
      start: number
      end: number
    }
  | {
      type: "count"
      section: string
      sectionSpan: Span
      start: number
      end: number
    }
  | { type: "number"; value: string; start: number; end: number }
  | { type: "string"; value: string; start: number; end: number }
  | { type: "boolean"; value: boolean; start: number; end: number }
  | { type: "null"; start: number; end: number }
  | {
      type: "unary"
      op: "-" | "not"
      operand: Expr
      start: number
      end: number
    }
  | {
      type: "binary"
      op: BinaryOp
      left: Expr
      right: Expr
      start: number
      end: number
    }

export type ParseResult =
  { ok: true; expr: Expr } | { ok: false; message: string; offset: number }
