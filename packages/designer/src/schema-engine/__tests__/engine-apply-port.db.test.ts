import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { diffCatalogModels } from "simetra/model"
import type { EngineAction, EnginePlan, EngineScope } from "simetra/schema"
import { createPgDeltaEngine } from ".."
import {
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../../simetra/test/support"

/**
 * Порт `SchemaEngine` для застосування (план П3-1, задача 2): межа сегмента,
 * заблоковані таблиці, ідентичність двигуна й копія стану цілі. Ціль кожного
 * тесту — окрема база від `withDesiredShadow`; база стеку лише читається.
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

/** Розгортає `sql` у тимчасову базу поруч зі стеком; її прибирає порт. */
async function inTarget<T>(
  sql: string,
  fn: (url: string) => Promise<T>
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    sql,
    scope,
    (target) => fn(target.url)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

/** План «ціль → бажане» над окремою ціллю з `targetSql`. */
function planOf(targetSql: string, desiredSql: string): Promise<EnginePlan> {
  return inTarget(targetSql, async (url) => {
    const outcome = await engine.withDesiredShadow(
      { target: { url } },
      desiredSql,
      scope,
      async (_shadow, plan) => plan
    )
    if (outcome.status !== "loaded")
      throw new Error(
        `desired did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
      )
    return outcome.value
  })
}

function actionMatching(plan: EnginePlan, pattern: RegExp): EngineAction {
  const hits = plan.actions.filter((a) => pattern.test(a.sql))
  expect(
    hits.map((a) => a.sql),
    `one action matching ${pattern} in ${plan.actions.map((a) => a.sql).join("\n")}`
  ).toHaveLength(1)
  return hits[0]!
}

describe("SchemaEngine apply port", () => {
  it("carries newSegmentBefore on the consumer of an added enum value", async () => {
    const plan = await planOf(
      [
        "create schema app;",
        "create type app.s as enum ('a');",
        "create table app.t (id int, s app.s);",
      ].join("\n"),
      [
        "create schema app;",
        "create type app.s as enum ('a', 'b');",
        "create table app.t (id int, s app.s default 'b');",
      ].join("\n")
    )
    const addValue = actionMatching(plan, /ADD VALUE/i)
    expect(addValue.transactionality).toBe("commitBoundaryAfter")
    const setDefault = actionMatching(plan, /SET DEFAULT/i)
    expect(setDefault.newSegmentBefore).toBe(true)
  })

  it("reports locked tables structurally", async () => {
    const plan = await planOf(
      'create schema app; create table app."a.b" (id int);',
      'create schema app; create table app."a.b" (id int, c int);'
    )
    const addColumn = actionMatching(plan, /ADD COLUMN/i)
    expect(addColumn.lockedTables).toEqual([{ schema: "app", name: "a.b" }])
  })

  it("locks the table of a column-only action", async () => {
    const plan = await planOf(
      "create schema app; create table app.t (id int, c int);",
      "create schema app; create table app.t (id int, c int not null);"
    )
    const setNotNull = actionMatching(plan, /SET NOT NULL/i)
    expect(setNotNull.lockedTables).toEqual([{ schema: "app", name: "t" }])
  })

  it("does not report a domain as a locked table", async () => {
    // Обмеження домену двигун адресує тим самим видом `constraint`, що й
    // обмеження таблиці, з іменем домену в полі `table`; таблиці з таким
    // іменем у вихідному стані немає
    const plan = await planOf(
      "create schema app; create domain app.d as int constraint d_pos check (value > 0);",
      "create schema app; create domain app.d as int constraint d_small check (value < 10);"
    )
    const drop = actionMatching(plan, /DROP CONSTRAINT/i)
    expect(drop.lockClass).toBe("accessExclusive")
    expect(drop.lockedTables).toEqual([])
    expect(actionMatching(plan, /ADD CONSTRAINT/i).lockedTables).toEqual([])
  })

  it("does not report a foreign table as a locked table", async () => {
    // Дія над колонкою сторонньої таблиці не несе батька `foreignTable:`, а
    // `LOCK TABLE` на сторонній таблиці дає 42809
    const fdw = [
      "create extension if not exists postgres_fdw with schema extensions;",
      "create server app_srv foreign data wrapper postgres_fdw",
      "  options (host 'localhost', dbname 'none');",
      "create schema app;",
    ].join("\n")
    const plan = await planOf(
      `${fdw}\ncreate foreign table app.ft (x int default 1, y int not null) server app_srv;`,
      `${fdw}\ncreate foreign table app.ft (x int default 2, y int) server app_srv;`
    )
    const setDefault = actionMatching(plan, /SET DEFAULT/i)
    expect(setDefault.consumes).toEqual(["default:app.ft.x"])
    expect(setDefault.lockClass).toBe("accessExclusive")
    expect(setDefault.lockedTables).toEqual([])
    const dropNotNull = actionMatching(plan, /DROP NOT NULL/i)
    expect(dropNotNull.consumes).toEqual(["column:app.ft.y"])
    expect(dropNotNull.lockedTables).toEqual([])
  })

  it("does not lock a table the plan creates", async () => {
    const plan = await planOf(
      "create schema app;",
      "create schema app; create table app.n (id int primary key);"
    )
    const create = actionMatching(plan, /CREATE TABLE/i)
    expect(create.consumes).toContain("table:app.n")
    expect(create.lockedTables).toEqual([])
  })

  it("locks an existing table the plan drops and recreates, once", async () => {
    // Перехід до секціонованої таблиці двигун робить через DROP і CREATE;
    // DROP знищує й `table:`, і `column:` тієї самої таблиці
    const plan = await planOf(
      "create schema app; create table app.t (id int, c int);",
      "create schema app; create table app.t (id int, c int) partition by range (id);"
    )
    const drop = actionMatching(plan, /DROP TABLE/i)
    expect(drop.destroys).toEqual(
      expect.arrayContaining(["table:app.t", "column:app.t.id"])
    )
    expect(drop.lockedTables).toEqual([{ schema: "app", name: "t" }])
    expect(plan.actions.indexOf(drop)).toBeLessThan(
      plan.actions.indexOf(actionMatching(plan, /CREATE TABLE/i))
    )
  })

  it("reports destroyed objects structurally", async () => {
    const dropColumn = await planOf(
      'create schema app; create table app."a.b" (id int, c int);',
      'create schema app; create table app."a.b" (id int);'
    )
    expect(actionMatching(dropColumn, /DROP COLUMN/i).destroyed).toEqual([
      { kind: "column", schema: "app", table: "a.b", name: "c" },
    ])
    const dropTable = await planOf(
      "create schema app; create table app.t (id int);",
      "create schema app;"
    )
    expect(actionMatching(dropTable, /DROP TABLE/i).destroyed).toEqual(
      expect.arrayContaining([{ kind: "table", schema: "app", name: "t" }])
    )
  })

  it("passes the engine preamble through on every path", async () => {
    const desired = [
      "create schema app;",
      "create function app.f() returns int language sql as 'select 1';",
    ].join("\n")
    const expected = expect.arrayContaining([
      { name: "check_function_bodies", value: "off" },
      { name: "search_path", value: "pg_catalog" },
    ])
    const viaShadow = await planOf("create schema app;", desired)
    expect(viaShadow.preamble).toEqual(expected)
    expect(viaShadow.diagnostics).toEqual([])
    await inTarget("create schema app;", async (url) => {
      const from = await engine.extract({ url }, scope)
      await inTarget(desired, async (desiredUrl) => {
        const to = await engine.extract({ url: desiredUrl }, scope)
        const plan = engine.plan(from.catalog, to.catalog, scope)
        expect(plan.preamble).toEqual(expected)
        expect(plan.diagnostics).toEqual([])
      })
    })
  })

  it("plans with the options of the given catalog", async () => {
    const targetSql = "create schema app; create table app.t (id int);"
    const desiredSql =
      "create schema app; create table app.t (id int, c int not null default 0);"
    await inTarget(targetSql, async (url) => {
      const viaShadow = await engine.withDesiredShadow(
        { target: { url } },
        desiredSql,
        scope,
        async (shadowUrl, plan) => ({
          plan,
          shadow: await engine.extract(shadowUrl, scope),
        })
      )
      if (viaShadow.status !== "loaded") throw new Error("shadow failed")
      const target = await engine.extract({ url }, scope)
      const { plan: expected, shadow } = viaShadow.value
      // Копія цілі як джерело, тінь — бажане; опції — з цілі
      const clone = await engine.withTargetClone(
        { target: { url } },
        target,
        scope,
        (cloneUrl) => engine.extract(cloneUrl, scope)
      )
      if (clone.status !== "loaded") throw new Error("clone failed")
      const plan = engine.plan(clone.value.catalog, shadow.catalog, scope, {
        optionsFrom: target.catalog,
      })
      expect(plan.actions.map((a) => a.sql)).toEqual(
        expected.actions.map((a) => a.sql)
      )
    })
  })

  it("identity matches the installed pg-delta", async () => {
    // Пакет не експортує `package.json`, тож шлях — від точки входу `dist`
    const entry = createRequire(import.meta.url).resolve("@supabase/pg-delta")
    const manifest = JSON.parse(
      await readFile(join(dirname(entry), "..", "package.json"), "utf8")
    ) as { name: string; version: string }
    expect(manifest.name).toBe("@supabase/pg-delta")
    expect(engine.identity).toEqual({
      name: "pg-delta",
      version: manifest.version,
    })
  })

  it("clones the target state", async () => {
    const targetSql = [
      "create schema app;",
      "create table app.note (",
      "  id int primary key,",
      "  body text check (length(body) > 0)",
      ");",
      "create index note_body_idx on app.note (body);",
      "alter table app.note enable row level security;",
      "create policy note_read on app.note for select to authenticated using (true);",
      "grant select on app.note to authenticated;",
      "create function app.on_user() returns trigger language plpgsql",
      "  security definer set search_path = ''",
      "  as $$ begin return new; end $$;",
      "create trigger app_on_user after insert on auth.users",
      "  for each row execute function app.on_user();",
      "create policy app_read on storage.objects for select to authenticated",
      "  using (bucket_id = 'app');",
    ].join("\n")
    await inTarget(targetSql, async (url) => {
      const target = await engine.extract({ url }, scope)
      const outcome = await engine.withTargetClone(
        { target: { url } },
        target,
        scope,
        (clone) => engine.extract(clone, scope)
      )
      if (outcome.status !== "loaded")
        throw new Error(
          `clone failed: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
        )
      const clone = outcome.value
      const back = engine.plan(clone.catalog, target.catalog, scope)
      expect(back.actions.map((a) => a.sql)).toEqual([])
      expect(back.empty).toBe(true)
      expect(diffCatalogModels(target.model, clone.model)).toEqual([])
    })
  })

  it("reports a failed reproduction as engine.clone-failed", async () => {
    // Тип колонки живе в схемі поза межею: засів копії її не відтворює, а план
    // «копія → ціль» межею не виходить, тож відтворення падає на копії
    await inTarget(
      [
        "create schema other;",
        "create type other.e as enum ('a');",
        "create schema app;",
        "create table app.t (id int, e other.e);",
      ].join("\n"),
      async (url) => {
        const before = await shadowDatabaseCount()
        const target = await engine.extract({ url }, scope)
        let called = false
        const outcome = await engine.withTargetClone(
          { target: { url } },
          target,
          scope,
          async () => {
            called = true
          }
        )
        expect(called).toBe(false)
        expect(outcome.status).toBe("shadow-failed")
        expect(outcome.diagnostics.map((d) => d.code)).toEqual([
          "engine.clone-failed",
        ])
        expect(outcome.diagnostics[0]!.severity).toBe("error")
        expect(outcome.diagnostics[0]!.message).toMatch(
          /^The current target state could not be reproduced in a copy: .*other\.e/
        )
        expect(await shadowDatabaseCount()).toBe(before)
      }
    )
  })

  it("drops the clone on success and on error", async () => {
    await inTarget(
      "create schema app; create table app.t (id int);",
      async (url) => {
        const before = await shadowDatabaseCount()
        const target = await engine.extract({ url }, scope)
        const ok = await engine.withTargetClone(
          { target: { url } },
          target,
          scope,
          async () => "done"
        )
        expect(ok).toMatchObject({ status: "loaded", value: "done" })
        expect(await shadowDatabaseCount()).toBe(before)
        await expect(
          engine.withTargetClone({ target: { url } }, target, scope, () =>
            Promise.reject(new Error("boom"))
          )
        ).rejects.toThrow("boom")
        expect(await shadowDatabaseCount()).toBe(before)
      }
    )
  })
})
