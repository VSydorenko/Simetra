import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PLATFORM_ROLES } from "simetra/model"
import { withRuntimeLogin } from "./support/db"
import {
  dataToolsHelpers,
  heldEnv,
  violations,
  type Env,
} from "./data-tools.support"

/**
 * Кейси запобіжника інструментів даних, прив'язані до Supabase: сервісна роль
 * `service_role` (з `BYPASSRLS`) і мігратор цілі, що є її членом. Профіль
 * `postgres` сервісної ролі не має — його напарник
 * `data-tools.postgres.db.test.ts` доводить її відсутність.
 */

describe("data tools over a real database", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 180_000)
  afterAll(() => target.close(), 60_000)

  const { readGauges, factsAs } = dataToolsHelpers(() => env)

  describe("before the database is marked as a development one", () => {
    it("a login role with service is refused", async () => {
      await withRuntimeLogin(
        env.url,
        [PLATFORM_ROLES.command, "service_role"],
        async (login) => {
          // Рівно один факт-порушення: змішана побудова не доводила б, що
          // відмовляє саме він
          expect(violations(await factsAs(login))).toEqual(["service"])
          expect((await readGauges({ url: login })).refusal).toMatchObject({
            reason: "data-guard",
            detail: "login-refused",
          })
        },
        "data_service"
      )
    })

    it("the migrator of the target is a member of the service role and bypasses RLS", async () => {
      expect(violations(await factsAs(env.url))).toEqual(
        expect.arrayContaining(["rolbypassrls", "migrator", "service"])
      )
    })
  })
})
