import { describe, expect, it } from "vitest"
import { testSuperuserUrl, withRollback } from "./connection"
import { ownerLoginModel, probe, seedProbes } from "./rights-guards.support"
import { deploy } from "./rights-seed"

/**
 * Вхід провайдера, що сам володіє функціями прав (платформна спека §10.5):
 * суперкористувач стека Supabase `supabase_admin` — вхід провайдера, і план,
 * помилково застосований під ним, лишає режим обслуговування недоступним.
 * На стеку `postgres` власник — несуперкористувач `simetra_owner`, тож
 * аналог — кейс власника функцій у `rights-guards.db.test.ts`.
 */

describe("maintenance only from the owner login", () => {
  it("a provider login that owns the rights functions never enables maintenance", async () => {
    const model = await ownerLoginModel()
    expect(model.diagnostics).toEqual([])
    await withRollback(async (client) => {
      // Без `SET ROLE`: власник функцій прав — сам суперкористувач стека.
      await deploy(client, model.model!)
      const member = await seedProbes(client)
      const owner = await client.query<{ same: boolean; login: string }>(
        "SELECT session_user = current_user AS same, session_user AS login"
      )
      expect(owner.rows[0]?.same).toBe(true)
      await probe(client, member, owner.rows[0]!.login, "rights-context")
    }, testSuperuserUrl())
  }, 120_000)
})
