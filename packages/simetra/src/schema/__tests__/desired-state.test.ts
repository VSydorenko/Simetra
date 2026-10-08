import { describe, expect, it } from "vitest"
import { compile, type SqlUnit } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  acceptDebt,
  attribute,
  catalog,
  metaFiles,
  project,
  salesDocument,
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

/** Предмет — порядок рендера одиниць, а не ратчет: увесь борг фікстури прийнято. */
async function render(entries: Record<string, unknown>) {
  const result = await compile(await acceptDebt(metaFiles(entries)))
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

  it("movement wrapper after its tables", async () => {
    const result = await compile(
      metaFiles({ "project.meta.json": project(), ...salesDocument() })
    )
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    const wrapper = model.sqlUnits.find((u) => u.class === "movementQuery")!
    expect(wrapper).toBeDefined()
    const state = renderDesiredState(model)
    const wrapperIndex = state.statements.findIndex(
      (s) => s.kind === "unit" && s.object === wrapper.identity
    )
    const tableIndexes = state.statements
      .map((s, i) => (s.kind === "table" ? i : -1))
      .filter((i) => i >= 0)
    expect(wrapperIndex).toBeGreaterThan(-1)
    // Обгортка читає таблиці регістра й документа: усі вони вже створені.
    for (const name of ["sale", "stock"]) {
      const at = state.statements.findIndex(
        (s) => s.kind === "table" && s.object.endsWith(`.${name}`)
      )
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(wrapperIndex)
    }
    expect(tableIndexes.length).toBeGreaterThan(1)
  })

  it("the platform layer: schema first, the identities foreign key among the last", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project({ defaultSchema: "app" }),
        "catalogs/Users/Users.meta.json": catalog("Users", {
          role: "users",
          scope: "none",
        }),
      })
    )
    expect(result.diagnostics).toEqual([])
    const state = renderDesiredState(result.model!)
    const all = labels(state)
    // Схему `simetra` створює той самий шар — першим оператором, до будь-якого
    // її об'єкта.
    const schema = all.indexOf("schema simetra")
    expect(schema).toBeGreaterThan(-1)
    expect(
      state.statements.findIndex(
        (s) => s.kind !== "schema" && s.sql.includes("simetra")
      )
    ).toBeGreaterThan(schema)
    const kinds = state.statements.map((s) => s.kind)
    const identitiesFk = all.indexOf("foreignKey simetra.identities")
    expect(identitiesFk).toBeGreaterThan(kinds.lastIndexOf("unit"))
    expect(identitiesFk).toBeGreaterThan(kinds.lastIndexOf("table"))
    expect(state.statements[identitiesFk]!.sql.replace(/\s+/g, " ")).toContain(
      "DEFERRABLE INITIALLY DEFERRED"
    )
  })

  it("a unit ending with a line comment still terminates", () => {
    const unit = (name: string, sql: string) =>
      ({
        class: "function",
        identity: `function:app.${name}()`,
        schema: "app",
        name,
        module: "m",
        sql,
      }) as SqlUnit
    const units = [
      unit("a", "select 1 -- note"),
      unit("b", "select 2 -- done;"),
      unit("c", "select 3"),
      unit("d", "select 4;"),
    ]
    const state = renderDesiredState({
      physical: { tables: [], enumTypes: [] },
      sqlUnits: units,
      creationOrder: units.map((u) => ({ type: "unit", identity: u.identity })),
    })
    expect(state.sql).toMatchInlineSnapshot(`
      "CREATE SCHEMA IF NOT EXISTS app;

      select 1 -- note
      ;

      select 2 -- done;
      ;

      select 3;

      select 4;"
    `)
  })

  it("map insertion order does not change the sql", async () => {
    const entries = domain(
      'CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;'
    )
    const reversed = Object.fromEntries(Object.entries(entries).reverse())
    expect((await render(reversed)).sql).toBe((await render(entries)).sql)
  })
})
