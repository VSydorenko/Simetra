import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PLATFORM_ROLES, PROVIDER_API_ROLES } from "simetra/model"
import { testProvider } from "../../../simetra/test/support"
import { withRuntimeLogin } from "./support/db"
import {
  dataToolsHelpers,
  heldEnv,
  REQUEST_ROLE,
  violations,
  type Env,
} from "./data-tools.support"

/**
 * Напарник кейса «роль входу зі службовою роллю» на Supabase
 * (`data-tools.supabase.db.test.ts`): профіль `postgres` службової ролі не
 * має, тож запобіжник не бачить жодного сервісного гранту, а звичайна роль
 * входу його проходить.
 */

describe("data tools guard without a service role", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 180_000)
  afterAll(() => target.close(), 60_000)

  const { factsAs } = dataToolsHelpers(() => env)

  it("the profile names no service role and a login role has no service fact", async () => {
    expect(PROVIDER_API_ROLES[testProvider()].service).toBeNull()
    await withRuntimeLogin(
      env.url,
      [PLATFORM_ROLES.command, REQUEST_ROLE],
      async (login) => {
        expect(violations(await factsAs(login))).toEqual([])
        expect((await factsAs(login)).service).toBe(false)
      },
      "data_no_service"
    )
  })
})
