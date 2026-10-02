import { resolveProfile } from "@supabase/pg-delta"
import { resolveView } from "@supabase/pg-delta/policy"
import pg from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  createPgDeltaEngine,
  renderDesiredState,
  type DbConnection,
  type EngineScope,
  type Extracted,
} from "simetra/schema"
import { readCensus, type CensusCount } from "../engine/census"
import { COVERED_CLASSES, factKindOf } from "../engine/pg-delta/census-facts"
import { scopeProfile } from "../engine/pg-delta/policy"
import { SUPABASE_SCHEMAS } from "../engine/provider/supabase"
import {
  shadowDatabaseCount,
  testDatabaseUrl,
  testSuperuserUrl,
} from "../../../test/db/connection"
import { FIXTURES } from "./fixtures/e1-fixtures"

/**
 * Перепис класів у межі керування (план E2a, рішення 8): клас, якого двигун
 * не бачить, дає помилку, а не тихе «порожньо» (Review Focus 5); стан
 * заповнення подання extract віддає для звірки з тінню.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

async function withPool<T>(
  db: DbConnection,
  fn: (pool: pg.Pool) => Promise<T>
): Promise<T> {
  const pool = new pg.Pool({ connectionString: db.url })
  try {
    return await fn(pool)
  } finally {
    await pool.end()
  }
}

/**
 * Бажаний SQL у тіні → `fn` над тінню. Діагностики тіні тут не перевіряються:
 * непокриті класи двигун сам позначає `unmodeled_drift` (цілі їх бракує).
 */
async function inShadow<T>(
  desiredSql: string,
  shadowScope: EngineScope,
  fn: (shadow: DbConnection) => Promise<T>
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    stack,
    desiredSql,
    shadowScope,
    (shadow) => fn(shadow)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `shadow did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

interface ShadowFacts {
  extracted: Extracted
  census: CensusCount[]
}

async function extractWithCensus(
  desiredSql: string,
  shadowScope: EngineScope = scope
): Promise<ShadowFacts> {
  return inShadow(desiredSql, shadowScope, async (shadow) => ({
    extracted: await engine.extract(shadow, shadowScope),
    census: await withPool(shadow, (pool) => readCensus(pool, shadowScope)),
  }))
}

function errorsOf(extracted: Extracted, code: string) {
  return extracted.diagnostics
    .filter((d) => d.code === code)
    .map((d) => ({
      severity: d.severity,
      object: d.object,
      message: d.message,
    }))
}

/**
 * Об'єкти класів поза моделлю двигуна (casts, text search, statistics —
 * `unmodeled_kind` двигуна; conversion — без жодного сигналу двигуна) поряд
 * із класами, які він моделює.
 */
const BROAD_SQL = `
create schema app;
create type app.mood as enum ('calm', 'angry');
create type app.pair as (a int, b int);
create type app.span as range (subtype = int4);
create domain app.positive as int check (value > 0);
create table app.doc (
  id int primary key,
  a int,
  b int,
  during int4range,
  constraint doc_no_overlap exclude using gist (during with &&)
);
create index doc_a on app.doc (a);
-- Унікальний індекс без обмеження під FK: conindid FK вказує на нього
create table app.ref (code int not null);
create unique index ref_code on app.ref (code);
create table app.ref_child (code int references app.ref (code));
create sequence app.counter;
create view app.doc_view as select id, a from app.doc;
create materialized view app.doc_totals as select count(*) as n from app.doc;
create function app.touch() returns trigger language plpgsql
  as $$ begin return new; end $$;
create procedure app.noop() language sql as $$ select 1 $$;
create aggregate app.total(int) (sfunc = int4pl, stype = int);
create trigger doc_touch before insert on app.doc
  for each row execute function app.touch();
create constraint trigger doc_check after insert on app.doc
  for each row execute function app.touch();
create policy doc_read on app.doc for select using (true);
create rule doc_log as on update to app.doc do also select 1;
create collation app.ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
alter publication supabase_realtime add table app.doc;
alter default privileges for role postgres in schema app grant select on tables to anon;
create extension citext with schema extensions;
create function app.pair_text(app.pair) returns text language sql
  as $$ select ($1).a::text $$;
create cast (app.pair as text) with function app.pair_text(app.pair);
create text search configuration app.simple_ua (copy = simple);
create text search dictionary app.simple_dict (template = simple);
create statistics app.doc_stats on a, b from app.doc;
create conversion app.to_latin for 'UTF8' to 'LATIN1' from utf8_to_iso8859_1;
create function app.pair_eq(app.pair, app.pair) returns boolean language sql
  as $$ select ($1).a = ($2).a $$;
create operator app.=== (leftarg = app.pair, rightarg = app.pair, function = app.pair_eq);
`

describe("class census inside the managed boundary", () => {
  it("unmodeled classes are counted", async () => {
    const { extracted, census } = await extractWithCensus(`
      create schema app;
      create type app.pair as (a int, b int);
      create cast (app.pair as text) with inout;
      create text search configuration app.simple_ua (copy = simple);
      create table app.doc (a int, b int);
      create statistics app.doc_stats on a, b from app.doc;
      create conversion app.to_latin for 'UTF8' to 'LATIN1' from utf8_to_iso8859_1;
    `)
    expect(census).toEqual(
      expect.arrayContaining([
        { class: "cast", count: 1 },
        { class: "conversion", count: 1 },
        { class: "statistics", count: 1 },
        { class: "textSearchConfiguration", count: 1 },
      ])
    )
    const unmodeled = errorsOf(extracted, "engine.unmodeled-class")
    expect(unmodeled.map((d) => d.severity)).toEqual([
      "error",
      "error",
      "error",
      "error",
    ])
    expect(unmodeled.map((d) => d.message)).toEqual([
      expect.stringMatching(/^1 object\(s\) of class cast /),
      expect.stringMatching(/^1 object\(s\) of class conversion /),
      expect.stringMatching(/^1 object\(s\) of class statistics /),
      expect.stringMatching(/^1 object\(s\) of class textSearchConfiguration /),
    ])
    // Перепис уже назвав ці класи в межі — сигнал двигуна без межі не дублює їх
    expect(
      extracted.diagnostics.filter((d) => d.engineCode === "unmodeled_kind")
    ).toEqual([])
  })

  it("unpopulated materialized view is reported, not diagnosed", async () => {
    const view = (populate: "with data" | "with no data") => `
      create schema app;
      create table app.doc (id int primary key);
      create materialized view app.doc_totals as
        select count(*) as n from app.doc ${populate};
    `
    const unpopulated = await extractWithCensus(view("with no data"))
    const populated = await inShadow(
      view("with data"),
      scope,
      async (shadow) => {
        const extracted = await engine.extract(shadow, scope)
        return {
          extracted,
          // Обидва каталоги — під одну межу, тож двигун планує між тінями
          plan: engine.plan(
            unpopulated.extracted.catalog,
            extracted.catalog,
            scope
          ),
        }
      }
    )
    // Модель і план двигуна стану заповнення не бачать
    expect(populated.extracted.model).toEqual(unpopulated.extracted.model)
    expect(populated.plan.empty).toBe(true)
    // Вузький запит бачить; порівнює його звірка, а не перепис
    expect(unpopulated.extracted.unpopulated).toEqual([
      "materializedView:app.doc_totals",
    ])
    expect(populated.extracted.unpopulated).toEqual([])
    expect(
      unpopulated.extracted.diagnostics.filter((d) => d.severity === "error")
    ).toEqual([])
  })

  it("shell type is counted as its own class", async () => {
    // Shell-тип створює лише суперкористувач: тінь під роллю застосунку його не
    // завантажить, тож перепис перевіряється в транзакції стеку з відкатом
    const client = new pg.Client({ connectionString: testSuperuserUrl() })
    await client.connect()
    try {
      await client.query("begin")
      await client.query("create schema census_shell")
      await client.query("create type census_shell.later")
      expect(
        await readCensus(client, {
          schemas: ["census_shell"],
          provider: "supabase",
        })
      ).toEqual([{ class: "type.shell", count: 1 }])
    } finally {
      await client.query("rollback").catch(() => undefined)
      await client.end()
    }
  })

  it("generated column noise is filtered", async () => {
    // Послідовність identity, масив енам-типу, рядковий тип таблиці, індекси
    // обмежень, конструктори й cast до мультидіапазону діапазонного типу
    // Postgres створює сам — це частини своїх об'єктів
    const { extracted, census } = await extractWithCensus(`
      create schema app;
      create type app.mood as enum ('calm', 'angry');
      create type app.span as range (subtype = int4);
      create table app.doc (
        id bigint generated always as identity primary key,
        a int unique,
        b int generated always as (a * 2) stored,
        mood app.mood
      );
      create index doc_b on app.doc (b);
    `)
    expect(census).toEqual([
      { class: "index", count: 1 },
      { class: "table", count: 1 },
      { class: "type.enum", count: 1 },
      { class: "type.range", count: 1 },
    ])
    // Діапазонний тип модель не виражає (`engine.unrepresentable`), але
    // перепис зайвих класів не додає
    expect(
      extracted.diagnostics.filter((d) =>
        ["engine.unmodeled-class", "engine.census-mismatch"].includes(d.code)
      )
    ).toEqual([])
  })
})

/**
 * Види фактів двигуна, яких перепис не рахує окремо: частини й сателіти
 * об'єкта, що рахується, та схема, яку рендер створює зі схем об'єктів.
 */
const SATELLITE_KINDS: readonly [string, string][] = [
  ["schema", "a managed schema is implied by its objects"],
  ["column", "part of its table"],
  ["default", "part of its column"],
  [
    "constraint",
    "part of its table or domain; exclusion and constraint triggers are counted",
  ],
  ["typeAttribute", "part of its composite type"],
  ["acl", "a grant on a counted object"],
  ["comment", "a comment on a counted object"],
  ["securityLabel", "a label on a counted object"],
]

/** Межа фікстури — її схеми без схем провайдера. */
async function fixtureCase(
  files: Map<string, string>
): Promise<[string, EngineScope]> {
  const result = await compile(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  const model = result.model!
  const provider = new Set(SUPABASE_SCHEMAS)
  const schemas = [
    ...new Set([
      ...model.physical.tables.map((t) => t.schema),
      ...model.physical.enumTypes.map((t) => t.schema),
      ...model.sqlUnits.map((u) => u.schema),
    ]),
  ].filter((s) => s !== "" && !provider.has(s))
  return [renderDesiredState(model).sql, { schemas, provider: "supabase" }]
}

/** Керовані факти виду двигуна в тіні, перепис і extract порту тієї ж тіні. */
async function engineKindsAndCensus(
  desiredSql: string,
  shadowScope: EngineScope
): Promise<{
  kinds: Set<string>
  census: CensusCount[]
  extracted: Extracted
}> {
  return inShadow(desiredSql, shadowScope, async (shadow) => ({
    extracted: await engine.extract(shadow, shadowScope),
    ...(await withPool(shadow, async (pool) => {
      const profile = await resolveProfile(pool, scopeProfile(shadowScope))
      const { factBase } = await profile.extract(pool)
      const options = profile.planOptions
      const view = resolveView(
        factBase,
        options.policy,
        options.capability,
        options.baseline
      )
      const kinds = new Set(
        view
          .facts()
          .filter((f) => !view.isReferenceOnly(f.id))
          .map((f) => f.id.kind)
      )
      return { kinds, census: await readCensus(pool, shadowScope) }
    })),
  }))
}

describe("covered classes match the pinned engine", () => {
  const covered = new Set(COVERED_CLASSES)
  const coveredKinds = new Set(COVERED_CLASSES.map((c) => factKindOf(c)))
  const satellites = new Set(SATELLITE_KINDS.map(([kind]) => kind))

  const corpus: [string, () => Promise<[string, EngineScope]>][] = [
    ...FIXTURES.map(
      ([name, fixture]): [string, () => Promise<[string, EngineScope]>] => [
        name,
        () => fixtureCase(fixture()),
      ]
    ),
    ["objects of every creatable class", async () => [BROAD_SQL, scope]],
  ]

  for (const [name, load] of corpus) {
    it(name, async () => {
      const [desiredSql, shadowScope] = await load()
      const { kinds, census, extracted } = await engineKindsAndCensus(
        desiredSql,
        shadowScope
      )
      // Кожен вид факту, що трапився, перепис рахує як покритий клас або
      // він — частина такого класу
      for (const kind of kinds)
        expect(
          coveredKinds.has(kind as never) || satellites.has(kind),
          `engine fact kind ${kind} is neither a covered census class nor a part of one`
        ).toBe(true)
      // Покритий клас, що трапився в переписі, має принаймні вид факту в
      // двигуні; точну кількість за класом звіряє сам extract
      // (`engine.census-mismatch`), зокрема для класів, що ділять вид
      for (const { class: censusClass } of census)
        if (covered.has(censusClass))
          expect(
            kinds.has(factKindOf(censusClass)!),
            `census class ${censusClass} is covered, but the engine has no ${factKindOf(censusClass)} fact`
          ).toBe(true)
      expect(
        extracted.diagnostics.filter((d) => d.code === "engine.census-mismatch")
      ).toEqual([])
      if (desiredSql === BROAD_SQL)
        // Класи, що ділять вид факту з модельованими, мапер називає поіменно
        expect(
          extracted.diagnostics
            .filter((d) => d.code === "engine.unrepresentable")
            .map((d) => d.object)
        ).toEqual(
          expect.arrayContaining([
            "constraint:app.doc.doc_no_overlap",
            "type:app.pair",
            "type:app.span",
          ])
        )
    })
  }
})
