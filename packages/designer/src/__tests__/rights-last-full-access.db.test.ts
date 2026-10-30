import { randomUUID } from "node:crypto"
import pg from "pg"
import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { RIGHTS_MAINTENANCE_SETTING } from "simetra/model"
import { engineScope, renderDesiredState } from "simetra/schema"
import {
  ORG_ADMIN_ID,
  adminRoles,
  policyDomain,
  writeRoles,
} from "../../../simetra/test/support"
import { inTarget, waitForLock } from "./support/db"

/**
 * Останнього носія перевіряємо двома з'єднаннями після реального COMMIT:
 * тільки Postgres доводить, що замок версії серіалізує одночасні зміни, а
 * VOLATILE-перевірка бачить свіжий знімок у READ COMMITTED.
 */

type Carrier = {
  org: string
  first: string
  second: string
  targetOrg: string
  targetMember: string
}

async function session(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  return client
}

async function seedCarrier(client: pg.Client): Promise<Carrier> {
  const org = randomUUID()
  const targetOrg = randomUUID()
  const targetMember = randomUUID()
  const people = [randomUUID(), randomUUID()]
  const members = [randomUUID(), randomUUID()]
  const assignments = [randomUUID(), randomUUID()]
  await client.query("BEGIN")
  try {
    await client.query("SELECT set_config($1, 'on', true)", [
      RIGHTS_MAINTENANCE_SETTING,
    ])
    await client.query("INSERT INTO public.organization (id) VALUES ($1)", [
      org,
    ])
    await client.query("INSERT INTO public.organization (id) VALUES ($1)", [
      targetOrg,
    ])
    for (let i = 0; i < 2; i++) {
      await client.query("INSERT INTO public.users (id) VALUES ($1)", [
        people[i],
      ])
      await client.query(
        "INSERT INTO public.org_member (id, org_id, user_id) VALUES ($1, $2, $3)",
        [members[i], org, people[i]]
      )
      await client.query(
        "INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ($1, $2, $3, $4)",
        [assignments[i], org, members[i], ORG_ADMIN_ID]
      )
    }
    const targetUser = randomUUID()
    await client.query("INSERT INTO public.users (id) VALUES ($1)", [
      targetUser,
    ])
    await client.query(
      "INSERT INTO public.org_member (id, org_id, user_id) VALUES ($1, $2, $3)",
      [targetMember, targetOrg, targetUser]
    )
    await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    await client.query("SELECT set_config($1, 'off', true)", [
      RIGHTS_MAINTENANCE_SETTING,
    ])
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  }
  return {
    org,
    first: assignments[0]!,
    second: assignments[1]!,
    targetOrg,
    targetMember,
  }
}

describe("concurrent last fullAccess carrier", () => {
  it("serializes READ COMMITTED and rejects the stale REPEATABLE READ transaction", async () => {
    const result = await compile(policyDomain(writeRoles(), adminRoles()))
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    await inTarget(
      renderDesiredState(model).sql,
      (await engineScope(model)).scope,
      async (url) => {
        const owner = await session(url)
        try {
          for (const [isolation, expectedCode, expectedDetail] of [
            ["READ COMMITTED", "42501", "last-full-access"],
            ["REPEATABLE READ", "40001", undefined],
          ] as const) {
            const carrier = await seedCarrier(owner)
            const first = await session(url)
            const second = await session(url)
            try {
              await first.query(`BEGIN ISOLATION LEVEL ${isolation}`)
              await second.query(`BEGIN ISOLATION LEVEL ${isolation}`)
              await first.query("SELECT set_config($1, 'on', true)", [
                RIGHTS_MAINTENANCE_SETTING,
              ])
              await second.query("SELECT set_config($1, 'on', true)", [
                RIGHTS_MAINTENANCE_SETTING,
              ])
              const { rows } = await second.query<{ pid: number }>(
                "SELECT pg_backend_pid() AS pid"
              )
              await first.query(
                "UPDATE public.org_role_assignments SET deletion_mark = true WHERE id = $1",
                [carrier.first]
              )
              await first.query("SET CONSTRAINTS ALL IMMEDIATE")
              // Замок рядка версії скоупу — перший крок оператора (спека прав §7):
              // сесія 2 стає в чергу вже на своєму UPDATE, а не на COMMIT
              const pending = (async () => {
                try {
                  await second.query(
                    "UPDATE public.org_role_assignments SET deletion_mark = true WHERE id = $1",
                    [carrier.second]
                  )
                  await second.query("COMMIT")
                  return undefined
                } catch (error) {
                  return error
                }
              })()
              await waitForLock(first, rows[0]!.pid)
              await first.query("COMMIT")
              const failure = await pending
              expect(failure).toBeInstanceOf(pg.DatabaseError)
              expect(failure).toMatchObject({
                code: expectedCode,
                ...(expectedDetail === undefined
                  ? {}
                  : { detail: expectedDetail }),
              })
              const { rows: active } = await owner.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM public.org_role_assignments WHERE org_id = $1 AND deletion_mark = false",
                [carrier.org]
              )
              expect(active[0]?.n).toBe(1)
            } finally {
              await first.query("ROLLBACK").catch(() => undefined)
              await second.query("ROLLBACK").catch(() => undefined)
              await first.end()
              await second.end()
            }
          }
          const carrier = await seedCarrier(owner)
          const first = await session(url)
          const second = await session(url)
          try {
            await first.query("BEGIN")
            await second.query("BEGIN")
            await first.query("SELECT set_config($1, 'on', true)", [
              RIGHTS_MAINTENANCE_SETTING,
            ])
            await second.query("SELECT set_config($1, 'on', true)", [
              RIGHTS_MAINTENANCE_SETTING,
            ])
            await first.query(
              "UPDATE public.org_role_assignments SET org_id = $1, subject = $2 WHERE id = $3",
              [carrier.targetOrg, carrier.targetMember, carrier.first]
            )
            await first.query("SET CONSTRAINTS ALL IMMEDIATE")
            const { rows } = await second.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid"
            )
            const pending = (async () => {
              try {
                await second.query(
                  "UPDATE public.org_role_assignments SET deletion_mark = true WHERE id = $1",
                  [carrier.second]
                )
                await second.query("SET CONSTRAINTS ALL IMMEDIATE")
                await second.query("COMMIT")
                return undefined
              } catch (error) {
                return error
              }
            })()
            await waitForLock(first, rows[0]!.pid)
            await first.query("COMMIT")
            const failure = await pending
            expect(failure).toBeInstanceOf(pg.DatabaseError)
            expect(failure).toMatchObject({
              code: "42501",
              detail: "last-full-access",
            })
            const { rows: active } = await owner.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM public.org_role_assignments WHERE org_id = $1 AND deletion_mark = false",
              [carrier.org]
            )
            expect(active[0]?.n).toBe(1)
          } finally {
            await first.query("ROLLBACK").catch(() => undefined)
            await second.query("ROLLBACK").catch(() => undefined)
            await first.end()
            await second.end()
          }
        } finally {
          await owner.end()
        }
      }
    )
  }, 120_000)
})
