import { describe, it, expect } from "vitest"
import { parseExpression, type Expr } from "../posting"

function ok(text: string): Expr {
  const result = parseExpression(text)
  if (!result.ok) throw new Error(`${result.message} @${result.offset}`)
  return result.expr
}

describe("parseExpression", () => {
  it("parses precedence", () => {
    const expr = ok("row.qty * row.price + doc.delivery")
    expect(expr.type).toBe("binary")
    if (expr.type !== "binary") return
    expect(expr.op).toBe("+")
    expect(expr.left.type).toBe("binary")
    if (expr.left.type === "binary") expect(expr.left.op).toBe("*")
    expect(expr.right).toMatchObject({
      type: "field",
      base: "doc",
      name: "delivery",
    })
  })

  it("parses aggregates", () => {
    expect(ok("sum(goods.amount)")).toMatchObject({
      type: "sum",
      section: "goods",
      field: "amount",
    })
    expect(ok("count(goods)")).toMatchObject({
      type: "count",
      section: "goods",
    })
  })

  it("rejects expression in sum", () => {
    const result = parseExpression("sum(goods.qty * 2)")
    expect(result).toMatchObject({ ok: false, offset: 14 })
  })

  it("strings with doubled quotes", () => {
    expect(ok("'it''s'")).toMatchObject({ type: "string", value: "it's" })
  })

  it("keywords are case-insensitive", () => {
    const expr = ok("NOT row.active AND doc.posted")
    expect(expr).toMatchObject({ type: "binary", op: "and" })
    if (expr.type === "binary") {
      expect(expr.left).toMatchObject({ type: "unary", op: "not" })
    }
    expect(ok("TRUE")).toMatchObject({ type: "boolean", value: true })
    expect(ok("Null")).toMatchObject({ type: "null" })
  })

  it("reports offset of unexpected token", () => {
    expect(parseExpression("row.qty +")).toMatchObject({
      ok: false,
      offset: 9,
    })
  })

  it("node spans", () => {
    expect(ok("doc.date")).toMatchObject({ start: 0, end: 8 })
  })

  it("parses numbers, unary minus and parentheses", () => {
    expect(ok("12.50")).toMatchObject({ type: "number", value: "12.50" })
    expect(ok("-(row.a + 1)")).toMatchObject({ type: "unary", op: "-" })
    expect(ok("row.a <= 3 or row.b != 4")).toMatchObject({ op: "or" })
  })

  it("rejects trailing tokens, unknown bases and unterminated strings", () => {
    expect(parseExpression("row.a row.b")).toMatchObject({
      ok: false,
      offset: 6,
    })
    expect(parseExpression("foo.bar")).toMatchObject({ ok: false, offset: 0 })
    expect(parseExpression("'abc")).toMatchObject({ ok: false, offset: 0 })
    expect(parseExpression("")).toMatchObject({ ok: false, offset: 0 })
    expect(parseExpression("row.a # 2")).toMatchObject({
      ok: false,
      offset: 6,
    })
  })

  it("spans include parentheses", () => {
    expect(ok("-(row.a + 1)")).toMatchObject({ start: 0, end: 12 })
    expect(ok("(row.a) * 2")).toMatchObject({ start: 0, end: 11 })
    expect(ok("(row.a)")).toMatchObject({ start: 0, end: 7 })
  })

  it("unary spans", () => {
    expect(ok("-row.a")).toMatchObject({ type: "unary", start: 0, end: 6 })
    expect(ok("not row.a")).toMatchObject({ type: "unary", start: 0, end: 9 })
  })

  it("identifiers starting with a keyword are fields", () => {
    const expr = ok("row.order + doc.notes + row.sumTotal")
    expect(expr).toMatchObject({ type: "binary", op: "+" })
    if (expr.type !== "binary") return
    expect(expr.right).toMatchObject({ type: "field", name: "sumTotal" })
    expect(expr.left).toMatchObject({ type: "binary" })
  })

  it("rejects chained comparison", () => {
    expect(parseExpression("row.a < row.b < row.c")).toMatchObject({
      ok: false,
      offset: 14,
    })
  })

  it("is left-associative", () => {
    const expr = ok("1 - 2 - 3")
    expect(expr).toMatchObject({
      type: "binary",
      op: "-",
      right: { type: "number", value: "3" },
      left: {
        type: "binary",
        op: "-",
        left: { value: "1" },
        right: { value: "2" },
      },
    })
  })

  it("rejects malformed aggregate arguments", () => {
    expect(parseExpression("count(goods.x)")).toMatchObject({
      ok: false,
      offset: 11,
    })
    expect(parseExpression("sum(goods)")).toMatchObject({
      ok: false,
      offset: 9,
    })
  })

  it("doc and row are case-insensitive, names are not", () => {
    expect(ok("DOC.date")).toMatchObject({
      type: "field",
      base: "doc",
      name: "date",
    })
    expect(ok("Row.Qty")).toMatchObject({ base: "row", name: "Qty" })
  })
})
