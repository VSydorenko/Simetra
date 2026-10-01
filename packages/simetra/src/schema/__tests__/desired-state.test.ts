import { describe, expect, it } from "vitest"
import { compile, type CompiledModel, type SqlUnit } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  attribute,
  catalog,
  metaFiles,
  project,
} from "../../compiler/__tests__/helpers"

const MISC = "sql/app/misc.sql"

function domain(extraSql = ""): Record<string, unknown> {
  return {
    "project.meta.json": project({ defaultSchema: "app" }),
    "catalogs/Item/Item.meta.json": catalog("Item", {
      attributes: [
        attribute("category", {
          physicalName: "category_id",
          type: "Ref",
          ref: { kind: "Catalog", name: "Category" },
        }),
      ],
    }),
    "catalogs/Category/Category.meta.json": catalog("Category", {
      attributes: [
        attribute("parentItem", {
          physicalName: "parent_item_id",
          type: "Ref",
          ref: { kind: "Catalog", name: "Item" },
        }),
      ],
    }),
    [MISC]: extraSql,
  }
}

async function render(entries: Record<string, unknown>) {
  const result = await compile(metaFiles(entries))
  expect(result.diagnostics).toEqual([])
  return renderDesiredState(result.model!)
}

const labels = (state: { statements: { kind: string; object: string }[] }) =>
  state.statements.map((s) => `${s.kind} ${s.object}`)

describe("renderDesiredState", () => {
  it("schemas first, then creation order, then foreign keys", async () => {
    const state = await render(domain())
    const kinds = state.statements.map((s) => s.kind)
    expect(kinds[0]).toBe("schema")
    const firstFk = kinds.indexOf("foreignKey")
    expect(firstFk).toBeGreaterThan(kinds.lastIndexOf("table"))
    expect(kinds.slice(firstFk).every((k) => k === "foreignKey")).toBe(true)
    expect(labels(state)).toMatchInlineSnapshot(`
      [
        "schema app",
        "table app.category",
        "index app.category_parent_item_id_idx",
        "index app.category_predefined_name_idx",
        "rowLevelSecurity app.category",
        "table app.item",
        "index app.item_category_id_idx",
        "index app.item_predefined_name_idx",
        "rowLevelSecurity app.item",
        "foreignKey app.category",
        "foreignKey app.item",
      ]
    `)
    expect(state.sql).toBe(state.statements.map((s) => s.sql).join("\n\n"))
  })

  it("extension unit before tables", async () => {
    const state = await render(
      domain('CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;')
    )
    const list = labels(state)
    // Схема `extensions` належить провайдеру: `CREATE SCHEMA` для неї не
    // емітується, а розширення стоїть перед таблицями.
    expect(list.filter((l) => l.startsWith("schema "))).toEqual(["schema app"])
    expect(list.indexOf("unit extension:uuid-ossp")).toBeGreaterThan(-1)
    expect(list.indexOf("unit extension:uuid-ossp")).toBeLessThan(
      list.findIndex((l) => l.startsWith("table "))
    )
    expect(state.sql).not.toContain("CREATE SCHEMA IF NOT EXISTS extensions")
    expect(state.sql).toContain(
      'CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;'
    )
  })

  it("provider schemas are not created", () => {
    const table = (schema: string, name: string): PhysicalTable => ({
      schema,
      name,
      origin: { objectId: "x" },
      rowLevelSecurity: "off",
      columns: [{ name: "id", type: "uuid", notNull: true, origin: {} }],
      uniques: [],
      checks: [],
      foreignKeys: [],
      indexes: [],
    })
    const names = [
      "public",
      "auth",
      "storage",
      "realtime",
      "extensions",
      "b",
      "a",
    ]
    const state = renderDesiredState({
      physical: { tables: names.map((s) => table(s, "t")), enumTypes: [] },
      sqlUnits: [],
      creationOrder: names.map((s) => ({
        type: "table",
        schema: s,
        name: "t",
      })),
    })
    expect(
      state.statements.filter((s) => s.kind === "schema").map((s) => s.sql)
    ).toEqual([
      "CREATE SCHEMA IF NOT EXISTS a;",
      "CREATE SCHEMA IF NOT EXISTS b;",
    ])
  })

  it("movement wrapper after its tables", () => {
    const table = (name: string): PhysicalTable => ({
      schema: "app",
      name,
      origin: { objectId: "x" },
      rowLevelSecurity: "off",
      columns: [{ name: "id", type: "uuid", notNull: true, origin: {} }],
      uniques: [],
      checks: [],
      foreignKeys: [],
      indexes: [],
    })
    const wrapper = {
      class: "movementQuery",
      identity: "movementQuery:app.sale_stock",
      schema: "app",
      name: "sale_stock",
      module: "m",
      sql: "CREATE FUNCTION app.sale_stock() RETURNS SETOF app.stock LANGUAGE sql AS $$ SELECT * FROM app.stock $$",
    } as SqlUnit
    const model: Pick<
      CompiledModel,
      "physical" | "sqlUnits" | "creationOrder"
    > = {
      physical: { tables: [table("sale"), table("stock")], enumTypes: [] },
      sqlUnits: [wrapper],
      creationOrder: [
        { type: "table", schema: "app", name: "sale" },
        { type: "table", schema: "app", name: "stock" },
        { type: "unit", identity: wrapper.identity },
      ],
    }
    const state = renderDesiredState(model)
    expect(labels(state)).toEqual([
      "schema app",
      "table app.sale",
      "table app.stock",
      "unit movementQuery:app.sale_stock",
    ])
    // Дослівна одиниця без `;` отримує її, щоб скрипт лишався виконуваним.
    expect(state.statements.at(-1)!.sql.endsWith("$$;")).toBe(true)
  })

  it("map insertion order does not change the sql", async () => {
    const entries = domain(
      'CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;'
    )
    const reversed = Object.fromEntries(Object.entries(entries).reverse())
    expect((await render(reversed)).sql).toBe((await render(entries)).sql)
  })
})
