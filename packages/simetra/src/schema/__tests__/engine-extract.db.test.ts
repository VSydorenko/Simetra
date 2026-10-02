import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  catalogFromSnapshot,
  diffCatalogModels,
  type CatalogModel,
  type CatalogTable,
} from "simetra/model"
import {
  createPgDeltaEngine,
  renderDesiredState,
  type EngineScope,
  type Extracted,
} from "simetra/schema"
import { PROVIDER_SCHEMAS } from "../engine/pg-delta/policy"
import {
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../test/db/connection"
import { readReferenceDomain } from "../../compiler/__tests__/fixtures/reference-domain"
import {
  customTable,
  metaFiles,
  project,
  uuid,
} from "../../compiler/__tests__/helpers"
import { FIXTURES } from "./fixtures/e1-fixtures"

/**
 * Extract порту мапить факти pg-delta у модель каталогу (план E2a, задача 4):
 * рендер бажаного стану в тіні → extract → модель дорівнює знімку
 * компілятора. Розбіжність поза переліченими нижче шляхами текстів виразів —
 * дефект мапера, а не привід розширити перелік.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

/**
 * Поля текстів виразів, які Postgres зберігає в канонічній формі, а знімок —
 * в авторській; порівнюються лише наявністю (спека П2 §9: канонічну форму
 * виразу дає база).
 */
const EXPRESSION_PATHS: readonly [string, string][] = [
  [
    "columns.*.default",
    "Postgres stores the parsed default and prints it with casts (`'none'::text`)",
  ],
  [
    "columns.*.generated.expression",
    "a generated column expression is printed from its parse tree with extra parentheses",
  ],
  [
    "checks.*.expression",
    "pg_get_constraintdef prints the check from its parse tree (`(amount >= (0)::numeric)`)",
  ],
  [
    "indexes.*.where",
    "pg_get_indexdef prints the predicate from its parse tree",
  ],
  [
    "indexes.*.keys.*.expression",
    "pg_get_indexdef prints key expressions from their parse tree",
  ],
]

const EXPRESSION = "<expression>"

/** Таблиця з текстами виразів, заміненими на маркер; порожній вираз лишається як є. */
function withoutExpressionTexts(table: CatalogTable): CatalogTable {
  const mark = (value: string) => (value.trim() === "" ? value : EXPRESSION)
  return {
    ...table,
    columns: table.columns.map((c) => ({
      ...c,
      ...(c.default === undefined ? {} : { default: mark(c.default) }),
      ...(c.generated === undefined
        ? {}
        : { generated: { expression: mark(c.generated.expression) } }),
    })),
    checks: table.checks.map((c) => ({
      ...c,
      expression: mark(c.expression),
    })),
    indexes: table.indexes.map((index) => ({
      ...index,
      ...(index.where === undefined ? {} : { where: mark(index.where) }),
      keys: index.keys.map((key) =>
        "expression" in key ? { ...key, expression: mark(key.expression) } : key
      ),
    })),
  }
}

/** Тексти виразів таблиці — щоб довести, що жоден не порожній. */
function expressionTexts(table: CatalogTable): string[] {
  return [
    ...table.columns.flatMap((c) => [
      ...(c.default === undefined ? [] : [c.default]),
      ...(c.generated === undefined ? [] : [c.generated.expression]),
    ]),
    ...table.checks.map((c) => c.expression),
    ...table.indexes.flatMap((index) => [
      ...(index.where === undefined ? [] : [index.where]),
      ...index.keys.flatMap((key) =>
        "expression" in key ? [key.expression] : []
      ),
    ]),
  ]
}

async function compiled(files: Map<string, string>): Promise<CompiledModel> {
  const result = await compile(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/**
 * Межа тесту — схеми застосунку з моделі без схем провайдера (задача 6
 * дасть продуктовий `engineScope`).
 */
function scopeOf(model: CompiledModel): EngineScope {
  const provider = new Set(PROVIDER_SCHEMAS)
  const schemas = [
    ...new Set([
      ...model.physical.tables.map((t) => t.schema),
      ...model.physical.enumTypes.map((t) => t.schema),
      ...model.sqlUnits.map((u) => u.schema),
    ]),
  ].filter((s) => s !== "" && !provider.has(s))
  return { schemas, provider: "supabase" }
}

/** Рендер у тіні → extract тіні. */
async function extractDesired(
  desiredSql: string,
  scope: EngineScope
): Promise<Extracted> {
  const outcome = await engine.withDesiredShadow(
    stack,
    desiredSql,
    scope,
    (shadow) => engine.extract(shadow, scope)
  )
  expect(outcome.status === "loaded" ? [] : outcome.diagnostics).toEqual([])
  if (outcome.status !== "loaded") throw new Error("shadow did not load")
  return outcome.value
}

/** Частини списку ідентичності через кому верхнього рівня (типи аргументів у дужках). */
function splitList(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const ch of text) {
    if (ch === "," && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    if (ch === "(") depth++
    if (ch === ")") depth--
    current += ch
  }
  parts.push(current)
  return parts
}

/**
 * Класи одиниць, які база тримає інакше, ніж оператор компілятора: їхні
 * ідентичності зводяться до форми бази.
 */
const HELD_DIFFERENTLY: readonly [string, string][] = [
  [
    "functionSettings",
    "ALTER FUNCTION … SET is stored in pg_proc.proconfig and printed inside the function definition, so it is the function's unit",
  ],
  [
    "grant",
    "the catalog holds one ACL entry per (object, grantee), merging every statement's privileges for the pair",
  ],
  [
    "defaultPrivileges",
    "pg_default_acl holds one entry per (role, schema, object type, grantee)",
  ],
  [
    "publication",
    "pg_publication_rel holds one row per (publication, table); SET leaves the same rows as ADD",
  ],
]

/**
 * Ідентичності одиниць компілятора у формі бази: оператор розгорнуто в пари
 * факту (рішення за спайком, 5), налаштування функції — у її ідентичність.
 */
function databaseIdentities(units: CompiledModel["sqlUnits"]): string[] {
  const own = new Set(units.map((u) => u.identity))
  const pairs = new Map<string, Set<string>>()
  const pair = (key: string, privileges: string[]) => {
    const set = pairs.get(key) ?? new Set<string>()
    for (const p of privileges) set.add(p)
    pairs.set(key, set)
  }
  const out = new Set<string>()
  for (const unit of units) {
    const parts = unit.identity.split(":")
    switch (unit.class) {
      case "functionSettings": {
        const signature = parts.slice(1).join(":")
        out.add(
          own.has(`procedure:${signature}`)
            ? `procedure:${signature}`
            : `function:${signature}`
        )
        break
      }
      case "grant": {
        const [, verb, type, objects, roles, privileges] = parts
        if (verb !== "grant" || type!.startsWith("allInSchema."))
          throw new Error(`fixture form not expanded: ${unit.identity}`)
        for (const object of splitList(objects!))
          for (const role of roles!.split(","))
            pair(
              `grant:grant:${type}:${object}:${role}`,
              splitList(privileges!)
            )
        break
      }
      case "defaultPrivileges": {
        const [, roles, schemas, type, verb, grantees, privileges] = parts
        for (const role of roles!.split(","))
          for (const schema of schemas!.split(","))
            for (const grantee of grantees!.split(","))
              pair(
                `defaultPrivileges:${role}:${schema}:${type}:${verb}:${grantee}`,
                splitList(privileges!)
              )
        break
      }
      case "publication": {
        const [, name, action, tables] = parts
        if (action === "drop")
          throw new Error(`fixture form not expanded: ${unit.identity}`)
        for (const table of splitList(tables!))
          out.add(`publication:${name}:add:${table}`)
        break
      }
      default:
        out.add(unit.identity)
    }
  }
  for (const [key, privileges] of pairs)
    out.add(`${key}:${[...privileges].sort().join(",")}`)
  return [...out].sort()
}

/**
 * Модель extract дорівнює знімку компілятора з точністю до текстів виразів,
 * а одиниці — одиницям компілятора у формі бази.
 */
async function expectExtractMatchesModel(files: Map<string, string>) {
  const model = await compiled(files)
  const extracted = await extractDesired(
    renderDesiredState(model).sql,
    scopeOf(model)
  )
  expect(extracted.diagnostics.filter((d) => d.severity === "error")).toEqual(
    []
  )
  const expected = catalogFromSnapshot(model.physical)
  const actual = extracted.model
  for (const table of actual.tables)
    for (const text of expressionTexts(table)) expect(text.trim()).not.toBe("")
  const tablesOnly = (m: Pick<CatalogModel, "tables" | "enumTypes">) => ({
    tables: m.tables.map(withoutExpressionTexts),
    enumTypes: m.enumTypes,
    units: [],
  })
  expect(diffCatalogModels(tablesOnly(expected), tablesOnly(actual))).toEqual(
    []
  )
  expect(actual.units.map((u) => u.identity)).toEqual(
    databaseIdentities(model.sqlUnits)
  )
}

/** Таблиця `app.note` фікстур одиниць. */
function note() {
  return customTable("Note", {
    columns: [
      {
        id: uuid(201),
        name: "id",
        physicalName: "id",
        type: "UUID",
        notNull: true,
      },
      { id: uuid(202), name: "body", physicalName: "body", type: "Text" },
    ],
    primaryKey: { name: "note_pk", columns: ["id"] },
    rowLevelSecurity: "enabled",
  })
}

/**
 * Одиниці всіх класів, які оголошує `.sql` (спека П2 §8.3), над таблицею
 * `CustomTable`: гранти кількох ролей на кілька об'єктів, членство в
 * publication, `REPLICA IDENTITY`, налаштування функції.
 */
function unitClasses(): Map<string, string> {
  return metaFiles({
    "project.meta.json": project({ defaultSchema: "app" }),
    "custom-tables/Note/Note.meta.json": note(),
    "sql/app/units.sql": [
      "CREATE FUNCTION app.note_count(p_from int, p_note uuid) RETURNS bigint",
      "  LANGUAGE sql STABLE AS $$ SELECT count(*) FROM app.note $$;",
      "ALTER FUNCTION app.note_count(int, uuid) SET search_path = app;",
      "CREATE PROCEDURE app.touch() LANGUAGE sql AS $$ SELECT 1 $$;",
      "CREATE AGGREGATE app.total(int) (SFUNC = int4pl, STYPE = int);",
      "CREATE FUNCTION app.note_stamp() RETURNS trigger LANGUAGE plpgsql",
      "  AS $$ BEGIN RETURN NEW; END $$;",
      "CREATE TRIGGER note_stamp BEFORE INSERT ON app.note",
      "  FOR EACH ROW EXECUTE FUNCTION app.note_stamp();",
      "CREATE POLICY note_read ON app.note FOR SELECT TO authenticated USING (body IS NOT NULL);",
      "CREATE VIEW app.note_view AS SELECT id, body FROM app.note;",
      "CREATE MATERIALIZED VIEW app.note_totals AS SELECT count(*) AS n FROM app.note;",
      "CREATE SEQUENCE app.note_seq;",
      "ALTER SEQUENCE app.note_seq OWNED BY app.note.body;",
      "CREATE DOMAIN app.positive AS int CONSTRAINT positive_check CHECK (VALUE > 0);",
      "COMMENT ON VIEW app.note_view IS 'Notes';",
      "GRANT USAGE ON SCHEMA app TO authenticated, anon;",
      "GRANT SELECT, INSERT ON app.note, app.note_view TO authenticated, anon;",
      "GRANT UPDATE ON app.note TO authenticated;",
      "GRANT EXECUTE ON FUNCTION app.note_count(int, uuid) TO authenticated;",
      "ALTER PUBLICATION supabase_realtime ADD TABLE app.note;",
      "ALTER TABLE app.note REPLICA IDENTITY FULL;",
      "",
    ].join("\n"),
  })
}

/**
 * Типові привілеї окремо: роль застосовує їх до кожного об'єкта, який створює
 * після них, і каталог тримає ці права як звичайні гранти, яких жоден
 * оператор не оголошує. Тож тут немає об'єктів виду, якого вони стосуються.
 */
function defaultPrivileges(): Map<string, string> {
  return metaFiles({
    "project.meta.json": project({ defaultSchema: "app" }),
    "custom-tables/Note/Note.meta.json": note(),
    "sql/app/units.sql":
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT SELECT, USAGE ON SEQUENCES TO anon, authenticated;\n",
  })
}

describe("extract maps pg-delta facts into the catalog model", () => {
  for (const [name, fixture] of FIXTURES) {
    it(name, async () => {
      await expectExtractMatchesModel(fixture())
    })
  }

  it("reference domain", async () => {
    await expectExtractMatchesModel(readReferenceDomain())
  })

  it("every unit class maps to the compiler identity", async () => {
    await expectExtractMatchesModel(unitClasses())
  })

  it("default privileges map to pairs", async () => {
    await expectExtractMatchesModel(defaultPrivileges())
  })

  it("the lists of tolerated differences carry their reasons", () => {
    for (const [, reason] of [...EXPRESSION_PATHS, ...HELD_DIFFERENTLY])
      expect(reason).not.toBe("")
  })
})

describe("properties without a model field are loud", () => {
  const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

  it("unlogged table and not valid foreign key are unrepresentable", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      create table app.parent (id int primary key);
      create unlogged table app.scratch (id int);
      create table app.child (id int primary key, parent_id int);
      alter table app.child add constraint child_parent_fk
        foreign key (parent_id) references app.parent (id) not valid;
      `,
      scope
    )
    const unrepresentable = extracted.diagnostics
      .filter((d) => d.code === "engine.unrepresentable")
      .map((d) => ({ object: d.object, severity: d.severity }))
    expect(unrepresentable).toEqual(
      expect.arrayContaining([
        { object: "table:app.scratch", severity: "error" },
        { object: "constraint:app.child.child_parent_fk", severity: "error" },
      ])
    )
    expect(unrepresentable).toHaveLength(2)
    expect(
      extracted.diagnostics.find((d) => d.object === "table:app.scratch")
        ?.message
    ).toContain("persistence")
    const child = extracted.model.tables.find((t) => t.name === "child")
    expect(child?.foreignKeys).toEqual([])
  })

  it("replica identity full is a unit", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      create table app.doc (id int primary key);
      alter table app.doc replica identity full;
      `,
      scope
    )
    expect(extracted.diagnostics.filter((d) => d.severity === "error")).toEqual(
      []
    )
    expect(extracted.model.units).toEqual([
      {
        class: "replicaIdentity",
        identity: "replicaIdentity:app.doc",
        schema: "app",
        name: "doc",
        sql: "ALTER TABLE app.doc REPLICA IDENTITY FULL",
      },
    ])
  })
})
