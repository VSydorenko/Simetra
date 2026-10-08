import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile } from "simetra/compiler"
import { PROVIDER_FUNCTION_GRANTEES } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  attribute,
  catalog,
  metaFiles,
  project,
  uuid,
} from "../../src/compiler/__tests__/helpers"
import { queryAs, withRollback } from "./connection"

/**
 * Членство на справжньому Postgres (спека користувачів §8): унікальність
 * `(носій скоупу, користувач)` NULLS DISTINCT, «мій учасник» і функція
 * множини з членства під claims запиту. Схема — `public`: провайдер дає там
 * ролям API `EXECUTE` на нові функції типовими привілеями, тож це суворіший
 * випадок за власну схему застосунку.
 */

async function deploy(client: pg.Client): Promise<void> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project({
        scopeKinds: [
          {
            id: uuid(80),
            name: "org",
            physicalName: "org_id",
            root: { object: { kind: "Catalog", name: "Organization" } },
            setFunction: "membership",
          },
        ],
      }),
      "catalogs/Organization/Organization.meta.json": catalog("Organization", {
        scope: "org",
      }),
      "catalogs/Users/Users.meta.json": catalog("Users", {
        role: "users",
        scope: "none",
      }),
      "catalogs/OrgMember/OrgMember.meta.json": catalog("OrgMember", {
        scope: "org",
        membership: { user: "user" },
        attributes: [
          attribute("user", {
            physicalName: "user_id",
            type: "Ref",
            ref: { kind: "Catalog", name: "Users" },
          }),
        ],
      }),
    })
  )
  expect(result.diagnostics).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
}

/** Обліковий запис провайдера: провізія створює рядок «Користувачів». */
async function signUp(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), gen_random_uuid() || '@example.test') RETURNING id"
  )
  return rows[0]!.id
}

async function organization(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO public.organization (id, description) VALUES (gen_random_uuid(), 'Org') RETURNING id"
  )
  return rows[0]!.id
}

async function member(
  client: pg.Client,
  org: string,
  user: string | null
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO public.org_member (id, org_id, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id",
    [org, user]
  )
  return rows[0]!.id
}

const user = (sub: string) => ({ sub, role: "authenticated" })

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
          "authenticated",
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
          "authenticated",
          user(sub),
          "SELECT s FROM public.org_member_member_scopes() AS s"
        )
      expect(await scopes(alice)).toEqual({ rows: [{ s: a }] })
      expect(await scopes(bob)).toEqual({ rows: [{ s: b }] })
    })
  })

  it("the provider function grantees match the default privileges of the stack", async () => {
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
        [...PROVIDER_FUNCTION_GRANTEES.supabase].sort()
      )
    })
  })

  it("service_role gets no member instead of a permission error", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const alice = await signUp(client)
      const org = await organization(client)
      await member(client, org, alice)
      const service = { role: "service_role" }
      expect(
        await queryAs<{ m: string | null }>(
          client,
          "service_role",
          service,
          "SELECT public.org_member_my_member($1) AS m",
          [org]
        )
      ).toEqual({ rows: [{ m: null }] })
      expect(
        await queryAs(
          client,
          "service_role",
          service,
          "SELECT s FROM public.org_member_member_scopes() AS s"
        )
      ).toEqual({ rows: [] })
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
          await queryAs(client, "anon", { role: "anon" }, sql, params),
          sql
        ).toEqual({ code: "42501" })
      }
    })
  })
})
