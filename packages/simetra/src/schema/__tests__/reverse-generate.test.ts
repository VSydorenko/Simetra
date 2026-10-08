import { beforeAll, describe, expect, it } from "vitest"
import {
  compile,
  loadSqlParser,
  readSqlUnits,
  type SchemaPathResolver,
  type SqlParser,
} from "simetra/compiler"
import {
  catalogFromSnapshot,
  customTableSchema,
  type AttributeCase,
  type DatabaseProvider,
  type CatalogColumn,
  type CatalogModel,
  type CatalogTable,
  type CatalogUnit,
} from "simetra/model"
import { reverseGenerate, type ReverseResult } from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
  uuid,
} from "../../compiler/__tests__/helpers"

/** Зворотний генератор (план E2b, задача 3): рішення плану 3–8. */

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

function counter(start = 900_000): () => string {
  let n = start
  return () => uuid(++n)
}

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

function options(
  existing: ReadonlyMap<string, string> = new Map(),
  overrides: {
    name?: string
    defaultSchema?: string
    attributeCase?: AttributeCase
    databaseProvider?: DatabaseProvider
  } = {}
) {
  return {
    project: {
      name: overrides.name ?? "App",
      defaultSchema: overrides.defaultSchema ?? "app",
      attributeCase: overrides.attributeCase ?? "snake_case",
      databaseProvider: overrides.databaseProvider ?? "supabase",
    },
    existing,
    newId: counter(),
    schemaPath,
    parse,
  }
}

const idColumn: CatalogColumn = { name: "id", type: "uuid", notNull: true }

function table(
  schema: string,
  name: string,
  overrides: Partial<CatalogTable> = {}
): CatalogTable {
  return {
    schema,
    name,
    rowLevelSecurity: "off",
    columns: [idColumn],
    primaryKey: { name: `${name}_pkey`, columns: ["id"] },
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
    ...overrides,
  }
}

/** Одиниці з тексту — тим самим класифікатором, що й extract. */
function units(sql: string): CatalogUnit[] {
  const read = readSqlUnits(
    [{ file: "x.sql", text: sql, schema: "" }],
    parse,
    []
  )
  expect(read.diagnostics).toEqual([])
  return read.units.map((u) => ({
    class: u.class,
    identity: u.identity,
    schema: u.schema,
    name: u.name,
    sql: u.sql,
  }))
}

function model(partial: Partial<CatalogModel>): CatalogModel {
  return { tables: [], enumTypes: [], units: [], ...partial }
}

type Json = Record<string, unknown>

function json(result: ReverseResult, path: string): Json {
  const text = result.files.get(path)
  expect(text, path).toBeDefined()
  return JSON.parse(text!) as Json
}

function withoutId(column: Json): Json {
  const copy = { ...column }
  delete copy.id
  return copy
}

const errors = (result: ReverseResult) =>
  result.diagnostics.filter((d) => d.severity === "error")

// Ім'я — те саме, що в `options`: розбіжність з ним — діагностика
const SNAKE_PROJECT = project({
  name: "App",
  defaultSchema: "app",
  naming: { attributeCase: "snake_case" },
})

const SUBSCRIPTION_FILE =
  "event-subscriptions/CurrencyTouch/CurrencyTouch.meta.json"

/**
 * Тека з довідником `Currency` — файлом виду 1С, який генератор не чіпає;
 * `extra` — інші збережені файли.
 */
function keptCatalog(extra: Record<string, unknown> = {}): Map<string, string> {
  return metaFiles({
    "project.meta.json": SNAKE_PROJECT,
    "catalogs/Currency/Currency.meta.json": catalog("Currency", {
      schema: "app",
    }),
    ...extra,
  })
}

const TOUCH = [
  "CREATE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;",
  "CREATE TRIGGER note_touch BEFORE UPDATE ON app.note FOR EACH ROW EXECUTE FUNCTION app.touch();",
].join("\n")

describe("reverseGenerate", () => {
  it("table becomes a CustomTable with explicit names", async () => {
    const result = await reverseGenerate(
      model({
        tables: [
          table("app", "service_order", {
            comment: "Orders",
            rowLevelSecurity: "enabled",
            columns: [
              idColumn,
              { name: "total_amount", type: "numeric(10,2)", notNull: false },
              {
                name: "line_no",
                type: "integer",
                notNull: true,
                identity: {
                  generation: "always",
                  sequence: "service_order_line_no_seq",
                },
              },
              { name: "point", type: "point", notNull: false },
            ],
            checks: [
              { name: "positive", expression: "(total_amount > (0)::numeric)" },
            ],
            uniques: [
              {
                name: "service_order_line_no_key",
                columns: ["line_no"],
                nullsNotDistinct: true,
              },
            ],
          }),
        ],
      }),
      options(new Map(), { attributeCase: "camelCase" })
    )
    expect(result.diagnostics).toEqual([])
    const data = json(
      result,
      "custom-tables/ServiceOrder/ServiceOrder.meta.json"
    )
    expect(data).toMatchObject({
      $schema:
        "schemas-of/custom-tables/ServiceOrder/ServiceOrder.meta.json/custom-tables.schema.json",
      kind: "CustomTable",
      name: "ServiceOrder",
      physicalName: "service_order",
      comment: "Orders",
      rowLevelSecurity: "enabled",
      primaryKey: { name: "service_order_pkey", columns: ["id"] },
      uniques: [
        {
          name: "service_order_line_no_key",
          columns: ["lineNo"],
          nullsNotDistinct: true,
        },
      ],
      checks: [
        { name: "positive", expression: "(total_amount > (0)::numeric)" },
      ],
    })
    // Схема проєкту — без поля `schema`
    expect(data.schema).toBeUndefined()
    const columns = data.columns as Json[]
    expect(columns.map(withoutId)).toEqual([
      { name: "id", physicalName: "id", notNull: true, type: "UUID" },
      {
        name: "totalAmount",
        physicalName: "total_amount",
        type: "Numeric",
        precision: 10,
        scale: 2,
      },
      {
        name: "lineNo",
        physicalName: "line_no",
        notNull: true,
        identity: "always",
        type: "Integer",
      },
      { name: "point", physicalName: "point", type: "Raw", pgType: "point" },
    ])
    expect(new Set([data.id, ...columns.map((c) => c.id)]).size).toBe(5)
    // Нова тека — повний файл проєкту
    expect(json(result, "project.meta.json")).toMatchObject({
      name: "App",
      defaultSchema: "app",
      database: { provider: "supabase" },
      naming: { attributeCase: "camelCase" },
    })
    expect(result.changes.map((c) => c.path)).toEqual([
      "custom-tables/ServiceOrder/ServiceOrder.meta.json",
      "project.meta.json",
      "sql-debt.json",
    ])
  })

  it("fk to a managed table uses an object ref, to auth.users external", async () => {
    const result = await reverseGenerate(
      model({
        tables: [
          table("app", "customer"),
          table("app", "sale", {
            columns: [
              idColumn,
              { name: "customer_id", type: "uuid", notNull: true },
              { name: "owner_id", type: "uuid", notNull: false },
            ],
            foreignKeys: [
              {
                name: "sale_customer_id_fkey",
                columns: ["customer_id"],
                references: {
                  schema: "app",
                  table: "customer",
                  columns: ["id"],
                },
                onDelete: "noAction",
                onUpdate: "noAction",
                deferrable: "no",
              },
              {
                name: "sale_owner_id_fkey",
                columns: ["owner_id"],
                references: { schema: "auth", table: "users", columns: ["id"] },
                onDelete: "cascade",
                onUpdate: "noAction",
                deferrable: "initiallyDeferred",
              },
            ],
          }),
        ],
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(
      json(result, "custom-tables/Sale/Sale.meta.json").foreignKeys
    ).toEqual([
      {
        name: "sale_customer_id_fkey",
        columns: ["customer_id"],
        references: {
          object: { kind: "CustomTable", name: "Customer" },
          columns: ["id"],
        },
      },
      {
        name: "sale_owner_id_fkey",
        columns: ["owner_id"],
        references: {
          external: { schema: "auth", table: "users", columns: ["id"] },
        },
        onDelete: "cascade",
        deferrable: "initiallyDeferred",
      },
    ])
  })

  it("enum column references the PgEnum by logical name", async () => {
    const result = await reverseGenerate(
      model({
        enumTypes: [
          { schema: "app", name: "order_status", values: ["new", "done"] },
        ],
        tables: [
          table("app", "sale", {
            columns: [
              idColumn,
              // format_type пише тип без схеми, коли схема в search_path
              { name: "status", type: "order_status", notNull: true },
              { name: "history", type: "app.order_status[]", notNull: false },
            ],
          }),
        ],
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(
      json(result, "pg-enums/OrderStatus/OrderStatus.meta.json")
    ).toMatchObject({
      kind: "PgEnum",
      name: "OrderStatus",
      physicalName: "order_status",
      values: ["new", "done"],
    })
    const sale = json(result, "custom-tables/Sale/Sale.meta.json")
    const columns = (sale.columns as Json[]).slice(1)
    expect(columns.map(withoutId)).toEqual([
      {
        name: "status",
        physicalName: "status",
        notNull: true,
        type: "PgEnum",
        enum: { kind: "PgEnum", name: "OrderStatus" },
      },
      {
        name: "history",
        physicalName: "history",
        type: "PgEnum",
        array: true,
        enum: { kind: "PgEnum", name: "OrderStatus" },
      },
    ])
    expect(customTableSchema.safeParse(sale).success).toBe(true)
    expect((await compile(result.files)).diagnostics).toEqual([])
  })

  it("trigger function used by one table goes to its sidecar before the trigger", async () => {
    const result = await reverseGenerate(
      model({ tables: [table("app", "note")], units: units(TOUCH) }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    const sql = result.files.get("custom-tables/Note/Note.sql")
    expect(sql).toBeDefined()
    expect(sql!.indexOf("CREATE FUNCTION app.touch()")).toBeGreaterThanOrEqual(
      0
    )
    expect(sql!.indexOf("CREATE FUNCTION")).toBeLessThan(
      sql!.indexOf("CREATE TRIGGER")
    )
    expect(
      [...result.files.keys()].filter((p) => p.startsWith("sql/"))
    ).toEqual([])
  })

  it("trigger function shared by two tables goes to sql/<schema>", async () => {
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note"), table("app", "memo")],
        units: units(
          `${TOUCH}\nCREATE TRIGGER memo_touch BEFORE UPDATE ON app.memo FOR EACH ROW EXECUTE FUNCTION app.touch();`
        ),
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(result.files.get("sql/app/touch.sql")).toContain(
      "CREATE FUNCTION app.touch()"
    )
    expect(result.files.get("custom-tables/Memo/Memo.sql")).toContain(
      "memo_touch"
    )
  })

  it("shared function goes to sql/<schema>/<name>__<args>.sql", async () => {
    const result = await reverseGenerate(
      model({
        units: units(
          "CREATE FUNCTION reports.add(a integer, b integer) RETURNS integer LANGUAGE sql AS $$ SELECT a + b $$;"
        ),
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(result.files.get("sql/reports/add__int4_int4.sql")).toBe(
      "CREATE FUNCTION reports.add(a integer, b integer) RETURNS integer LANGUAGE sql AS $$ SELECT a + b $$;\n"
    )
  })

  it("two grants on one object get distinct paths", async () => {
    const result = await reverseGenerate(
      model({
        units: units(
          [
            "CREATE FUNCTION app.add(a integer, b integer) RETURNS integer LANGUAGE sql AS $$ SELECT a + b $$;",
            "GRANT EXECUTE ON FUNCTION app.add(integer, integer) TO anon;",
            "GRANT EXECUTE ON FUNCTION app.add(integer, integer) TO authenticated;",
          ].join("\n")
        ),
      }),
      options()
    )
    expect(errors(result)).toEqual([])
    const grants = [...result.files.keys()].filter(
      (p) =>
        p.startsWith("sql/app/") && result.files.get(p)!.startsWith("GRANT")
    )
    expect(grants).toHaveLength(2)
    expect(new Set(grants).size).toBe(2)
  })

  it("grants and policies on a table go to its sidecar", async () => {
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note", { rowLevelSecurity: "enabled" })],
        units: units(
          [
            "GRANT SELECT ON TABLE app.note TO anon;",
            "CREATE POLICY note_read ON app.note FOR SELECT TO anon USING (true);",
            "ALTER TABLE app.note REPLICA IDENTITY FULL;",
          ].join("\n")
        ),
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    const sql = result.files.get("custom-tables/Note/Note.sql")!
    expect(sql).toContain("GRANT SELECT")
    expect(sql).toContain("CREATE POLICY note_read")
    expect(sql).toContain("REPLICA IDENTITY FULL")
  })

  it("a table revoke precedes a column grant in the sidecar", async () => {
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note")],
        units: units(
          "GRANT SELECT (id) ON TABLE app.note TO anon;\n" +
            "REVOKE ALL ON TABLE app.note FROM anon;"
        ),
      }),
      options()
    )
    const sql = result.files.get("custom-tables/Note/Note.sql")!
    expect(sql.indexOf("REVOKE")).toBeLessThan(sql.indexOf("GRANT"))
  })

  it("orders in two schemas get distinct names", async () => {
    const result = await reverseGenerate(
      model({ tables: [table("app", "orders"), table("reports", "orders")] }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(
      json(result, "custom-tables/AppOrders/AppOrders.meta.json")
    ).toMatchObject({
      physicalName: "orders",
    })
    expect(
      json(result, "custom-tables/ReportsOrders/ReportsOrders.meta.json")
    ).toMatchObject({
      schema: "reports",
      physicalName: "orders",
    })
  })

  it("names that collide in one schema get a numeric suffix", async () => {
    const result = await reverseGenerate(
      model({ tables: [table("app", "a_b"), table("app", "a__b")] }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(
      json(result, "custom-tables/AppAB/AppAB.meta.json").physicalName
    ).toBe("a__b")
    expect(
      json(result, "custom-tables/AppAB2/AppAB2.meta.json").physicalName
    ).toBe("a_b")
  })

  it("a physical name without a valid logical name is unrepresentable", async () => {
    const result = await reverseGenerate(
      model({
        tables: [
          table("app", "2fa_codes"),
          table("app", "note", {
            columns: [
              idColumn,
              { name: "Title", type: "text", notNull: false },
            ],
          }),
        ],
      }),
      options()
    )
    expect(errors(result).map((d) => [d.code, d.params?.object])).toEqual([
      ["introspect.unrepresentable", "app.2fa_codes"],
      ["introspect.unrepresentable", "app.note.Title"],
    ])
    expect(result.changes).toEqual([])
  })

  it("existing ids are kept by (kind, schema, physicalName)", async () => {
    const catalogModel = model({
      enumTypes: [{ schema: "app", name: "order_status", values: ["new"] }],
      tables: [table("app", "orders")],
      units: units(TOUCH.replaceAll("note", "orders")),
    })
    const first = await reverseGenerate(catalogModel, options())
    expect(first.diagnostics).toEqual([])
    const second = await reverseGenerate(catalogModel, {
      ...options(first.files),
      newId: counter(950_000),
    })
    expect(second.diagnostics).toEqual([])
    expect(second.changes).toEqual([])
    expect(second.files).toEqual(first.files)

    // Перейменований автором об'єкт лишається тим самим: ключ — фізичне ім'я
    const renamed = new Map(first.files)
    const orders = JSON.parse(
      renamed.get("custom-tables/Orders/Orders.meta.json")!
    ) as Json
    renamed.delete("custom-tables/Orders/Orders.meta.json")
    renamed.delete("custom-tables/Orders/Orders.sql")
    renamed.set(
      "custom-tables/Sale/Sale.meta.json",
      JSON.stringify({ ...orders, name: "Sale" })
    )
    const third = await reverseGenerate(catalogModel, {
      ...options(renamed),
      newId: counter(960_000),
    })
    expect(third.diagnostics).toEqual([])
    expect(json(third, "custom-tables/Sale/Sale.meta.json").id).toBe(orders.id)
    expect(third.files.has("custom-tables/Sale/Sale.sql")).toBe(true)
  })

  it("introspect keeps the existing kindLabel of a custom table", async () => {
    // Мітку призначено раз: інакше повторний introspect дав би
    // `identity.assigned-once-changed`.
    const catalogModel = model({ tables: [table("app", "note")] })
    const first = await reverseGenerate(catalogModel, options())
    expect(first.diagnostics).toEqual([])
    const path = "custom-tables/Note/Note.meta.json"
    const existing = new Map(first.files)
    existing.set(
      path,
      JSON.stringify({ ...json(first, path), kindLabel: "memo_note" })
    )
    const second = await reverseGenerate(catalogModel, {
      ...options(existing),
      newId: counter(950_000),
    })
    expect(second.diagnostics).toEqual([])
    expect(json(second, path).kindLabel).toBe("memo_note")
  })

  it("introspect labels a new custom table with a single uuid key the way fix does", async () => {
    const result = await reverseGenerate(
      model({
        tables: [
          table("app", "note"),
          table("app", "tag", {
            columns: [{ name: "tag", type: "text", notNull: true }],
            primaryKey: { name: "tag_pkey", columns: ["tag"] },
          }),
        ],
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(json(result, "custom-tables/Note/Note.meta.json").kindLabel).toBe(
      "note"
    )
    expect(json(result, "custom-tables/Tag/Tag.meta.json")).not.toHaveProperty(
      "kindLabel"
    )
  })

  it("id columns in many tables keep their own ids", async () => {
    const catalogModel = model({
      tables: [table("app", "a"), table("app", "b"), table("reports", "a")],
    })
    const first = await reverseGenerate(catalogModel, options())
    const columnId = (r: ReverseResult, path: string) =>
      (json(r, path).columns as Json[])[0]!.id
    const paths = [
      "custom-tables/AppA/AppA.meta.json",
      "custom-tables/B/B.meta.json",
      "custom-tables/ReportsA/ReportsA.meta.json",
    ]
    const ids = paths.map((p) => columnId(first, p))
    expect(new Set(ids).size).toBe(3)
    const second = await reverseGenerate(catalogModel, {
      ...options(first.files),
      newId: counter(950_000),
    })
    expect(paths.map((p) => columnId(second, p))).toEqual(ids)
    expect(second.changes).toEqual([])
  })

  it("a duplicate key in the existing folder is an identity conflict", async () => {
    const first = await reverseGenerate(
      model({ tables: [table("app", "orders")] }),
      options()
    )
    const existing = new Map(first.files)
    const orders = JSON.parse(
      existing.get("custom-tables/Orders/Orders.meta.json")!
    ) as Json
    existing.set(
      "custom-tables/Copy/Copy.meta.json",
      JSON.stringify({ ...orders, id: uuid(1), name: "Copy" })
    )
    const result = await reverseGenerate(
      model({ tables: [table("app", "orders")] }),
      options(existing)
    )
    expect(errors(result).map((d) => [d.code, d.file])).toEqual([
      ["introspect.identity-conflict", "custom-tables/Orders/Orders.meta.json"],
    ])
    expect(result.changes).toEqual([])
  })

  it("stale generated file is deleted, a 1C kind file is kept", async () => {
    const kept = keptCatalog()
    const compiled = await compile(kept)
    expect(compiled.diagnostics).toEqual([])
    const first = await reverseGenerate(
      model({
        tables: [table("app", "old")],
        units: units(
          "CREATE FUNCTION app.f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"
        ),
      }),
      options(kept)
    )
    expect(first.diagnostics).toEqual([])
    const existing = new Map(first.files)
    existing.set("custom-tables/Old/Old.module.ts", "export {}\n")

    // Таблиця довідника в базі описана його файлом, а не новою CustomTable
    const result = await reverseGenerate(
      model({
        tables: [
          ...catalogFromSnapshot(compiled.model!.physical).tables,
          table("app", "fresh"),
        ],
      }),
      options(existing)
    )
    expect(result.diagnostics).toEqual([])
    expect(result.changes.map((c) => [c.path, c.content === null])).toEqual([
      ["custom-tables/Fresh/Fresh.meta.json", false],
      ["custom-tables/Old/Old.meta.json", true],
      ["custom-tables/Old/Old.module.ts", true],
      // Борг зник разом зі своєю функцією: introspect переписує перелік цілим.
      ["sql-debt.json", false],
      ["sql/app/f.sql", true],
    ])
    expect(result.files.get("catalogs/Currency/Currency.meta.json")).toBe(
      kept.get("catalogs/Currency/Currency.meta.json")
    )
  })

  it("existing project file is not rewritten", async () => {
    const text =
      '{"name":"Mine","defaultSchema":"app","database":{"provider":"supabase"},"naming":{"attributeCase":"snake_case"},"title":{"uk":"Моє"}}'
    const existing = new Map([["project.meta.json", text]])
    const result = await reverseGenerate(
      model({ tables: [table("app", "note")] }),
      options(existing, { name: "Mine" })
    )
    expect(result.diagnostics).toEqual([])
    expect(result.files.get("project.meta.json")).toBe(text)
    expect(result.changes.map((c) => c.path)).toEqual([
      "custom-tables/Note/Note.meta.json",
      "sql-debt.json",
    ])

    const mismatch = await reverseGenerate(
      model({ tables: [table("public", "note")] }),
      options(existing, { name: "Mine", defaultSchema: "public" })
    )
    expect(errors(mismatch).map((d) => [d.code, d.pointer])).toEqual([
      ["introspect.project-mismatch", "/defaultSchema"],
    ])
    expect(mismatch.changes).toEqual([])

    // Стиль імен файлу проєкту теж діє мовчки лише тоді, коли збігається
    const style = await reverseGenerate(
      model({ tables: [table("app", "note")] }),
      options(existing, { name: "Mine", attributeCase: "camelCase" })
    )
    expect(errors(style).map((d) => [d.code, d.pointer])).toEqual([
      ["introspect.project-mismatch", "/naming/attributeCase"],
    ])

    // Явно назване інше ім'я проєкту так само не ігнорується мовчки
    const name = await reverseGenerate(
      model({ tables: [table("app", "note")] }),
      options(existing, { name: "Other" })
    )
    expect(errors(name).map((d) => [d.code, d.pointer])).toEqual([
      ["introspect.project-mismatch", "/name"],
    ])
    expect(name.changes).toEqual([])

    // Провайдер з виклику, відмінний від файлу проєкту, теж гучний. У переліку
    // лише одне значення, тож інше подаємо через `unknown`-приведення
    const provider = await reverseGenerate(
      model({ tables: [table("app", "note")] }),
      options(existing, {
        name: "Mine",
        databaseProvider: "other" as unknown as DatabaseProvider,
      })
    )
    expect(errors(provider).map((d) => [d.code, d.pointer])).toEqual([
      ["introspect.project-mismatch", "/database/provider"],
    ])
    expect(provider.changes).toEqual([])
  })

  it("default opclass, collation and deferrable are omitted", async () => {
    const result = await reverseGenerate(
      model({
        tables: [
          table("app", "note", {
            columns: [
              idColumn,
              {
                name: "title",
                type: "text",
                notNull: false,
                collation: { name: "C" },
              },
              {
                name: "body",
                type: "text",
                notNull: false,
                collation: { name: "default" },
              },
              { name: "code", type: "character varying(20)", notNull: false },
            ],
            uniques: [
              {
                name: "note_code_key",
                columns: ["code"],
                nullsNotDistinct: false,
                deferrable: "deferrable",
              },
            ],
            foreignKeys: [
              {
                name: "note_owner_fkey",
                columns: ["id"],
                references: { schema: "auth", table: "users", columns: ["id"] },
                onDelete: "noAction",
                onUpdate: "noAction",
                deferrable: "no",
              },
            ],
            indexes: [
              {
                name: "note_title_idx",
                unique: false,
                method: "btree",
                keys: [
                  {
                    column: "title",
                    opclass: { name: "text_ops" },
                    collation: { name: "C" },
                  },
                  { column: "code", opclass: { name: "text_ops" } },
                  {
                    column: "body",
                    opclass: { name: "text_pattern_ops" },
                    collation: { name: "C" },
                  },
                ],
                include: [],
                nullsNotDistinct: false,
              },
            ],
          }),
        ],
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    const data = json(result, "custom-tables/Note/Note.meta.json")
    expect((data.columns as Json[]).map((c) => c.collation)).toEqual([
      undefined,
      { name: "C" },
      undefined,
      undefined,
    ])
    expect(data.indexes).toEqual([
      {
        name: "note_title_idx",
        keys: [
          { column: "title" },
          { column: "code" },
          {
            column: "body",
            opclass: { name: "text_pattern_ops" },
            collation: { name: "C" },
          },
        ],
      },
    ])
    expect(data.uniques).toEqual([
      { name: "note_code_key", columns: ["code"], deferrable: "deferrable" },
    ])
    expect((data.foreignKeys as Json[])[0]).not.toHaveProperty("deferrable")
  })

  it("an unknown catalog field and a table without columns are unrepresentable", async () => {
    // Поле поза типом моделі каталогу (тут — уявна форма EXCLUDE; сам EXCLUDE
    // звітує extract) — гучна помилка, а не мовчки пропущене поле
    const withExclude = {
      ...table("app", "booking"),
      exclusions: [
        {
          name: "booking_no_overlap",
          definition: "EXCLUDE USING gist (during WITH &&)",
        },
      ],
    } as unknown as CatalogTable
    const result = await reverseGenerate(
      model({
        tables: [
          withExclude,
          table("app", "empty", { columns: [], primaryKey: undefined }),
        ],
      }),
      options()
    )
    expect(
      errors(result).map((d) => [d.code, d.params?.object, d.params?.property])
    ).toEqual([
      ["introspect.unrepresentable", "app.booking", "exclusions"],
      ["introspect.unrepresentable", "app.empty", "columns"],
    ])
    expect(result.changes).toEqual([])
  })

  it("an identity sequence name the compiler would not choose is unrepresentable", async () => {
    const result = await reverseGenerate(
      model({
        tables: [
          table("app", "note", {
            columns: [
              idColumn,
              {
                name: "n",
                type: "bigint",
                notNull: true,
                identity: { generation: "byDefault", sequence: "legacy_seq" },
              },
            ],
          }),
        ],
      }),
      options()
    )
    expect(
      errors(result).map((d) => [d.code, d.params?.object, d.params?.property])
    ).toEqual([
      ["introspect.unrepresentable", "app.note.n", "identity.sequence"],
    ])
    expect(result.changes).toEqual([])
  })

  it("fk to a kept 1C object uses an object ref", async () => {
    const kept = keptCatalog()
    const compiled = await compile(kept)
    expect(compiled.diagnostics).toEqual([])
    const result = await reverseGenerate(
      model({
        tables: [
          ...catalogFromSnapshot(compiled.model!.physical).tables,
          table("app", "price", {
            columns: [
              idColumn,
              { name: "currency_id", type: "uuid", notNull: true },
            ],
            foreignKeys: [
              {
                name: "price_currency_id_fkey",
                columns: ["currency_id"],
                references: {
                  schema: "app",
                  table: "currency",
                  columns: ["id"],
                },
                onDelete: "noAction",
                onUpdate: "noAction",
                deferrable: "no",
              },
            ],
          }),
        ],
      }),
      options(kept)
    )
    expect(result.diagnostics).toEqual([])
    expect(
      json(result, "custom-tables/Price/Price.meta.json").foreignKeys
    ).toEqual([
      {
        name: "price_currency_id_fkey",
        columns: ["currency_id"],
        references: {
          object: { kind: "Catalog", name: "Currency" },
          columns: ["ref"],
        },
      },
    ])
    const recompiled = await compile(result.files)
    expect(recompiled.diagnostics).toEqual([])
    expect(
      recompiled.model!.references.some(
        (r) => r.role === "customTable.foreignKey"
      )
    ).toBe(true)
  })

  it("fk to a tabular section of a kept 1C object is unrepresentable", async () => {
    // Таблиця ТЧ належить об'єкту, але власного `MetadataRef` не має
    const kept = metaFiles({
      "project.meta.json": SNAKE_PROJECT,
      "catalogs/Currency/Currency.meta.json": catalog("Currency", {
        schema: "app",
        tabularSections: [
          { id: uuid(9101), name: "rates", physicalName: "rates" },
        ],
      }),
    })
    const compiled = await compile(kept)
    expect(compiled.diagnostics).toEqual([])
    const rates = compiled.model!.physical.tables.find(
      (t) => t.origin.tabularSectionId !== undefined
    )!
    const result = await reverseGenerate(
      model({
        tables: [
          ...catalogFromSnapshot(compiled.model!.physical).tables,
          table("app", "quote", {
            columns: [
              idColumn,
              { name: "rate_id", type: "uuid", notNull: true },
            ],
            foreignKeys: [
              {
                name: "quote_rate_id_fkey",
                columns: ["rate_id"],
                references: {
                  schema: rates.schema,
                  table: rates.name,
                  columns: ["id"],
                },
                onDelete: "noAction",
                onUpdate: "noAction",
                deferrable: "no",
              },
            ],
          }),
        ],
      }),
      options(kept)
    )
    expect(
      errors(result).map((d) => [d.code, d.params?.object, d.params?.property])
    ).toEqual([
      [
        "introspect.unrepresentable",
        "app.quote.quote_rate_id_fkey",
        "references",
      ],
    ])
    expect(result.changes).toEqual([])
  })

  it("a trigger function also called from a kept file is shared", async () => {
    // Тригер довідника — підписка: модуль виду тригерів не приймає. Обробник
    // лежить у `sql/app/` попередньої генерації, тож теку можна скомпілювати.
    const touch = TOUCH.split("\n")[0]!.replace(
      "LANGUAGE plpgsql",
      "LANGUAGE plpgsql VOLATILE"
    )
    const kept = keptCatalog({
      [SUBSCRIPTION_FILE]: {
        id: uuid(990_001),
        kind: "EventSubscription",
        name: "CurrencyTouch",
        physicalName: "currency_touch",
        sources: [{ kind: "Catalog", name: "Currency" }],
        event: "beforeWrite",
        handler: { schema: "app", name: "touch" },
      },
      "sql/app/touch.sql": `${touch}\n`,
    })
    const compiled = await compile(kept)
    expect(compiled.diagnostics).toEqual([])
    const result = await reverseGenerate(
      model({
        tables: [
          ...catalogFromSnapshot(compiled.model!.physical).tables,
          table("app", "note"),
        ],
        units: units(
          `${touch}\nCREATE TRIGGER note_touch BEFORE UPDATE ON app.note FOR EACH ROW EXECUTE FUNCTION app.touch();`
        ),
      }),
      options(kept)
    )
    expect(result.diagnostics).toEqual([])
    expect(result.files.get("sql/app/touch.sql")).toContain(
      "CREATE FUNCTION app.touch()"
    )
    expect(result.files.get("custom-tables/Note/Note.sql")).not.toContain(
      "CREATE FUNCTION"
    )
    expect(result.files.get(SUBSCRIPTION_FILE)).toBe(
      kept.get(SUBSCRIPTION_FILE)
    )
  })

  it("settings and grants of an own trigger function follow it, an overload does not", async () => {
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note")],
        units: units(
          [
            TOUCH,
            "ALTER FUNCTION app.touch() SET search_path = '';",
            "GRANT EXECUTE ON FUNCTION app.touch() TO anon;",
            "CREATE FUNCTION app.touch(n integer) RETURNS integer LANGUAGE sql AS $$ SELECT n $$;",
            "GRANT EXECUTE ON FUNCTION app.touch(integer) TO anon;",
          ].join("\n")
        ),
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    const sidecar = result.files.get("custom-tables/Note/Note.sql")!
    expect(sidecar).toContain("ALTER FUNCTION app.touch() SET")
    expect(sidecar).toContain("GRANT EXECUTE ON FUNCTION app.touch() TO anon")
    expect(sidecar).not.toContain("touch(integer)")
    expect(sidecar.indexOf("CREATE FUNCTION")).toBeLessThan(
      sidecar.indexOf("ALTER FUNCTION")
    )
    const shared = [...result.files]
      .filter(([p]) => p.startsWith("sql/app/"))
      .map(([, t]) => t)
    expect(shared.some((t) => t.includes("app.touch(integer) TO anon"))).toBe(
      true
    )
    expect(shared.some((t) => t.includes("app.touch(n integer)"))).toBe(true)
  })

  it("an existing generated file without a physical name is reported", async () => {
    const existing = new Map([
      [
        "custom-tables/Note/Note.meta.json",
        JSON.stringify({
          id: uuid(7),
          kind: "CustomTable",
          name: "Note",
          columns: [{ id: uuid(8), name: "id", type: "UUID" }],
        }),
      ],
    ])
    const result = await reverseGenerate(
      model({ tables: [table("app", "note")] }),
      options(existing)
    )
    expect(errors(result).map((d) => [d.code, d.file])).toEqual([
      ["identity.physical-name-missing", "custom-tables/Note/Note.meta.json"],
    ])
    expect(result.changes).toEqual([])
  })

  it("final map compiles", async () => {
    const result = await reverseGenerate(
      model({
        enumTypes: [{ schema: "app", name: "status", values: ["a", "b"] }],
        tables: [
          table("app", "customer", {
            columns: [
              idColumn,
              { name: "state", type: "status", notNull: true },
            ],
            indexes: [
              {
                name: "customer_lower_idx",
                unique: true,
                method: "btree",
                keys: [{ expression: "lower((id)::text)" }],
                include: [],
                where: "(state = 'a'::app.status)",
                nullsNotDistinct: false,
              },
            ],
          }),
          table("reports", "customer", {
            primaryKey: undefined,
            foreignKeys: [
              {
                name: "customer_id_fkey",
                columns: ["id"],
                references: {
                  schema: "app",
                  table: "customer",
                  columns: ["id"],
                },
                onDelete: "cascade",
                onUpdate: "noAction",
                deferrable: "no",
              },
            ],
          }),
        ],
        units: units(
          [
            "CREATE VIEW reports.active AS SELECT id FROM app.customer;",
            "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
            "COMMENT ON VIEW reports.active IS 'Active';",
            "ALTER DEFAULT PRIVILEGES IN SCHEMA reports GRANT SELECT ON TABLES TO anon;",
            "CREATE SEQUENCE app.counter;",
            "ALTER SEQUENCE app.counter OWNED BY app.customer.id;",
          ].join("\n")
        ),
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    const compiled = await compile(result.files)
    expect(compiled.diagnostics).toEqual([])
    expect(compiled.ok).toBe(true)
    expect(
      result.files.get("custom-tables/AppCustomer/AppCustomer.sql")
    ).toContain("OWNED BY app.customer.id")
  })

  it("introspect writes the full debt list; a function in the shell is not debt", async () => {
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note")],
        units: units(
          [
            TOUCH,
            "CREATE POLICY note_read ON app.note USING (true);",
            "CREATE FUNCTION app.closed() RETURNS int LANGUAGE sql STABLE AS $$ SELECT 1 $$;",
          ].join("\n")
        ),
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    // Обробник без явної волатильності — поза оболонкою, тож теж борг.
    expect(json(result, "sql-debt.json")).toEqual({
      $schema: "schemas-of/sql-debt.json/sql-debt.schema.json",
      units: [
        "function:app.touch()",
        "policy:app.note.note_read",
        "trigger:app.note.note_touch",
      ],
    })
    expect(result.changes.map((c) => c.path)).toContain("sql-debt.json")
  })

  it("introspect writes an empty debt list too", async () => {
    const result = await reverseGenerate(
      model({ tables: [table("app", "note")] }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(json(result, "sql-debt.json").units).toEqual([])
  })
})
