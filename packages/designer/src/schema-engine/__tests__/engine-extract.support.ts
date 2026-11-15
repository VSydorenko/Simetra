import { expect } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  catalogFromSnapshot,
  diffCatalogModels,
  type CatalogModel,
  PROVIDER_OWNER_ROLES,
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
  testDatabaseUrl,
  acceptDebt,
  customTable,
  metaFiles,
  project,
  uuid,
  testProvider,
  testRoleFor,
} from "../../../../simetra/test/support"

/**
 * Спільна підготовка тестів extract порту: рендер бажаного стану в тіні →
 * extract → модель дорівнює знімку компілятора. Розбіжність поза переліченими
 * нижче шляхами текстів виразів — дефект мапера, а не привід розширити
 * перелік.
 */

/** Ролі профілю в SQL фікстур: ролі API (user, anonymous) і власник схеми. */
const USER = testRoleFor("user")
const ANON = testRoleFor("anonymous")
const OWNER = PROVIDER_OWNER_ROLES[testProvider()]

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

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

/**
 * Предмет — відповідність одиниць extract і моделі, а не ратчет боргу: увесь
 * борг фікстури прийнято.
 */
export async function compiled(
  files: Map<string, string>
): Promise<CompiledModel> {
  const result = await compile(await acceptDebt(files))
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/** Рендер у тіні → extract тіні. */
export async function extractDesired(
  desiredSql: string,
  scope: EngineScope
): Promise<Extracted> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
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

/** Привілеї оператора; `all` — повний перелік класу об'єкта. */
function expandAll(type: string, privileges: string): string[] {
  if (privileges !== "all") return splitList(privileges)
  const all = ALL_PRIVILEGES[type]
  if (all === undefined) throw new Error(`no privilege list for ${type}`)
  return [...all]
}

/** Роздільник колонки в ключі пари: в ідентичність він не потрапляє. */
const COLUMN_KEY = "\u0000"

/**
 * Ідентичності одиниць компілятора у формі бази: оператор розгорнуто в пари
 * факту, налаштування функції — у її ідентичність.
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
        // extract бачить відкликання лише як різницю з типовим ACL об'єкта:
        // у функції це вбудований EXECUTE для PUBLIC. Відкликання в ролі, що
        // права не мала, у каталозі нічого не лишає
        if (verb === "revoke") {
          if (type === "function" && roles!.toLowerCase() === "public")
            for (const object of splitList(objects!))
              out.add(`grant:revoke:${type}:${object}:public:${privileges}`)
          break
        }
        if (verb !== "grant")
          throw new Error(`fixture form not expanded: ${unit.identity}`)
        // Колонковий привілей живе в ACL колонки (`pg_attribute.attacl`):
        // запис на (об'єкт, отримувач, колонка), тож пара — на колонку
        for (const object of splitList(objects!))
          for (const role of roles!.split(","))
            for (const privilege of expandAll(type!, privileges!)) {
              const key = `grant:grant:${type}:${object}:${role}`
              const columns = /^(\w+)\((.*)\)$/.exec(privilege)
              if (columns === null) pair(key, [privilege])
              else
                for (const column of columns[2]!.split(","))
                  pair(`${key}${COLUMN_KEY}${column}`, [
                    `${columns[1]}(${column})`,
                  ])
            }
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
    out.add(`${key.split(COLUMN_KEY)[0]}:${[...privileges].sort().join(",")}`)
  return [...out].sort()
}

/**
 * Модель extract дорівнює знімку компілятора з точністю до текстів виразів,
 * а одиниці — одиницям компілятора у формі бази.
 */
export async function expectExtractMatchesModel(files: Map<string, string>) {
  const model = await compiled(files)
  const extracted = await extractDesired(
    renderDesiredState(model).sql,
    (await engineScope(model)).scope
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
  expect(
    diffCatalogModels(tablesOnly(expected), tablesOnly(actual), {
      columnOrder: true,
    })
  ).toEqual([])
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
export function unitClasses(
  extraUnits: readonly string[] = []
): Map<string, string> {
  return metaFiles({
    "project.meta.json": project({
      defaultSchema: "app",
      database: { provider: testProvider() },
    }),
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
      `CREATE POLICY note_read ON app.note FOR SELECT TO ${USER} USING (body IS NOT NULL);`,
      "CREATE VIEW app.note_view AS SELECT id, body FROM app.note;",
      "CREATE MATERIALIZED VIEW app.note_totals AS SELECT count(*) AS n FROM app.note;",
      "CREATE SEQUENCE app.note_seq;",
      "ALTER SEQUENCE app.note_seq OWNED BY app.note.body;",
      "CREATE DOMAIN app.positive AS int CONSTRAINT positive_check CHECK (VALUE > 0);",
      "COMMENT ON VIEW app.note_view IS 'Notes';",
      `GRANT USAGE ON SCHEMA app TO ${USER}, ${ANON};`,
      `GRANT SELECT, INSERT ON app.note, app.note_view TO ${USER}, ${ANON};`,
      `GRANT UPDATE ON app.note TO ${USER};`,
      // ADP дає `anon` SELECT на кожну таблицю, створену після нього (порядок
      // створення ставить його перед об'єктами схеми): рівні йому гранти
      // неявні, а `note_totals` має більше — явна одиниця
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA app GRANT SELECT ON TABLES TO ${ANON};`,
      `GRANT SELECT, UPDATE ON app.note_totals TO ${ANON};`,
      // Коментар control-файлу розширення ставить сам CREATE EXTENSION: він
      // неявний, тож одиниці коментаря немає
      "CREATE EXTENSION citext WITH SCHEMA extensions;",
      `GRANT EXECUTE ON FUNCTION app.note_count(int, uuid) TO ${USER};`,
      "ALTER TABLE app.note REPLICA IDENTITY FULL;",
      ...extraUnits,
      "",
    ].join("\n"),
  })
}
