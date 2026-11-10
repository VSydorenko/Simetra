import { PROVIDER_OWNER_ROLES } from "simetra/model"
import { describe, expect, it } from "vitest"
import { superuserClient } from "./connection"
import {
  assertIdentityState,
  IDENTITY_SQL,
  identityFingerprint,
} from "./stack-guard"

// DB-тест, бо юніт-тест сторожа відповідає на запити звірки підставними
// рядками: що форма цих рядків (імена об'єктів, `privilege_type`) і сам SQL
// збігаються з каталогом живого Postgres після `db:pg:start`, видно лише тут
describe("the better_auth check of the stack guard on database simetra", () => {
  it("passes the absolute check and gives a stable fingerprint", async () => {
    const fingerprint = await assertIdentityState("postgres")
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(await identityFingerprint("postgres")).toBe(fingerprint)
  })

  // Порожні факти пройшли б абсолютну звірку мовчки: запити мусять бачити
  // схему, таблицю ідентичності й обидва гранти власника
  it("reads the owners and the owner's grants the check allows", async () => {
    const client = await superuserClient()
    try {
      const owners = (
        await client.query<{ object: string; owner: string }>(
          IDENTITY_SQL.owners,
          ["better_auth"]
        )
      ).rows
      expect(owners).toEqual(
        expect.arrayContaining([
          { object: "schema better_auth", owner: "simetra_auth" },
          { object: "relation user", owner: "simetra_auth" },
        ])
      )
      const grants = (
        await client.query<{
          object: string
          grantee: string
          privilege: string
        }>(IDENTITY_SQL.grants, ["better_auth"])
      ).rows.filter((g) => g.grantee === PROVIDER_OWNER_ROLES.postgres)
      expect(grants).toEqual([
        {
          object: "relation user",
          grantee: PROVIDER_OWNER_ROLES.postgres,
          privilege: "TRIGGER",
        },
        {
          object: "schema better_auth",
          grantee: PROVIDER_OWNER_ROLES.postgres,
          privilege: "USAGE",
        },
      ])
      const triggers = (
        await client.query<{ name: string; enabled: string }>(
          IDENTITY_SQL.triggers,
          ["better_auth", "user"]
        )
      ).rows
      expect(triggers.length).toBeGreaterThan(0)
    } finally {
      await client.end()
    }
  })
})
