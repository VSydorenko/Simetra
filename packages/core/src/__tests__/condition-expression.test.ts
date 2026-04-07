import { describe, it, expect } from "vitest"
import { conditionExpressionSchema } from "../schemas"

describe("conditionExpressionSchema", () => {
  describe("valid expressions", () => {
    it("accepts doc.field = string literal", () => {
      expect(conditionExpressionSchema.parse("doc.status = 'Active'")).toBe(
        "doc.status = 'Active'"
      )
    })

    it("accepts row.field > number", () => {
      expect(conditionExpressionSchema.parse("row.quantity > 0")).toBe(
        "row.quantity > 0"
      )
    })

    it("accepts compound AND with !=", () => {
      expect(
        conditionExpressionSchema.parse(
          "doc.amount >= 100 AND doc.status != 'Draft'"
        )
      ).toBe("doc.amount >= 100 AND doc.status != 'Draft'")
    })

    it("accepts boolean literal", () => {
      expect(conditionExpressionSchema.parse("doc.is_active = true")).toBe(
        "doc.is_active = true"
      )
    })

    it("accepts null literal", () => {
      expect(conditionExpressionSchema.parse("doc.parent_id != null")).toBe(
        "doc.parent_id != null"
      )
    })

    it("accepts OR combinator", () => {
      expect(
        conditionExpressionSchema.parse("row.price > 0 OR row.quantity > 0")
      ).toBe("row.price > 0 OR row.quantity > 0")
    })

    it("accepts grouped expressions with parentheses", () => {
      const expr =
        "(doc.status = 'Active' AND doc.amount > 0) OR doc.is_vip = true"
      expect(conditionExpressionSchema.parse(expr)).toBe(expr)
    })

    it("accepts SQL keyword inside string literal (quote-aware)", () => {
      expect(
        conditionExpressionSchema.parse("doc.status = 'SELECT'")
      ).toBe("doc.status = 'SELECT'")
    })

    it("accepts negative number literal", () => {
      expect(conditionExpressionSchema.parse("row.amount > -100")).toBe(
        "row.amount > -100"
      )
    })
  })

  describe("invalid expressions — SQL injection prevention", () => {
    it("rejects DROP TABLE", () => {
      expect(() =>
        conditionExpressionSchema.parse("DROP TABLE users")
      ).toThrow()
    })

    it("rejects DELETE keyword", () => {
      expect(() =>
        conditionExpressionSchema.parse("DELETE FROM t WHERE 1=1")
      ).toThrow()
    })

    it("rejects INSERT keyword", () => {
      expect(() =>
        conditionExpressionSchema.parse("INSERT INTO t VALUES (1)")
      ).toThrow()
    })

    it("rejects UPDATE keyword", () => {
      expect(() =>
        conditionExpressionSchema.parse("UPDATE t SET x = 1")
      ).toThrow()
    })

    it("rejects ALTER keyword", () => {
      expect(() =>
        conditionExpressionSchema.parse("ALTER TABLE t ADD col INT")
      ).toThrow()
    })

    it("rejects EXEC keyword", () => {
      expect(() =>
        conditionExpressionSchema.parse("EXEC sp_executesql")
      ).toThrow()
    })

    it("rejects semicolons", () => {
      expect(() =>
        conditionExpressionSchema.parse("doc.field; DELETE FROM t")
      ).toThrow()
    })

    it("rejects line comments", () => {
      expect(() =>
        conditionExpressionSchema.parse("doc.field -- comment")
      ).toThrow()
    })

    it("rejects block comments", () => {
      expect(() =>
        conditionExpressionSchema.parse("doc.field /* comment */")
      ).toThrow()
    })

    it("rejects SELECT keyword outside string literal", () => {
      expect(() =>
        conditionExpressionSchema.parse("SELECT * FROM users")
      ).toThrow()
    })

    it("rejects UNION keyword", () => {
      expect(() => conditionExpressionSchema.parse("UNION SELECT 1")).toThrow()
    })
  })

  describe("invalid expressions — grammar violations", () => {
    it("rejects empty string", () => {
      expect(() => conditionExpressionSchema.parse("")).toThrow()
    })

    it("rejects whitespace-only string", () => {
      expect(() => conditionExpressionSchema.parse("   ")).toThrow()
    })

    it("rejects unbalanced opening parenthesis", () => {
      expect(() =>
        conditionExpressionSchema.parse("(doc.status = 'Active'")
      ).toThrow()
    })

    it("rejects unbalanced closing parenthesis", () => {
      expect(() =>
        conditionExpressionSchema.parse("doc.status = 'Active')")
      ).toThrow()
    })

    it("rejects expression without field reference", () => {
      expect(() => conditionExpressionSchema.parse("true AND false")).toThrow()
    })
  })
})
