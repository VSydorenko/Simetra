import { describe, expect, it } from "vitest"
import { PLATFORM_ROLES, quoteIdent } from "simetra/model"
import type { PlanOutcome } from "simetra/schema"
import {
  catalog,
  uuid,
  withSessionOptions,
} from "../../../../simetra/test/support"
import { asSuperuser, query } from "../../__tests__/support/db"
import {
  ANON,
  codes,
  compiled,
  EMPTY,
  establish,
  inTarget,
  PARTY,
  party,
  plan,
  USER,
  useBuildPlanRoles,
} from "./build-plan.support"

/**
 * Схема застосунку, відмінна від `public`: таблицю читають лише ролі з
 * `USAGE` на її схемі. Грант схеми дає платформа тим ролям, яким вид дає
 * доступ до таблиць, — без дослівного гранту в проєкті. DB-рівень, бо
 * відмову за схемою дає лише сервер.
 */

useBuildPlanRoles()

describe.concurrent("USAGE on the application schema", () => {
  it.each([
    ["the request role", USER],
    ["the command role", PLATFORM_ROLES.command],
  ])("lets %s read a table of a non-public schema", async (_name, role) => {
    const model = await compiled({ [PARTY]: party() })
    expect(model.project.defaultSchema).toBe("app")
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      const rows = await query<{ n: number }>(
        withSessionOptions(asSuperuser(url), `-c role=${role}`),
        "select count(*)::int as n from app.party"
      )
      expect(rows).toEqual([{ n: 0 }])
    })
  })
})

describe("a USAGE grant of the application on its schema", () => {
  const USAGE = "sql/app/usage.sql"
  const REGION = "catalogs/Region/Region.meta.json"
  const region = (publicRead?: string) =>
    catalog("Region", {
      id: uuid(9002),
      scope: "none",
      ...(publicRead === undefined ? {} : { publicRead }),
    })
  const grantSql = (roles: readonly string[]) =>
    roles
      .map((r) => `GRANT USAGE ON SCHEMA app TO ${quoteIdent(r)};\n`)
      .join("")
  const schemaSteps = (outcome: PlanOutcome) =>
    (outcome.status === "planned" ? outcome.artifact.steps : [])
      .map((s) => s.sql)
      .filter((sql) => /ON SCHEMA "?app"?/i.test(sql))

  it.each([
    ["keeps the application's grant", true, []],
    [
      "revokes the generated grant without it",
      false,
      [`REVOKE ALL ON SCHEMA "app" FROM "${ANON}"`],
    ],
  ] as const)(
    "%s when the last need of the platform disappears",
    async (_name, declared, revoked) => {
      // Схему ділять таблиці виду й власні об'єкти застосунку: його `USAGE`
      // ролі `anon` (скажімо, для своїх RPC) переживає зникнення
      // `publicRead: anon` — план його не відкликає
      const own = declared ? { [USAGE]: grantSql([ANON]) } : {}
      const before = await compiled({
        [PARTY]: party(),
        [REGION]: region("anon"),
        ...own,
      })
      const after = await compiled({
        [PARTY]: party(),
        [REGION]: region(),
        ...own,
      })
      await inTarget(EMPTY, async (url) => {
        await establish(url, before)
        expect(schemaSteps(await plan(url, after))).toEqual(revoked)
      })
    }
  )

  it("plans nothing on a database applied with the identical grant", async () => {
    // Дослівна тотожна одиниця перемагає згенеровану, тож модель з нею —
    // та сама, що й до генерації `USAGE`: marker бази, застосованої тоді,
    // збігається з новим
    const model = await compiled({
      [PARTY]: party(),
      [USAGE]: grantSql([USER, PLATFORM_ROLES.command]),
    })
    expect(model.sqlUnits.filter((u) => u.generator === "schemaUsage")).toEqual(
      []
    )
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      const outcome = await plan(url, model)
      expect(codes(outcome)).not.toContain("apply.drift")
      expect(outcome.status).toBe("unchanged")
    })
  })
})
