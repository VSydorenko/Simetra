import { describe, expect, it } from "vitest"
import { canonicalSnapshot, compile } from "simetra/compiler"
import type { PhysicalSnapshot, PhysicalTable } from "simetra/model"
import {
  acceptDebt,
  attribute,
  customTable,
  metaFiles,
  project,
  salesDocument,
} from "./helpers"

const SALE_SQL = "documents/Sale/Sale.sql"

/** Документ `Sale` з двома посиланнями, рядком і сумою, плюс `.sql`. */
function files(sql: Record<string, string>) {
  const ref = (name: string) =>
    attribute(name, {
      physicalName: `${name}_id`,
      type: "Ref",
      ref: { kind: "Catalog", name: "Item" },
    })
  return metaFiles({
    "project.meta.json": project(),
    ...salesDocument(
      {},
      {
        attributes: [
          ref("buyer"),
          ref("seller"),
          attribute("code", { type: "String", length: 10, required: true }),
          attribute("amount", { type: "Numeric", precision: 15, scale: 2 }),
          attribute("discount", { type: "Numeric", precision: 15, scale: 2 }),
        ],
      }
    ),
    "custom-tables/T/T.meta.json": customTable("T"),
    ...sql,
  })
}

function tableOf(physical: PhysicalSnapshot, name: string): PhysicalTable {
  return physical.tables.find((t) => t.name === name)!
}

const rule = (expression: string, table = "public.sale", name = "sale_rule") =>
  `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expression});`

describe("row rule of a kind module", () => {
  it("a valid row rule becomes a table CHECK with its origin, not a unit", async () => {
    const result = await compile(
      files({
        [SALE_SQL]:
          "ALTER TABLE public.sale ADD CONSTRAINT sale_one_party CHECK (num_nonnulls(buyer_id, seller_id) <= 1);",
      })
    )
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    const sale = tableOf(model.physical, "sale")
    expect(sale.checks).toContainEqual({
      name: "sale_one_party",
      expression: "num_nonnulls(buyer_id, seller_id) <= 1",
      origin: { rowRule: { file: SALE_SQL } },
    })
    expect(model.sqlUnits.filter((u) => u.file === SALE_SQL)).toEqual([])
  })

  it("the hash snapshot keeps the row-rule origin without the file path", async () => {
    // Спека П2 §8.3: канонічна форма без шляхів файлів; шлях лишається в
    // знімку для `explain`.
    const result = await compile(
      files({ [SALE_SQL]: rule("num_nonnulls(buyer_id, seller_id) <= 1") })
    )
    const { physical } = canonicalSnapshot(result.model!) as {
      physical: PhysicalSnapshot
    }
    expect(
      tableOf(physical, "sale").checks.find((c) => c.name === "sale_rule")
    ).toEqual({
      name: "sale_rule",
      expression: "num_nonnulls(buyer_id, seller_id) <= 1",
      origin: { rowRule: {} },
    })
    expect(
      tableOf(result.model!.physical, "sale").checks.find(
        (c) => c.name === "sale_rule"
      )?.origin
    ).toEqual({ rowRule: { file: SALE_SQL } })
  })

  it("the whole grammar is accepted in its canonical text", async () => {
    const result = await compile(
      files({
        [SALE_SQL]: rule(
          "code IS NOT NULL AND (amount >= discount OR NOT code IN ('a', 'b''c')) AND code NOT IN ('x') AND code <> 'y' AND buyer_id IS NULL"
        ),
      })
    )
    expect(result.diagnostics).toEqual([])
    expect(
      tableOf(result.model!.physical, "sale").checks.find(
        (c) => c.name === "sale_rule"
      )?.expression
    ).toBe(
      "code IS NOT NULL AND (amount >= discount OR NOT code IN ('a', 'b''c')) AND code NOT IN ('x') AND code <> 'y' AND buyer_id IS NULL"
    )
  })

  it.each([
    ["lower(code) = 'x'", "FuncCall"],
    ["code = (SELECT 1)", "SubLink"],
    ["code = 'x'::text", "TypeCast"],
    ["other.code IS NULL", "qualified column"],
    ["amount > code", "column type mismatch"],
    ["missing IS NULL", "unknown column"],
    ["amount > 1", "operator > with a literal"],
    [
      "num_nonnulls(buyer_id, seller_id) <= 1.5",
      "num_nonnulls bound not an integer",
    ],
    ["code LIKE 'x%'", "AEXPR_LIKE"],
    ["code = NULL", "NULL literal (use IS [NOT] NULL)"],
    ["code <> NULL", "NULL literal (use IS [NOT] NULL)"],
    ["code IN ('a', NULL)", "NULL literal (use IS [NOT] NULL)"],
  ])("grammar rejects %s", async (expression, construct) => {
    const result = await compile(files({ [SALE_SQL]: rule(expression) }))
    expect(
      result.diagnostics.map((d) => [d.code, d.file, d.params?.construct])
    ).toEqual([["sql.row-rule-grammar", SALE_SQL, construct]])
  })

  it("row rule on another object's table is an error", async () => {
    const result = await compile(
      files({ [SALE_SQL]: rule("id IS NOT NULL", "public.item", "item_rule") })
    )
    expect(result.diagnostics.map((d) => [d.code, d.file])).toEqual([
      ["sql.row-rule-foreign-table", SALE_SQL],
    ])
  })

  it("row rule in a shared sql file is an error", async () => {
    const result = await compile(
      files({ "sql/public/rules.sql": rule("code IS NOT NULL") })
    )
    expect(result.diagnostics.map((d) => [d.code, d.file])).toEqual([
      ["sql.row-rule-outside-module", "sql/public/rules.sql"],
    ])
  })

  it("row rule in a custom table module is an error", async () => {
    const result = await compile(
      files({
        "custom-tables/T/T.sql": rule("id IS NOT NULL", "public.t", "t_rule"),
      })
    )
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "sql.row-rule-outside-module",
    ])
  })

  it("row rule name equal to a derived CHECK is an error", async () => {
    const derived = await compile(files({ [SALE_SQL]: "" }))
    const taken = tableOf(derived.model!.physical, "sale").checks[0]!.name
    const result = await compile(
      files({ [SALE_SQL]: rule("code IS NOT NULL", "public.sale", taken) })
    )
    expect(
      result.diagnostics.map((d) => [d.code, d.file, d.params?.name])
    ).toEqual([["sql.row-rule-name-taken", SALE_SQL, taken]])
  })

  it.each([
    ["primary key", (t: PhysicalTable) => t.primaryKey?.name],
    ["unique", (t: PhysicalTable) => t.uniques[0]?.name],
    ["foreign key", (t: PhysicalTable) => t.foreignKeys[0]?.name],
  ])(
    "row rule name equal to the %s of the table is an error",
    async (_name, nameOf) => {
      const derived = await compile(files({ [SALE_SQL]: "" }))
      const taken = nameOf(tableOf(derived.model!.physical, "sale"))
      expect(taken).toBeDefined()
      const result = await compile(
        files({ [SALE_SQL]: rule("code IS NOT NULL", "public.sale", taken) })
      )
      expect(
        result.diagnostics.map((d) => [d.code, d.file, d.params?.name])
      ).toEqual([["sql.row-rule-name-taken", SALE_SQL, taken]])
    }
  )

  it("two row rules with the same name on one table are an error", async () => {
    const result = await compile(
      files({
        [SALE_SQL]:
          rule("code IS NOT NULL") + "\n" + rule("amount IS NOT NULL"),
      })
    )
    expect(
      result.diagnostics.map((d) => [d.code, d.params?.name, d.params?.line])
    ).toEqual([["sql.row-rule-name-taken", "sale_rule", 2]])
  })

  it("a row rule on the object's own tabular section table is accepted", async () => {
    const result = await compile(
      files({
        [SALE_SQL]: rule(
          "num_nonnulls(item_id, qty) >= 1 OR qty IS NULL",
          "public.goods",
          "sale_goods_rule"
        ),
      })
    )
    expect(result.diagnostics).toEqual([])
    expect(tableOf(result.model!.physical, "goods").checks).toContainEqual({
      name: "sale_goods_rule",
      expression: "num_nonnulls(item_id, qty) >= 1 OR qty IS NULL",
      origin: { rowRule: { file: SALE_SQL } },
    })
  })

  it("a CHECK without a name is not allowed", async () => {
    const result = await compile(
      files({
        [SALE_SQL]: "ALTER TABLE public.sale ADD CHECK (code IS NOT NULL);",
      })
    )
    expect(result.diagnostics.map((d) => [d.code, d.params?.detail])).toEqual([
      ["sql.statement-not-allowed", "rowRuleName"],
    ])
  })
})

describe("kind module overloads count all of pg_proc", () => {
  it("a procedure of the same name in a shared file overloads a module function", async () => {
    // Процедура — завжди борг, а предмет тут перевантаження, не ратчет.
    const result = await compile(
      await acceptDebt(
        files({
          [SALE_SQL]:
            "CREATE FUNCTION public.g(a int) RETURNS int LANGUAGE sql STABLE AS $$ select a $$;",
          "sql/public/g.sql":
            "CREATE PROCEDURE public.g(a text) LANGUAGE sql AS $$ select 1 $$;",
        })
      )
    )
    expect(result.diagnostics.map((d) => [d.code, d.file])).toEqual([
      ["sql.function-overload", SALE_SQL],
    ])
  })
})
