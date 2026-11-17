import { describe, expect, it } from "vitest"
import { PROVIDER_API_ROLES, PROVIDER_LOGIN_ROLES } from "simetra/model"
import { withRollback } from "./connection"

/**
 * `PROVIDER_LOGIN_ROLES.supabase` — за фактом стеку, а не за призначенням:
 * плану й застосуванню під цими входами відмовляє гейт власника, а режим
 * обслуговування прав для них не вмикається. DB-рівень, бо хто з сервісів
 * провайдера яким входом працює, видно лише в `pg_roles` і
 * `pg_stat_activity`. PostgREST локальний стек не запускає (`[api]`
 * вимкнено), тож `authenticator` доводить членство в ролях запиту API.
 */
const LOGINS = PROVIDER_LOGIN_ROLES.supabase

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
