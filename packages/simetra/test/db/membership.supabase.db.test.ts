import { describe, expect, it } from "vitest"
import { PROVIDER_API_ROLES } from "simetra/model"
import { signUp } from "./auth"
import { queryAs, withRollback, claimsFor } from "./connection"
import {
  deployMembership as deploy,
  member,
  organization,
} from "./membership.support"

/**
 * Членство на стеку Supabase (платформна спека §10.5): типові гранти
 * `EXECUTE` провайдера в схемі `public` і сервісна роль, якої профіль
 * `postgres` не має. Решта кейсів — `membership.db.test.ts`.
 */

describe("membership in Postgres", () => {
  it("the provider API roles are exactly the default EXECUTE grantees of the stack", async () => {
    // Факт провайдера в T0: розходження зі стеком дало б функцію, яку
    // виконує роль, що її не названо.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ grantee: string }>(
        `SELECT DISTINCT a.grantee::regrole::text AS grantee
         FROM pg_default_acl d, aclexplode(d.defaclacl) a
         WHERE d.defaclrole = 'postgres'::regrole
           AND d.defaclnamespace = 'public'::regnamespace
           AND d.defaclobjtype = 'f'
           AND a.privilege_type = 'EXECUTE'
           AND a.grantee <> d.defaclrole
         ORDER BY 1`
      )
      expect(rows.map((r) => r.grantee)).toEqual(
        Object.values(PROVIDER_API_ROLES.supabase).sort()
      )
    })
  })

  it("service_role gets no member instead of a permission error", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const alice = await signUp(client)
      const org = await organization(client)
      await member(client, org, alice)
      const service = claimsFor("service")
      expect(
        await queryAs<{ m: string | null }>(
          client,
          "service",
          service,
          "SELECT public.org_member_my_member($1) AS m",
          [org]
        )
      ).toEqual({ rows: [{ m: null }] })
      expect(
        await queryAs(
          client,
          "service",
          service,
          "SELECT s FROM public.org_member_member_scopes() AS s"
        )
      ).toEqual({ rows: [] })
    })
  })
})
