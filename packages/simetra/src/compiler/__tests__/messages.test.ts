import { describe, expect, it } from "vitest"
import { SCHEMA_RULES } from "simetra/model"
import {
  COMPILER_RULES,
  MESSAGES,
  localize,
  compile,
  type RuleCode,
} from "simetra/compiler"
import { metaFiles, project } from "./helpers"
import { diagnostic } from "../diagnostics"

const ALL_RULES: RuleCode[] = [...SCHEMA_RULES, ...COMPILER_RULES]

// Параметри, яких вимагають тексти: порожні params дали б "undefined" у рядку.
const PARAMS = new Proxy(
  {},
  { get: (_, key) => (key === "then" ? undefined : `<${String(key)}>`) }
) as Record<string, string>

describe("messages catalog", () => {
  it("every rule has en and uk", () => {
    for (const code of ALL_RULES) {
      const entry = MESSAGES[code]
      expect(entry, code).toBeDefined()
      expect(entry.en(PARAMS).trim(), `${code} en`).not.toBe("")
      expect(entry.uk(PARAMS).trim(), `${code} uk`).not.toBe("")
      if (entry.hint !== undefined) {
        for (const locale of ["en", "uk"] as const) {
          const hint = entry.hint[locale]
          const text = typeof hint === "string" ? hint : hint(PARAMS)
          expect(text.trim(), `${code} hint ${locale}`).not.toBe("")
        }
      }
    }
  })

  it("the catalog has no entries outside the rule lists", () => {
    expect(Object.keys(MESSAGES).sort()).toEqual([...ALL_RULES].sort())
  })

  it("a Ukrainian text differs from the English one", () => {
    // Копія англійського тексту в uk — ознака забутого перекладу.
    for (const code of ALL_RULES) {
      expect(MESSAGES[code].uk(PARAMS), code).not.toBe(
        MESSAGES[code].en(PARAMS)
      )
    }
  })

  it("file.schema gets the Zod Ukrainian text", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Item/Item.meta.json": { kind: "Catalog", name: 7 },
      })
    )
    const d = result.diagnostics.find((x) => x.code === "file.schema")
    expect(d?.message).toMatch(/^Invalid input/)
    expect(localize(d!, "uk").message).toMatch(/^Неправильн.*отримано число/)
  })

  it("localize returns uk text", () => {
    const d = diagnostic("identity.id-missing", "a.meta.json", "/id")
    expect(d.message).toBe("id is missing")
    expect(localize(d, "en")).toEqual({
      message: "id is missing",
      hint: "Run simetra fix to assign ids.",
    })
    expect(localize(d, "uk")).toEqual({
      message: "Немає id",
      hint: "Виконайте simetra fix, щоб призначити id.",
    })
  })

  it("localize fills parameters and parametric hints", () => {
    const d = diagnostic("reference.ambiguous", "a.meta.json", "/x", {
      name: "Item",
      candidates: "Catalog.Item, Document.Item",
    })
    expect(localize(d, "uk")).toEqual({
      message: 'Ім\'я "Item" неоднозначне між Catalog.Item, Document.Item',
      hint: "Кваліфікуйте маркер як <Kind>.<Name>, наприклад Catalog.Item.",
    })
  })

  it("localize omits the hint when the rule has none", () => {
    const d = diagnostic("identity.name-duplicate", "a", "/n", {
      name: "X",
      scope: "Y",
    })
    expect(localize(d, "uk")).toEqual({
      message: 'Ім\'я "X" уже оголошене в Y',
    })
  })

  it("sql.closed-shell puts the line on the statement only for dynamic SQL", () => {
    const text = (problem: string, locale: "en" | "uk") =>
      localize(
        diagnostic("sql.closed-shell", "a.sql", "", {
          function: "public.f",
          line: 7,
          problem,
        }),
        locale
      ).message
    expect(text("dynamicSql", "en")).toBe(
      "Function public.f is outside the closed shell: its body runs dynamic SQL (EXECUTE, a dynamic cursor or RETURN QUERY EXECUTE) at line 7"
    )
    expect(text("dynamicSql", "uk")).toBe(
      "Функція public.f поза закритою оболонкою: її тіло виконує динамічний SQL (EXECUTE, динамічний курсор чи RETURN QUERY EXECUTE) у рядку 7"
    )
    // Решта проблем — про функцію цілком: рядок її початку.
    expect(text("volatility", "en")).toBe(
      "Function public.f at line 7 is outside the closed shell: its volatility is not explicit"
    )
    expect(text("volatility", "uk")).toBe(
      "Функція public.f у рядку 7 поза закритою оболонкою: її волатильність не явна"
    )
  })

  it("renders every fill problem of promote.expression-invalid as a sentence", () => {
    const reasons = [
      "noKey",
      "syntax",
      "subquery",
      "aggregate",
      "foreignTable",
      "multipleTargets",
      "multipleStatements",
      "setReturning",
      "volatile",
      "unknownFunction",
      "unqualifiedFunction",
      "castToTime",
      "specialTimeLiteral",
      "nondeterministicWindow",
      "unknownColumn",
    ]
    for (const locale of ["en", "uk"] as const) {
      const messages = reasons.map((reason) => {
        const { message } = localize(
          diagnostic("promote.expression-invalid", "", "", {
            at: "/fill/0/expression",
            expression: "x",
            reason,
          }),
          locale
        )
        expect(message, `${reason} ${locale}`).not.toMatch(
          new RegExp(`: ${reason}$`)
        )
        return message
      })
      expect(new Set(messages).size, locale).toBe(reasons.length)
    }
  })
})
