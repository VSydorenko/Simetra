import { describe, expect, it } from "vitest"
import { PROVIDER_EXPECTED_BLIND_FUNCTIONS } from "simetra/schema"
import { project } from "../../../../simetra/test/support"
import { asSuperuser, query } from "../../__tests__/support/db"
import {
  BLIND_SETUP,
  compiled,
  EMPTY,
  errors,
  inTarget,
  party,
  PARTY,
  plan,
  SERVICE_ROLE,
  useBuildPlanRoles,
} from "./build-plan.support"

/**
 * Конвеєр плану `buildPlan` на стеку Supabase — сліпі функції пресету,
 * об'єкти службової ролі провайдера й базовий стан провайдера в `public`.
 * Спільна підготовка — `build-plan.support.ts`.
 */

useBuildPlanRoles()

// Конкурентно: ціль і копії кожного тесту — власні бази, ролі створює лише
// `beforeAll`
describe.concurrent("buildPlan", () => {
  // Спека промоції §7.2: сліпа функція з переліку
  // пресету провайдера — рядок виводу, а не попередження; сліпа функція
  // провайдера поза переліком і функція застосування — попередження
  it("warns about blind functions in the plan except the provider's expected ones", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await query(asSuperuser(url), BLIND_SETUP)
      const outcome = await plan(url, model)
      // Засів тіні несе базовий стан провайдера, тож сліпі там усі функції
      // переліку: ідентичності пресету збігаються з каталогом поіменно
      expect(outcome).toMatchObject({
        status: "planned",
        expectedBlindFunctions:
          PROVIDER_EXPECTED_BLIND_FUNCTIONS.supabase.length,
      })
      expect(
        outcome.diagnostics.filter(
          (d) => d.code === "apply.function-check-blind"
        )
      ).toMatchObject([
        {
          severity: "warning",
          params: {
            count: 2,
            functions: "other.fh(), pgbouncer.other_auth(text)",
          },
        },
      ])
    })
  })

  it("checks owners only where the engine reads, not inside extensions", async () => {
    // Межа з `public` і розширенням у ній: на провайдері розширення й усі
    // його члени належать службовій ролі, членом якої роль сесії не є.
    // Двигун членів розширення не планує, тож перепис власників їх не судить
    const model = await compiled({
      "project.meta.json": project({ defaultSchema: "public" }),
      [PARTY]: party(),
    })
    await inTarget(EMPTY, async (url) => {
      await query(url, "create extension pg_trgm schema public")
      const [extension] = await query<{ owner: string; member: boolean }>(
        url,
        `select pg_get_userbyid(extowner) as owner,
           pg_has_role(current_user, extowner, 'MEMBER') as member
         from pg_extension where extname = 'pg_trgm'`
      )
      // Передумова тесту: власник розширення — чужа роль, як на провайдері
      expect(extension?.member).toBe(false)
      expect(errors(await plan(url, model))).not.toContain(
        "plan.owner-mismatch"
      )

      // Об'єкт поза розширенням, що належить службовій ролі провайдера
      await query(
        asSuperuser(url),
        `create table public.stray (id int);
         alter table public.stray owner to ${SERVICE_ROLE};`
      )
      const outcome = await plan(url, model)
      expect(errors(outcome)).toEqual(["plan.owner-mismatch"])
      expect(
        outcome.diagnostics.find((d) => d.code === "plan.owner-mismatch")
          ?.params
      ).toEqual({
        count: 1,
        objects: `relation public.stray (owner ${SERVICE_ROLE}, not a role postgres is a member of)`,
      })
    })
  })

  it("proves a scope with public on the provider base state", async () => {
    // Відтворення В-3: типові привілеї базового стану провайдера в `public`
    // (власні та службових ролей) копія не відтворює, а двигун їх не бачить
    const model = await compiled({
      "project.meta.json": project({ defaultSchema: "public" }),
      [PARTY]: party(),
    })
    await inTarget(EMPTY, async (url) => {
      await query(
        asSuperuser(url),
        `alter default privileges for role postgres in schema public
           grant all on tables to postgres, anon, authenticated, service_role;
         alter default privileges for role postgres in schema public
           grant all on sequences to postgres, anon, authenticated, service_role;
         alter default privileges for role postgres in schema public
           grant all on functions to postgres, anon, authenticated, service_role;
         alter default privileges for role supabase_admin in schema public
           grant all on tables to postgres, anon, authenticated, service_role;
         alter default privileges for role supabase_admin in schema public
           grant all on sequences to postgres, anon, authenticated, service_role;
         alter default privileges for role supabase_admin in schema public
           grant all on functions to postgres, anon, authenticated, service_role;
         alter default privileges for role supabase_auth_admin in schema public
           grant all on tables to postgres, anon;`
      )
      const outcome = await plan(url, model)
      expect(errors(outcome)).not.toContain("plan.clone-mismatch")
    })
  })
})
