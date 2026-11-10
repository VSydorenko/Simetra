import { describe, expect, it } from "vitest"
import { executePlan } from "simetra/schema"
import {
  loginUrl,
  testRoleName,
  testSuperuserUrl,
} from "../../../../simetra/test/support"
import { dropRoles, query } from "../../__tests__/support/db"
import {
  apply,
  FP,
  inTarget,
  NEUTRAL,
  options,
  planFor,
  reader,
  RENAME_A,
  run,
  checkFailed,
  TABLE_T,
  useFunctionChecks,
} from "./function-checks.support"
import { readProviderLocks, PROVIDER_LOCKS } from "simetra/schema"
import { asSuperuser } from "../../__tests__/support/db"
import { testProvider } from "../../../../simetra/test/support"

/**
 * `plpgsql_check` проти базової лінії на стеку Supabase: у базі розширення
 * немає, тож тимчасове встановлення (`supautils`), схема розширення й ім'я
 * тимчасової схеми — предмет цих тестів. База профілю postgres несе
 * розширення з шаблону, і ці випадки там не відтворюються. Спільна підготовка
 * — `function-checks.support.ts`.
 */

useFunctionChecks()

describe("plpgsql_check", () => {
  it("installs the extension only for the check", async () => {
    const leftover = (url: string) =>
      query(
        url,
        `select
           exists (select 1 from pg_extension where extname = 'plpgsql_check') as extension,
           exists (select 1 from pg_namespace where nspname = 'simetra_plpgsql_check') as schema`
      )
    await inTarget(FP, async (url) => {
      // Розширення в цій базі немає, і помилку тіла, якої валідатор мови не
      // бачить, ловить лише воно: тимчасове встановлення справді відбулося
      expect(await leftover(url)).toEqual([{ extension: false, schema: false }])
      const failed = await executePlan(
        apply,
        { url },
        await planFor(url, [RENAME_A]),
        options
      )
      expect(failed).toMatchObject({
        status: "failed",
        diagnostics: [{ code: "apply.function-check-failed" }],
      })
      expect(String(failed.diagnostics[0]!.params.functions)).toContain(
        "app.fp(): 42703"
      )
      // Та сама база, закомічений прогін: розширення й схема не пережили
      // своєї точки збереження
      const committed = await executePlan(
        apply,
        { url },
        await planFor(url, [NEUTRAL]),
        options
      )
      expect(committed).toMatchObject({ status: "committed", diagnostics: [] })
      expect(await leftover(url)).toEqual([{ extension: false, schema: false }])
    })
  })

  it("uses an installed extension in place", async () => {
    const setup = `${FP};
      create schema ext;
      create extension plpgsql_check schema ext`
    await run(
      setup,
      [RENAME_A],
      { plpgsqlCheck: "installed" },
      async (outcome, url) => {
        expect(checkFailed(outcome)).toContain("app.fp(): 42703")
        expect(
          await query(
            url,
            "select extnamespace::regnamespace::text as schema from pg_extension where extname = 'plpgsql_check'"
          )
        ).toEqual([{ schema: "ext" }])
      }
    )
  })

  it("fails when plpgsql_check cannot be taken on the target", async () => {
    // Ролі `postgres` стеку `USAGE` на будь-яку схему дає членство в
    // `pg_read_all_data`, тож відібрати його нічим. Тому застосовує інша роль
    // без членств: розширення стоїть у схемі, якої вона не бачить, а план
    // «встановлене» обіцяв перевірку; BYPASSRLS — щоб застосування пройшло
    // гейт власника (`plan.owner-not-bypassrls`) і дійшло до перевірки
    const NOUSAGE = testRoleName("fncheck_nousage")
    await query(
      testSuperuserUrl(),
      `create role ${NOUSAGE} login bypassrls password 'x'`
    )
    try {
      await inTarget(
        `${TABLE_T};
         grant usage, create on schema app to ${NOUSAGE};
         grant usage on schema simetra to ${NOUSAGE};
         grant select on all tables in schema simetra to ${NOUSAGE}`,
        async (url) => {
          const as = new URL(loginUrl(url, NOUSAGE, "x"))
          const outcome = await executePlan(
            apply,
            { url: as.toString() },
            await planFor(url, [NEUTRAL], {
              plpgsqlCheck: "installed",
              role: NOUSAGE,
              providerLocks: await reader.transaction(
                { url: as.toString() },
                "rollback",
                (tx) =>
                  readProviderLocks(tx, NOUSAGE, PROVIDER_LOCKS[testProvider()])
              ),
            }),
            options
          )
          expect(outcome).toMatchObject({
            status: "failed",
            diagnostics: [
              {
                code: "apply.plpgsql-check-unavailable",
                params: { sqlstate: "42501" },
              },
            ],
          })
          expect(
            await query(url, "select to_regclass('app.n') is null as absent")
          ).toEqual([{ absent: true }])
          // Контроль: з тим самим планом, але з `USAGE` на схему розширення
          // роль застосовує, тож причина відмови саме в `USAGE`
          await query(
            asSuperuser(url),
            `grant usage on schema simetra_locked_ext to ${NOUSAGE};
             grant insert, update, delete on all tables in schema simetra to ${NOUSAGE}`
          )
          expect(
            await executePlan(
              apply,
              { url: as.toString() },
              await planFor(url, [NEUTRAL], {
                plpgsqlCheck: "installed",
                role: NOUSAGE,
                providerLocks: await reader.transaction(
                  { url: as.toString() },
                  "rollback",
                  (tx) =>
                    readProviderLocks(
                      tx,
                      NOUSAGE,
                      PROVIDER_LOCKS[testProvider()]
                    )
                ),
              }),
              options
            )
          ).toMatchObject({ status: "committed", diagnostics: [] })
        },
        `create schema simetra_locked_ext;
         create extension plpgsql_check schema simetra_locked_ext`
      )
    } finally {
      await dropRoles(NOUSAGE)
    }
  })

  it("refuses when plpgsql_check vanished since the plan", async () => {
    // План будують, поки розширення стоїть, а до застосування його знято
    await inTarget(
      `${TABLE_T};
       create schema ext;
       create extension plpgsql_check schema ext`,
      async (url) => {
        const plan = await planFor(url, [NEUTRAL], {
          plpgsqlCheck: "installed",
        })
        await query(url, "drop extension plpgsql_check")
        const outcome = await executePlan(apply, { url }, plan, options)
        expect(outcome).toMatchObject({
          status: "refused",
          diagnostics: [
            {
              code: "apply.target-changed",
              params: { sections: "plpgsqlCheck" },
            },
          ],
        })
        expect(
          await query(url, "select to_regclass('app.n') is null as absent")
        ).toEqual([{ absent: true }])
      }
    )
  })

  it("refuses a taken check schema", async () => {
    const setup = `${TABLE_T};
      create schema simetra_plpgsql_check`
    await run(setup, [NEUTRAL], {}, async (outcome, url) => {
      expect(outcome).toMatchObject({
        status: "refused",
        diagnostics: [
          {
            code: "apply.temp-name-taken",
            params: { name: "simetra_plpgsql_check" },
          },
        ],
      })
      expect(
        await query(url, "select to_regclass('app.n') is null as absent")
      ).toEqual([{ absent: true }])
    })
  })
})
