import { describe, expect, it } from "vitest"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_OWNER_ROLES,
} from "simetra/model"
import { signUp } from "./auth"
import { queryAs, withRollback, claimsFor } from "./connection"
import {
  deployMembership as deploy,
  member,
  organization,
} from "./membership.support"
import { testProvider } from "./profile"

/**
 * Членство на справжньому Postgres (спека користувачів §8): унікальність
 * `(носій скоупу, користувач)` NULLS DISTINCT, «мій учасник» і функція
 * множини з членства під claims запиту. Схема — `public`: на стеку Supabase
 * провайдер дає там ролям API `EXECUTE` на нові функції типовими
 * привілеями, тож це суворіший випадок за власну схему застосунку; кейси
 * сервісної ролі й типових привілеїв провайдера —
 * `membership.supabase.db.test.ts`.
 */

const user = (sub: string) => claimsFor("user", sub)

describe("membership in Postgres", () => {
  it("members without a user may repeat in a tenant; the same user may not", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const org = await organization(client)
      await member(client, org, null)
      await member(client, org, null)
      const alice = await signUp(client)
      await member(client, org, alice)
      await client.query("SAVEPOINT twice")
      const twice = await member(client, org, alice).catch(
        (error: { code: string }) => error.code
      )
      await client.query("ROLLBACK TO SAVEPOINT twice")
      expect(twice).toBe("23505")
    })
  })

  it("my_member finds the member of the current user only", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const alice = await signUp(client)
      const bob = await signUp(client)
      const own = await organization(client)
      const other = await organization(client)
      const invitedOnly = await organization(client)
      const aliceMember = await member(client, own, alice)
      await member(client, other, bob)
      await member(client, invitedOnly, null)
      const myMember = (sub: string, org: string) =>
        queryAs<{ m: string | null }>(
          client,
          "user",
          user(sub),
          "SELECT public.org_member_my_member($1) AS m",
          [org]
        )
      expect(await myMember(alice, own)).toEqual({ rows: [{ m: aliceMember }] })
      // Учасник лише деінде — у чужому тенанті нікого.
      expect(await myMember(alice, other)).toEqual({ rows: [{ m: null }] })
      // Запрошення без облікового запису нічиїм учасником не є.
      expect(await myMember(alice, invitedOnly)).toEqual({
        rows: [{ m: null }],
      })
    })
  })

  it("member_scopes returns exactly the scopes of the current user", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const alice = await signUp(client)
      const bob = await signUp(client)
      const a = await organization(client)
      const b = await organization(client)
      await member(client, a, alice)
      await member(client, b, bob)
      await member(client, b, null)
      const scopes = (sub: string) =>
        queryAs<{ s: string }>(
          client,
          "user",
          user(sub),
          "SELECT s FROM public.org_member_member_scopes() AS s"
        )
      expect(await scopes(alice)).toEqual({ rows: [{ s: a }] })
      expect(await scopes(bob)).toEqual({ rows: [{ s: b }] })
    })
  })

  it("no function of the model is executable by PUBLIC or by a role outside the profile", async () => {
    // Аналог кейсу типових грантів провайдера (`membership.supabase`): без
    // типових привілеїв `EXECUTE` нової функції дістає `PUBLIC`, і функцію
    // виконав би будь-хто з входом, зокрема роль сервісу автентифікації.
    // Функції моделі — ті, що з'явилися з розгортанням.
    await withRollback(async (client) => {
      const functionsSql = `SELECT p.oid, n.nspname || '.' || p.proname AS fn
          FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'simetra')`
      const before = await client.query<{ oid: number }>(functionsSql)
      await deploy(client)
      const known = new Set(before.rows.map((f) => f.oid))
      const functions = (
        await client.query<{ oid: number; fn: string }>(functionsSql)
      ).rows.filter((f) => !known.has(f.oid))
      // Функції моделі справді є: інакше «жодного гранту» нічого б не довело
      expect(functions.map((f) => f.fn)).toContain(
        "public.org_member_my_member"
      )
      const provider = testProvider()
      const allowed = [
        PROVIDER_OWNER_ROLES[provider],
        ...Object.values(PROVIDER_API_ROLES[provider]).filter(
          (role): role is string => role !== null
        ),
        ...Object.values(PLATFORM_ROLES),
      ]
      // Без ACL функція має типовий: `EXECUTE` для `PUBLIC`
      const { rows } = await client.query<{ fn: string; grantee: string }>(
        `SELECT n.nspname || '.' || p.proname AS fn,
                CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          WHERE p.oid = ANY ($1::oid[])
            AND a.privilege_type = 'EXECUTE'
            AND (a.grantee = 0 OR NOT a.grantee::regrole::text = ANY ($2::text[]))
          ORDER BY 1, 2`,
        [functions.map((f) => f.oid), allowed]
      )
      expect(rows).toEqual([])
    })
  })

  it("anon may execute neither function", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const org = await organization(client)
      for (const sql of [
        "SELECT public.org_member_my_member($1)",
        "SELECT public.org_member_member_scopes()",
      ]) {
        const params = sql.includes("$1") ? [org] : []
        expect(
          await queryAs(
            client,
            "anonymous",
            claimsFor("anonymous"),
            sql,
            params
          ),
          sql
        ).toEqual({ code: "42501" })
      }
    })
  })
})
