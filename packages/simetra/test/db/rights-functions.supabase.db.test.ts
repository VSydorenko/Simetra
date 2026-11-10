import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { queryAs, claimsFor } from "./connection"
import { scopeKindModel, seedScopeKind } from "./rights-functions.support"
import { deploy, describeTransaction, outcome, set } from "./rights-seed"

/**
 * Функції прав під сервісною роллю провайдера (платформна спека §10.5): роль
 * є лише на стеку Supabase. Решта кейсів опису —
 * `rights-functions.db.test.ts`.
 */

describe("rights functions with a scope kind", () => {
  const tx = describeTransaction()

  beforeAll(async () => {
    const client = await tx.open()
    await deploy(client, await scopeKindModel())
    await seedScopeKind(client)
  })

  afterAll(() => tx.close())

  it("service-role: empty sets without an error", async () => {
    expect(
      outcome(
        await queryAs<{ v: unknown }>(
          tx.client(),
          "service",
          claimsFor("service"),
          set("simetra.rights_any('read','task')")
        )
      )
    ).toEqual([])
  })
})
