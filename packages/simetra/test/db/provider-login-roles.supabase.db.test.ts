import { describe, expect, it } from "vitest"
import {
  PLATFORM_LOGIN_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
} from "simetra/model"
import { runTag, withRollback } from "./connection"

/**
 * `PROVIDER_LOGIN_ROLES.supabase` — за фактом стеку, а не за призначенням:
 * плану й застосуванню під цими входами відмовляє гейт власника, а режим
 * обслуговування прав для них не вмикається. DB-рівень, бо хто з сервісів
 * провайдера яким входом працює, видно лише в `pg_roles` і
 * `pg_stat_activity`. PostgREST локальний стек не запускає (`[api]`
 * вимкнено), тож `authenticator` доводить членство в ролях запиту API.
 */
const LOGINS = PROVIDER_LOGIN_ROLES.supabase

/**
 * Ролі LOGIN стеку, яких навмисно немає в переліку, — кожна з причиною.
 * Нова роль входу образу, якої немає ні тут, ні в переліку, валить тест.
 */
const NOT_PROVIDER_LOGINS: Record<string, string> = {
  [PROVIDER_OWNER_ROLES.supabase]:
    "the owner role: the migrator plans and applies under it, and the pooler (Supavisor) shares it",
  ...Object.fromEntries(
    Object.values(PLATFORM_LOGIN_ROLES).map((role) => [
      role,
      "a login of the platform, not of the provider: roles.sql creates it",
    ])
  ),
}

describe("supabase provider login roles", () => {
  it("lists only LOGIN roles", async () => {
    const rows = await withRollback((client) =>
      client
        .query<{ role: string; login: boolean }>(
          "select rolname as role, rolcanlogin as login from pg_roles where rolname = any($1::text[]) order by 1",
          [LOGINS]
        )
        .then((r) => r.rows)
    )
    expect(rows).toEqual(
      [...LOGINS].sort().map((role) => ({ role, login: true }))
    )
  })

  it("names every LOGIN role of the stack, or excludes it with a reason", async () => {
    // Теговані ролі прогону створюють тести; чужих прогонів на стеку немає:
    // сторож пускає один DB-прогін за раз
    const tag = runTag()
    const roles = await withRollback((client) =>
      client
        .query<{ role: string }>(
          "select rolname as role from pg_roles where rolcanlogin order by 1"
        )
        .then((r) => r.rows.map((row) => row.role))
    )
    const unexplained = roles.filter(
      (role) =>
        !LOGINS.includes(role) &&
        !(role in NOT_PROVIDER_LOGINS) &&
        !role.endsWith(`_${tag}`)
    )
    expect(unexplained).toEqual([])
  })

  it("covers every session of the provider's services", async () => {
    // Сесії сервісів: не наші (без імені прогону чи сторожа) і не власника
    // `postgres`, від якого працює мігратор і пулер
    const users = await withRollback((client) =>
      client
        .query<{ role: string }>(
          `select distinct usename as role from pg_stat_activity
            where backend_type = 'client backend' and usename is not null
              and usename <> 'postgres'
              and coalesce(application_name, '') not like 'simetra\\_db\\_%'
            order by 1`
        )
        .then((r) => r.rows.map((row) => row.role))
    )
    // Auth і Storage тримають пул з'єднань: без них перевірка була б порожньою
    expect(users).toEqual(
      expect.arrayContaining(["supabase_auth_admin", "supabase_storage_admin"])
    )
    expect(users.filter((u) => !LOGINS.includes(u))).toEqual([])
  })

  it("lets authenticator switch into every API request role", async () => {
    const api = PROVIDER_API_ROLES.supabase
    const rows = await withRollback((client) =>
      client
        .query<{ role: string; member: boolean }>(
          "select r as role, pg_has_role('authenticator', r, 'MEMBER') as member from unnest($1::text[]) r order by 1",
          [[api.user, api.anonymous, api.service]]
        )
        .then((r) => r.rows)
    )
    expect(rows.every((r) => r.member)).toBe(true)
    expect(rows).toHaveLength(3)
  })
})
