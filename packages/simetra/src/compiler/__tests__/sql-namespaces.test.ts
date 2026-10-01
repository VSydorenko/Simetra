import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
import {
  catalog,
  customTable,
  metaFiles,
  project,
  salesDocument,
  uuid,
} from "./helpers"

const MISC = "sql/public/misc.sql"

/** Енам-тип моделі — прийнятий `PgEnum` (перерахування — мітки + CHECK). */
const PG_ENUM = {
  id: uuid(930),
  kind: "PgEnum",
  name: "Status",
  physicalName: "status",
  values: ["new", "done"],
}

async function compileSql(
  sql: string,
  extra: Record<string, unknown> = {}
): Promise<CompileResult> {
  return compile(
    metaFiles({ "project.meta.json": project(), [MISC]: sql, ...extra })
  )
}

/** Один конфлікт простору імен в одиниці файлу `MISC`. */
function conflict(params: Record<string, unknown>) {
  return expect.objectContaining({
    code: "sql.namespace-conflict",
    severity: "error",
    file: MISC,
    pointer: "",
    params: expect.objectContaining(params),
  })
}

// Спека П2 §8.3 «Простори імен Postgres»: різні класи з одним ключем у
// `pg_proc`, `pg_class` чи `pg_type` — конфлікт, який інакше впав би на
// `CREATE` у П3.
describe("postgres namespaces", () => {
  it("function and procedure with the same signature", async () => {
    const result = await compileSql(
      "CREATE FUNCTION public.f(a int) RETURNS int LANGUAGE sql AS $$ select 1 $$;\n" +
        "CREATE PROCEDURE f(b integer) LANGUAGE sql AS $$ select 1 $$;"
    )
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([
      conflict({
        identity: "procedure:public.f(int4)",
        line: 2,
        space: "proc",
        key: "public.f(int4)",
        other: "function:public.f(int4)",
      }),
    ])
    expect(result.diagnostics[0]!.message).toContain("pg_proc")
  })

  it("procedure with the movement wrapper signature", async () => {
    const result = await compileSql(
      "CREATE PROCEDURE public.sale_stock_movements(p uuid) LANGUAGE sql AS $$ select 1 $$;",
      salesDocument()
    )
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([
      conflict({
        identity: "procedure:public.sale_stock_movements(uuid)",
        line: 1,
        space: "proc",
        key: "public.sale_stock_movements(uuid)",
        other: "function:public.sale_stock_movements(uuid)",
      }),
    ])
  })

  it("aggregate and function", async () => {
    const result = await compileSql(
      "CREATE FUNCTION public.add(s int, v int) RETURNS int LANGUAGE sql AS $$ select s + v $$;\n" +
        "CREATE FUNCTION public.total(v int) RETURNS int LANGUAGE sql AS $$ select v $$;\n" +
        "CREATE AGGREGATE public.total(int) (sfunc = public.add, stype = int);"
    )
    expect(result.diagnostics).toEqual([
      conflict({
        identity: "aggregate:public.total(int4)",
        line: 3,
        space: "proc",
        key: "public.total(int4)",
        other: "function:public.total(int4)",
      }),
    ])
  })

  it("aggregate (*) takes the signature without arguments", async () => {
    const result = await compileSql(
      "CREATE FUNCTION public.inc(s int) RETURNS int LANGUAGE sql AS $$ select s + 1 $$;\n" +
        "CREATE AGGREGATE public.cnt(*) (sfunc = public.inc, stype = int);\n" +
        "CREATE FUNCTION public.cnt() RETURNS int LANGUAGE sql AS $$ select 0 $$;"
    )
    expect(result.diagnostics).toEqual([
      conflict({
        identity: "function:public.cnt()",
        line: 3,
        key: "public.cnt()",
        other: "aggregate:public.cnt(*)",
      }),
    ])
  })

  it.each([
    ["view", "CREATE VIEW item AS SELECT 1;", "view:public.item", "rel"],
    ["sequence", "CREATE SEQUENCE public.item;", "sequence:public.item", "rel"],
    ["domain", "CREATE DOMAIN item AS text;", "domain:public.item", "type"],
  ])(
    "model table and %s with the same name",
    async (_, sql, identity, space) => {
      const result = await compileSql(sql, {
        "catalogs/Item/Item.meta.json": catalog("Item"),
      })
      expect(result.ok).toBe(false)
      expect(result.diagnostics).toEqual([
        conflict({
          identity,
          line: 1,
          space,
          key: "public.item",
          other: "table:public.item",
        }),
      ])
    }
  )

  it("model table index and view with the same name", async () => {
    const result = await compileSql("CREATE VIEW item_pkey AS SELECT 1;", {
      "catalogs/Item/Item.meta.json": catalog("Item"),
    })
    expect(result.diagnostics).toEqual([
      conflict({
        identity: "view:public.item_pkey",
        space: "rel",
        key: "public.item_pkey",
        other: "table:public.item",
      }),
    ])
  })

  it("model enum type and domain with the same name", async () => {
    const result = await compileSql("CREATE DOMAIN status AS text;", {
      "pg-enums/Status/Status.meta.json": PG_ENUM,
    })
    expect(result.diagnostics).toEqual([
      conflict({
        identity: "domain:public.status",
        space: "type",
        key: "public.status",
        other: "enumType:public.status",
      }),
    ])
  })

  it("view and materialized view", async () => {
    const result = await compileSql(
      "CREATE VIEW v AS SELECT 1;\nCREATE MATERIALIZED VIEW public.v AS SELECT 2;"
    )
    // В'юха займає і `pg_class`, і `pg_type`, але конфлікт пари — один.
    expect(result.diagnostics).toEqual([
      conflict({
        identity: "materializedView:public.v",
        line: 2,
        space: "rel",
        key: "public.v",
        other: "view:public.v",
      }),
    ])
  })

  it("domain and view row type share pg_type", async () => {
    const result = await compileSql(
      "CREATE VIEW v AS SELECT 1;\nCREATE DOMAIN public.v AS text;"
    )
    expect(result.diagnostics).toEqual([
      conflict({
        identity: "domain:public.v",
        space: "type",
        key: "public.v",
        other: "view:public.v",
      }),
    ])
  })

  it("conflicts are reported in a stable order across files", async () => {
    const files = {
      "sql/public/b.sql":
        "CREATE PROCEDURE f(a int) LANGUAGE sql AS $$ select 1 $$;",
      "sql/public/a.sql":
        "CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
    }
    const result = await compile(
      metaFiles({ "project.meta.json": project(), ...files })
    )
    // Першою вважається одиниця, раніша за шляхом файлу.
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "sql.namespace-conflict",
        file: "sql/public/b.sql",
        params: expect.objectContaining({
          other: "function:public.f(int4)",
        }),
      }),
    ])
  })

  it("functions with different signatures are clean", async () => {
    const result = await compileSql(
      "CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $$ select 1 $$;\n" +
        "CREATE PROCEDURE f(a text) LANGUAGE sql AS $$ select 1 $$;\n" +
        "CREATE FUNCTION public.sale_stock_movements(p text) RETURNS int LANGUAGE sql AS $$ select 1 $$;",
      salesDocument()
    )
    expect(result.diagnostics).toEqual([])
  })

  it("the same name in different schemas is clean", async () => {
    const result = await compileSql(
      "CREATE VIEW other.item AS SELECT 1;\n" +
        "CREATE MATERIALIZED VIEW other.v AS SELECT 1;\n" +
        "CREATE VIEW v AS SELECT 2;\n" +
        "CREATE DOMAIN other.status AS text;",
      {
        "catalogs/Item/Item.meta.json": catalog("Item"),
        "pg-enums/Status/Status.meta.json": PG_ENUM,
      }
    )
    expect(result.diagnostics).toEqual([])
  })

  it("a function may share its name with a table", async () => {
    // `pg_proc` і `pg_class` — різні простори.
    const result = await compileSql(
      "CREATE FUNCTION item() RETURNS int LANGUAGE sql AS $$ select 1 $$;",
      { "catalogs/Item/Item.meta.json": catalog("Item") }
    )
    expect(result.diagnostics).toEqual([])
  })
})

// Явні імена індексів, первинних ключів і UNIQUE `CustomTable` займають
// `pg_class` схеми поряд із таблицями: збіг між об'єктами моделі — помилка
// стадії 4, а не «relation already exists» на DDL. Похідні імена обходять
// зайняті самі (`assignNames`).
describe("model relation names in pg_class", () => {
  const LOG = "custom-tables/Log/Log.meta.json"
  const AUDIT = "custom-tables/Audit/Audit.meta.json"
  const id = { id: uuid(940), name: "id", physicalName: "id", type: "UUID" }
  const indexed = (name: string) => ({
    indexes: [{ name, keys: [{ column: "id" }] }],
  })

  async function compileModel(entries: Record<string, unknown>) {
    return compile(metaFiles({ "project.meta.json": project(), ...entries }))
  }

  function duplicate(
    file: string,
    pointer: string,
    params: Record<string, unknown>
  ) {
    return expect.objectContaining({
      code: "physical.relation-duplicate",
      severity: "error",
      file,
      pointer,
      params: expect.objectContaining(params),
    })
  }

  it("two CustomTables with the same explicit index name", async () => {
    const result = await compileModel({
      [AUDIT]: customTable("Audit", indexed("shared_idx")),
      [LOG]: customTable("Log", indexed("shared_idx")),
    })
    expect(result.diagnostics).toEqual([
      duplicate(LOG, "/indexes/0/name", {
        name: "public.shared_idx",
        firstFile: AUDIT,
      }),
    ])
  })

  it("two indexes of one table with the same explicit name", async () => {
    const result = await compileModel({
      [LOG]: customTable("Log", {
        indexes: [
          { name: "log_idx", keys: [{ column: "id" }] },
          { name: "log_idx", keys: [{ expression: "(id)::text" }] },
        ],
      }),
    })
    expect(result.diagnostics).toEqual([
      duplicate(LOG, "/indexes/1/name", { name: "public.log_idx" }),
    ])
  })

  it("explicit index name equal to a catalog table name", async () => {
    const result = await compileModel({
      "catalogs/Item/Item.meta.json": catalog("Item"),
      [LOG]: customTable("Log", indexed("item")),
    })
    expect(result.diagnostics).toEqual([
      duplicate(LOG, "/indexes/0/name", {
        name: "public.item",
        firstFile: "catalogs/Item/Item.meta.json",
      }),
    ])
    expect(result.diagnostics[0]!.message).toContain("table")
  })

  it("explicit primary key and UNIQUE names take pg_class too", async () => {
    const result = await compileModel({
      [AUDIT]: customTable("Audit", {
        columns: [{ ...id, notNull: true }],
        primaryKey: { name: "audit_key", columns: ["id"] },
      }),
      [LOG]: customTable("Log", {
        uniques: [{ name: "audit_key", columns: ["id"] }],
        ...indexed("audit_key"),
      }),
    })
    expect(result.diagnostics).toEqual([
      duplicate(LOG, "/indexes/0/name", { name: "public.audit_key" }),
      duplicate(LOG, "/uniques/0/name", { name: "public.audit_key" }),
    ])
  })

  it("explicit index name equal to an enum type name is clean", async () => {
    // Індекс — у `pg_class`, енам-тип — у `pg_type`.
    const result = await compileModel({
      "pg-enums/Status/Status.meta.json": PG_ENUM,
      [LOG]: customTable("Log", indexed("status")),
    })
    expect(result.diagnostics).toEqual([])
  })
})
