import { randomUUID } from "node:crypto"
import pg from "pg"
import { expect } from "vitest"
import {
  PROVIDER_OWNER_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  quoteIdent,
} from "simetra/model"
import {
  TASK_VIEWER_ID,
  adminRoles,
  compileRights,
  policyDomain,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import { asSessionLogin, testRoleFor } from "./connection"
import { testProvider } from "./profile"
import { insert, profileLayer } from "./rights-seed"

/**
 * Опис «maintenance only from the owner login», спільний для `rights-guards`
 * і `rights-guards.supabase`: хто власник функцій прав і під яким входом
 * сесія, вирішує Postgres — `session_user = current_user` у
 * `SECURITY DEFINER` юніт не доводить.
 */

export const ownerLoginModel = () =>
  compileRights(policyDomain(writeRoles(), adminRoles(), profileLayer()))

/** Засів і функції-зонди: `debt_grant` вмикає режим, `debt_grant_plain` — ні. */
export async function seedProbes(client: pg.Client): Promise<string> {
  const org = randomUUID()
  const member = randomUUID()
  const user = await signUp(client)
  await insert(client, "organization", { id: org })
  await insert(client, "org_member", {
    id: member,
    org_id: org,
    user_id: user,
  })
  const grant = `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype)
        VALUES (gen_random_uuid(), '${org}', p_subject, '${TASK_VIEWER_ID}');`
  for (const [name, prelude] of [
    [
      "debt_grant",
      `PERFORM set_config('${RIGHTS_MAINTENANCE_SETTING}', 'on', true);`,
    ],
    ["debt_grant_plain", ""],
  ]) {
    await client.query(`CREATE FUNCTION public.${name}(p_subject uuid) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
      BEGIN
        ${prelude}
        ${grant}
      END $$`)
    await client.query(
      `GRANT EXECUTE ON FUNCTION public.${name}(uuid) TO ${quoteIdent(testRoleFor("user")!)}`
    )
  }
  return member
}

/**
 * Виклик зонда `fn` від ролі входу `login` (`asSessionLogin`). Вхід, що не
 * власник, кличе зонд від ролі запиту користувача, якщо він її член (як
 * PostgREST), інакше — сам: роль входу сервісу автентифікації профілю
 * `postgres` членом ролі запиту не є. `expected` — деталь відмови; без неї —
 * успіх.
 */
export async function probe(
  client: pg.Client,
  member: string,
  login: string,
  expected?: string,
  fn = "debt_grant"
): Promise<void> {
  const owner = PROVIDER_OWNER_ROLES[testProvider()]
  const user = testRoleFor("user")!
  const { rows } = await client.query<{ member: boolean }>(
    "SELECT pg_has_role($1, $2, 'MEMBER') AS member",
    [login, user]
  )
  const asUser = login !== owner && rows[0]!.member
  await asSessionLogin(client, login, async () => {
    if (asUser) await client.query(`SET LOCAL ROLE ${user}`)
    const identity = await client.query<{ login: string; role: string }>(
      "SELECT session_user AS login, current_user AS role"
    )
    expect(identity.rows[0]).toEqual({ login, role: asUser ? user : login })
    // Відмова зонда зриває транзакцію: точка збереження дає повернути вхід
    await client.query("SAVEPOINT api_login")
    let failure: pg.DatabaseError | undefined
    try {
      await client.query(`SELECT public.${fn}($1)`, [member])
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    } catch (error) {
      if (!(error instanceof pg.DatabaseError)) throw error
      failure = error
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT api_login")
    }
    if (expected === undefined) expect(failure).toBeUndefined()
    else expect(failure).toMatchObject({ code: "42501", detail: expected })
  })
}
