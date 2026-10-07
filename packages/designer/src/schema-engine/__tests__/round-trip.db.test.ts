import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  compile,
  loadSqlParser,
  type CompiledModel,
  type SchemaPathResolver,
  type SqlParser,
} from "simetra/compiler"
import {
  compareWithDesired,
  engineScope,
  renderDesiredState,
  reverseGenerate,
  type DbConnection,
  type DesiredComparison,
  type EngineDiagnostic,
  type EngineScope,
  type Extracted,
} from "simetra/schema"
import { createPgDeltaEngine } from ".."
import {
  shadowDatabaseCount,
  testDatabaseUrl,
  readReferenceDomain,
  FIXTURES,
} from "../../../../simetra/test/support"
import {
  CLASS_FIXTURES,
  readOracle,
  type OracleShape,
} from "./fixtures/round-trip-classes"

/**
 * Повний round-trip (спека П2 §9, план E2b, задача 4): ціль — тінь із SQL
 * фікстури → extract → зворотна генерація в порожню теку → компіляція →
 * рендер → звірка з тінню рендера. Порожньої звірки замало (рішення 10):
 * незалежний читач `pg_catalog` мусить бачити властивість класу і в цілі, і
 * в тіні, тож однакова втрата з обох боків extract-у не пройде.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

const schemaPath: SchemaPathResolver = (_file, schemaFile) =>
  `schemas/${schemaFile}`

const errors = (diagnostics: readonly { severity: string }[]) =>
  diagnostics.filter((d) => d.severity === "error")

async function withClient<T>(
  db: DbConnection,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: db.url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Розгортає `sql` у тінь-ціль поруч зі стеком; тінь прибирає порт. */
async function inTarget<T>(
  sql: string,
  scope: EngineScope,
  fn: (target: DbConnection) => Promise<T>
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    sql,
    scope,
    (target) => fn(target)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

interface Project {
  defaultSchema: string
  attributeCase: CompiledModel["project"]["naming"]["attributeCase"]
}

interface RoundTrip {
  extracted: Extracted
  model: CompiledModel
  scope: EngineScope
  comparison: Extract<DesiredComparison, { status: "compared" }>
  target: OracleShape
  shadow: OracleShape
}

/**
 * Ланцюжок §9 над уже розгорнутою ціллю. Кожна ланка — без помилок, звірка —
 * порожня, а оракул читає ціль і окрему тінь того самого рендера.
 */
async function roundTripOf(
  target: DbConnection,
  extractScope: EngineScope,
  project: Project
): Promise<RoundTrip> {
  const extracted = await engine.extract(target, extractScope)
  expect(errors(extracted.diagnostics)).toEqual([])

  const reversed = await reverseGenerate(extracted.model, {
    project: { name: "RoundTrip", ...project },
    existing: new Map(),
    newId: () => randomUUID(),
    schemaPath,
    parse,
  })
  expect(errors(reversed.diagnostics)).toEqual([])

  const compiled = await compile(reversed.files)
  expect(errors(compiled.diagnostics)).toEqual([])
  const model = compiled.model!
  const sql = renderDesiredState(model).sql
  const { scope, diagnostics } = await engineScope(model)
  // Межа з метаданих — та сама, що й межа читання: інакше звірка дивилася б
  // не на ті схеми, з яких прочитано базу
  expect([...scope.schemas].sort()).toEqual([...extractScope.schemas].sort())

  const comparison = await compareWithDesired(
    engine,
    { target: target },
    sql,
    scope,
    diagnostics
  )
  expect(
    comparison.status === "compared" ? [] : comparison.diagnostics
  ).toEqual([])
  if (comparison.status !== "compared") throw new Error("shadow failed")
  // Спершу — що саме не порожнє, а не голе `false`
  expect({
    actions: comparison.plan.actions.map((a) => a.sql),
    differences: comparison.differences,
    errors: errors(comparison.diagnostics),
  }).toEqual({ actions: [], differences: [], errors: [] })
  expect(comparison.empty).toBe(true)

  const schemas = [...scope.schemas]
  const oracle = await engine.withDesiredShadow(
    { target: target },
    sql,
    scope,
    async (shadow) => ({
      target: await withClient(target, (c) => readOracle(c, schemas)),
      shadow: await withClient(shadow, (c) => readOracle(c, schemas)),
    })
  )
  if (oracle.status !== "loaded") throw new Error("oracle shadow failed")
  return { extracted, model, scope, comparison, ...oracle.value }
}

const scopeOf = (schemas: string[]): EngineScope => ({
  schemas,
  provider: "supabase",
})

describe("class fixtures survive the round trip", () => {
  for (const fixture of CLASS_FIXTURES) {
    it(fixture.name, async () => {
      const scope = scopeOf(fixture.schemas)
      await inTarget(fixture.sql, scope, async (target) => {
        const result = await roundTripOf(target, scope, {
          defaultSchema: "app",
          attributeCase: "snake_case",
        })
        // Властивість класу є в цілі (фікстура її створила) і в тіні
        expect(fixture.property(result.target)).toEqual(fixture.expected)
        expect(fixture.property(result.shadow)).toEqual(fixture.expected)
        expect(result.shadow).toEqual(result.target)
      })
    })
  }
})

describe("the builtin PUBLIC privilege beside a schema ADP", () => {
  it("builtin PUBLIC execute beside a schema ADP writes no PUBLIC grant", async () => {
    // Маркер двигуна для рядка ADP схеми не означає відкликання: вбудований
    // `EXECUTE` для `PUBLIC` не має ставати ні `GRANT`, ні `REVOKE`
    const scope = scopeOf(["app"])
    await inTarget(
      `CREATE SCHEMA app;
       ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO anon;
       CREATE FUNCTION app.open() RETURNS int LANGUAGE sql AS $$ select 1 $$;`,
      scope,
      async (target) => {
        const result = await roundTripOf(target, scope, {
          defaultSchema: "app",
          attributeCase: "snake_case",
        })
        // Лише гранти на об'єкти: рядок ADP схеми з синтезованим маркером
        // `PUBLIC` — окрема одиниця `defaultPrivileges`, поза цією перевіркою
        expect(
          result.extracted.model.units.filter(
            (u) => u.class === "grant" && /\bPUBLIC\b/i.test(u.sql)
          )
        ).toEqual([])
        const publicAcl = (shape: OracleShape) =>
          shape.acls
            .find((a) => a.object === "f:app.open()")
            ?.acl.filter((item) => item.startsWith("="))
        expect(publicAcl(result.target)).toEqual(["=X/postgres"])
        expect(publicAcl(result.shadow)).toEqual(["=X/postgres"])
      }
    )
  })
})

describe("a role of the application's own", () => {
  it("is assumed, and a grant to it survives the round trip", async () => {
    // Роль — інфраструктура кластера (спека §6.9): межа керує грантами на неї,
    // а не нею самою. Роль кластерна, тож видна й тіні поруч із ціллю;
    // прибирається в `finally`
    const role = "simetra_round_trip_reader"
    const admin = { url: testDatabaseUrl() }
    await withClient(admin, async (c) => {
      await c.query(`DROP ROLE IF EXISTS ${role}`)
      await c.query(`CREATE ROLE ${role} NOLOGIN`)
    })
    try {
      const scope = scopeOf(["app"])
      await inTarget(
        `CREATE SCHEMA app;
         CREATE TABLE app.report (id uuid PRIMARY KEY, body text);
         GRANT SELECT ON app.report TO ${role};`,
        scope,
        async (target) => {
          const result = await roundTripOf(target, scope, {
            defaultSchema: "app",
            attributeCase: "snake_case",
          })
          expect(
            result.extracted.model.units
              .filter((u) => u.class === "grant")
              .map((u) => u.sql)
          ).toEqual([expect.stringContaining(role)])
          const granted = (shape: OracleShape) =>
            shape.acls
              .find((a) => a.object === "r:app.report")
              ?.acl.filter((item) => item.startsWith(`${role}=`))
          expect(granted(result.target)).toEqual([`${role}=r/postgres`])
          expect(granted(result.shadow)).toEqual([`${role}=r/postgres`])
        }
      )
    } finally {
      await withClient(admin, (c) => c.query(`DROP ROLE IF EXISTS ${role}`))
    }
  })
})

/** Ключ таблиці моделі: схема й фізичне ім'я. */
const tableKeys = (model: CompiledModel) =>
  model.physical.tables.map((t) => `${t.schema}.${t.name}`).sort()

async function corpusRoundTrip(files: Map<string, string>) {
  const original = await compile(files)
  expect(errors(original.diagnostics)).toEqual([])
  const source = original.model!
  const { scope } = await engineScope(source)
  await inTarget(renderDesiredState(source).sql, scope, async (target) => {
    const result = await roundTripOf(target, scope, {
      defaultSchema: source.project.defaultSchema,
      attributeCase: source.project.naming.attributeCase,
    })
    // Види 1С повертаються як `CustomTable` з тими самими фізичними іменами
    expect(tableKeys(result.model)).toEqual(tableKeys(source))
    expect(
      [...new Set(result.model.objects.map((o) => o.kind))].filter(
        (kind) => kind !== "CustomTable" && kind !== "PgEnum"
      )
    ).toEqual([])
    expect(result.shadow).toEqual(result.target)
  })
}

describe("the E1 corpus and the reference domain survive the round trip", () => {
  for (const [name, fixture] of FIXTURES) {
    it(name, async () => {
      await corpusRoundTrip(fixture())
    })
  }

  it("reference domain", async () => {
    await corpusRoundTrip(readReferenceDomain())
  })
})

/** Діагностики extract-у цілі з `sql`. */
async function extractDiagnostics(
  sql: string,
  schemas: string[]
): Promise<EngineDiagnostic[]> {
  const scope = scopeOf(schemas)
  return inTarget(
    sql,
    scope,
    async (target) => (await engine.extract(target, scope)).diagnostics
  )
}

describe("what the round trip cannot carry is loud", () => {
  it("an exclusion constraint is unrepresentable by name", async () => {
    const diagnostics = await extractDiagnostics(
      `CREATE SCHEMA app;
       CREATE TABLE app.booking (
         id uuid PRIMARY KEY,
         during tstzrange NOT NULL,
         CONSTRAINT booking_no_overlap EXCLUDE USING gist (during WITH &&)
       );`,
      ["app"]
    )
    // Модель каталогу не має поля для EXCLUDE, тож до генератора воно не
    // доходить: гучно його називає вже extract, і `introspect` не пише нічого
    const messages = diagnostics
      .filter((d) => d.code === "engine.unrepresentable")
      .map((d) => d.message)
    expect(messages).toEqual([
      expect.stringMatching(/booking_no_overlap.*exclusion/),
    ])
    expect(messages[0]).toContain("app.booking")
  })

  it("an owner other than the session role is unrepresentable by name", async () => {
    // Таблицю ролі провайдера (`authenticated`) політика двигуна виключає, і
    // її ловить перепис; власника поза ролями провайдера двигун читає ребром
    // `owner`, якого модель не має. Роль кластерна — прибирається в `finally`
    const role = "simetra_round_trip_owner"
    const admin = { url: testDatabaseUrl() }
    await withClient(admin, async (c) => {
      await c.query(`DROP ROLE IF EXISTS ${role}`)
      await c.query(`CREATE ROLE ${role} NOLOGIN`)
      await c.query(`GRANT ${role} TO current_user`)
    })
    try {
      const diagnostics = await extractDiagnostics(
        `CREATE SCHEMA app;
         CREATE TABLE app.ledger (id uuid PRIMARY KEY);
         GRANT CREATE ON SCHEMA app TO ${role};
         ALTER TABLE app.ledger OWNER TO ${role};`,
        ["app"]
      )
      // Сама роль — припущена інфраструктура кластера, не помилка: гучна
      // лише таблиця з чужим власником
      expect(
        diagnostics
          .filter((d) => d.code === "engine.unrepresentable")
          .map((d) => d.message)
      ).toEqual([
        `table:app.ledger: property owner cannot be represented in the catalog model: owner role:${role} is not the default owner`,
      ])
    } finally {
      await withClient(admin, (c) => c.query(`DROP ROLE IF EXISTS ${role}`))
    }
  })

  it("a cast is an unmodeled class", async () => {
    const diagnostics = await extractDiagnostics(
      `CREATE SCHEMA app;
       CREATE TYPE app.pair AS (a int, b int);
       CREATE CAST (app.pair AS text) WITH INOUT;`,
      ["app"]
    )
    expect(
      diagnostics
        .filter((d) => d.code === "engine.unmodeled-class")
        .map((d) => d.message)
    ).toEqual([expect.stringMatching(/^1 object\(s\) of class cast /)])
  })
})
