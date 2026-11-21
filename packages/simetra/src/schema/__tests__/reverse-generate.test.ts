import { beforeAll, describe, expect, it } from "vitest"
import {
  authorTriggerName,
  compile,
  keyTriggerNames,
  loadSqlParser,
  platformBeforeTriggerName,
  readSqlUnits,
  renderModelIndependentLayer,
  rightsGuardNames,
  type SchemaPathResolver,
  type SqlParser,
  withoutLocations,
} from "simetra/compiler"
import {
  catalogFromSnapshot,
  customTableSchema,
  isObjectOrigin,
  type AttributeCase,
  type DatabaseProvider,
  type CatalogColumn,
  type CatalogModel,
  type CatalogTable,
  type CatalogUnit,
  type FunctionVolatility,
} from "simetra/model"
import {
  reverseGenerate,
  type ExecuteFacts,
  type ReverseResult,
} from "simetra/schema"
import {
  expectClean,
  catalog,
  metaFiles,
  project,
  salesDocument,
  uuid,
} from "../../compiler/__tests__/helpers"
import {
  COMMENT_FILE,
  authorCarrier,
  policyDomain,
  singleTenantRights,
  commandCoreLayer,
  writeRoles,
} from "../../compiler/__tests__/fixtures/rights"

/** Зворотний генератор (спека П2 §9). */

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
    reference?: CatalogModel
    executeFacts?: ExecuteFacts
  } = {}
) {
  return {
    ...(overrides.reference === undefined
      ? {}
      : { reference: overrides.reference }),
    ...(overrides.executeFacts === undefined
      ? {}
      : { executeFacts: overrides.executeFacts }),
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

/**
 * Еталон теки у формі каталогу (`reference`) без бази: тінь з бажаним станом
 * теки тут заступає її рендер, бо одиничний «каталог» тестів — теж текст
 * генератора. Розбіжність форм каталогу й генератора судять живі тести.
 */
async function renderedFolder(
  kept: ReadonlyMap<string, string>
): Promise<CatalogModel> {
  const compiled = await compile(kept)
  expect(compiled.model, "the kept folder compiles").toBeDefined()
  return {
    tables: catalogFromSnapshot(compiled.model!.physical).tables,
    enumTypes: [],
    units: compiled.model!.sqlUnits.map((u) => ({
      class: u.class,
      identity: u.identity,
      schema: u.schema,
      name: u.name,
      sql: u.sql,
    })),
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
/**
 * Волатильність функції, як її дає extract: факт каталогу, а текст без
 * волатильності — типова VOLATILE.
 */
function volatilityOf(sql: string): FunctionVolatility {
  const parsed = parse(sql)
  const stmt = parsed.ok ? parsed.statements[0]?.stmt : undefined
  const options =
    stmt !== undefined && "CreateFunctionStmt" in stmt
      ? (stmt.CreateFunctionStmt.options ?? [])
      : []
  for (const option of options) {
    if (!("DefElem" in option) || option.DefElem.defname !== "volatility")
      continue
    const arg = option.DefElem.arg
    if (arg !== undefined && "String" in arg)
      return arg.String.sval as FunctionVolatility
  }
  return "volatile"
}

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
    ...(u.class === "function" ? { volatility: volatilityOf(u.sql) } : {}),
  }))
}

/**
 * Факти `EXECUTE` definer-функцій, чий ACL — лише власник (плюс `granted`):
 * без факту definer-функція в теці — помилка, а не «без викликачів».
 */
function executeFacts(
  names: readonly string[],
  granted: Record<string, boolean> = {}
): ExecuteFacts {
  return {
    missingRoles: [],
    crossCheckFailures: [],
    catalogChanged: false,
    functions: names.map((qualifiedName) => {
      const [schema, name] = qualifiedName.split(".") as [string, string]
      return {
        schema,
        name,
        identityArguments: "",
        owner: "postgres",
        acl: [
          { grantee: "postgres", grantor: "postgres", grantable: false },
          ...Object.keys(granted).map((grantee) => ({
            grantee,
            grantor: "postgres",
            grantable: false,
          })),
        ],
        executeByRole: granted,
        schemaUsageByRole: Object.fromEntries(
          Object.keys(granted).map((role) => [role, true])
        ),
      }
    }),
  }
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

/**
 * Тригерна функція, що лишається боргом за будь-якої волатильності:
 * SECURITY DEFINER без `search_path` поза закритою оболонкою.
 */
const DEBT_TOUCH = TOUCH.replace(
  "LANGUAGE plpgsql",
  "LANGUAGE plpgsql SECURITY DEFINER"
)

describe("reverseGenerate", () => {
  it.each(["supabase", "postgres"] as const)(
    "%s: the signal outbox and its units are the platform's, adoption from scratch writes none of them",
    async (provider) => {
      // База, до якої застосовано Simetra, завжди несе outbox сигналів: прийом
      // з нуля не описує його теці (спека профілю `postgres` §5.1)
      const compiled = await compile(
        metaFiles({
          "project.meta.json": project({ database: { provider } }),
        })
      )
      expect(compiled.diagnostics).toEqual([])
      const outbox = compiled.model!.sqlUnits.filter(
        (u) => u.generator === "signalOutbox"
      )
      expect(outbox.length).toBeGreaterThan(0)
      const result = await reverseGenerate(
        model({
          tables: [
            ...catalogFromSnapshot(compiled.model!.physical).tables,
            table("app", "fresh"),
          ],
          units: units(outbox.map((u) => u.sql).join("\n")),
        }),
        options(new Map(), { databaseProvider: provider })
      )
      expect(result.diagnostics).toEqual([])
      expect([...result.files.keys()].sort()).toEqual([
        "custom-tables/Fresh/Fresh.meta.json",
        "project.meta.json",
        "sql-debt.json",
      ])
    }
  )

  it.each(["supabase", "postgres"] as const)(
    "%s: the platform install in the catalog's own grant form is the platform's; a user's grant beside it is written",
    async (provider) => {
      // Каталог тримає гранти по колонці й зливає привілеї однієї ролі: ці
      // одиниці не мають ідентичності одиниці компілятора, а належать
      // платформі за атомами власних грантів установки (напрям, ціль, роль,
      // привілей). Послідовність версій теж ставить платформа
      const install = await compile(
        metaFiles({ "project.meta.json": project({ database: { provider } }) })
      )
      expect(install.diagnostics).toEqual([])
      const catalogForm = [
        'GRANT INSERT ("method") ON TABLE "simetra"."signal_outbox" TO "simetra_command";',
        'GRANT INSERT ("payload") ON TABLE "simetra"."signal_outbox" TO "simetra_command";',
        'GRANT DELETE, SELECT ON TABLE "simetra"."signal_outbox" TO "simetra_signal_consumer";',
        'REVOKE EXECUTE ON FUNCTION "simetra"."signal_outbox_prune"(interval) FROM PUBLIC;',
        "CREATE SEQUENCE simetra.row_version AS bigint MINVALUE 1 NO CYCLE CACHE 1;",
      ].join("\n")
      const own =
        "GRANT SELECT ON TABLE simetra.signal_outbox, app.fresh TO simetra_command;"
      const result = await reverseGenerate(
        model({
          tables: [
            ...catalogFromSnapshot(install.model!.physical).tables,
            table("app", "fresh"),
          ],
          units: units(`${catalogForm}\n${own}`),
        }),
        options(new Map(), { databaseProvider: provider })
      )
      // Грант на об'єкт платформи разом з таблицею застосунку — не
      // платформний: його пише тека, а компіляція відмовляє за ціллю в
      // `simetra`. Більше тека з бази нічого не бере
      expect({
        files: [...result.files.keys()].sort(),
        codes: result.diagnostics.map((d) => d.code),
      }).toEqual({
        files: [
          "custom-tables/Fresh/Fresh.meta.json",
          "project.meta.json",
          "sql-debt.json",
          "sql/app/grant__table__app_fresh_simetra_signal_outbox__simetra_command__select.sql",
        ],
        codes: ["schema.reserved"],
      })
    }
  )

  it.each(["supabase", "postgres"] as const)(
    "%s: a grant on an install object the install does not give goes to the folder and is refused",
    async (provider) => {
      // Інша роль чи `PUBLIC` на таблиці outbox — чужий грант, а не
      // установка: його не губимо мовчки, тека отримує його, а компіляція
      // відмовляє за ціллю в `simetra`
      const install = await compile(
        metaFiles({ "project.meta.json": project({ database: { provider } }) })
      )
      expect(install.diagnostics).toEqual([])
      const result = await reverseGenerate(
        model({
          tables: catalogFromSnapshot(install.model!.physical).tables,
          units: units(
            [
              'GRANT SELECT ON TABLE "simetra"."signal_outbox" TO "some_extra_role";',
              'GRANT DELETE, INSERT, SELECT ON TABLE "simetra"."signal_outbox" TO PUBLIC;',
            ].join("\n")
          ),
        }),
        options(new Map(), { databaseProvider: provider })
      )
      expect({
        files: [...result.files.keys()].filter((p) => p.startsWith("sql/")),
        codes: result.diagnostics.map((d) => d.code),
      }).toEqual({
        files: [
          "sql/simetra/grant__table__simetra_signal_outbox__public__delete_insert_select.sql",
          "sql/simetra/grant__table__simetra_signal_outbox__some_extra_role__select.sql",
        ],
        codes: ["schema.reserved", "schema.reserved"],
      })
      expect(result.changes).toEqual([])
    }
  )

  it.each(["supabase", "postgres"] as const)(
    "%s: a grant on the outbox prune function to another role goes to the folder and is refused",
    async (provider) => {
      // Ціль гранту — функція установки, але роль і привілей не її (И2):
      // за вмістом це не платформне, тож тека отримує грант, а компіляція
      // відмовляє за ціллю в `simetra`
      const install = await compile(
        metaFiles({ "project.meta.json": project({ database: { provider } }) })
      )
      expect(install.diagnostics).toEqual([])
      const result = await reverseGenerate(
        model({
          tables: catalogFromSnapshot(install.model!.physical).tables,
          units: units(
            'GRANT EXECUTE ON FUNCTION "simetra"."signal_outbox_prune"(interval) TO "some_extra_role";'
          ),
        }),
        options(new Map(), { databaseProvider: provider })
      )
      const file =
        "sql/simetra/grant__function__simetra_signal_outbox_prune_interval__some_extra_role__execute.sql"
      expect({
        files: [...result.files.keys()].filter((p) => p.startsWith("sql/")),
        diagnostics: result.diagnostics.map((d) => [d.code, d.file]),
      }).toEqual({
        files: [file],
        diagnostics: [["schema.reserved", file]],
      })
    }
  )

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

  // Ідентичність функції з ім'ям у верхньому регістрі — у лапках: сирий
  // шаблон `function:app.Touch()` не впізнав би власну тригерну функцію
  it("trigger function with a name that needs quotes goes to the sidecar", async () => {
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note")],
        units: units(
          [
            'CREATE FUNCTION app."Touch"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;',
            'CREATE TRIGGER note_touch BEFORE UPDATE ON app.note FOR EACH ROW EXECUTE FUNCTION app."Touch"();',
          ].join("\n")
        ),
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(result.files.get("custom-tables/Note/Note.sql")).toContain(
      'CREATE FUNCTION app."Touch"()'
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
      "CREATE FUNCTION reports.add(a integer, b integer) RETURNS integer VOLATILE LANGUAGE sql AS $$ SELECT a + b $$;\n"
    )
  })

  // Сира кома розрізала б `"x,"` на `app."x` і `"`, і порожній сегмент
  // дав би зайве `_`
  it.each([
    ['app."x,y"', "sql/app/f__app_x_y.sql"],
    ['app."x,"', "sql/app/f__app_x.sql"],
  ])(
    "a quoted argument type %s with a comma is one argument in the file name",
    async (type, path) => {
      const result = await reverseGenerate(
        model({
          units: units(
            `CREATE FUNCTION app.f(a ${type}) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;`
          ),
        }),
        options()
      )
      expect(errors(result)).toEqual([])
      expect(
        [...result.files.keys()].filter((p) => p.startsWith("sql/"))
      ).toEqual([path])
    }
  )

  // Перевантаження, що різняться лише межею лапок, мають різні ідентичності,
  // але один `slug`: гучна колізія шляху, а не тихий перезапис файлу
  it("overloads that differ only in the quote boundary collide loudly", async () => {
    const result = await reverseGenerate(
      model({
        units: units(
          [
            'CREATE FUNCTION app.f(a app."x,y") RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;',
            "CREATE FUNCTION app.f(a app.x, b y) RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$;",
          ].join("\n")
        ),
      }),
      options()
    )
    expect(
      result.diagnostics.map((d) => [d.code, d.params?.path])
    ).toContainEqual(["introspect.path-collision", "sql/app/f__app_x_y.sql"])
    expect(result.files.has("sql/app/f__app_x_y.sql")).toBe(false)
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
          // Борг — завдяки `SECURITY DEFINER` поза оболонкою; без `EXECUTE`
          // для ролей API, інакше її відмовила б перевірка викликача.
          "CREATE FUNCTION app.f() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;\n" +
            "REVOKE EXECUTE ON FUNCTION app.f() FROM PUBLIC, authenticated, anon;"
        ),
      }),
      options(kept, { executeFacts: executeFacts(["app.f"]) })
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
      [
        "sql/app/grant__revoke__function__app_f__anon_authenticated_public__execute.sql",
        true,
      ],
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
          key: "ref",
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

  // FK на таблицю виду пишеться формою ключа (спека прав §4.7); пара колонок поза
  // складеним ключем цілі (інший порядок, не ключ) — невиражена.
  it.each([
    [["org_id", "id"], { key: "scopedRef" }],
    [["id"], { key: "ref" }],
    [["id", "org_id"], undefined],
  ])("fk to a scoped kept object on %j", async (target, expected) => {
    const kept = metaFiles({
      "project.meta.json": project({
        name: "App",
        defaultSchema: "app",
        naming: { attributeCase: "snake_case" },
        scopeKinds: [
          {
            id: uuid(9411),
            name: "org",
            physicalName: "org_id",
            root: { object: { kind: "Catalog", name: "Organization" } },
            setFunction: { name: "my_orgs" },
          },
        ],
      }),
      "catalogs/Organization/Organization.meta.json": catalog("Organization", {
        schema: "app",
        scope: "org",
      }),
      "catalogs/Currency/Currency.meta.json": catalog("Currency", {
        schema: "app",
        scope: "org",
      }),
    })
    const compiled = await compile(kept)
    expectClean(compiled, { allow: ["rights.scope-kind-unread"] })
    const local = target.map((c) => (c === "id" ? "currency_id" : c))
    const result = await reverseGenerate(
      model({
        tables: [
          ...catalogFromSnapshot(compiled.model!.physical).tables,
          table("app", "price", {
            columns: [
              idColumn,
              { name: "org_id", type: "uuid", notNull: true },
              { name: "currency_id", type: "uuid", notNull: true },
            ],
            foreignKeys: [
              {
                name: "price_currency_fkey",
                columns: local,
                references: {
                  schema: "app",
                  table: "currency",
                  columns: target,
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
    const unrepresentable = result.diagnostics
      .filter((d) => d.code === "introspect.unrepresentable")
      .map((d) => d.params?.property)
    if (expected === undefined) {
      expect(unrepresentable).toEqual(["references"])
      return
    }
    expect(unrepresentable).toEqual([])
    expect(
      json(result, "custom-tables/Price/Price.meta.json").foreignKeys
    ).toEqual([
      {
        name: "price_currency_fkey",
        columns: local,
        references: {
          object: { kind: "Catalog", name: "Currency" },
          ...expected,
        },
      },
    ])
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
      (t) => isObjectOrigin(t.origin) && t.origin.tabularSectionId !== undefined
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
    // Обробник — з порожнім `search_path` (спека прав §5.3).
    const touch = TOUCH.split("\n")[0]!.replace(
      "LANGUAGE plpgsql",
      "LANGUAGE plpgsql VOLATILE SET search_path = ''"
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

  it("a subscription handler re-introspected from catalog text stays closed and is not debt", async () => {
    // Текст каталогу (`pg_get_functiondef`) типової VOLATILE не друкує;
    // волатильність — факт, тож обробник після introspect лишається закритим.
    // Обробник — з порожнім `search_path` (спека прав §5.3).
    const catalogText = TOUCH.split("\n")[0]!.replace(
      "LANGUAGE plpgsql",
      "LANGUAGE plpgsql SET search_path = ''"
    )
    const handler = catalogText.replace(
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
      "sql/app/touch.sql": `${handler}\n`,
    })
    const compiled = await compile(kept)
    expect(compiled.diagnostics).toEqual([])
    const result = await reverseGenerate(
      model({
        tables: catalogFromSnapshot(compiled.model!.physical).tables,
        units: units(catalogText),
      }),
      options(kept)
    )
    expect(result.diagnostics).toEqual([])
    expect(result.files.get("sql/app/touch.sql")).toBe(
      "CREATE FUNCTION app.touch() RETURNS trigger VOLATILE LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN RETURN NEW; END $$;\n"
    )
    expect(json(result, "sql-debt.json").units).toEqual([])
    expect((await compile(result.files)).diagnostics).toEqual([])
  })

  describe("volatility comes from the catalog fact", () => {
    const fn = (name: string, volatility = "") =>
      `CREATE FUNCTION app.${name}() RETURNS integer LANGUAGE sql${volatility} AS $$ SELECT 1 $$;`

    it("a function without a volatility clause gets VOLATILE; STABLE and IMMUTABLE stay", async () => {
      const result = await reverseGenerate(
        model({
          units: units(
            [fn("v"), fn("s", " STABLE"), fn("i", " IMMUTABLE")].join("\n")
          ),
        }),
        options()
      )
      expect(result.diagnostics).toEqual([])
      expect(result.files.get("sql/app/v.sql")).toBe(
        "CREATE FUNCTION app.v() RETURNS integer VOLATILE LANGUAGE sql AS $$ SELECT 1 $$;\n"
      )
      expect(result.files.get("sql/app/s.sql")).toBe(`${fn("s", " STABLE")}\n`)
      expect(result.files.get("sql/app/i.sql")).toBe(
        `${fn("i", " IMMUTABLE")}\n`
      )
    })

    it("the keyword is the fact, not a default", async () => {
      const [unit] = units(fn("s"))
      const result = await reverseGenerate(
        model({ units: [{ ...unit!, volatility: "stable" }] }),
        options()
      )
      expect(result.diagnostics).toEqual([])
      expect(result.files.get("sql/app/s.sql")).toBe(
        "CREATE FUNCTION app.s() RETURNS integer STABLE LANGUAGE sql AS $$ SELECT 1 $$;\n"
      )
    })

    // Тіло SQL-стандарту друкується після опцій: вставка слова зсуває його
    // позиції, а зміст лишається тим самим
    it.each([
      ["r", "CREATE FUNCTION app.r() RETURNS integer LANGUAGE sql RETURN 1;"],
      [
        "atomic",
        "CREATE FUNCTION app.atomic() RETURNS integer LANGUAGE sql BEGIN ATOMIC SELECT 1; END;",
      ],
    ])(
      "a SQL-standard body (app.%s) gets VOLATILE and keeps its body",
      async (name, sql) => {
        const [unit] = units(sql)
        const result = await reverseGenerate(
          model({ units: [{ ...unit!, volatility: "volatile" }] }),
          options()
        )
        expect(result.diagnostics).toEqual([])
        const text = result.files.get(`sql/app/${name}.sql`)
        expect(text).toContain(" VOLATILE LANGUAGE sql ")
        const body = (source: string) => {
          const parsed = parse(source)
          const stmt = parsed.ok ? parsed.statements[0]?.stmt : undefined
          return stmt !== undefined && "CreateFunctionStmt" in stmt
            ? withoutLocations(stmt.CreateFunctionStmt.sql_body)
            : undefined
        }
        expect(body(text!)).toBeDefined()
        expect(body(text!)).toEqual(body(sql))
      }
    )

    it("a procedure is untouched", async () => {
      const procedure =
        "CREATE PROCEDURE app.p() LANGUAGE sql AS $$ SELECT 1 $$;"
      const result = await reverseGenerate(
        model({ units: units(procedure) }),
        options()
      )
      expect(result.diagnostics).toEqual([])
      expect(result.files.get("sql/app/p.sql")).toBe(`${procedure}\n`)
    })
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

  it("introspect over a deployed platform layer writes nothing for simetra", async () => {
    // Шар — частина моделі «Користувачів»: його таблиця й одиниці описані
    // збереженим файлом довідника, тож генератор їх не розкладає вдруге.
    const kept = metaFiles({
      "project.meta.json": SNAKE_PROJECT,
      "catalogs/Users/Users.meta.json": catalog("Users", {
        schema: "app",
        role: "users",
        scope: "none",
      }),
    })
    const compiled = await compile(kept)
    expect(compiled.diagnostics).toEqual([])
    const layer = compiled.model!
    expect(layer.sqlUnits.some((u) => u.schema === "simetra")).toBe(true)
    const result = await reverseGenerate(
      model({
        tables: catalogFromSnapshot(layer.physical).tables,
        units: layer.sqlUnits.map((u) => ({
          class: u.class,
          identity: u.identity,
          schema: u.schema,
          name: u.name,
          sql: u.sql,
        })),
      }),
      options(kept, { reference: await renderedFolder(kept) })
    )
    expect(result.diagnostics).toEqual([])
    // Лише перелік боргу (теки без нього introspect пише завжди) — і він
    // порожній: жодна одиниця шару не стала дослівним SQL.
    expect(result.changes.map((c) => c.path)).toEqual(["sql-debt.json"])
    expect(json(result, "sql-debt.json").units).toEqual([])
  })

  it("the folder reference wins over the install on the same identity", async () => {
    // Еталон теки задано вручну: одиниця під ідентичністю, яка є й в установці,
    // має інший вміст. Каталог дорівнює формі теки — одиниця платформна лише
    // тоді, коли одиниці теки стоять у еталоні останніми
    const kept = metaFiles({
      "project.meta.json": SNAKE_PROJECT,
      "catalogs/Users/Users.meta.json": catalog("Users", {
        schema: "app",
        role: "users",
        scope: "none",
      }),
    })
    const reference = await renderedFolder(kept)
    const identity = "function:simetra.touch()"
    const own = reference.units!.find((u) => u.identity === identity)
    expect(own?.identity).toBe(identity)
    const folderForm = own!.sql.replace("now()", "clock_timestamp()")
    expect(folderForm).not.toBe(own!.sql)
    const withFolderForm = (units: NonNullable<CatalogModel["units"]>) =>
      units.map((u) =>
        u.identity === identity ? { ...u, sql: folderForm } : u
      )
    const result = await reverseGenerate(
      model({
        tables: reference.tables,
        units: withFolderForm(reference.units!),
      }),
      options(kept, {
        reference: { ...reference, units: withFolderForm(reference.units!) },
      })
    )
    expect(result.diagnostics).toEqual([])
    expect(json(result, "sql-debt.json").units).toEqual([])
    expect(result.changes.map((c) => c.content ?? "").join("\n")).not.toContain(
      "clock_timestamp"
    )
  })

  /** Колонки таблиці, якої вимагають тригери шару, що не залежить від моделі. */
  const LAYER_TABLE_COLUMNS: CatalogColumn[] = [
    idColumn,
    { name: "updated_at", type: "timestamp with time zone", notNull: true },
    { name: "version", type: "bigint", notNull: true },
    { name: "created_by_id", type: "uuid", notNull: false },
    { name: "updated_by_id", type: "uuid", notNull: false },
  ]

  /** Шар, що не залежить від моделі, для `app.note` — у формі одиниць каталогу. */
  const noteLayer = () =>
    units(
      renderModelIndependentLayer(
        { schema: "app", name: "note" },
        "supabase",
        parse
      )
        .map((u) => u.sql)
        .join("\n")
    )

  const AUDIT_FN =
    "CREATE FUNCTION app.audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;"
  const AUDIT =
    "CREATE TRIGGER note_audit AFTER UPDATE ON app.note FOR EACH ROW EXECUTE FUNCTION app.audit();"

  it("introspect without a kept folder writes no mechanics units, but keeps own triggers", async () => {
    // Без теки еталон — установка й шар, що не залежить від моделі (спека
    // промоції §9.2): механіку, авторство й ключ таблиці з їхніми колонками
    // платформа рендерить сама, тож вони не пишуться. Власний тригер, що
    // кличе ту саму функцію, — уже не механіка.
    const STAMP =
      "CREATE TRIGGER note_stamp BEFORE UPDATE ON app.note FOR EACH ROW EXECUTE FUNCTION simetra.touch();"
    const layer = noteLayer()
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note", { columns: LAYER_TABLE_COLUMNS })],
        units: [...layer, ...units([AUDIT_FN, AUDIT, STAMP].join("\n"))],
      }),
      options()
    )
    // Власний тригер пишеться дослівно, а виклик функції платформи, що не
    // лише читає, — гучна помилка на ньому (спека прав §5.3), а не тихий пропуск.
    expect(
      errors(result).map((d) => ({ code: d.code, params: d.params }))
    ).toEqual([
      {
        code: "sql.platform-function-call",
        params: {
          unit: "trigger:app.note.note_stamp",
          function: "simetra.touch",
          line: 5,
        },
      },
    ])
    const sidecar = result.files.get("custom-tables/Note/Note.sql")
    expect(sidecar).toContain("CREATE TRIGGER note_audit")
    expect(sidecar).toContain("CREATE FUNCTION app.audit()")
    expect(sidecar).toContain("CREATE TRIGGER note_stamp")
    const written = [...result.files.values()].join("\n")
    for (const unit of layer) expect(written).not.toContain(unit.sql)
  })

  it.each([
    ["no layer column", []],
    ["only updated_at", ["updated_at"]],
    ["only version", ["version"]],
    ["only created_by_id", ["created_by_id"]],
    ["only updated_by_id", ["updated_by_id"]],
  ])(
    "a mechanics trigger on a CustomTable without the mechanics columns goes to the folder (%s)",
    async (_, present) => {
      // Еталон тригера шару — лише для таблиці з усіма колонками його
      // генератора (спека промоції §9.2): без них тригер механіки й авторства
      // не платформний, а дослівний SQL таблиці, і виклик функції платформи на
      // ньому — гучна помилка. Частини колонок замало. Ключ `id` таблиця має,
      // тож тригери ключа — платформні.
      const layer = noteLayer()
      const columns = LAYER_TABLE_COLUMNS.filter(
        (c) => c.name === "id" || present.includes(c.name)
      )
      const result = await reverseGenerate(
        model({ tables: [table("app", "note", { columns })], units: layer }),
        options()
      )
      const written = [
        "trigger:app.note.note_simetra_author",
        "trigger:app.note.note_simetra_touch",
      ]
      expect(
        errors(result).map((d) => ({ code: d.code, unit: d.params?.unit }))
      ).toEqual(
        written.map((unit) => ({ code: "sql.platform-function-call", unit }))
      )
      expect(result.files.get("custom-tables/Note/Note.sql")).toBe(
        `${written
          .map((identity) => layer.find((u) => u.identity === identity)!.sql)
          .join(";\n\n")};\n`
      )
    }
  )

  it("a trigger under a mechanics name with another event goes to the folder", async () => {
    // Вміст, а не ім'я (И4): тригер з ім'ям механіки на таблиці з її
    // колонками, але `AFTER` замість `BEFORE`, — дослівний SQL таблиці.
    const trigger = noteLayer().find((u) => u.name === "note_simetra_touch")!
    const changed = trigger.sql.replace(" BEFORE ", " AFTER ")
    expect(changed).not.toBe(trigger.sql)
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note", { columns: LAYER_TABLE_COLUMNS })],
        units: units(changed),
      }),
      options()
    )
    expect(
      errors(result).map((d) => ({ code: d.code, unit: d.params?.unit }))
    ).toEqual([{ code: "sql.platform-function-call", unit: trigger.identity }])
    expect(result.files.get("custom-tables/Note/Note.sql")).toBe(
      `${changed};\n`
    )
  })

  // 50 байтів — довше за межу 41, з якої імена рядкових `BEFORE`-тригерів
  // ідуть спільним префіксом із хешем (спека П4 §6.8)
  const LONG_COMMENT = `task_comment_${"x".repeat(37)}`
  it.each([
    ["short names", "task_comment", {}],
    [
      "a 50-byte table",
      LONG_COMMENT,
      { [COMMENT_FILE]: { physicalName: LONG_COMMENT } },
    ],
  ])(
    "recognizes carrier and split mechanics units over the kept folder as platform (%s)",
    async (_, comment, layer) => {
      // Розділена механіка (спека промоції §9.3) й одиниці копій носіїв —
      // платформні, коли їх рендерить збережена тека: вміст збігається з
      // еталоном теки. Одиниці — справжній вихід генераторів над доменом з
      // копіями носіїв
      const kept = policyDomain(layer)
      const compiled = await compile(kept)
      expect(
        compiled.diagnostics.filter((d) => d.severity === "error")
      ).toEqual([])
      const platform = compiled.model!.sqlUnits.filter(
        (u) => u.generator === "carriers" || u.generator === "mechanics"
      )
      const names = new Set(platform.map((u) => u.name))
      // Тригер виведення носіїв (і його функція) — під іменем спільного префікса
      expect(names).toContain(
        platformBeforeTriggerName(comment, "simetra_carriers")
      )
      expect(names).toContain(
        platformBeforeTriggerName(comment, "simetra_touch_update")
      )
      for (const label of [
        "simetra_touch_update",
        "simetra_carriers",
        "simetra_carriers_out",
        "simetra_carriers_out_insert",
      ])
        expect(
          [...names].some((n) => n.endsWith(`_${label}`)),
          label
        ).toBe(true)
      expect(new Set(platform.map((u) => u.class))).toEqual(
        new Set(["function", "grant", "sequence", "trigger"])
      )
      const result = await reverseGenerate(
        model({
          units: [
            // Увесь вихід компілятора теки, і файли користувача теж
            ...compiled.model!.sqlUnits.map((u) => ({
              class: u.class,
              identity: u.identity,
              schema: u.schema,
              name: u.name,
              sql: u.sql,
            })),
          ],
        }),
        options(kept, {
          reference: await renderedFolder(kept),
          name: "RightsApp",
          defaultSchema: "public",
          attributeCase: "camelCase",
        })
      )
      expect(errors(result)).toEqual([])
      // Записане — зміни теки: збережені файли сюди не входять
      const written = result.changes.map((c) => c.content ?? "").join("\n")
      expect(written).not.toContain("simetra_carriers")
      expect(written).not.toContain("simetra_touch")
    }
  )

  it("recognizes effects triggers and functions over the kept folder as platform", async () => {
    // Тригери ефектів дії — платформні, коли їх рендерить збережена тека.
    // Одиниці — справжній вихід генераторів над доменом із правами запису
    const kept = policyDomain(writeRoles())
    const compiled = await compile(kept)
    const platform = compiled.model!.sqlUnits.filter(
      (u) => u.generator === "effects"
    )
    const names = new Set(platform.map((u) => u.name))
    for (const label of ["simetra_effects", "simetra_effects_update"])
      expect(
        [...names].some((n) => n.endsWith(`_${label}`)),
        label
      ).toBe(true)
    expect(new Set(platform.map((u) => u.class))).toEqual(
      new Set(["function", "grant", "trigger"])
    )
    const result = await reverseGenerate(
      model({
        units: [
          // Увесь вихід компілятора теки, і файли користувача теж
          ...compiled.model!.sqlUnits.map((u) => ({
            class: u.class,
            identity: u.identity,
            schema: u.schema,
            name: u.name,
            sql: u.sql,
          })),
        ],
      }),
      options(kept, {
        reference: await renderedFolder(kept),
        name: "RightsApp",
        defaultSchema: "public",
        attributeCase: "camelCase",
      })
    )
    // Записане — зміни теки: збережені файли сюди не входять
    const written = result.changes.map((c) => c.content ?? "").join("\n")
    expect(written).not.toContain("simetra_effects")
    expect(errors(result)).toEqual([])
  })

  it("recognizes author triggers and the author function over the kept folder as platform", async () => {
    // Тригери авторства (спека П4 §6.8) (і розділені на таблиці з копіями, і під
    // іменем спільного префікса на 60-байтній таблиці) й `simetra.author()`
    // — платформні, коли їх рендерить збережена тека. Одиниці — справжній
    // вихід генератора
    const kept = singleTenantRights({
      ...authorCarrier(),
      ...authorCarrier("long"),
    })
    const compiled = await compile(kept)
    expectClean(compiled)
    const platform = compiled.model!.sqlUnits.filter(
      (u) => u.generator === "mechanics" && u.identity.includes("author")
    )
    const names = new Set(platform.map((u) => u.name))
    for (const label of ["simetra_author", "simetra_author_update"])
      expect(
        [...names].filter((n) => n.endsWith(`_${label}`)).length,
        label
      ).toBe(2)
    expect(new Set(platform.map((u) => u.class))).toEqual(
      new Set(["function", "grant", "trigger"])
    )
    const result = await reverseGenerate(
      model({
        units: [
          // Увесь вихід компілятора теки, і файли користувача теж
          ...compiled.model!.sqlUnits.map((u) => ({
            class: u.class,
            identity: u.identity,
            schema: u.schema,
            name: u.name,
            sql: u.sql,
          })),
        ],
      }),
      options(kept, {
        reference: await renderedFolder(kept),
        name: "SingleTenantRights",
        defaultSchema: "public",
        attributeCase: "camelCase",
      })
    )
    expect(errors(result)).toEqual([])
    // Записане — зміни теки: збережені файли сюди не входять
    const written = result.changes.map((c) => c.content ?? "").join("\n")
    expect(written).not.toContain("simetra_author")
    expect(written).not.toContain('"author"')
  })

  it("recognizes hierarchy triggers and the hierarchy function over the kept folder as platform", async () => {
    // Тригери ієрархії (спека П4 §6.6) й функція ієрархії таблиці —
    // платформні, коли їх рендерить збережена тека. Одиниці — справжній
    // вихід генератора
    const kept = policyDomain(writeRoles(), commandCoreLayer())
    const compiled = await compile(kept)
    expectClean(compiled)
    const platform = compiled.model!.sqlUnits.filter(
      (u) => u.generator === "mechanics" && u.identity.includes("_hierarchy")
    )
    expect(
      platform.filter((u) => u.class === "trigger").map((u) => u.name)
    ).toEqual(["ticket_simetra_hierarchy", "ticket_simetra_hierarchy_update"])
    expect(new Set(platform.map((u) => u.class))).toEqual(
      new Set(["function", "grant", "trigger"])
    )
    const result = await reverseGenerate(
      model({
        units: [
          // Увесь вихід компілятора теки, і файли користувача теж
          ...compiled.model!.sqlUnits.map((u) => ({
            class: u.class,
            identity: u.identity,
            schema: u.schema,
            name: u.name,
            sql: u.sql,
          })),
        ],
      }),
      options(kept, {
        reference: await renderedFolder(kept),
        name: "RightsApp",
        defaultSchema: "public",
        attributeCase: "camelCase",
      })
    )
    expect(errors(result)).toEqual([])
    // Записане — зміни теки: збережені файли сюди не входять
    const written = result.changes.map((c) => c.content ?? "").join("\n")
    expect(written).not.toContain("simetra_hierarchy")
  })

  it("a hierarchy-named trigger that calls another function is written", async () => {
    // Fail-closed: ім'я тригера ієрархії без власної функції — тригер таблиці
    const FN =
      "CREATE FUNCTION app.stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;"
    const NAMESAKE =
      "CREATE TRIGGER note_simetra_hierarchy AFTER UPDATE ON app.note FOR EACH ROW EXECUTE FUNCTION app.stamp();"
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note")],
        units: units([FN, NAMESAKE].join("\n")),
      }),
      options()
    )
    expect(errors(result)).toEqual([])
    expect([...result.files.values()].join("\n")).toContain(
      "CREATE TRIGGER note_simetra_hierarchy"
    )
  })

  it("introspect over a deployed write-rights layer writes nothing for command functions", async () => {
    // Функції контексту команди — одиниці генератора `command`, як функції
    // `rights`: їх описує збережена тека, тож вони не стають дослівним SQL
    const kept = policyDomain(writeRoles())
    const compiled = await compile(kept)
    expect(compiled.diagnostics).toEqual([])
    const layer = compiled.model!
    expect(layer.sqlUnits.some((u) => u.generator === "command")).toBe(true)
    const result = await reverseGenerate(
      model({
        tables: catalogFromSnapshot(layer.physical).tables,
        units: layer.sqlUnits.map((u) => ({
          class: u.class,
          identity: u.identity,
          schema: u.schema,
          name: u.name,
          sql: u.sql,
        })),
      }),
      options(kept, {
        reference: await renderedFolder(kept),
        name: "RightsApp",
        defaultSchema: "public",
        attributeCase: "camelCase",
      })
    )
    expect(errors(result)).toEqual([])
    const written = [...result.files.values()].join("\n")
    expect(written).not.toContain("command_parsed")
    expect(written).not.toContain("simetra_effects")
  })

  it("an effects-named trigger that calls another function is written", async () => {
    // Fail-closed: ім'я тригера ефектів без власної функції — тригер таблиці
    const FN =
      "CREATE FUNCTION app.stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;"
    const NAMESAKE =
      "CREATE TRIGGER note_simetra_effects AFTER UPDATE ON app.note FOR EACH ROW EXECUTE FUNCTION app.stamp();"
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note")],
        units: units([FN, NAMESAKE].join("\n")),
      }),
      options()
    )
    expect(errors(result)).toEqual([])
    expect(result.files.get("custom-tables/Note/Note.sql")).toContain(
      NAMESAKE.slice(0, -1)
    )
  })

  it.each(rightsGuardNames({ schema: "app", name: "note" }))(
    "a rights guard $trigger without a kept folder goes to the folder",
    async ({ trigger, function: fn }) => {
      // Guards прав залежать від моделі видів (спека промоції §9.2): без
      // теки еталона в них немає, тож це дослівний SQL таблиці
      const sql = [
        `CREATE FUNCTION app.${fn.name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`,
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON app.note FOR EACH ROW EXECUTE FUNCTION app.${fn.name}();`,
      ].join("\n")
      const result = await reverseGenerate(
        model({ tables: [table("app", "note")], units: units(sql) }),
        options()
      )
      expect(errors(result)).toEqual([])
      const sidecar = result.files.get("custom-tables/Note/Note.sql")
      expect(sidecar).toContain(`CREATE TRIGGER ${trigger} `)
      expect(sidecar).toContain(`CREATE FUNCTION app.${fn.name}()`)
    }
  )

  it("keeps a rights guard namesake that calls another function", async () => {
    const [{ trigger }] = rightsGuardNames({ schema: "app", name: "note" })
    const sql = [
      "CREATE FUNCTION app.stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;",
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON app.note FOR EACH ROW EXECUTE FUNCTION app.stamp();`,
    ].join("\n")
    const result = await reverseGenerate(
      model({ tables: [table("app", "note")], units: units(sql) }),
      options()
    )
    expect(errors(result)).toEqual([])
    expect(result.files.get("custom-tables/Note/Note.sql")).toContain(
      `CREATE TRIGGER ${trigger}`
    )
  })

  it("recognizes key triggers and simetra.key_immutable as platform without a kept folder", async () => {
    // Тригери незмінності (спека прав §7) ключа й їхня функція — шар, що не
    // залежить від моделі: таблиця з колонкою ключа впізнає їх і без теки.
    // Одиниці — справжній вихід генератора
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Note/Note.meta.json": catalog("Note"),
      })
    )
    expectClean(compiled)
    const platform = compiled.model!.sqlUnits.filter(
      (u) => u.generator === "key"
    )
    const names = keyTriggerNames("note")
    expect(platform.map((u) => u.name)).toEqual(
      expect.arrayContaining([names.before, names.after, "key_immutable"])
    )
    const AUDIT_FN =
      "CREATE FUNCTION public.audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;"
    const AUDIT =
      "CREATE TRIGGER note_audit AFTER UPDATE ON public.note FOR EACH ROW EXECUTE FUNCTION public.audit();"
    const result = await reverseGenerate(
      model({
        tables: catalogFromSnapshot(compiled.model!.physical).tables.filter(
          (t) => t.schema === "public" && t.name === "note"
        ),
        units: [
          ...platform.map((u) => ({
            class: u.class,
            identity: u.identity,
            schema: u.schema,
            name: u.name,
            sql: u.sql,
          })),
          ...units([AUDIT_FN, AUDIT].join("\n")),
        ],
      }),
      options(new Map(), { defaultSchema: "public" })
    )
    expect(errors(result)).toEqual([])
    const written = [...result.files.values()].join("\n")
    expect(written).toContain("CREATE TRIGGER note_audit")
    expect(written).not.toContain("simetra_key")
    expect(written).not.toContain("key_immutable")
  })

  it("keeps a key trigger namesake that calls another function", async () => {
    const { before } = keyTriggerNames("note")
    const sql = [
      "CREATE FUNCTION app.stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;",
      `CREATE TRIGGER ${before} BEFORE UPDATE ON app.note FOR EACH ROW EXECUTE FUNCTION app.stamp();`,
    ].join("\n")
    const result = await reverseGenerate(
      model({ tables: [table("app", "note")], units: units(sql) }),
      options()
    )
    expect(errors(result)).toEqual([])
    expect(result.files.get("custom-tables/Note/Note.sql")).toContain(
      `CREATE TRIGGER ${before}`
    )
  })

  it("refuses the deferred rights check of the platform schema instead of adopting it", async () => {
    // Схему `simetra` інтроспекція не читає; якщо її одиниці все ж дійшли,
    // генератор не пише їх у модуль користувача мовчки, а відмовляє
    const sql = [
      "CREATE FUNCTION simetra.rights_tx_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;",
      "CREATE CONSTRAINT TRIGGER rights_tx_pending_check AFTER INSERT ON simetra.rights_tx_pending DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION simetra.rights_tx_check();",
    ].join("\n")
    const result = await reverseGenerate(
      model({ tables: [table("app", "note")], units: units(sql) }),
      options()
    )
    expect(errors(result).map((d) => [d.code, d.file])).toEqual([
      ["schema.reserved", "sql/simetra/rights_tx_check.sql"],
      [
        "schema.reserved",
        "sql/simetra/rights_tx_pending__rights_tx_pending_check.sql",
      ],
    ])
  })

  it("a grant shared with another function and a mechanics-named trigger on another function are written", async () => {
    // Межі (спека промоції §9.2): пропускається лише одиниця, ціла належна механіці.
    // Грант зі спільною ціллю несе й чужий привілей, а тригер з ім'ям
    // механіки, що кличе іншу функцію, — власний тригер таблиці.
    const MIXED =
      "REVOKE EXECUTE ON FUNCTION simetra.touch(), app.other() FROM anon;"
    const NAMESAKE =
      "CREATE TRIGGER note_simetra_touch BEFORE UPDATE ON app.note FOR EACH ROW EXECUTE FUNCTION app.stamp();"
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note")],
        units: units(
          [
            "CREATE FUNCTION app.stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;",
            NAMESAKE,
            MIXED,
          ].join("\n")
        ),
      }),
      options()
    )
    // Грант пишеться дослівно, і схема платформи в ньому — гучна помилка
    // `schema.reserved` саме на його файлі, а не тихий пропуск
    const grantFile =
      "sql/app/grant__revoke__function__app_other_simetra_touch__anon__execute.sql"
    expect(result.files.get(grantFile)).toContain(MIXED.slice(0, -1))
    expect(errors(result).map((d) => ({ code: d.code, file: d.file }))).toEqual(
      [{ code: "schema.reserved", file: grantFile }]
    )
    expect(result.files.get("custom-tables/Note/Note.sql")).toContain(
      NAMESAKE.slice(0, -1)
    )
  })

  it("over a kept folder a foreign grant on what the platform grants is refused, not dropped", async () => {
    // Перший introspect бази, вже керованої Simetra (И7): гранти, які
    // рендерить тека, — платформні за вмістом і не пишуться. Чужий грант на
    // функцію множини чи таблицю виду з контрактом доступу (ADP схеми,
    // ручний GRANT) з еталоном не збігається: він іде в теку, і компілятор
    // називає його `sql.generated-grant`, а не губить мовчки.
    const kept = metaFiles({
      "project.meta.json": project({
        name: "App",
        defaultSchema: "app",
        naming: { attributeCase: "snake_case" },
        scopeKinds: [
          {
            id: uuid(9401),
            name: "org",
            physicalName: "org_id",
            root: { object: { kind: "Catalog", name: "Organization" } },
            setFunction: { name: "my_orgs" },
          },
        ],
      }),
      "catalogs/Organization/Organization.meta.json": catalog("Organization", {
        schema: "app",
        scope: "org",
      }),
    })
    const compiled = await compile(kept)
    expectClean(compiled, { allow: ["rights.scope-kind-unread"] })
    const layer = compiled.model!
    expect(layer.sqlUnits.some((u) => u.generator === "functionExecute")).toBe(
      true
    )
    // Грант на функцію поза платформою — прийнятий стан бази: його пишемо.
    const OWN_GRANT = "GRANT EXECUTE ON FUNCTION app.other() TO anon;"
    const foreign = [
      "GRANT EXECUTE ON FUNCTION app.my_orgs() TO anon;",
      "REVOKE INSERT ON TABLE app.organization FROM authenticated;",
      "GRANT SELECT ON TABLE app.organization TO some_role;",
    ]
    const result = await reverseGenerate(
      model({
        tables: catalogFromSnapshot(layer.physical).tables,
        units: [
          ...layer.sqlUnits.map((u) => ({
            class: u.class,
            identity: u.identity,
            schema: u.schema,
            name: u.name,
            sql: u.sql,
          })),
          ...units([...foreign, OWN_GRANT].join("\n")),
        ],
      }),
      options(kept, {
        reference: await renderedFolder(kept),
        executeFacts: executeFacts(["app.my_orgs"], { anon: true }),
      })
    )
    const files = [
      "sql/app/grant__function__app_my_orgs__anon__execute.sql",
      "sql/app/grant__revoke__table__app_organization__authenticated__insert.sql",
      "sql/app/grant__table__app_organization__some_role__select.sql",
    ]
    expect(errors(result).map((d) => ({ code: d.code, file: d.file }))).toEqual(
      files.map((file) => ({ code: "sql.generated-grant", file }))
    )
    expect(files.map((file) => result.files.get(file))).toEqual(
      foreign.map((statement) => `${statement}\n`)
    )
    // Грант на функцію поза платформою — прийнятий стан бази
    expect(
      [...result.files.values()].some((t) => t.includes(OWN_GRANT.slice(0, -1)))
    ).toBe(true)
    // Грант, який рендерить тека, не пишеться: інших файлів грантів немає
    expect(
      [...result.files.keys()].filter((p) => p.includes("grant__")).sort()
    ).toEqual(
      [...files, "sql/app/grant__function__app_other__anon__execute.sql"].sort()
    )
  })

  it("over a kept folder the movement query wrapper is described by the document, not written", async () => {
    // Обгортку запиту рухів описує блок документа, а не генератор (Р4): її
    // ідентичність — серед описаних файлом користувача, тож прийом поверх
    // теки її не пише; розбіжність тіла показує `diff`, а не introspect
    const block =
      "SELECT d.date, 'Expense', g.item_id, g.qty\n" +
      "FROM public.goods g JOIN public.sale d ON d.id = g.parent_id\n" +
      "WHERE d.id = p_document_id\n" +
      "ORDER BY g.line_number"
    const kept = metaFiles({
      "project.meta.json": project(),
      ...salesDocument({}, { posting: undefined }),
      "documents/Sale/Sale.sql": `-- @movements Stock\n${block}\n-- @end\n`,
    })
    const compiled = await compile(kept)
    expectClean(compiled)
    const wrapper = compiled.model!.sqlUnits.find(
      (u) => u.class === "movementQuery"
    )!
    // У каталозі бази обгортка — звичайна функція з тією самою ідентичністю
    const [function_] = units(wrapper.sql)
    expect(function_).toMatchObject({
      class: "function",
      identity: wrapper.identity,
    })
    const result = await reverseGenerate(
      model({
        tables: catalogFromSnapshot(compiled.model!.physical).tables,
        units: [
          ...compiled
            .model!.sqlUnits.filter((u) => u !== wrapper)
            .map((u) => ({
              class: u.class,
              identity: u.identity,
              schema: u.schema,
              name: u.name,
              sql: u.sql,
            })),
          function_!,
        ],
      }),
      options(kept, {
        reference: await renderedFolder(kept),
        name: "TestApp",
        defaultSchema: "public",
        attributeCase: "camelCase",
      })
    )
    expect(errors(result)).toEqual([])
    expect(result.changes.map((c) => c.path)).toEqual(["sql-debt.json"])
  })

  it("over a kept folder a generated unit with another body goes to the folder and is refused", async () => {
    // Згенеровану одиницю теки описує не файл користувача, а генератор (Р4):
    // вона платформна лише за вмістом. Функція механіки з іншим тілом під
    // тим самим ім'ям — чужий SQL, і компіляція відмовляє за схемою `simetra`
    const kept = keptCatalog()
    const compiled = await compile(kept)
    expectClean(compiled)
    const catalogUnits = compiled.model!.sqlUnits.map((u) => ({
      class: u.class,
      identity: u.identity,
      schema: u.schema,
      name: u.name,
      sql: u.sql,
    }))
    const touch = catalogUnits.find(
      (u) => u.identity === "function:simetra.touch()"
    )!
    const changed = touch.sql.replace("RETURN NEW;", "RETURN NULL;")
    expect(changed).not.toBe(touch.sql)
    const result = await reverseGenerate(
      model({
        tables: catalogFromSnapshot(compiled.model!.physical).tables,
        units: catalogUnits.map((u) =>
          u === touch ? { ...u, sql: changed } : u
        ),
      }),
      options(kept, { reference: await renderedFolder(kept) })
    )
    expect(errors(result).map((d) => [d.code, d.file])).toEqual([
      ["schema.reserved", "sql/simetra/touch.sql"],
    ])
  })

  it("over an applied folder without the folder reference the generated units are not the platform's", async () => {
    // Еталон теки — лише форма каталогу її тіні: без неї половина еталона від
    // теки порожня, і згенеровані одиниці довідника йдуть у теку гучно, а не
    // тонуть мовчки
    const kept = keptCatalog()
    const compiled = await compile(kept)
    expectClean(compiled)
    const catalog = model({
      tables: catalogFromSnapshot(compiled.model!.physical).tables,
      units: compiled.model!.sqlUnits.map((u) => ({
        class: u.class,
        identity: u.identity,
        schema: u.schema,
        name: u.name,
        sql: u.sql,
      })),
    })
    const without = await reverseGenerate(catalog, options(kept))
    // Кожен тригер довідника, який рендерить тека: усі три гучні
    expect(errors(without).map((d) => [d.code, d.file])).toEqual(
      [
        "currency__currency_simetra_key",
        "currency__currency_simetra_key_after",
        "currency__currency_simetra_touch",
      ].flatMap((name) => [
        ["sql.kind-table-verbatim", `sql/app/${name}.sql`],
        ["sql.platform-function-call", `sql/app/${name}.sql`],
      ])
    )
    expect(without.changes).toEqual([])
    const withReference = await reverseGenerate(
      catalog,
      options(kept, { reference: await renderedFolder(kept) })
    )
    expect(errors(withReference)).toEqual([])
  })

  it("over a kept folder a generated unit is compared with the reference's catalog form, not the generator text", async () => {
    // Каталог пише одиницю у своїй формі; еталон теки — та сама форма з її
    // тіні. Тож рівність з формою еталона — платформне, а рівність лише з
    // текстом генератора — ні
    const kept = keptCatalog()
    const compiled = await compile(kept)
    expectClean(compiled)
    const identity = "trigger:app.currency.currency_simetra_key"
    const own = compiled.model!.sqlUnits.find((u) => u.identity === identity)!
    // Інше дерево розбору без правила нормалізації — як вираз, який каталог
    // переписав у своїй формі
    const catalogForm = own.sql.replace("WHEN (", "WHEN (true AND ")
    expect(catalogForm).not.toBe(own.sql)
    const reference = await renderedFolder(kept)
    const inCatalogForm = (m: CatalogModel): CatalogModel => ({
      ...m,
      units: m.units.map((u) =>
        u.identity === identity ? { ...u, sql: catalogForm } : u
      ),
    })
    const catalog = inCatalogForm(reference)
    const same = await reverseGenerate(
      catalog,
      options(kept, { reference: inCatalogForm(reference) })
    )
    expect(errors(same)).toEqual([])
    const generatorOnly = await reverseGenerate(
      catalog,
      options(kept, { reference })
    )
    expect(errors(generatorOnly).map((d) => [d.code, d.file])).toEqual([
      ["sql.kind-table-verbatim", "sql/app/currency__currency_simetra_key.sql"],
      [
        "sql.platform-function-call",
        "sql/app/currency__currency_simetra_key.sql",
      ],
    ])
  })

  it("a second introspect over the folder of the first is clean", async () => {
    // Тека першого прийому — `CustomTable` і перелік боргу: еталон над нею
    // несе й установку, і шар, що не залежить від моделі, тож механіка
    // таблиці лишається платформною й удруге
    const catalog = model({
      tables: [table("app", "note", { columns: LAYER_TABLE_COLUMNS })],
      units: [...noteLayer(), ...units([AUDIT_FN, AUDIT].join("\n"))],
    })
    const first = await reverseGenerate(catalog, options())
    expect(first.diagnostics).toEqual([])
    const second = await reverseGenerate(catalog, options(first.files))
    expect(second.diagnostics).toEqual([])
    expect(second.changes).toEqual([])
  })

  it("over a mixed folder the layer of a CustomTable is the platform's", async () => {
    // Тека з довідником і таблицею без виду, що має колонки й тригери шару:
    // тригери довідника рендерить тека, тригери таблиці — шар
    const kept = keptCatalog()
    const compiled = await compile(kept)
    expectClean(compiled)
    const layer = noteLayer()
    const catalog = model({
      tables: [
        ...catalogFromSnapshot(compiled.model!.physical).tables,
        table("app", "note", { columns: LAYER_TABLE_COLUMNS }),
      ],
      units: [
        ...compiled.model!.sqlUnits.map((u) => ({
          class: u.class,
          identity: u.identity,
          schema: u.schema,
          name: u.name,
          sql: u.sql,
        })),
        ...layer,
      ],
    })
    const result = await reverseGenerate(
      catalog,
      options(kept, { reference: await renderedFolder(kept) })
    )
    expect(result.diagnostics).toEqual([])
    const written = result.changes.map((c) => c.content ?? "").join("\n")
    for (const unit of layer) expect(written).not.toContain(unit.sql)
    expect(result.changes.map((c) => c.path).sort()).toEqual([
      "custom-tables/Note/Note.meta.json",
      "sql-debt.json",
    ])
    // Тека тепер змішана — вид і `CustomTable` з шаром; удруге — так само чисто
    const second = await reverseGenerate(
      catalog,
      options(result.files, { reference: await renderedFolder(result.files) })
    )
    expect(second.diagnostics).toEqual([])
    expect(second.changes).toEqual([])
  })

  it("over a kept folder a layer trigger on a kind table that the folder does not render goes to the folder", async () => {
    // Тригери таблиці виду рендерить тека, а не шар: тригер авторства на
    // довіднику без авторства — чужий SQL, навіть коли таблиця в базі має
    // колонки авторства
    const kept = keptCatalog()
    const compiled = await compile(kept)
    expectClean(compiled)
    const tables = catalogFromSnapshot(compiled.model!.physical).tables
    const currency = tables.find((t) => t.name === "currency")!
    expect(currency.columns.map((c) => c.name)).not.toContain("created_by_id")
    const author = units(
      renderModelIndependentLayer(
        { schema: "app", name: "currency" },
        "supabase",
        parse
      )
        .filter((u) => u.name === authorTriggerName("currency"))
        .map((u) => u.sql)
        .join("\n")
    )
    expect(author).toHaveLength(1)
    const result = await reverseGenerate(
      model({
        tables: tables.map((t) =>
          t === currency
            ? {
                ...t,
                columns: [
                  ...t.columns,
                  ...LAYER_TABLE_COLUMNS.filter((c) =>
                    ["created_by_id", "updated_by_id"].includes(c.name)
                  ),
                ],
              }
            : t
        ),
        units: [
          ...compiled.model!.sqlUnits.map((u) => ({
            class: u.class,
            identity: u.identity,
            schema: u.schema,
            name: u.name,
            sql: u.sql,
          })),
          ...author,
        ],
      }),
      options(kept, { reference: await renderedFolder(kept) })
    )
    expect(
      errors(result).map((d) => [d.code, d.params?.identity ?? d.params?.unit])
    ).toEqual([
      ["sql.kind-table-verbatim", author[0]!.identity],
      ["sql.platform-function-call", author[0]!.identity],
    ])
  })

  it("a layer function with another body in the database goes to the folder", async () => {
    // Шар упізнається лише за вмістом: функція механіки з іншим тілом під
    // тим самим ім'ям — чужий SQL і без теки
    const layer = noteLayer()
    const touch = layer.find((u) => u.identity === "function:simetra.touch()")!
    const changed = touch.sql.replace("RETURN NEW;", "RETURN NULL;")
    expect(changed).not.toBe(touch.sql)
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note", { columns: LAYER_TABLE_COLUMNS })],
        units: layer.map((u) => (u === touch ? { ...u, sql: changed } : u)),
      }),
      options()
    )
    expect(errors(result).map((d) => [d.code, d.file])).toEqual([
      ["schema.reserved", "sql/simetra/touch.sql"],
    ])
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
            "CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;",
            "COMMENT ON VIEW reports.active IS 'Active';",
            "ALTER DEFAULT PRIVILEGES IN SCHEMA reports GRANT SELECT ON TABLES TO anon;",
            "CREATE SEQUENCE app.counter;",
            "ALTER SEQUENCE app.counter OWNED BY app.customer.id;",
          ].join("\n")
        ),
      }),
      options()
    )
    // Розширення лише в схемі провайдера (спека прав §5.3): без SCHEMA воно було б
    // помилкою `sql.debt-extension-schema`.
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
            DEBT_TOUCH,
            "CREATE POLICY note_read ON app.note USING (true);",
            "CREATE FUNCTION app.closed() RETURNS int LANGUAGE sql STABLE AS $$ SELECT 1 $$;",
          ].join("\n")
        ),
      }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    // SECURITY DEFINER без search_path — поза оболонкою, тож теж борг.
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

  it("introspect lists an accepted function with dynamic SQL as debt", async () => {
    const result = await reverseGenerate(
      model({
        tables: [table("app", "note")],
        units: units(
          TOUCH.replace("RETURN NEW;", "EXECUTE 'select 1'; RETURN NEW;")
        ),
      }),
      options()
    )
    expect(json(result, "sql-debt.json").units).toEqual([
      "function:app.touch()",
      "trigger:app.note.note_touch",
    ])
  })

  it("introspect writes an empty debt list too", async () => {
    const result = await reverseGenerate(
      model({ tables: [table("app", "note")] }),
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(json(result, "sql-debt.json").units).toEqual([])
  })

  describe("bootstrap of the debt list", () => {
    /** Тека з довідником і таблицею `Note`, чий тригер є і в базі, — без переліку боргу. */
    async function withoutList() {
      const kept = keptCatalog()
      const catalogTables = catalogFromSnapshot(
        (await compile(kept)).model!.physical
      ).tables
      const db = model({
        tables: [...catalogTables, table("app", "note")],
        units: units(DEBT_TOUCH),
      })
      const first = await reverseGenerate(db, options(kept))
      expect(first.diagnostics).toEqual([])
      const existing = new Map(first.files)
      existing.delete("sql-debt.json")
      return { db, existing }
    }

    it("introspect lists the debt of a folder without sql-debt.json", async () => {
      const { db, existing } = await withoutList()
      expect((await compile(existing)).diagnostics.map((d) => d.code)).toEqual([
        "sql.debt-grows",
        "sql.debt-grows",
      ])
      const result = await reverseGenerate(db, options(existing))
      expect(result.diagnostics).toEqual([])
      // Довідник описано його файлом: тека з лише ратчетом — компілюється.
      expect(
        [...result.files.keys()].filter((k) => k.startsWith("custom-tables/"))
      ).toEqual([
        "custom-tables/Note/Note.meta.json",
        "custom-tables/Note/Note.sql",
      ])
      expect(json(result, "sql-debt.json").units).toEqual([
        "function:app.touch()",
        "trigger:app.note.note_touch",
      ])
      expect((await compile(result.files)).diagnostics).toEqual([])
    })

    it("introspect rewrites a stale list instead of refusing the folder", async () => {
      const { db, existing } = await withoutList()
      existing.set(
        "sql-debt.json",
        JSON.stringify({
          units: [
            "function:app.touch()",
            "policy:app.note.gone",
            "trigger:app.note.note_touch",
          ],
        })
      )
      expect((await compile(existing)).diagnostics.map((d) => d.code)).toEqual([
        "sql.debt-stale",
      ])
      const result = await reverseGenerate(db, options(existing))
      expect(result.diagnostics).toEqual([])
      expect(json(result, "sql-debt.json").units).toEqual([
        "function:app.touch()",
        "trigger:app.note.note_touch",
      ])
    })

    it("a trigger only in the folder never enters the list", async () => {
      const { db, existing } = await withoutList()
      const listed = await reverseGenerate(db, options(existing))
      const folder = new Map(listed.files)
      const sql = "custom-tables/Note/Note.sql"
      folder.set(
        sql,
        `${folder.get(sql)!}\nCREATE TRIGGER note_extra BEFORE INSERT ON app.note FOR EACH ROW EXECUTE FUNCTION app.touch();\n`
      )
      expect(
        (await compile(folder)).diagnostics.map((d) => [
          d.code,
          d.params?.identity,
        ])
      ).toEqual([["sql.debt-grows", "trigger:app.note.note_extra"]])
      const again = await reverseGenerate(db, options(folder))
      expect(json(again, "sql-debt.json").units).not.toContain(
        "trigger:app.note.note_extra"
      )
    })

    it("a folder with another error stays uncompilable", async () => {
      const { db, existing } = await withoutList()
      existing.set("catalogs/Broken/Broken.meta.json", "{")
      const result = await reverseGenerate(db, options(existing))
      // Як і досі: тека не каже, що описує, тож таблицю довідника описано вдруге.
      expect(errors(result).map((d) => d.code)).toContain("file.invalid-json")
      expect(
        [...result.files.keys()].some((k) =>
          k.startsWith("custom-tables/Currency/")
        )
      ).toBe(true)
      expect(result.changes).toEqual([])
    })
  })
})
