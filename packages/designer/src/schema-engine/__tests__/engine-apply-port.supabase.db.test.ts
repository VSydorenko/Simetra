import { describe, expect, it } from "vitest"
import { diffCatalogModels } from "simetra/model"
import type { EngineAction, EnginePlan, EngineScope } from "simetra/schema"
import { createPgDeltaEngine } from ".."
import { inTarget } from "../../__tests__/support/db"

/**
 * Копія стану цілі на стеку Supabase: об'єкти застосунку на поверхнях
 * провайдера (тригер на `auth.users`, політика на `storage.objects`)
 * відтворюються в копії без різниці.
 */

const engine = createPgDeltaEngine()
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

/** План «ціль → бажане» над окремою ціллю з `targetSql`. */
function planOf(targetSql: string, desiredSql: string): Promise<EnginePlan> {
  return inTarget(targetSql, scope, async (url) => {
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
    await inTarget(targetSql, scope, async (url) => {
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
      expect(
        diffCatalogModels(target.model, clone.model, { columnOrder: true })
      ).toEqual([])
    })
  })

  // Розширення `postgres_fdw` власник цілі створює лише на Supabase (там це
  // дозволяє `supautils`); на стеку postgres воно потребує суперкористувача
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
})
