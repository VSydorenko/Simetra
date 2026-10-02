import type { BinaryOp, Expr, ParseResult, Span } from "./ast"

type TokenKind = "ident" | "number" | "string" | "op" | "eof"

interface Token {
  kind: TokenKind
  /** Для ident — у нижньому регістрі не нормалізується: ключові слова порівнюються окремо. */
  text: string
  /** Для рядкового літерала — значення без лапок і з розгорнутим `''`. */
  value?: string
  start: number
  end: number
}

class ParseError extends Error {
  constructor(
    message: string,
    readonly offset: number
  ) {
    super(message)
  }
}

const COMPARISON_OPS: ReadonlySet<string> = new Set([
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
])

const IDENT_START = /[A-Za-z_]/
const IDENT_PART = /[A-Za-z0-9_]/
const DIGIT = /[0-9]/

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const start = i
    if (IDENT_START.test(ch)) {
      while (i < text.length && IDENT_PART.test(text.charAt(i))) i++
      tokens.push({ kind: "ident", text: text.slice(start, i), start, end: i })
    } else if (DIGIT.test(ch)) {
      while (i < text.length && DIGIT.test(text.charAt(i))) i++
      // Дробова частина потребує цифри після крапки, інакше крапка — окремий токен.
      if (text.charAt(i) === "." && DIGIT.test(text.charAt(i + 1))) {
        i++
        while (i < text.length && DIGIT.test(text.charAt(i))) i++
      }
      tokens.push({ kind: "number", text: text.slice(start, i), start, end: i })
    } else if (ch === "'") {
      i++
      let value = ""
      let closed = false
      while (i < text.length) {
        if (text.charAt(i) === "'") {
          if (text.charAt(i + 1) === "'") {
            value += "'"
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        value += text.charAt(i)
        i++
      }
      if (!closed) throw new ParseError("Unterminated string literal", start)
      tokens.push({
        kind: "string",
        text: text.slice(start, i),
        value,
        start,
        end: i,
      })
    } else {
      const two = text.slice(i, i + 2)
      if (two === "!=" || two === "<=" || two === ">=") {
        i += 2
      } else if ("+-*/=<>().,".includes(ch)) {
        i++
      } else {
        throw new ParseError(`Unexpected character "${ch}"`, start)
      }
      tokens.push({ kind: "op", text: text.slice(start, i), start, end: i })
    }
  }
  tokens.push({ kind: "eof", text: "", start: text.length, end: text.length })
  return tokens
}

/**
 * Рекурсивний спуск. Пріоритет зростає: or < and < not < порівняння < + - <
 * * / < унарний - < первинні. Власний розбір, а не залежність: граматика
 * мала, а зміщення у вузлах потрібні діагностикам.
 */
class Parser {
  private pos = 0

  constructor(private readonly tokens: Token[]) {}

  private get current(): Token {
    return this.tokens[this.pos] as Token
  }

  private isKeyword(word: string): boolean {
    const token = this.current
    return token.kind === "ident" && token.text.toLowerCase() === word
  }

  private isOp(text: string): boolean {
    const token = this.current
    return token.kind === "op" && token.text === text
  }

  private advance(): Token {
    const token = this.current
    if (token.kind !== "eof") this.pos++
    return token
  }

  private describe(token: Token): string {
    return token.kind === "eof" ? "end of expression" : `"${token.text}"`
  }

  private fail(expected: string): never {
    const token = this.current
    throw new ParseError(
      `Expected ${expected}, found ${this.describe(token)}`,
      token.start
    )
  }

  private expectOp(text: string): Token {
    if (!this.isOp(text)) this.fail(`"${text}"`)
    return this.advance()
  }

  private expectIdent(what: string): Token {
    if (this.current.kind !== "ident") this.fail(what)
    return this.advance()
  }

  parse(): Expr {
    const expr = this.parseOr()
    if (this.current.kind !== "eof") this.fail("end of expression")
    return expr
  }

  private binary(op: BinaryOp, left: Expr, right: Expr): Expr {
    return {
      type: "binary",
      op,
      left,
      right,
      start: left.start,
      end: right.end,
    }
  }

  private parseOr(): Expr {
    let left = this.parseAnd()
    while (this.isKeyword("or")) {
      this.advance()
      left = this.binary("or", left, this.parseAnd())
    }
    return left
  }

  private parseAnd(): Expr {
    let left = this.parseNot()
    while (this.isKeyword("and")) {
      this.advance()
      left = this.binary("and", left, this.parseNot())
    }
    return left
  }

  private parseNot(): Expr {
    if (this.isKeyword("not")) {
      const op = this.advance()
      const operand = this.parseNot()
      return {
        type: "unary",
        op: "not",
        operand,
        start: op.start,
        end: operand.end,
      }
    }
    return this.parseComparison()
  }

  private parseComparison(): Expr {
    const left = this.parseAdditive()
    const token = this.current
    if (token.kind === "op" && COMPARISON_OPS.has(token.text)) {
      this.advance()
      return this.binary(token.text as BinaryOp, left, this.parseAdditive())
    }
    return left
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative()
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.advance().text as BinaryOp
      left = this.binary(op, left, this.parseMultiplicative())
    }
    return left
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary()
    while (this.isOp("*") || this.isOp("/")) {
      const op = this.advance().text as BinaryOp
      left = this.binary(op, left, this.parseUnary())
    }
    return left
  }

  private parseUnary(): Expr {
    if (this.isOp("-")) {
      const op = this.advance()
      const operand = this.parseUnary()
      return {
        type: "unary",
        op: "-",
        operand,
        start: op.start,
        end: operand.end,
      }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Expr {
    const token = this.current
    if (token.kind === "number") {
      this.advance()
      return {
        type: "number",
        value: token.text,
        start: token.start,
        end: token.end,
      }
    }
    if (token.kind === "string") {
      this.advance()
      return {
        type: "string",
        value: token.value ?? "",
        start: token.start,
        end: token.end,
      }
    }
    if (this.isOp("(")) {
      const open = this.advance()
      const inner = this.parseOr()
      const close = this.expectOp(")")
      // Скобки входять у проміжок вузла, щоб діагностика підсвічувала їх разом зі вмістом.
      return { ...inner, start: open.start, end: close.end }
    }
    if (token.kind === "ident") return this.parseWord(token)
    return this.fail("an expression")
  }

  private parseWord(token: Token): Expr {
    const word = token.text.toLowerCase()
    if (word === "true" || word === "false") {
      this.advance()
      return {
        type: "boolean",
        value: word === "true",
        start: token.start,
        end: token.end,
      }
    }
    if (word === "null") {
      this.advance()
      return { type: "null", start: token.start, end: token.end }
    }
    if (word === "sum") {
      this.advance()
      this.expectOp("(")
      const section = this.expectIdent("a tabular section name")
      this.expectOp(".")
      const field = this.expectIdent("a field name")
      const close = this.expectOp(")")
      return {
        type: "sum",
        section: section.text,
        field: field.text,
        sectionSpan: spanOf(section),
        fieldSpan: spanOf(field),
        start: token.start,
        end: close.end,
      }
    }
    if (word === "count") {
      this.advance()
      this.expectOp("(")
      const section = this.expectIdent("a tabular section name")
      const close = this.expectOp(")")
      return {
        type: "count",
        section: section.text,
        sectionSpan: spanOf(section),
        start: token.start,
        end: close.end,
      }
    }
    // doc/row — ключові слова, тож регістр не важить; імена реквізитів і ТЧ чутливі.
    if (word === "doc" || word === "row") {
      this.advance()
      this.expectOp(".")
      const name = this.expectIdent("a field name")
      return {
        type: "field",
        base: word,
        name: name.text,
        fieldSpan: spanOf(name),
        start: token.start,
        end: name.end,
      }
    }
    throw new ParseError(
      `Unknown identifier "${token.text}"; expected doc.<field>, row.<field>, sum(...) or count(...)`,
      token.start
    )
  }
}

function spanOf(token: Token): Span {
  return { start: token.start, end: token.end }
}

/** Розбирає вираз конструктора рухів; помилка несе зміщення в `text`. */
export function parseExpression(text: string): ParseResult {
  try {
    return { ok: true, expr: new Parser(tokenize(text)).parse() }
  } catch (error) {
    if (error instanceof ParseError) {
      return { ok: false, message: error.message, offset: error.offset }
    }
    throw error
  }
}
