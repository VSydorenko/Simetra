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

async function units(entries: Record<string, unknown>) {
  const result = await compile(metaFiles(entries))
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
  it("wraps a query block", async () => {
    const entries = salesDocument({}, { posting: undefined })
    const block =
      "SELECT d.date, 'Expense', g.item_id, g.qty\n" +
      "FROM public.goods g JOIN public.sale d ON d.id = g.parent_id\n" +
      "WHERE d.id = p_document_id\n" +
      "ORDER BY g.line_number"
    const result = await units({
      "project.meta.json": project(),
      ...entries,
      [SALE_SQL]: `-- before\n-- @movements Stock\n${block}\n-- @end\n`,
    })
    expect(result).toHaveLength(1)
    const [unit] = result
    expect(unit).toMatchObject({
      class: "movementQuery",
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

  it("translates constructor movement from tabular section", async () => {
    const [unit] = await units(
      sales({ condition: "row.qty > 0 and not false" })
    )
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
        WHERE d.id = sale_stock_movements.p_document_id
          AND ((r.qty > 0) AND (NOT false))
      ) m
      ORDER BY m.__movement, m.__line
      $simetra$;"
    `)
  })

  it("union of two movements into one register", async () => {
    const entries = sales()
    saleMovements(entries).push({
      register: { kind: "AccumulationRegister", name: "Stock" },
      source: { tabularSection: "goods" },
      movementType: "Receipt",
      condition: "row.qty < 0",
      fields: { item: "row.item", qty: "-row.qty", note: "'it''s back'" },
    })
    const [unit] = await units(entries)
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
        WHERE d.id = sale_stock_movements.p_document_id
        UNION ALL
        SELECT d.date AS period, 'Receipt' AS movement_type, r.item_id AS item_id, -r.qty AS qty, 'it''s back' AS note, 1 AS __movement, r.line_number AS __line
        FROM public.goods r
        JOIN public.sale d ON d.id = r.parent_id
        WHERE d.id = sale_stock_movements.p_document_id
          AND (r.qty < 0)
      ) m
      ORDER BY m.__movement, m.__line
      $simetra$;"
    `)
  })

  it("aggregate from document source", async () => {
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
    const [unit] = await units(entries)
    expect(unit!.sql).toMatchInlineSnapshot(`
      "CREATE OR REPLACE FUNCTION public.sale_stock_movements(p_document_id uuid)
      RETURNS TABLE (period timestamp with time zone, movement_type text, item_id uuid, qty numeric(15,3), note character varying(100))
      LANGUAGE sql STABLE
      AS $simetra$
      SELECT m.period, m.movement_type, m.item_id, m.qty, m.note
      FROM (
        SELECT d.date AS period, 'Expense' AS movement_type, d.item_id AS item_id, (SELECT COALESCE(sum(t.qty), 0) FROM public.goods t WHERE t.parent_id = d.id) * 2 AS qty, NULL::character varying(100) AS note, 0 AS __movement, 0 AS __line
        FROM public.sale d
        WHERE d.id = sale_stock_movements.p_document_id
          AND ((SELECT count(*) FROM public.goods t WHERE t.parent_id = d.id) > 0)
      ) m
      ORDER BY m.__movement, m.__line
      $simetra$;"
    `)
  })

  it("periodic information register truncates period in project timezone", async () => {
    const withPrices = async (
      projectOverrides: Record<string, unknown>,
      period?: string
    ) => {
      const entries = sales(
        {},
        {
          attributes: [
            attribute("shippedAt", {
              type: "DateTime",
              physicalName: "shipped_at",
            }),
          ],
        },
        projectOverrides
      )
      const sale = entries[SALE_FILE] as Record<string, unknown>
      ;(sale.registerMovements as unknown[]).push({
        kind: "InformationRegister",
        name: "Prices",
      })
      saleMovements(entries).push({
        register: { kind: "InformationRegister", name: "Prices" },
        source: { tabularSection: "goods" },
        fields: { item: "row.item", price: "row.amount / row.qty" },
        ...(period !== undefined ? { period } : {}),
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
      const prices = (await units(entries)).find(
        (u) => u.name === "sale_prices_movements"
      )
      return prices!.sql
    }

    expect(await withPrices({}, "doc.shippedAt")).toContain(
      "date_trunc('month', d.shipped_at, 'UTC') AS period"
    )
    expect(await withPrices({ timezone: "Odd'Zone" })).toContain(
      "date_trunc('month', d.date, 'Odd''Zone')"
    )
    const kyiv = await withPrices({ timezone: "Europe/Kyiv" })
    expect(kyiv).toContain("date_trunc('month', d.date, 'Europe/Kyiv')")
    expect(await withPrices({})).toContain("date_trunc('month', d.date, 'UTC')")
    expect(kyiv).toMatchInlineSnapshot(`
      "CREATE OR REPLACE FUNCTION public.sale_prices_movements(p_document_id uuid)
      RETURNS TABLE (period timestamp with time zone, item_id uuid, price numeric(15,2))
      LANGUAGE sql STABLE
      AS $simetra$
      SELECT m.period, m.item_id, m.price
      FROM (
        SELECT date_trunc('month', d.date, 'Europe/Kyiv') AS period, r.item_id AS item_id, (r.amount)::numeric / r.qty AS price, 1 AS __movement, r.line_number AS __line
        FROM public.goods r
        JOIN public.sale d ON d.id = r.parent_id
        WHERE d.id = sale_prices_movements.p_document_id
      ) m
      ORDER BY m.__movement, m.__line
      $simetra$;"
    `)
  })

  it("units are sorted by schema and name", async () => {
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
    expect((await units(entries)).map((u) => [u.schema, u.name])).toEqual([
      ["public", "a_return_stock_movements"],
      ["public", "sale_stock_movements"],
    ])
  })

  it("scope carrier is not a result column", async () => {
    const entries = sales({}, { scope: "org" })
    ;(entries[STOCK_FILE] as Record<string, unknown>).scope = "org"
    entries["project.meta.json"] = scopedProject()
    entries["catalogs/Organization/Organization.meta.json"] = organization()
    entries["catalogs/Item/Item.meta.json"] = catalog("Item", { scope: "org" })
    const stock = (
      await compile(metaFiles(entries))
    ).model!.physical.tables.find((t) => t.name === "stock")
    expect(stock!.columns.map((c) => c.name)).toContain("org_id")
    const [unit] = await units(entries)
    expect(unit!.sql).toContain(
      "RETURNS TABLE (period timestamp with time zone, movement_type text, item_id uuid, qty numeric(15,3), note character varying(100))"
    )
    expect(unit!.sql).not.toContain("org_id")
  })

  it("singleton key is not a result column", async () => {
    const entries = sales()
    const sale = entries[SALE_FILE] as Record<string, unknown>
    ;(sale.registerMovements as unknown[]).push({
      kind: "InformationRegister",
      name: "Flags",
    })
    saleMovements(entries).push({
      register: { kind: "InformationRegister", name: "Flags" },
      source: "document",
      fields: { amount: "1" },
    })
    entries["information-registers/Flags/Flags.meta.json"] = {
      id: "00000000-0000-4000-8000-000000000903",
      kind: "InformationRegister",
      name: "Flags",
      physicalName: "flags",
      writeMode: "RecorderSubordinate",
      recorderTypes: [{ kind: "Document", name: "Sale" }],
      resources: [
        attribute("amount", { type: "Numeric", precision: 15, scale: 2 }),
      ],
    }
    const flags = (
      await compile(metaFiles(entries))
    ).model!.physical.tables.find((t) => t.name === "flags")
    expect(flags!.columns.map((c) => c.name)).toContain("singleton")
    const unit = (await units(entries)).find(
      (u) => u.name === "sale_flags_movements"
    )
    expect(unit!.sql).toContain("RETURNS TABLE (amount numeric(15,2))")
    expect(unit!.sql).not.toContain("singleton")
  })

  it("equality treats empty values as equal", async () => {
    const entries = sales(
      { condition: "row.note = doc.note and row.qty != 0" },
      {
        attributes: [attribute("note", { type: "String", length: 100 })],
      }
    )
    const goods = (
      entries[SALE_FILE] as { tabularSections: { attributes: unknown[] }[] }
    ).tabularSections[0]!
    goods.attributes.push(attribute("note", { type: "String", length: 100 }))
    const [unit] = await units(entries)
    expect(unit!.sql).toContain(
      "AND ((r.note IS NOT DISTINCT FROM d.note) AND (r.qty IS DISTINCT FROM 0))"
    )
  })

  it("comparison with null in condition and in a field value", async () => {
    const entries = sales({
      condition: "row.note != null",
      fields: { item: "row.item", qty: "row.qty", flag: "row.note = null" },
    })
    const goods = (
      entries[SALE_FILE] as { tabularSections: { attributes: unknown[] }[] }
    ).tabularSections[0]!
    goods.attributes.push(attribute("note", { type: "String", length: 100 }))
    ;(entries[STOCK_FILE] as { attributes: unknown[] }).attributes.push(
      attribute("flag", { type: "Boolean" })
    )
    const [unit] = await units(entries)
    expect(unit!.sql).toContain("AND (r.note IS DISTINCT FROM NULL)")
    expect(unit!.sql).toContain("r.note IS NOT DISTINCT FROM NULL AS flag")
  })

  it("omitted optional dimension is typed null", async () => {
    const entries = sales({ fields: { qty: "row.qty" } })
    const [unit] = await units(entries)
    expect(unit!.sql).toContain("NULL::uuid AS item_id")
  })

  it("top-level null field gives a typed NULL", async () => {
    const [unit] = await units(
      sales({ fields: { item: "row.item", qty: "row.qty", note: "null" } })
    )
    expect(unit!.sql).toContain("NULL::character varying(100) AS note")
  })

  it("movement type as an expression", async () => {
    const [unit] = await units(
      sales(
        { movementType: "doc.direction" },
        { attributes: [attribute("direction", { type: "String", length: 10 })] }
      )
    )
    expect(unit!.sql).toContain("d.direction AS movement_type")
  })

  it("snake_case project resolves standard attributes in its style", async () => {
    const [unit] = await units(
      sales(
        { condition: "row.line_number > 0 and not doc.deletion_mark" },
        {},
        { naming: { attributeCase: "snake_case" } }
      )
    )
    expect(unit!.sql).toContain(
      "AND ((r.line_number > 0) AND (NOT d.deletion_mark))"
    )
  })

  it("snake_case project leaves shell columns out of the result", async () => {
    // Колонки оболонки впізнаються за іменем у стилі проєкту: канонічне
    // camelCase-ім'я не збіглося б, і реєстратор потрапив би в результат.
    const [unit] = await units(
      sales({}, {}, { naming: { attributeCase: "snake_case" } })
    )
    expect(unit!.sql).toContain(
      "RETURNS TABLE (period timestamp with time zone, movement_type text, item_id uuid, qty numeric(15,3), note character varying(100))"
    )
  })

  describe("polymorphic register field", () => {
    /** `Stock` з поліморфним реквізитом `source` і рядок ТЧ з поліморфним `origin`. */
    const polymorphic = (
      movement: Record<string, unknown>,
      source: Record<string, unknown> = {}
    ) => {
      const entries = sales(movement)
      entries["catalogs/Service/Service.meta.json"] = catalog("Service")
      const allowedTypes = [
        { kind: "Catalog", name: "Item" },
        { kind: "Catalog", name: "Service" },
      ]
      ;(entries[STOCK_FILE] as { attributes: unknown[] }).attributes.push(
        attribute("source", {
          physicalName: "source",
          type: "Ref",
          allowedTypes,
          ...source,
        })
      )
      const goods = (
        entries[SALE_FILE] as { tabularSections: { attributes: unknown[] }[] }
      ).tabularSections[0]!
      goods.attributes.push(
        attribute("origin", {
          physicalName: "origin",
          type: "Ref",
          allowedTypes,
        })
      )
      return entries
    }
    const fields = (source: string) => ({
      fields: { item: "row.item", qty: "row.qty", source },
    })

    it("result has both pair columns", async () => {
      const [unit] = await units(polymorphic(fields("row.origin")))
      expect(unit!.sql).toContain(
        "note character varying(100), source_type text, source_id uuid)"
      )
    })

    it("single-target reference carries its discriminator", async () => {
      const [unit] = await units(polymorphic(fields("row.item")))
      expect(unit!.sql).toContain(
        "'item' AS source_type, r.item_id AS source_id"
      )
    })

    it("polymorphic value copies the pair", async () => {
      const [unit] = await units(polymorphic(fields("row.origin")))
      expect(unit!.sql).toContain(
        "r.origin_type AS source_type, r.origin_id AS source_id"
      )
    })

    it("null fills both columns of a nullable field", async () => {
      const [unit] = await units(polymorphic(fields("null")))
      expect(unit!.sql).toContain(
        "NULL::text AS source_type, NULL::uuid AS source_id"
      )
      const required = await compile(
        metaFiles(polymorphic(fields("null"), { required: true }))
      )
      expect(required.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
        ["posting.type-mismatch", "/posting/movements/0/fields/source"],
      ])
    })

    it("standard references carry the document as their discriminator", async () => {
      const withSale = { allowedTypes: [{ kind: "Document", name: "Sale" }] }
      const headerEntries = polymorphic(
        {
          source: "document",
          fields: { item: "doc.item", qty: "1", source: "doc.ref" },
        },
        withSale
      )
      ;(headerEntries[SALE_FILE] as { attributes?: unknown[] }).attributes = [
        attribute("item", {
          physicalName: "item_id",
          type: "Ref",
          ref: { kind: "Catalog", name: "Item" },
        }),
      ]
      const [header] = await units(headerEntries)
      expect(header!.sql).toContain("'sale' AS source_type, d.id AS source_id")
      const [row] = await units(polymorphic(fields("row.parent"), withSale))
      expect(row!.sql).toContain(
        "'sale' AS source_type, r.parent_id AS source_id"
      )
    })

    it("a one-target pair into a single-target field gives its id", async () => {
      const entries = sales({ fields: { item: "row.origin", qty: "row.qty" } })
      const goods = (
        entries[SALE_FILE] as { tabularSections: { attributes: unknown[] }[] }
      ).tabularSections[0]!
      goods.attributes.push(
        attribute("origin", {
          physicalName: "origin",
          type: "Ref",
          allowedTypes: [{ kind: "Catalog", name: "Item" }],
        })
      )
      const [unit] = await units(entries)
      expect(unit!.sql).toContain("r.origin_id AS item_id")
      expect(unit!.sql).not.toContain("origin_type AS")
    })

    it("comparison with null checks the id of the pair", async () => {
      const [unit] = await units(
        polymorphic({ condition: "row.origin = null or row.origin != null" })
      )
      expect(unit!.sql).toContain(
        "AND ((r.origin_id IS NOT DISTINCT FROM NULL) OR (r.origin_id IS DISTINCT FROM NULL))"
      )
    })
  })

  it("division is numeric even over integers", async () => {
    const entries = sales({
      fields: { item: "row.item", qty: "row.pieces / 2 + row.pieces / 4" },
    })
    const goods = (
      entries[SALE_FILE] as { tabularSections: { attributes: unknown[] }[] }
    ).tabularSections[0]!
    goods.attributes.push(attribute("pieces", { type: "Integer" }))
    const [unit] = await units(entries)
    // Цілочисельне ділення Postgres загубило б дріб, який стадія 4 уже
    // дозволила покласти в ресурс Numeric.
    expect(unit!.sql).toContain(
      "((r.pieces)::numeric / 2) + ((r.pieces)::numeric / 4) AS qty"
    )
  })

  describe("wrapper dollar-quote tag", () => {
    it("a constructor literal with the tag switches to a free one", async () => {
      const [unit, ...rest] = await units(
        sales({
          fields: {
            item: "row.item",
            qty: "row.qty",
            note: "'$simetra$; DROP TABLE x'",
          },
        })
      )
      expect(rest).toEqual([])
      expect(unit!.sql).toContain("AS $simetra_1$\n")
      expect(unit!.sql.endsWith("\n$simetra_1$;")).toBe(true)
      expect(unit!.sql).toContain("'$simetra$; DROP TABLE x' AS note")
      // Тег з'являється лише як відкривач і закривач обгортки.
      expect(unit!.sql.split("$simetra_1$")).toHaveLength(3)
    })

    it("a block with the tag compiles with the next free tag", async () => {
      const entries = salesDocument({}, { posting: undefined })
      const block = "SELECT $simetra$x$simetra$, $simetra_1$y$simetra_1$"
      const [unit] = await units({
        "project.meta.json": project(),
        ...entries,
        [SALE_SQL]: `-- @movements Stock\n${block}\n-- @end\n`,
      })
      expect(unit!.sql).toContain(`AS $simetra_2$\n${block}\n$simetra_2$;`)
    })
  })

  it("deterministic output", async () => {
    const entries = sales()
    const first = await units(entries)
    const second = await units(entries)
    expect(second.map((u) => u.sql)).toEqual(first.map((u) => u.sql))
  })
})
