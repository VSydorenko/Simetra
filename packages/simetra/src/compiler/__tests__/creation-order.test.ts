import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
import { KIND_REGISTRY } from "simetra/model"
import {
  catalog,
  customTable,
  metaFiles,
  project,
  salesDocument,
  uuid,
} from "./helpers"

const MISC = "sql/public/misc.sql"
const CODES = "custom-tables/Codes/Codes.meta.json"

/** Прийнята таблиця `public.codes` з колонками понад `id`. */
function codes(
  columns: Record<string, unknown>[],
  overrides: Record<string, unknown> = {}
) {
  return customTable("Codes", {
    columns: [
      { id: uuid(9001), name: "id", physicalName: "id", type: "UUID" },
      ...columns,
    ],
    ...overrides,
  })
}

// Лічильник, а не ознака імені: кожна колонка отримує свій id.
let nextColumnId = 9100
function column(name: string, overrides: Record<string, unknown>) {
  nextColumnId += 1
  return {
    id: uuid(nextColumnId),
    name,
    physicalName: name,
    type: "Text",
    ...overrides,
  }
}

async function compileWith(
  entries: Record<string, unknown>
): Promise<CompileResult> {
  return compile(metaFiles({ "project.meta.json": project(), ...entries }))
}

/** Порядок створення як рядки: таблиці й енам-типи з префіксом, одиниці — ідентичність. */
async function order(entries: Record<string, unknown>): Promise<string[]> {
  const result = await compileWith(entries)
  expect(result.diagnostics).toEqual([])
  return result.model!.creationOrder.map((node) =>
    node.type === "unit"
      ? node.identity
      : `${node.type}:${node.schema}.${node.name}`
  )
}

/** Кожна пара `[раніше, пізніше]` стоїть у порядку саме так. */
function expectBefore(list: string[], pairs: [string, string][]): void {
  for (const [first, second] of pairs) {
    expect(list).toContain(first)
    expect(list).toContain(second)
    expect(list.indexOf(first), `${first} before ${second}`).toBeLessThan(
      list.indexOf(second)
    )
  }
}

const PLPGSQL = "LANGUAGE plpgsql AS $$ begin return null; end $$"

describe("creation order", () => {
  it("custom table default calls a unit function", async () => {
    // Без ребра таблиця йшла б першою: таблиці передують одиницям у tie-break.
    const list = await order({
      [CODES]: codes([column("code", { default: "public.next_code()" })]),
      [MISC]: `CREATE FUNCTION public.next_code() RETURNS text ${PLPGSQL};`,
    })
    expect(list).toEqual(["function:public.next_code()", "table:public.codes"])
  })

  it("view after its tables and functions", async () => {
    // Схема `a` у tie-break іде раніше за `z`, тож без ребер в'юха стояла б
    // перед функціями, а таблиця, що чекає `z.next_code`, — після в'юхи.
    const list = await order({
      [CODES]: codes([column("code", { default: "z.next_code()" })]),
      [MISC]:
        "CREATE VIEW a.v AS SELECT z.g() AS g, c.code FROM public.codes c;\n" +
        `CREATE FUNCTION z.g() RETURNS text ${PLPGSQL};\n` +
        `CREATE FUNCTION z.next_code() RETURNS text ${PLPGSQL};`,
    })
    expectBefore(list, [
      ["function:z.next_code()", "table:public.codes"],
      ["table:public.codes", "view:a.v"],
      ["function:z.g()", "view:a.v"],
    ])
  })

  it("trigger after table and function", async () => {
    const list = await order({
      [CODES]: codes([column("code", { default: "z.next_code()" })]),
      [MISC]:
        "CREATE TRIGGER trg BEFORE INSERT ON public.codes FOR EACH ROW EXECUTE FUNCTION z.on_insert();\n" +
        `CREATE FUNCTION z.on_insert() RETURNS trigger ${PLPGSQL};\n` +
        `CREATE FUNCTION z.next_code() RETURNS text ${PLPGSQL};`,
    })
    expectBefore(list, [
      ["table:public.codes", "trigger:public.codes.trg"],
      ["function:z.on_insert()", "trigger:public.codes.trg"],
    ])
  })

  it("extensions come before everything", async () => {
    const list = await order({
      "pg-enums/Status/Status.meta.json": {
        id: uuid(9200),
        kind: "PgEnum",
        name: "Status",
        physicalName: "status",
        values: ["new", "done"],
      },
      [CODES]: codes([
        column("ref", {
          type: "UUID",
          default: "extensions.uuid_generate_v4()",
        }),
      ]),
      [MISC]: 'CREATE EXTENSION "uuid-ossp" SCHEMA extensions;',
    })
    expect(list).toEqual([
      "extension:uuid-ossp",
      "enumType:public.status",
      "table:public.codes",
    ])
  })

  it("domain and sequence before the table", async () => {
    const list = await order({
      [CODES]: codes([
        column("code", { type: "Raw", pgType: "z.code" }),
        column("num", { type: "BigInt", default: "nextval('z.s')" }),
      ]),
      [MISC]: "CREATE DOMAIN z.code AS text;\nCREATE SEQUENCE z.s;",
    })
    expect(list).toEqual([
      "domain:z.code",
      "sequence:z.s",
      "table:public.codes",
    ])
  })

  it("table default reading its own table through a sql function is a cycle", async () => {
    const result = await compileWith({
      [CODES]: codes([column("code", { default: "public.next_code()" })]),
      [MISC]:
        "CREATE FUNCTION public.next_code() RETURNS text LANGUAGE sql AS $$ select max(code) from public.codes $$;",
    })
    expect(result.ok).toBe(false)
    expect(result.model).toBeUndefined()
    const cycles = result.diagnostics.filter(
      (d) => d.code === "sql.dependency-cycle"
    )
    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toMatchObject({
      severity: "error",
      file: MISC,
      pointer: "",
      params: { identity: "function:public.next_code()" },
    })
    expect(cycles[0]!.params!.cycle).toContain("function:public.next_code()")
    expect(cycles[0]!.params!.cycle).toContain("table:public.codes")
  })

  it("cycle is reported", async () => {
    const result = await compileWith({
      [MISC]:
        "CREATE VIEW public.v AS SELECT public.f() AS x;\n" +
        "CREATE FUNCTION public.f() RETURNS bigint LANGUAGE sql AS $$ select count(*) from public.v $$;",
    })
    expect(result.ok).toBe(false)
    const cycles = result.diagnostics.filter(
      (d) => d.code === "sql.dependency-cycle"
    )
    expect(cycles).toHaveLength(1)
    // Pointer — перша одиниця циклу за порядком: функція раніше за в'юху.
    expect(cycles[0]).toMatchObject({
      file: MISC,
      pointer: "",
      // Рядок одиниці у файлі: функція — другий оператор.
      params: { identity: "function:public.f()", line: 2 },
    })
    expect(cycles[0]!.params!.cycle).toContain("function:public.f()")
    expect(cycles[0]!.params!.cycle).toContain("view:public.v")
  })

  it("plpgsql bodies are not analyzed", async () => {
    // Те саме читання, що в циклі вище, але в plpgsql: Postgres не перевіряє
    // тіло при створенні, тож циклу немає.
    const list = await order({
      [CODES]: codes([column("code", { default: "public.next_code()" })]),
      [MISC]:
        "CREATE FUNCTION public.next_code() RETURNS text LANGUAGE plpgsql AS $$ begin return (select max(code) from public.codes); end $$;",
    })
    expect(list).toEqual(["function:public.next_code()", "table:public.codes"])
  })

  it("mutual foreign keys between tables give no edge and no cycle", async () => {
    // FK поза порядком створення: рендер додає їх після всіх таблиць, тож
    // порядок — чистий tie-break. `B` посилається на `A`, `A` — на `B`.
    const entries = {
      "catalogs/B/B.meta.json": catalog("B", {
        attributes: [
          {
            id: uuid(9302),
            name: "a",
            physicalName: "a_id",
            type: "Ref",
            ref: { kind: "Catalog", name: "A" },
          },
        ],
      }),
      "catalogs/A/A.meta.json": catalog("A", {
        attributes: [
          {
            id: uuid(9301),
            name: "b",
            physicalName: "b_id",
            type: "Ref",
            ref: { kind: "Catalog", name: "B" },
          },
        ],
      }),
    }
    expect(await order(entries)).toEqual(["table:public.a", "table:public.b"])
  })

  it("self-referencing foreign key gives no edge and no cycle", async () => {
    const list = await order({
      "catalogs/Folder/Folder.meta.json": catalog("Folder", {
        hierarchyType: "FoldersAndItems",
      }),
    })
    expect(list).toEqual(["table:public.folder"])
  })

  it("foreign key does not order tables: tie-break alone decides", async () => {
    // `aaa` посилається на `zzz`, але стоїть першим: FK додає рендер окремо.
    const list = await order({
      "custom-tables/Aaa/Aaa.meta.json": customTable("Aaa", {
        columns: [
          { id: uuid(9401), name: "id", physicalName: "id", type: "UUID" },
          { id: uuid(9402), name: "zzz", physicalName: "zzz", type: "UUID" },
        ],
        foreignKeys: [
          {
            columns: ["zzz"],
            references: {
              object: { kind: "CustomTable", name: "Zzz" },
              columns: ["id"],
            },
          },
        ],
      }),
      "custom-tables/Zzz/Zzz.meta.json": customTable("Zzz", {
        primaryKey: { columns: ["id"] },
      }),
    })
    expect(list).toEqual(["table:public.aaa", "table:public.zzz"])
  })

  it("a CTE named like a model relation is not a reference to it", async () => {
    // Тіло `calc` читає власний CTE `balances`, а не в'юху `public.balances`.
    const list = await order({
      [MISC]:
        "CREATE VIEW public.balances AS SELECT * FROM public.calc();\n" +
        "CREATE FUNCTION public.calc() RETURNS TABLE (x int) LANGUAGE sql AS $$ " +
        "WITH balances AS (SELECT 1 AS x) " +
        "SELECT * FROM (WITH inner_cte AS (SELECT x FROM balances) SELECT x FROM inner_cte) s $$;",
    })
    expect(list).toEqual(["function:public.calc()", "view:public.balances"])
  })

  it("a CTE name does not hide a schema-qualified relation", async () => {
    const result = await compileWith({
      [MISC]:
        "CREATE VIEW public.balances AS SELECT * FROM public.calc();\n" +
        "CREATE FUNCTION public.calc() RETURNS TABLE (x int) LANGUAGE sql AS $$ " +
        "WITH balances AS (SELECT 1 AS x) SELECT 1 FROM public.balances $$;",
    })
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "sql.dependency-cycle",
    ])
  })

  it("policy after its table and expression functions", async () => {
    const list = await order({
      [CODES]: codes([column("code", { default: "z.next_code()" })]),
      [MISC]:
        "CREATE POLICY p ON public.codes FOR SELECT USING (z.can_read());\n" +
        `CREATE FUNCTION z.can_read() RETURNS boolean ${PLPGSQL};\n` +
        `CREATE FUNCTION z.next_code() RETURNS text ${PLPGSQL};`,
    })
    expectBefore(list, [
      ["table:public.codes", "policy:public.codes.p"],
      ["function:z.can_read()", "policy:public.codes.p"],
    ])
  })

  it("functions in CHECK, index predicate and index key go before the table", async () => {
    // Таблиці передують одиницям у tie-break: таблиця після функції — лише
    // через ребро.
    const table = (name: string, extra: Record<string, unknown>) =>
      customTable(name, {
        columns: [column("id", { type: "UUID" })],
        ...extra,
      })
    const list = await order({
      "custom-tables/Checked/Checked.meta.json": table("Checked", {
        checks: [{ name: "checked_ok", expression: "z.valid(id)" }],
      }),
      "custom-tables/Partial/Partial.meta.json": table("Partial", {
        indexes: [
          { name: "partial_idx", keys: [{ column: "id" }], where: "z.flag()" },
        ],
      }),
      "custom-tables/Expr/Expr.meta.json": table("Expr", {
        indexes: [{ name: "expr_idx", keys: [{ expression: "z.norm(id)" }] }],
      }),
      [MISC]:
        `CREATE FUNCTION z.valid(uuid) RETURNS boolean ${PLPGSQL};\n` +
        `CREATE FUNCTION z.flag() RETURNS boolean ${PLPGSQL};\n` +
        `CREATE FUNCTION z.norm(uuid) RETURNS text ${PLPGSQL};`,
    })
    expectBefore(list, [
      ["function:z.valid(uuid)", "table:public.checked"],
      ["function:z.flag()", "table:public.partial"],
      ["function:z.norm(uuid)", "table:public.expr"],
    ])
  })

  it("function in a generated column expression goes before the table", async () => {
    // Період номера — `date_trunc(...)` без схеми; одноіменна функція моделі
    // (некваліфіковане ім'я збігається в будь-якій схемі) мусить бути раніше.
    const list = await order({
      "documents/Invoice/Invoice.meta.json": {
        id: uuid(9700),
        kind: "Document",
        name: "Invoice",
        physicalName: "invoice",
        numberPeriodicity: "Year",
      },
      [MISC]: `CREATE FUNCTION z.date_trunc(text, timestamp) RETURNS timestamp ${PLPGSQL};`,
    })
    expectBefore(list, [
      [
        "function:z.date_trunc(text,pg_catalog.timestamp)",
        "table:public.invoice",
      ],
    ])
  })

  it("OWNED BY, REPLICA IDENTITY, publication and function settings after their objects", async () => {
    // `codes` чекає `z.next_code`; `b.reader` читає `codes`. Без ребер
    // одиниці схем `""`, `b` і `public` стояли б раніше за свої об'єкти.
    const list = await order({
      [CODES]: codes([column("code", { default: "z.next_code()" })]),
      [MISC]:
        "CREATE SEQUENCE public.s1 OWNED BY public.codes.code;\n" +
        "CREATE SEQUENCE public.s2;\n" +
        "ALTER SEQUENCE public.s2 OWNED BY public.codes.code;\n" +
        "ALTER TABLE public.codes REPLICA IDENTITY FULL;\n" +
        "ALTER PUBLICATION pub ADD TABLE public.codes;\n" +
        "ALTER FUNCTION b.reader() SET search_path = public;\n" +
        "CREATE FUNCTION b.reader() RETURNS text LANGUAGE sql AS $$ select max(code) from public.codes $$;\n" +
        `CREATE FUNCTION z.next_code() RETURNS text ${PLPGSQL};`,
    })
    expectBefore(list, [
      ["table:public.codes", "sequence:public.s1"],
      ["table:public.codes", "sequenceOwnedBy:public.s2"],
      ["sequence:public.s2", "sequenceOwnedBy:public.s2"],
      ["table:public.codes", "replicaIdentity:public.codes"],
      ["table:public.codes", "publication:pub:add:public.codes"],
      ["table:public.codes", "function:b.reader()"],
      ["function:b.reader()", "functionSettings:b.reader()"],
    ])
  })

  it("grants on all functions and sequences in a schema after them", async () => {
    const list = await order({
      [MISC]:
        "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA z TO anon;\n" +
        "GRANT USAGE ON ALL SEQUENCES IN SCHEMA z TO anon;\n" +
        "CREATE SEQUENCE z.s;\n" +
        `CREATE FUNCTION z.f() RETURNS text ${PLPGSQL};`,
    })
    const [functions, sequences] = [
      list.find((n) => n.startsWith("grant:grant:allInSchema.function:")),
      list.find((n) => n.startsWith("grant:grant:allInSchema.sequence:")),
    ]
    expectBefore(list, [
      ["function:z.f()", functions!],
      ["sequence:z.s", sequences!],
    ])
  })

  it("comment target is read from the parse tree, quoted dots included", async () => {
    const list = await order({
      [MISC]:
        "COMMENT ON COLUMN z.\"v.w\".x IS 'x';\n" +
        'CREATE VIEW z."v.w" AS SELECT 1 AS x;',
    })
    expectBefore(list, [["view:z.v.w", "comment:column:z.v.w.x"]])
  })

  it("grants and comments after their objects", async () => {
    // Схема гранту й коментаря порожня, тож без ребер вони йшли б раніше.
    const list = await order({
      [MISC]:
        "GRANT SELECT ON ALL TABLES IN SCHEMA z TO anon;\n" +
        "COMMENT ON COLUMN z.v.x IS 'x';\n" +
        "GRANT EXECUTE ON FUNCTION z.f() TO anon;\n" +
        "CREATE VIEW z.v AS SELECT 1 AS x;\n" +
        `CREATE FUNCTION z.f() RETURNS text ${PLPGSQL};`,
    })
    expectBefore(list, [
      ["view:z.v", "grant:grant:allInSchema.table:z:anon:select"],
      ["view:z.v", "comment:column:z.v.x"],
      ["function:z.f()", "grant:grant:function:z.f():anon:execute"],
    ])
  })

  it("deterministic regardless of map order", async () => {
    const entries: Record<string, unknown> = {
      ...salesDocument(),
      [CODES]: codes([column("code", { default: "z.next_code()" })]),
      [MISC]:
        "CREATE VIEW a.v AS SELECT * FROM public.codes;\n" +
        "GRANT SELECT ON a.v TO authenticated;\n" +
        `CREATE FUNCTION z.next_code() RETURNS text ${PLPGSQL};`,
    }
    const forward = await order(entries)
    const backward = await order(
      Object.fromEntries(Object.entries(entries).reverse())
    )
    expect(backward).toEqual(forward)
    // Обгортка запиту рухів — sql-функція: читає таблиці документа.
    const wrapper = forward.find((n) => n.startsWith("function:public.sale_"))
    expect(wrapper).toBeDefined()
    expectBefore(forward, [
      ["table:public.sale", wrapper!],
      ["table:public.goods", wrapper!],
      ["view:a.v", "grant:grant:table:a.v:authenticated:select"],
    ])
  })

  it("1C kinds have rls enabled, custom table off by default", async () => {
    const result = await compileWith({
      ...salesDocument(),
      [CODES]: codes([]),
      "custom-tables/Locked/Locked.meta.json": customTable("Locked", {
        rowLevelSecurity: "forced",
      }),
    })
    expect(result.diagnostics).toEqual([])
    const rls = Object.fromEntries(
      result.model!.physical.tables.map((t) => [t.name, t.rowLevelSecurity])
    )
    expect(rls).toEqual({
      codes: "off",
      item: "enabled",
      locked: "forced",
      sale: "enabled",
      goods: "enabled",
      stock: "enabled",
      stock_totals: "enabled",
      stock_turnovers_month: "enabled",
    })
  })

  it("rls is a registry fact of every derived table kind", () => {
    for (const def of Object.values(KIND_REGISTRY)) {
      const derivedTable = def.materializes === "table" && !def.declared
      expect(def.rowLevelSecurity, def.kind).toBe(
        derivedTable ? "enabled" : undefined
      )
    }
  })
})
