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
    // обмеження таблиці, з іменем домену в полі `table`
    const plan = await planOf(
      "create schema app; create domain app.d as int constraint d_pos check (value > 0);",
      "create schema app; create domain app.d as int constraint d_small check (value < 10);"
    )
    const drop = actionMatching(plan, /DROP CONSTRAINT/i)
    expect(drop.lockClass).toBe("accessExclusive")
    expect(drop.lockedTables).toEqual([])
    expect(actionMatching(plan, /ADD CONSTRAINT/i).lockedTables).toEqual([])
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
      expect(
        engine
          .plan(clone.catalog, target.catalog, scope)
          .actions.map((a) => a.sql)
      ).toEqual([])
      expect(engine.plan(clone.catalog, target.catalog, scope).empty).toBe(true)
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
