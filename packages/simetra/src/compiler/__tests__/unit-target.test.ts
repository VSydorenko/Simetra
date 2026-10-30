import { beforeAll, describe, expect, it } from "vitest"
import {
  loadSqlParser,
  unitSubjectKeys,
  unitTarget,
  unitTargets,
  type SqlParser,
} from "simetra/compiler"
import type { SqlUnitClass } from "simetra/model"

/**
 * Структурована ціль одиниці (платформна спека §6.9): схема й об'єкт, на які
 * оператор діє, з дерева розбору, а не з тексту. Межа керування й діагностика
 * межі читають саме її.
 */

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const target = (cls: SqlUnitClass, sql: string, schema = "") =>
  unitTarget({ class: cls, schema, sql }, parse)
const targets = (cls: SqlUnitClass, sql: string, schema = "") =>
  unitTargets({ class: cls, schema, sql }, parse)

describe("unitTarget", () => {
  it("a grant on a table targets the table", () => {
    expect(target("grant", "GRANT SELECT ON reports.t TO anon")).toEqual({
      schema: "reports",
      object: "t",
      kind: "table",
    })
  })

  it("a grant on a function targets the function", () => {
    expect(
      target("grant", "GRANT EXECUTE ON FUNCTION app.f(uuid) TO anon")
    ).toEqual({ schema: "app", object: "f", kind: "function" })
  })

  it("a grant on a schema targets the schema", () => {
    expect(target("grant", "GRANT USAGE ON SCHEMA reports TO anon")).toEqual({
      schema: "reports",
      object: "reports",
      kind: "schema",
    })
  })

  it("a grant on objects of several schemas has one target per object", () => {
    expect(target("grant", "GRANT SELECT ON a.t, b.u TO anon")).toBeUndefined()
    expect(targets("grant", "GRANT SELECT ON a.t, b.u TO anon")).toEqual([
      { schema: "a", object: "t", kind: "table" },
      { schema: "b", object: "u", kind: "table" },
    ])
  })

  it("an unqualified target takes the schema of the unit", () => {
    expect(target("grant", "GRANT SELECT ON t TO anon")).toEqual({
      schema: "",
      object: "t",
      kind: "table",
    })
    expect(
      target(
        "policy",
        "CREATE POLICY p ON t FOR SELECT USING (true)",
        "reports"
      )
    ).toEqual({ schema: "reports", object: "t", kind: "table" })
  })

  it("a comment on a column, policy or trigger targets its table and keeps the member kind", () => {
    expect(target("comment", "COMMENT ON TABLE auth.users IS 'x'")).toEqual({
      schema: "auth",
      object: "users",
      kind: "table",
    })
    expect(
      target("comment", "COMMENT ON COLUMN auth.users.email IS 'x'")
    ).toEqual({ schema: "auth", object: "users", kind: "column" })
    expect(
      target("comment", "COMMENT ON POLICY p ON storage.objects IS 'x'")
    ).toEqual({ schema: "storage", object: "objects", kind: "policy" })
    expect(
      target("comment", "COMMENT ON TRIGGER t ON auth.users IS 'x'")
    ).toEqual({ schema: "auth", object: "users", kind: "trigger" })
    expect(target("comment", "COMMENT ON SCHEMA reports IS 'x'")).toEqual({
      schema: "reports",
      object: "reports",
      kind: "schema",
    })
    expect(target("comment", "COMMENT ON FUNCTION app.f(int) IS 'x'")).toEqual({
      schema: "app",
      object: "f",
      kind: "function",
    })
  })

  it("a policy and a trigger target their table", () => {
    expect(
      target(
        "policy",
        "CREATE POLICY p ON storage.objects FOR SELECT USING (true)",
        "storage"
      )
    ).toEqual({ schema: "storage", object: "objects", kind: "table" })
    expect(
      target(
        "trigger",
        "CREATE TRIGGER t AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION app.f()",
        "auth"
      )
    ).toEqual({ schema: "auth", object: "users", kind: "table" })
  })

  it("publication membership targets the tables and schemas", () => {
    expect(
      targets(
        "publication",
        "ALTER PUBLICATION supabase_realtime ADD TABLE app.t, TABLES IN SCHEMA reports"
      )
    ).toEqual([
      { schema: "app", object: "t", kind: "table" },
      { schema: "reports", object: "reports", kind: "schema" },
    ])
  })

  it("default privileges target the schemas of IN SCHEMA", () => {
    expect(
      targets(
        "defaultPrivileges",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA app, reports GRANT SELECT ON TABLES TO anon"
      )
    ).toEqual([
      { schema: "app", object: "app", kind: "schema" },
      { schema: "reports", object: "reports", kind: "schema" },
    ])
    expect(
      targets(
        "defaultPrivileges",
        "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO anon"
      )
    ).toEqual([])
  })

  it("a grant on all objects in a schema targets the schema", () => {
    for (const objects of ["TABLES", "FUNCTIONS", "SEQUENCES"]) {
      expect(
        targets(
          "grant",
          `GRANT SELECT ON ALL ${objects} IN SCHEMA simetra, app TO anon`,
          "public"
        ),
        objects
      ).toEqual([
        { schema: "simetra", object: "simetra", kind: "schema" },
        { schema: "app", object: "app", kind: "schema" },
      ])
    }
  })

  it("a unit that is its own object has no target", () => {
    expect(
      target("view", "CREATE VIEW app.v AS SELECT 1", "app")
    ).toBeUndefined()
  })
})

/**
 * Ключ предмета класу конверсії промоції (спека промоції §8): з класу,
 * цілей і імені одиниці; T2 зіставляє з ним одиниці, що зникли.
 */
describe("unitSubjectKeys", () => {
  const keys = (
    cls: SqlUnitClass,
    sql: string,
    name = "",
    schema = "",
    owner = "app"
  ) => unitSubjectKeys({ class: cls, schema, name, sql }, parse, owner)

  it("a policy and a trigger take the table and their own name", () => {
    expect(
      keys(
        "policy",
        "CREATE POLICY p_read ON app.items FOR SELECT USING (true)",
        "p_read",
        "app"
      )
    ).toEqual([
      { class: "policy", schema: "app", table: "items", name: "p_read" },
    ])
    expect(
      keys(
        "trigger",
        "CREATE TRIGGER t_touch BEFORE INSERT ON app.items FOR EACH ROW EXECUTE FUNCTION app.touch()",
        "t_touch",
        "app"
      )
    ).toEqual([
      { class: "trigger", schema: "app", table: "items", name: "t_touch" },
    ])
  })

  it("a grant is named by action, roles and privileges, not by its objects", () => {
    const table = keys(
      "grant",
      "GRANT SELECT, INSERT ON app.items TO authenticated, anon"
    )
    expect(table).toEqual([
      {
        class: "grant",
        schema: "app",
        table: "items",
        name: "grant:anon,authenticated:insert,select",
      },
    ])
    const column = keys("grant", "GRANT UPDATE (code) ON app.items TO anon")
    expect(column).toEqual([
      {
        class: "grant",
        schema: "app",
        table: "items",
        name: "grant:anon:update(code)",
      },
    ])
    // Два різні гранти на одну таблицю — різні ключі.
    expect(table[0]!.name).not.toBe(column[0]!.name)
    expect(keys("grant", "REVOKE SELECT ON app.items FROM anon")).toEqual([
      {
        class: "grant",
        schema: "app",
        table: "items",
        name: "revoke:anon:select",
      },
    ])
  })

  it("an unqualified grant of the compiler takes the owner schema", () => {
    expect(
      keys("grant", "GRANT SELECT ON items TO anon", "", "", "sales")
    ).toEqual([
      {
        class: "grant",
        schema: "sales",
        table: "items",
        name: "grant:anon:select",
      },
    ])
  })

  it("a grant on two tables gives two keys", () => {
    expect(
      keys("grant", "GRANT SELECT ON app.items, app.item_lines TO anon")
    ).toEqual([
      {
        class: "grant",
        schema: "app",
        table: "items",
        name: "grant:anon:select",
      },
      {
        class: "grant",
        schema: "app",
        table: "item_lines",
        name: "grant:anon:select",
      },
    ])
  })

  it("a comment is named by its column, or empty for the table", () => {
    expect(keys("comment", "COMMENT ON TABLE app.items IS 'Items'")).toEqual([
      { class: "comment", schema: "app", table: "items", name: "" },
    ])
    expect(
      keys("comment", "COMMENT ON COLUMN app.items.code IS 'Code'")
    ).toEqual([
      { class: "comment", schema: "app", table: "items", name: "code" },
    ])
  })

  it("a unit without a target is keyed by its own name", () => {
    expect(keys("view", "CREATE VIEW app.v AS SELECT 1", "v", "app")).toEqual([
      { class: "view", schema: "app", table: "", name: "v" },
    ])
  })
})
