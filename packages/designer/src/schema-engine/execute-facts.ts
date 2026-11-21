import type pg from "pg"
import { PLATFORM_ROLES, PROVIDER_API_ROLES } from "simetra/model"
import type {
  EngineScope,
  ExecuteFacts,
  FunctionExecuteFact,
} from "simetra/schema"

/**
 * Ролі профілю провайдера, чий дієвий `EXECUTE` читається: ролі API
 * провайдера й роль команд платформи. `signalConsumer` не призначення гранту
 * (його отримувач — чужий для декларації), тож його факт не потрібен: грант
 * цій ролі видно в ACL функції як сторонній.
 */
export function profileRoles(provider: EngineScope["provider"]): string[] {
  const roles = [
    ...Object.values(PROVIDER_API_ROLES[provider]),
    PLATFORM_ROLES.command,
  ].filter((role): role is string => typeof role === "string")
  return [...new Set(roles)]
}

/**
 * `$1` — схеми межі, `$2` — ролі профілю. Роль без запису в базі
 * (`to_regrole` → null: наприклад, ролі команд на базі без платформи) у факти
 * не потрапляє — `missingRoles` її називає, а `has_function_privilege` на
 * неіснуючій ролі впала б помилкою. Дієвий ACL — з типовим, коли `proacl`
 * порожній: Postgres тоді дає `EXECUTE` `PUBLIC` і власнику, і цього не видно в
 * самому `proacl`.
 */
const FACTS_SQL = `
with roles as (
  select r.name, to_regrole(quote_ident(r.name)) as oid
  from unnest($2::text[]) as r(name)
)
select
  n.nspname as schema,
  p.proname as name,
  pg_get_function_identity_arguments(p.oid) as "identityArguments",
  pg_get_userbyid(p.proowner) as owner,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'grantee', case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'grantor', pg_get_userbyid(a.grantor),
      'grantable', a.is_grantable
    ) order by a.grantee, a.grantor)
    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.privilege_type = 'EXECUTE'
  ), '[]'::jsonb) as acl,
  coalesce((
    select jsonb_object_agg(r.name, has_function_privilege(r.oid, p.oid, 'EXECUTE'))
    from roles r where r.oid is not null
  ), '{}'::jsonb) as "executeByRole",
  coalesce((
    select jsonb_object_agg(r.name, has_schema_privilege(r.oid, n.oid, 'USAGE'))
    from roles r where r.oid is not null
  ), '{}'::jsonb) as "schemaUsageByRole",
  (select coalesce(array_agg(r.name order by r.name), '{}') from roles r where r.oid is null) as missing
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = any($1::text[])
  and p.prokind in ('f', 'p')
  and not exists (
    select 1 from pg_depend d
    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype in ('e', 'i')
  )
order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
`

const ROLES_SQL = `
select coalesce(array_agg(r.name order by r.name) filter (where to_regrole(quote_ident(r.name)) is null), '{}') as missing
from unnest($1::text[]) as r(name)
`

/**
 * Факти `EXECUTE` на клієнті відкритої транзакції — тієї самої, що й extract
 * (знімок один). Лише читання каталогу.
 */
export async function readExecuteFacts(
  client: pg.ClientBase,
  scope: EngineScope,
  roles: readonly string[] = profileRoles(scope.provider)
): Promise<ExecuteFacts> {
  const { rows } = await client.query<FunctionExecuteFact>(FACTS_SQL, [
    [...scope.schemas],
    [...roles],
  ])
  const missing = await client.query<{ missing: string[] }>(ROLES_SQL, [
    [...roles],
  ])
  return {
    missingRoles: missing.rows[0]!.missing,
    functions: rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      identityArguments: r.identityArguments,
      owner: r.owner,
      acl: r.acl,
      executeByRole: r.executeByRole,
      schemaUsageByRole: r.schemaUsageByRole,
    })),
  }
}
