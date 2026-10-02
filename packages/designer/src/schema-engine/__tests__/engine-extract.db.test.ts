import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  catalogFromSnapshot,
  diffCatalogModels,
  type CatalogModel,
  type CatalogTable,
} from "simetra/model"
import {
  ALL_PRIVILEGES,
  engineScope,
  type EngineScope,
  renderDesiredState,
  type Extracted,
} from "simetra/schema"
import { createPgDeltaEngine } from ".."
import {
  shadowDatabaseCount,
  testDatabaseUrl,
  readReferenceDomain,
  customTable,
  metaFiles,
  project,
  uuid,
  FIXTURES,
} from "../../../../simetra/test/support"

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
]

const EXPRESSION = "<expression>"

/**
 * Значення з текстом за шляхом (`*` — кожен елемент масиву), заміненим на
 * маркер; знайдені тексти — у `found`. Порожній текст лишається як є.
 */
function masked(
  value: unknown,
  path: readonly string[],
  found: string[]
): unknown {
  const [head, ...rest] = path
  if (head === undefined) {
    if (typeof value !== "string") return value
    found.push(value)
    return value.trim() === "" ? value : EXPRESSION
  }
  if (head === "*")
    return Array.isArray(value)
      ? value.map((v) => masked(v, rest, found))
      : value
  if (value === null || typeof value !== "object" || !(head in value))
    return value
  const record = value as Record<string, unknown>
  return { ...record, [head]: masked(record[head], rest, found) }
}

/** Таблиця з текстами виразів за `EXPRESSION_PATHS`, заміненими на маркер. */
function withoutExpressionTexts(
  table: CatalogTable,
  found: string[] = []
): CatalogTable {
  let out: unknown = table
  for (const [path] of EXPRESSION_PATHS)
    out = masked(out, path.split("."), found)
  return out as CatalogTable
}

async function compiled(files: Map<string, string>): Promise<CompiledModel> {
  const result = await compile(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
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

/** Привілеї оператора; `all` — повний перелік класу об'єкта (рішення B). */
function expandAll(type: string, privileges: string): string[] {
  if (privileges !== "all") return splitList(privileges)
  const all = ALL_PRIVILEGES[type]
  if (all === undefined) throw new Error(`no privilege list for ${type}`)
  return [...all]
}

/**
 * Ідентичності одиниць компілятора у формі бази: оператор розгорнуто в пари
 * факту (рішення за спайком, 5), налаштування функції — у її ідентичність.
 * Класи, які база тримає інакше, ніж оператор компілятора, — гілки нижче.
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
      // `ALTER FUNCTION … SET` живе в pg_proc.proconfig і друкується в
      // дефініції функції, тож це одиниця функції
      case "functionSettings": {
        const signature = parts.slice(1).join(":")
        out.add(
          own.has(`procedure:${signature}`)
            ? `procedure:${signature}`
            : `function:${signature}`
        )
        break
      }
      // Каталог тримає один ACL-запис на (об'єкт, отримувач), зливаючи права
      // всіх операторів пари, а ALL — повним переліком прав класу
      case "grant": {
        const [, verb, type, objects, roles, privileges] = parts
        if (verb !== "grant" || type!.startsWith("allInSchema."))
          throw new Error(`fixture form not expanded: ${unit.identity}`)
        for (const object of splitList(objects!))
          for (const role of roles!.split(","))
            pair(
              `grant:grant:${type}:${object}:${role}`,
              expandAll(type!, privileges!)
            )
        break
      }
      // pg_default_acl — запис на (роль, схема, тип об'єкта, отримувач)
      case "defaultPrivileges": {
        const [, roles, schemas, type, verb, grantees, privileges] = parts
        for (const role of roles!.split(","))
          for (const schema of schemas!.split(","))
            for (const grantee of grantees!.split(","))
              pair(
                `defaultPrivileges:${role}:${schema}:${type}:${verb}:${grantee}`,
                expandAll(type!, privileges!)
              )
        break
      }
      // pg_publication_rel — рядок на (publication, таблиця); SET лишає ті
      // самі рядки, що й ADD
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
    engineScope(model).scope
  )
  expect(extracted.diagnostics.filter((d) => d.severity === "error")).toEqual(
    []
  )
  const expected = catalogFromSnapshot(model.physical)
  const actual = extracted.model
  const texts: string[] = []
  for (const table of actual.tables) withoutExpressionTexts(table, texts)
  for (const text of texts) expect(text.trim()).not.toBe("")
  const tablesOnly = (m: Pick<CatalogModel, "tables" | "enumTypes">) => ({
    tables: m.tables.map((t) => withoutExpressionTexts(t)),
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
 * `CustomTable`: гранти кількох ролей на кілька об'єктів, типові привілеї,
 * членство в publication, `REPLICA IDENTITY`, налаштування функції,
 * розширення.
 */
function unitClasses(): Map<string, string> {
  return metaFiles({
    "project.meta.json": project({ defaultSchema: "app" }),
    "custom-tables/Note/Note.meta.json": note(),
    // Таблиця моделі без грантів: права ADP вона отримує, лише якщо ADP
    // створено раніше за неї
    "custom-tables/Tag/Tag.meta.json": customTable("Tag", {
      columns: [
        {
          id: uuid(211),
          name: "id",
          physicalName: "id",
          type: "UUID",
          notNull: true,
        },
      ],
      primaryKey: { name: "tag_pk", columns: ["id"] },
    }),
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
      "GRANT ALL ON app.note_view TO service_role;",
      // ADP дає `anon` SELECT на кожну таблицю, створену після нього (порядок
      // створення ставить його перед об'єктами схеми): рівні йому гранти
      // неявні, а `note_totals` має більше — явна одиниця
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT SELECT ON TABLES TO anon;",
      "GRANT SELECT, UPDATE ON app.note_totals TO anon;",
      // Коментар control-файлу розширення ставить сам CREATE EXTENSION: він
      // неявний, тож одиниці коментаря немає
      "CREATE EXTENSION citext WITH SCHEMA extensions;",
      "GRANT EXECUTE ON FUNCTION app.note_count(int, uuid) TO authenticated;",
      "ALTER PUBLICATION supabase_realtime ADD TABLE app.note;",
      "ALTER TABLE app.note REPLICA IDENTITY FULL;",
      "",
    ].join("\n"),
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

  it("not valid domain constraint is unrepresentable", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      create domain app.d as int;
      alter domain app.d add constraint d_positive check (value > 0) not valid;
      `,
      scope
    )
    expect(
      extracted.diagnostics
        .filter((d) => d.code === "engine.unrepresentable")
        .map((d) => d.object)
    ).toEqual(["constraint:app.d.d_positive"])
  })

  it("force row level security without enable is unrepresentable", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      create table app.doc (id int primary key);
      alter table app.doc force row level security;
      `,
      scope
    )
    const found = extracted.diagnostics.filter(
      (d) => d.code === "engine.unrepresentable"
    )
    expect(found.map((d) => d.object)).toEqual(["table:app.doc"])
    expect(found[0]?.message).toContain("forceRowSecurity")
  })

  it("a grant equal to the schema default privileges is implicit", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      create table app.older (id int);
      alter default privileges for role postgres in schema app
        grant select on tables to anon;
      create table app.fresh (id int);
      create table app.extra (id int);
      grant insert on app.extra to anon;
      `,
      scope
    )
    expect(extracted.diagnostics.filter((d) => d.severity === "error")).toEqual(
      []
    )
    // `fresh` має рівно права ADP — неявні; `older` створено до ADP, тож
    // прав ADP у нього немає — явне відкликання; `extra` має більше — грант
    expect(extracted.model.units.map((u) => u.identity)).toEqual([
      "defaultPrivileges:postgres:app:table:grant:anon:select",
      "grant:grant:table:app.extra:anon:insert,select",
      "grant:revoke:table:app.older:anon:select",
    ])
  })

  it("default privileges missing on an identity sequence are a revoke", async () => {
    const older = await extractDesired(
      `
      create schema app;
      create table app.counter (id bigint generated always as identity primary key);
      alter default privileges for role postgres in schema app
        grant select on sequences to anon;
      `,
      scope
    )
    expect(older.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(older.model.units.map((u) => u.identity)).toEqual([
      "defaultPrivileges:postgres:app:sequence:grant:anon:select",
      "grant:revoke:sequence:app.counter_id_seq:anon:select",
    ])
    // Контроль: ADP раніше за таблицю — права послідовності неявні
    const fresh = await extractDesired(
      `
      create schema app;
      alter default privileges for role postgres in schema app
        grant select on sequences to anon;
      create table app.counter (id bigint generated always as identity primary key);
      `,
      scope
    )
    expect(fresh.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(fresh.model.units.map((u) => u.identity)).toEqual([
      "defaultPrivileges:postgres:app:sequence:grant:anon:select",
    ])
  })

  it("a revoke that also drops a default grant option is unrepresentable", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      alter default privileges for role postgres in schema app
        grant select, insert on tables to anon with grant option;
      create table app.doc (id int);
      revoke insert on app.doc from anon cascade;
      revoke grant option for select on app.doc from anon cascade;
      `,
      scope
    )
    const found = extracted.diagnostics.filter(
      (d) => d.code === "engine.unrepresentable"
    )
    expect(found.map((d) => d.object)).toEqual(["acl:(table:app.doc).anon"])
    expect(found[0]?.message).toContain("grantable")
  })

  it("a grant option narrower than the default privileges is unrepresentable", async () => {
    const extracted = await extractDesired(
      `
      create schema app;
      alter default privileges for role postgres in schema app
        grant select on tables to anon with grant option;
      create table app.doc (id int);
      revoke grant option for select on app.doc from anon cascade;
      `,
      scope
    )
    // Права рівні типовим, а опцію відкликано: GRANT без опції її не прибрав
    // би, тож одиниця була б хибною
    const found = extracted.diagnostics.filter(
      (d) => d.code === "engine.unrepresentable"
    )
    expect(found.map((d) => d.object)).toEqual(["acl:(table:app.doc).anon"])
    expect(found[0]?.message).toContain("grantable")
    expect(
      extracted.model.units.filter((u) => u.identity.includes("app.doc"))
    ).toEqual([])
  })

  it("extension comment is implicit unless it differs from the control file", async () => {
    const plain = await extractDesired(
      "create extension citext with schema extensions;",
      scope
    )
    expect(plain.model.units.map((u) => u.identity)).toEqual([
      "extension:citext",
    ])
    const commented = await extractDesired(
      `
      create extension citext with schema extensions;
      comment on extension citext is 'case-insensitive text for app';
      `,
      scope
    )
    expect(commented.model.units.map((u) => u.identity)).toEqual([
      "comment:extension:citext",
      "extension:citext",
    ])
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
