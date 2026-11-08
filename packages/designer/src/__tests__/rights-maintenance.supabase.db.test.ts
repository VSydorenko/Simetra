import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  APPLY_ADVISORY_LOCK,
  type RightsMaintenanceRequest,
} from "simetra/schema"
import { runTool } from "../cli/command"
import { rightsMaintenanceTool } from "../tools/rights-maintenance-tool"
import { GLOBAL_ADMIN_ID, signUp } from "../../../simetra/test/support"
import { query, throughPoolerAs, withCopy } from "./support/db"

import {
  asOwner,
  doneOf,
  ENV,
  type Env,
  globalAssignments,
  heldEnv,
  journalOf,
  maintain,
  refusalOf,
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

  it("first global: busy under the apply lock, then through the pooler, then not-first from the CLI", async () => {
    await inCopy(async (url) => {
      const [user, other] = await asOwner(url, async (owner) => [
        await signUp(owner),
        await signUp(owner),
      ])
      const first: RightsMaintenanceRequest = {
        action: "firstGlobalAssignment",
        user,
        role: "GlobalAdmin",
      }
      // Замок `apply` тримає інша сесія: інструмент не чекає й не пише
      await asOwner(url, async (holder) => {
        await holder.query("BEGIN")
        await holder.query(
          `SELECT pg_advisory_xact_lock(${APPLY_ADVISORY_LOCK})`
        )
        try {
          expect(refusalOf(await maintain(env.dir, url, first)).code).toBe(
            "maintenance.busy"
          )
        } finally {
          await holder.query("ROLLBACK")
        }
      })
      expect(await globalAssignments(url)).toBe(0)

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

      // Повтор — уже не перше призначення: відмова з ненульовим кодом виходу
      const again = await runTool(
        rightsMaintenanceTool,
        {
          _: [JSON.stringify({ ...first, user: other }), env.dir],
          yes: true,
          format: "json",
        },
        () => Promise.resolve(""),
        process.cwd(),
        { [ENV]: url }
      )
      expect(again.exitCode, again.stderr + again.stdout).toBe(1)
      expect(
        (JSON.parse(again.stdout) as { code: string }[]).map((d) => d.code)
      ).toEqual(["maintenance.not-first"])
      expect(await globalAssignments(url)).toBe(1)
    })
  })
})
