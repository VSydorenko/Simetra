import pg from "pg"
import { describe, expect, it } from "vitest"
import type { DbConnection, EngineDiagnostic } from "simetra/schema"
import { createPgDeltaEngine } from ".."
import { testDatabaseUrl } from "../../../../simetra/test/support"
import { boundaryViolations, scopeOf } from "./fixtures/engine-boundary"

/**
 * Порт `SchemaEngine` на стеку Supabase: межа керування §6.9 з поверхнями
 * провайдера (`auth`, `storage`), гранти пресету в керованій `public` і
 * базовий стан провайдера в тіні.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

const PGCRYPTO_CALLER = `
  create schema app;
  create function app.token() returns text language sql
    as $$ select encode(extensions.gen_random_bytes(8), 'hex') $$;
`

const byCodePoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/** Базовий стан провайдера, як його бачить каталог тіні. */
const PROVIDER_BASE_STATE = {
  publicAcl: [
    "=U",
    "anon=U",
    "authenticated=U",
    "postgres=U",
    "service_role=U",
  ],
  pgcrypto: ["extensions"],
}

async function baseStateOf(
  db: DbConnection
): Promise<typeof PROVIDER_BASE_STATE> {
  const client = new pg.Client({ connectionString: db.url })
  await client.connect()
  try {
    // Власника схеми (його права дає володіння) і грантора не порівнюємо
    const acl = await client.query<{ item: string }>(
      `SELECT split_part(item, '/', 1) AS item
         FROM pg_namespace n, unnest(n.nspacl::text[]) item
        WHERE n.nspname = 'public'
          AND split_part(item, '=', 1) <> n.nspowner::regrole::text`
    )
    const ext = await client.query<{ schema: string }>(
      `SELECT extnamespace::regnamespace::text AS schema
         FROM pg_extension WHERE extname = 'pgcrypto'`
    )
    return {
      publicAcl: acl.rows.map((r) => r.item).sort(byCodePoint),
      pgcrypto: ext.rows.map((r) => r.schema),
    }
  } finally {
    await client.end()
  }
}

/**
 * Шум, якого засіяна тінь давати не має: неперевірене тіло функції (розширення
 * не засіяне) і попередження про недоступне пересортування (спека П2 §9).
 */
const seedNoise = (diagnostics: readonly EngineDiagnostic[]) =>
  diagnostics.filter(
    (d) =>
      d.engineCode === "invalid_routine_body" ||
      (d.engineCode === "frontend_warning" &&
        /reorder|pg-topo/i.test(d.message))
  )

describe("SchemaEngine on pg-delta", () => {
  it("scope follows 6.9", async () => {
    // Керована `public` керується цілком: типові привілеї для ролей провайдера
    // оголошено явно (платформна спека §6.9), а гранти самої схеми
    // дає засів пресету провайдера (спека промоції §9.9)
    const scope = scopeOf("public")
    const desired = `
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
      { target: stack },
      "create schema other; create table other.x (id int);",
      scope,
      async (empty) => {
        const inner = await engine.withDesiredShadow(
          { target: empty },
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

  it("managed public with declared default privileges plans nothing against the stack", async () => {
    // Гранти самої схеми `public` дає засів пресету провайдера (спека
    // промоції §9.9), а типові привілеї провайдера в ній лишаються явними:
    // бажаний стан оголошує їх, і порівняння з образом стеку порожнє.
    // Припущення: у `public` стеку немає об'єктів застосунку — інші DB-тести
    // працюють у транзакції, яку відкочують
    const scope = scopeOf("public")
    const declared = `
      alter default privileges for role postgres in schema public
        grant all on tables to postgres, anon, authenticated, service_role;
      alter default privileges for role postgres in schema public
        grant all on sequences to postgres, anon, authenticated, service_role;
      alter default privileges for role postgres in schema public
        grant all on functions to postgres, anon, authenticated, service_role;
    `
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      declared,
      scope,
      (_shadow, plan) => Promise.resolve(plan)
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    expect(outcome.value).toMatchObject({
      actions: [],
      empty: true,
      diagnostics: [],
    })
  })

  it("managed public without declarations keeps the preset grants and drops the default privileges", async () => {
    // Без оголошень план не відкликає гранти схеми з пресету, але прибирає
    // типові привілеї провайдера: вони — явні одиниці застосунку
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      "select 1;",
      scopeOf("public"),
      (_shadow, plan) => Promise.resolve(plan)
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    const destroys = outcome.value.actions.flatMap((a) => a.destroys)
    expect(
      destroys.filter((id) => id.startsWith("acl:(schema:public)."))
    ).toEqual([])
    expect(destroys).toContainEqual(
      expect.stringMatching(/^defaultPrivilege:postgres\.public\./)
    )
  })

  it("the shadow carries the provider base state", async () => {
    // Тіло функції звертається до розширення базового стану: без засіву тінь
    // його не має, і перевірка тіл після завантаження скаржиться
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      PGCRYPTO_CALLER,
      scopeOf("app"),
      (shadow) => baseStateOf(shadow)
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    expect(outcome.value).toEqual(PROVIDER_BASE_STATE)
    expect(seedNoise(outcome.diagnostics)).toEqual([])
  })

  it("a shadow seeded from a shadow carries the provider base state", async () => {
    // Ціль сама є тінню з тим самим засівом: розширення вже стоять у ній, і
    // повторний засів не має конфліктувати з засівом припущених схем двигуна
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      "create schema other;",
      scopeOf("app"),
      async (seeded) => {
        const inner = await engine.withDesiredShadow(
          { target: seeded },
          PGCRYPTO_CALLER,
          scopeOf("app"),
          (shadow) => baseStateOf(shadow)
        )
        if (inner.status !== "loaded")
          throw new Error(JSON.stringify(inner.diagnostics))
        return inner
      }
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    expect(outcome.value.value).toEqual(PROVIDER_BASE_STATE)
    expect(seedNoise(outcome.value.diagnostics)).toEqual([])
    expect(seedNoise(outcome.diagnostics)).toEqual([])
  })
})
