import { describe, expect, it } from "vitest"
import { diffCatalogModels } from "simetra/model"
import type { EngineScope } from "simetra/schema"
import { createPgDeltaEngine } from ".."
import { inTarget } from "../../__tests__/support/db"

/**
 * Копія стану цілі на стеку Supabase: об'єкти застосунку на поверхнях
 * провайдера (тригер на `auth.users`, політика на `storage.objects`)
 * відтворюються в копії без різниці.
 */

const engine = createPgDeltaEngine()
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

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
})
