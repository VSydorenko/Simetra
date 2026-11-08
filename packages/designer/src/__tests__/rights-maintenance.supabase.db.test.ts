import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type RightsMaintenanceRequest } from "simetra/schema"
import { GLOBAL_ADMIN_ID, signUp } from "../../../simetra/test/support"
import { query, throughPoolerAs, withCopy } from "./support/db"

import {
  asOwner,
  doneOf,
  type Env,
  heldEnv,
  journalOf,
  maintain,
} from "./rights-maintenance.support"

/**
 * Інструмент обслуговування прав через пулер Supavisor: мігратор, що входить
 * через пулер, лишається власником функцій для `session_user`. Спільна
 * підготовка — `rights-maintenance.support.ts`.
 */

describe("rights-maintenance tool over a real database", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 180_000)
  afterAll(() => target.close(), 60_000)

  /** Копія цілі: глобальний сценарій пише те, чого не зняти. */
  const inCopy = <T>(fn: (url: string) => Promise<T>) =>
    withCopy(`template "${new URL(env.url).pathname.slice(1)}"`, (url) =>
      fn(url)
    )

  it("first global through the pooler: the migrator's session_user still owns the rights functions", async () => {
    await inCopy(async (url) => {
      const user = await asOwner(url, (owner) => signUp(owner))
      const first: RightsMaintenanceRequest = {
        action: "firstGlobalAssignment",
        user,
        role: "GlobalAdmin",
      }
      // Мігратор через Supavisor: `session_user` там теж власник функцій
      const done = doneOf(await maintain(env.dir, throughPoolerAs(url), first))
      expect(
        await query(
          url,
          "SELECT subject::text AS subject, archetype::text AS archetype FROM public.global_role_assignments WHERE id = $1",
          [done.assignment]
        )
      ).toEqual([{ subject: user, archetype: GLOBAL_ADMIN_ID }])
      expect(await journalOf(url, done.assignment)).toEqual([
        { actor: null, reason: "maintenance", action: null },
      ])
    })
  })
})
