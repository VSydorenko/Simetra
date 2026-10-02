import { parseId, type StableId } from "@supabase/pg-delta"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createPgDeltaEngine,
  type EngineAction,
  type EngineScope,
} from "simetra/schema"
import { PROVIDER_SCHEMAS } from "../engine/pg-delta/policy"
import {
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../test/db/connection"

/**
 * Порт `SchemaEngine` на живому стеку (план E2a, задача 3): extract у межі,
 * чистий plan і тінь бажаного стану з межею керування §6.9. Ціль — база
 * стеку, яку тести лише читають; пише порт тільки в тінь.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

const scopeOf = (...schemas: string[]): EngineScope => ({
  schemas,
  provider: "supabase",
})

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

/** Схема ідентичності: власна або цілі сателіта; без схеми — `undefined`. */
function schemaOf(id: StableId): string | undefined {
  if (id.kind === "schema") return id.name
  if ("target" in id) return schemaOf(id.target)
  if ("schema" in id) return id.schema ?? undefined
  return undefined
}

/** Вид ідентичності, яку змінює сателіт (ACL, коментар), — вид його цілі. */
function subjectKind(id: StableId): string {
  return "target" in id ? subjectKind(id.target) : id.kind
}

/** Об'єкти застосунку, які §6.9 дозволяє в схемах провайдера. */
const FOREIGN_APP_KINDS = new Set(["trigger", "policy", "publicationRel"])

/**
 * Порушення межі §6.9 за структурованими цілями дії, а не за текстом SQL:
 * жодна ціль не лежить у некерованій схемі поза пресетом провайдера; у схемі
 * провайдера дія створює чи видаляє лише об'єкт застосунку; дія без власних
 * `produces`/`destroys` (GRANT, `ENABLE RLS`) діє на те, що споживає, тож усе
 * споживане зі схемою — у керованих схемах.
 */
function boundaryViolations(
  actions: readonly EngineAction[],
  scope: EngineScope
): string[] {
  const managed = new Set(scope.schemas)
  const provider = new Set(PROVIDER_SCHEMAS)
  const out: string[] = []
  for (const action of actions) {
    const own = [...action.produces, ...action.destroys]
    for (const encoded of [...own, ...action.consumes]) {
      const schema = schemaOf(parseId(encoded))
      if (schema !== undefined && !managed.has(schema) && !provider.has(schema))
        out.push(`${encoded} in unmanaged schema: ${action.sql}`)
    }
    for (const encoded of own) {
      const id = parseId(encoded)
      const schema = schemaOf(id)
      if (
        schema !== undefined &&
        !managed.has(schema) &&
        !FOREIGN_APP_KINDS.has(subjectKind(id))
      )
        out.push(`${encoded} is a provider internal: ${action.sql}`)
    }
    if (own.length === 0)
      for (const encoded of action.consumes) {
        const schema = schemaOf(parseId(encoded))
        if (schema !== undefined && !managed.has(schema))
          out.push(
            `${encoded} is acted on outside managed schemas: ${action.sql}`
          )
      }
  }
  return out
}

describe("SchemaEngine on pg-delta", () => {
  it("stack database with no managed schemas extracts an empty model", async () => {
    const extracted = await engine.extract(stack, scopeOf())
    expect(extracted.model).toEqual({ tables: [], enumTypes: [], units: [] })
  })

  it("managed schema is kept", async () => {
    const desired = `
      create schema app;
      create table app.doc (id int primary key, title text not null);
      create text search configuration app.simple_ua (copy = simple);
      create schema other;
      create table other.x (id int);
    `
    const outcome = await engine.withDesiredShadow(
      stack,
      desired,
      scopeOf("app"),
      (shadow) => engine.extract(shadow, scopeOf("app"))
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    // Немодельований клас двигуна — гучна діагностика, а `dangling_edge`
    // засіяної тіні (шум засіву) відфільтровано
    const messages = outcome.value.diagnostics.map((d) => d.message)
    expect(
      outcome.value.diagnostics.some(
        (d) =>
          d.code === "engine.diagnostic" && d.engineCode === "unmodeled_kind"
      )
    ).toBe(true)
    expect(messages.filter((m) => m.includes("dangling_edge"))).toEqual([])
    expect(outcome.value.model.tables).toEqual([
      {
        schema: "app",
        name: "doc",
        rowLevelSecurity: "off",
        columns: [
          { name: "id", type: "integer", notNull: true },
          { name: "title", type: "text", notNull: true },
        ],
        primaryKey: { name: "doc_pkey", columns: ["id"] },
        uniques: [],
        checks: [],
        foreignKeys: [],
        indexes: [],
      },
    ])
  })

  it("self plan is empty", async () => {
    const scope = scopeOf("app")
    const outcome = await engine.withDesiredShadow(
      stack,
      "create schema app; create table app.doc (id int primary key);",
      scope,
      async (shadow) => {
        const first = await engine.extract(shadow, scope)
        const second = await engine.extract(shadow, scope)
        return {
          same: engine.plan(first.catalog, first.catalog, scope),
          reextracted: engine.plan(first.catalog, second.catalog, scope),
        }
      }
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    expect(outcome.value.same).toEqual({ actions: [], empty: true })
    expect(outcome.value.reextracted).toEqual({ actions: [], empty: true })
  })

  it("scope follows 6.9", async () => {
    // Керована `public` керується цілком: її гранти й типові привілеї для ролей
    // провайдера оголошено явно (рішення плану E2a за спайком, 6)
    const scope = scopeOf("public")
    const desired = `
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges for role postgres in schema public
        grant all on tables to anon, authenticated, service_role;
      create table public.note (id int primary key, body text);
      create policy app_read on storage.objects for select to authenticated
        using (bucket_id = 'app');
      create function public.on_user() returns trigger language plpgsql
        as $$ begin return new; end $$;
      create trigger app_on_user after insert on auth.users
        for each row execute function public.on_user();
    `
    // Ціль — засіяна тінь, у якій поза межею лежить лише некерована `other`:
    // у межі вона порожня, а план не сміє торкнутися `other`
    const outcome = await engine.withDesiredShadow(
      stack,
      "create schema other; create table other.x (id int);",
      scope,
      async (empty) => {
        const inner = await engine.withDesiredShadow(
          empty,
          desired,
          scope,
          async (shadow, shadowPlan) => {
            const source = await engine.extract(empty, scope)
            const target = await engine.extract(shadow, scope)
            return {
              shadowPlan,
              portPlan: engine.plan(source.catalog, target.catalog, scope),
            }
          }
        )
        if (inner.status !== "loaded")
          throw new Error(JSON.stringify(inner.diagnostics))
        return inner.value
      }
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    const { shadowPlan, portPlan } = outcome.value
    const produced = shadowPlan.actions.flatMap((a) => a.produces)
    expect(produced).toContain("table:public.note")
    expect(produced).toContain("policy:storage.objects.app_read")
    expect(produced).toContain("trigger:auth.users.app_on_user")
    expect(boundaryViolations(shadowPlan.actions, scope)).toEqual([])
    // shadow plan equals port plan: одна істина плану
    expect(portPlan).toEqual(shadowPlan)
  })

  it("unmodeled object in the shadow is reported as drift", async () => {
    // Двигун не моделює text search configuration: план не створить її на
    // цілі, і порт мусить сказати про це, а не віддати мовчазний план
    const outcome = await engine.withDesiredShadow(
      stack,
      `
        create schema app;
        create text search configuration app.simple_ua (copy = simple);
      `,
      scopeOf("app"),
      () => Promise.resolve(null)
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    expect(outcome.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "engine.unmodeled-drift",
        severity: "error",
        engineCode: "unmodeled_drift",
      })
    )
    expect(
      outcome.diagnostics.filter((d) => d.engineCode === "dangling_edge")
    ).toEqual([])
  })

  it("managed public with declared provider grants plans nothing against the stack", async () => {
    // Керована схема керується цілком: без явних грантів і типових привілеїв
    // для ролей провайдера план їх відкликає, з ними — порівняння порожнє
    // Припущення: у `public` стеку немає об'єктів застосунку — інші DB-тести
    // працюють у транзакції, яку відкочують
    const scope = scopeOf("public")
    const declared = `
      grant usage on schema public to postgres, anon, authenticated, service_role;
      alter default privileges for role postgres in schema public
        grant all on tables to postgres, anon, authenticated, service_role;
      alter default privileges for role postgres in schema public
        grant all on sequences to postgres, anon, authenticated, service_role;
      alter default privileges for role postgres in schema public
        grant all on functions to postgres, anon, authenticated, service_role;
    `
    const undeclared = await engine.withDesiredShadow(
      stack,
      "select 1;",
      scope,
      (_shadow, plan) => Promise.resolve(plan)
    )
    const withGrants = await engine.withDesiredShadow(
      stack,
      declared,
      scope,
      (_shadow, plan) => Promise.resolve(plan)
    )
    expect(undeclared.status).toBe("loaded")
    expect(withGrants.status).toBe("loaded")
    if (undeclared.status !== "loaded" || withGrants.status !== "loaded") return
    expect(undeclared.value.actions.flatMap((a) => a.destroys)).toContain(
      "acl:(schema:public).anon"
    )
    expect(withGrants.value).toEqual({ actions: [], empty: true })
  })

  it("desired state that fails to load is shadow-failed", async () => {
    const outcome = await engine.withDesiredShadow(
      stack,
      "create schema app; create table app.t (id int references app.missing (id));",
      scopeOf("app"),
      () => Promise.resolve("unreachable")
    )
    expect(outcome.status).toBe("shadow-failed")
    if (outcome.status !== "shadow-failed") return
    expect(outcome.diagnostics.length).toBeGreaterThan(0)
    for (const d of outcome.diagnostics) {
      expect(d.code).toBe("engine.shadow-load-failed")
      expect(d.severity).toBe("error")
    }
    expect(outcome.diagnostics.map((d) => d.message).join("\n")).toContain(
      'relation "app.missing" does not exist'
    )
  })

  it("shadow is dropped when the callback throws", async () => {
    await expect(
      engine.withDesiredShadow(
        stack,
        "create schema app;",
        scopeOf("app"),
        () => Promise.reject(new Error("callback failed"))
      )
    ).rejects.toThrow("callback failed")
  })
})
