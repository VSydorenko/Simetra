import { beforeAll, describe, expect, it } from "vitest"
import {
  loadSqlParser,
  unitTarget,
  unitTargets,
  type SqlParser,
} from "simetra/compiler"
import type { SqlUnitClass } from "simetra/model"

/**
 * Структурована ціль одиниці (план E2b, рішення 9): схема й об'єкт, на які
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
