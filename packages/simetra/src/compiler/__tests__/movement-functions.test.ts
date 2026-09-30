import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  SALE_FILE,
  STOCK_FILE,
  attribute,
  catalog,
  metaFiles,
  organization,
  project,
  salesDocument,
  scopedProject,
} from "./helpers"

const SALE_SQL = "documents/Sale/Sale.sql"

function units(entries: Record<string, unknown>) {
  const result = compile(metaFiles(entries))
  expect(result.diagnostics).toEqual([])
  return result.model!.sqlUnits
}

/** Документ `Sale` із ТЧ `goods` і регістр залишків `Stock` з необов'язковим реквізитом. */
function sales(
  movement: Record<string, unknown> = {},
  sale: Record<string, unknown> = {},
  projectOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const entries = salesDocument(movement, sale)
  const stock = entries[STOCK_FILE] as Record<string, unknown>
  stock.attributes = [
    attribute("note", { type: "String", length: 100, physicalName: "note" }),
  ]
  return { "project.meta.json": project(projectOverrides), ...entries }
}

function saleMovements(entries: Record<string, unknown>) {
  return (entries[SALE_FILE] as { posting: { movements: unknown[] } }).posting
    .movements
}

describe("movement query functions", () => {
  it("wraps a query block", () => {
    const entries = salesDocument({}, { posting: undefined })
    const block =
      "SELECT d.date, 'Expense', g.item_id, g.qty\n" +
      "FROM public.goods g JOIN public.sale d ON d.id = g.parent_id\n" +
      "WHERE d.id = p_document_id\n" +
      "ORDER BY g.line_number"
    const result = units({
      "project.meta.json": project(),
      ...entries,
      [SALE_SQL]: `-- before\n-- @movements Stock\n${block}\n-- @end\n`,
    })
    expect(result).toHaveLength(1)
    const [unit] = result
    expect(unit).toMatchObject({
      kind: "movementQuery",
      schema: "public",
      name: "sale_stock_movements",
      source: "query",
    })
    expect(unit!.sql).toContain(
      "RETURNS TABLE (period timestamp with time zone, movement_type text, item_id uuid, qty numeric(15,3))"
    )
    expect(unit!.sql).toContain(`AS $simetra$\n${block}\n$simetra$;`)
    expect(unit!.sql).toMatchInlineSnapshot(`
      "CREATE OR REPLACE FUNCTION public.sale_stock_movements(p_document_id uuid)
      RETURNS TABLE (period timestamp with time zone, movement_type text, item_id uuid, qty numeric(15,3))
      LANGUAGE sql STABLE
      AS $simetra$
      SELECT d.date, 'Expense', g.item_id, g.qty
      FROM public.goods g JOIN public.sale d ON d.id = g.parent_id
      WHERE d.id = p_document_id
      ORDER BY g.line_number
      $simetra$;"
    `)
  })

  it("translates constructor movement from tabular section", () => {
    const [unit] = units(sales({ condition: "row.qty > 0 and not false" }))
    expect(unit).toMatchObject({
      schema: "public",
      name: "sale_stock_movements",
      source: "constructor",
    })
    expect(unit!.sql).toMatchInlineSnapshot(`
      "CREATE OR REPLACE FUNCTION public.sale_stock_movements(p_document_id uuid)
      RETURNS TABLE (period timestamp with time zone, movement_type text, item_id uuid, qty numeric(15,3), note character varying(100))
      LANGUAGE sql STABLE
      AS $simetra$
      SELECT m.period, m.movement_type, m.item_id, m.qty, m.note
      FROM (
        SELECT d.date AS period, 'Expense' AS movement_type, r.item_id AS item_id, r.qty AS qty, NULL::character varying(100) AS note, 0 AS __movement, r.line_number AS __line
        FROM public.goods r
        JOIN public.sale d ON d.id = r.parent_id
        WHERE d.id = p_document_id
          AND ((r.qty > 0) AND (NOT false))
      ) m
      ORDER BY m.__movement, m.__line
      $simetra$;"
    `)
  })

  it("union of two movements into one register", () => {
    const entries = sales()
    saleMovements(entries).push({
      register: { kind: "AccumulationRegister", name: "Stock" },
      source: { tabularSection: "goods" },
      movementType: "Receipt",
      condition: "row.qty < 0",
      fields: { item: "row.item", qty: "-row.qty", note: "'it''s back'" },
    })
    const [unit] = units(entries)
    expect(unit!.sql).toMatchInlineSnapshot(`
      "CREATE OR REPLACE FUNCTION public.sale_stock_movements(p_document_id uuid)
      RETURNS TABLE (period timestamp with time zone, movement_type text, item_id uuid, qty numeric(15,3), note character varying(100))
      LANGUAGE sql STABLE
      AS $simetra$
      SELECT m.period, m.movement_type, m.item_id, m.qty, m.note
      FROM (
        SELECT d.date AS period, 'Expense' AS movement_type, r.item_id AS item_id, r.qty AS qty, NULL::character varying(100) AS note, 0 AS __movement, r.line_number AS __line
        FROM public.goods r
        JOIN public.sale d ON d.id = r.parent_id
        WHERE d.id = p_document_id
        UNION ALL
        SELECT d.date AS period, 'Receipt' AS movement_type, r.item_id AS item_id, -r.qty AS qty, 'it''s back' AS note, 1 AS __movement, r.line_number AS __line
        FROM public.goods r
        JOIN public.sale d ON d.id = r.parent_id
        WHERE d.id = p_document_id
          AND (r.qty < 0)
      ) m
      ORDER BY m.__movement, m.__line
      $simetra$;"
    `)
  })

  it("aggregate from document source", () => {
    const entries = sales(
      {
        source: "document",
        condition: "count(goods) > 0",
        period: "doc.date",
        fields: { item: "doc.item", qty: "sum(goods.qty) * 2" },
      },
      {
        attributes: [
          attribute("item", {
            physicalName: "item_id",
            type: "Ref",
            ref: { kind: "Catalog", name: "Item" },
          }),
        ],
      }
    )
    const [unit] = units(entries)
    expect(unit!.sql).toMatchInlineSnapshot(`
      "CREATE OR REPLACE FUNCTION public.sale_stock_movements(p_document_id uuid)
      RETURNS TABLE (period timestamp with time zone, movement_type text, item_id uuid, qty numeric(15,3), note character varying(100))
      LANGUAGE sql STABLE
      AS $simetra$
      SELECT m.period, m.movement_type, m.item_id, m.qty, m.note
      FROM (
        SELECT d.date AS period, 'Expense' AS movement_type, d.item_id AS item_id, (SELECT COALESCE(sum(t.qty), 0) FROM public.goods t WHERE t.parent_id = d.id) * 2 AS qty, NULL::character varying(100) AS note, 0 AS __movement, 0 AS __line
        FROM public.sale d
        WHERE d.id = p_document_id
          AND ((SELECT count(*) FROM public.goods t WHERE t.parent_id = d.id) > 0)
      ) m
      ORDER BY m.__movement, m.__line
      $simetra$;"
    `)
  })

  it("periodic information register truncates period in project timezone", () => {
    const withPrices = (projectOverrides: Record<string, unknown>) => {
      const entries = sales({}, {}, projectOverrides)
      const sale = entries[SALE_FILE] as Record<string, unknown>
      ;(sale.registerMovements as unknown[]).push({
        kind: "InformationRegister",
        name: "Prices",
      })
      saleMovements(entries).push({
        register: { kind: "InformationRegister", name: "Prices" },
        source: { tabularSection: "goods" },
        fields: { item: "row.item", price: "row.amount / row.qty" },
      })
      entries["information-registers/Prices/Prices.meta.json"] = {
        id: "00000000-0000-4000-8000-000000000901",
        kind: "InformationRegister",
        name: "Prices",
        physicalName: "prices",
        periodicity: "Month",
        writeMode: "RecorderSubordinate",
        recorderTypes: [{ kind: "Document", name: "Sale" }],
        dimensions: [
          attribute("item", {
            physicalName: "item_id",
            type: "Ref",
            ref: { kind: "Catalog", name: "Item" },
          }),
        ],
        resources: [
          attribute("price", { type: "Numeric", precision: 15, scale: 2 }),
        ],
      }
      const prices = units(entries).find(
        (u) => u.name === "sale_prices_movements"
      )
      return prices!.sql
    }

    const kyiv = withPrices({ timezone: "Europe/Kyiv" })
    expect(kyiv).toContain("date_trunc('month', d.date, 'Europe/Kyiv')")
    expect(withPrices({})).toContain("date_trunc('month', d.date, 'UTC')")
    expect(kyiv).toMatchInlineSnapshot(`
      "CREATE OR REPLACE FUNCTION public.sale_prices_movements(p_document_id uuid)
      RETURNS TABLE (period timestamp with time zone, item_id uuid, price numeric(15,2))
      LANGUAGE sql STABLE
      AS $simetra$
      SELECT m.period, m.item_id, m.price
      FROM (
        SELECT date_trunc('month', d.date, 'Europe/Kyiv') AS period, r.item_id AS item_id, r.amount / r.qty AS price, 1 AS __movement, r.line_number AS __line
        FROM public.goods r
        JOIN public.sale d ON d.id = r.parent_id
        WHERE d.id = p_document_id
      ) m
      ORDER BY m.__movement, m.__line
      $simetra$;"
    `)
  })

  it("units are sorted by schema and name", () => {
    const entries = sales()
    entries["documents/Return/Return.meta.json"] = {
      id: "00000000-0000-4000-8000-000000000902",
      kind: "Document",
      name: "Return",
      physicalName: "a_return",
      registerMovements: [{ kind: "AccumulationRegister", name: "Stock" }],
      attributes: [
        attribute("item", {
          physicalName: "item_id",
          type: "Ref",
          ref: { kind: "Catalog", name: "Item" },
        }),
      ],
      posting: {
        movements: [
          {
            register: { kind: "AccumulationRegister", name: "Stock" },
            source: "document",
            movementType: "Receipt",
            fields: { item: "doc.item", qty: "1" },
          },
        ],
      },
    }
    const stock = entries[STOCK_FILE] as { recorderTypes: unknown[] }
    stock.recorderTypes.push({ kind: "Document", name: "Return" })
    expect(units(entries).map((u) => [u.schema, u.name])).toEqual([
      ["public", "a_return_stock_movements"],
      ["public", "sale_stock_movements"],
    ])
  })

  it("scope carrier is not a result column", () => {
    const entries = sales({}, { scope: "org" })
    ;(entries[STOCK_FILE] as Record<string, unknown>).scope = "org"
    entries["project.meta.json"] = scopedProject()
    entries["catalogs/Organization/Organization.meta.json"] = organization()
    entries["catalogs/Item/Item.meta.json"] = catalog("Item", { scope: "org" })
    const stock = compile(metaFiles(entries)).model!.physical.tables.find(
      (t) => t.name === "stock"
    )
    expect(stock!.columns.map((c) => c.name)).toContain("org_id")
    const [unit] = units(entries)
    expect(unit!.sql).toContain(
      "RETURNS TABLE (period timestamp with time zone, movement_type text, item_id uuid, qty numeric(15,3), note character varying(100))"
    )
    expect(unit!.sql).not.toContain("org_id")
  })

  it("single-target reference into a polymorphic field carries its discriminator", () => {
    const entries = sales({
      fields: { item: "row.item", qty: "row.qty", source: "row.item" },
    })
    entries["catalogs/Service/Service.meta.json"] = catalog("Service")
    ;(entries[STOCK_FILE] as Record<string, unknown>).attributes = [
      attribute("source", {
        physicalName: "source",
        type: "Ref",
        allowedTypes: [
          { kind: "Catalog", name: "Item" },
          { kind: "Catalog", name: "Service" },
        ],
      }),
    ]
    const [unit] = units(entries)
    expect(unit!.sql).toContain("source_type text, source_id uuid)")
    expect(unit!.sql).toContain("'item' AS source_type, r.item_id AS source_id")
  })

  it("deterministic output", () => {
    const entries = sales()
    const first = units(entries)
    const second = units(entries)
    expect(second.map((u) => u.sql)).toEqual(first.map((u) => u.sql))
  })
})
