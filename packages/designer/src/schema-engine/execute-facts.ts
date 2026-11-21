import type pg from "pg"
import { PLATFORM_ROLES, PROVIDER_API_ROLES } from "simetra/model"
import type {
  EngineScope,
  ExecuteCrossCheckFailure,
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
 * `$1` — схеми межі, `$2` — ролі профілю.
 *
 * Виведення — лише з рядків каталогу, прочитаних `SELECT` у знімку
 * транзакції (`pg_proc`, `pg_namespace`, `pg_roles`, `pg_auth_members`):
 * функції каталожного кешу (`has_*_privilege`, `to_regrole`, `pg_get_userbyid`)
 * бачать свіжіший стан, ніж знімок `REPEATABLE READ`. Межа виведення — ролі
 * профілю як кандидати у викликачі, а не вся семантика Postgres: `PUBLIC`,
 * власник (запис типового ACL), суперкористувач і членство з `inherit_option`
 * (рекурсивно). `has_function_privilege` і `has_schema_privilege` лишаються
 * звіркою (`observed*`): розбіжність каже, що ACL чи членство змінилися між
 * читаннями.
 *
 * Ідентичність аргументів (`pg_get_function_identity_arguments`) читає кеш; її
 * зміна без зміни ACL фактів не псує, бо ключ функції — oid знімка, а
 * `has_function_privilege` на зниклій функції дає `null` і розбіжність.
 */
const FACTS_SQL = `
with recursive roles as (
  select r.name, x.oid, coalesce(x.rolsuper, false) as superuser
  from unnest($2::text[]) as r(name)
  left join pg_roles x on x.rolname = r.name
), reach(role_name, oid) as (
  select name, oid from roles where oid is not null
  union
  select reach.role_name, m.roleid
  from reach join pg_auth_members m on m.member = reach.oid and m.inherit_option
), scoped as (
  select p.oid, n.oid as nsp, n.nspname, p.proname, p.proowner,
         coalesce(p.proacl, acldefault('f', p.proowner)) as facl,
         coalesce(n.nspacl, acldefault('n', n.nspowner)) as nacl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = any($1::text[])
    and p.prokind in ('f', 'p')
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype in ('e', 'i')
    )
)
select
  s.nspname as schema,
  s.proname as name,
  pg_get_function_identity_arguments(s.oid) as "identityArguments",
  (select rolname from pg_roles where oid = s.proowner) as owner,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'grantee', case a.grantee when 0 then 'PUBLIC' else (select rolname from pg_roles where oid = a.grantee) end,
      'grantor', (select rolname from pg_roles where oid = a.grantor),
      'grantable', a.is_grantable
    ) order by a.grantee, a.grantor)
    from aclexplode(s.facl) a
    where a.privilege_type = 'EXECUTE'
  ), '[]'::jsonb) as acl,
  coalesce((
    select jsonb_object_agg(r.name,
      r.superuser or exists (
        select 1 from aclexplode(s.facl) a
        where a.privilege_type = 'EXECUTE'
          and (a.grantee = 0 or a.grantee in (select oid from reach where role_name = r.name))))
    from roles r where r.oid is not null
  ), '{}'::jsonb) as "executeByRole",
  coalesce((
    select jsonb_object_agg(r.name,
      r.superuser or exists (
        select 1 from aclexplode(s.nacl) a
        where a.privilege_type = 'USAGE'
          and (a.grantee = 0 or a.grantee in (select oid from reach where role_name = r.name))))
    from roles r where r.oid is not null
  ), '{}'::jsonb) as "schemaUsageByRole",
  coalesce((
    select jsonb_object_agg(r.name, coalesce(has_function_privilege(r.oid, s.oid, 'EXECUTE'), false))
    from roles r where r.oid is not null
  ), '{}'::jsonb) as "observedExecute",
  coalesce((
    select jsonb_object_agg(r.name, coalesce(has_schema_privilege(r.oid, s.nsp, 'USAGE'), false))
    from roles r where r.oid is not null
  ), '{}'::jsonb) as "observedUsage"
from scoped s
order by s.nspname, s.proname, pg_get_function_identity_arguments(s.oid)
`

const MISSING_SQL = `
select r.name
from unnest($1::text[]) as r(name)
where not exists (select 1 from pg_roles x where x.rolname = r.name)
order by r.name
`

interface FactRow extends FunctionExecuteFact {
  observedExecute: Record<string, boolean>
  observedUsage: Record<string, boolean>
}

/**
 * Факти `EXECUTE` на клієнті відкритої транзакції — тієї самої, що й extract
 * (знімок один). Лише читання каталогу.
 */
export async function readExecuteFacts(
  client: pg.ClientBase,
  scope: EngineScope,
  roles: readonly string[] = profileRoles(scope.provider)
): Promise<ExecuteFacts> {
  const { rows } = await client.query<FactRow>(FACTS_SQL, [
    [...scope.schemas],
    [...roles],
  ])
  const missing = await client.query<{ name: string }>(MISSING_SQL, [
    [...roles],
  ])
  const crossCheckFailures: ExecuteCrossCheckFailure[] = []
  for (const r of rows) {
    const failure = (role: string, privilege: "EXECUTE" | "USAGE") =>
      crossCheckFailures.push({
        schema: r.schema,
        name: r.name,
        identityArguments: r.identityArguments,
        role,
        privilege,
      })
    for (const role of Object.keys(r.executeByRole))
      if (r.executeByRole[role] !== r.observedExecute[role])
        failure(role, "EXECUTE")
    for (const role of Object.keys(r.schemaUsageByRole))
      if (r.schemaUsageByRole[role] !== r.observedUsage[role])
        failure(role, "USAGE")
  }
  // Роль, відсутня у знімку, але наявна у свіжому каталозі, створена між
  // читаннями: у виведення вона не потрапила, а `PUBLIC` міг дати їй доступ
  for (const m of missing.rows) {
    const created = await client.query<{ exists: boolean }>(
      "select to_regrole(quote_ident($1)) is not null as exists",
      [m.name]
    )
    if (created.rows[0]!.exists)
      crossCheckFailures.push({
        schema: "",
        name: "",
        identityArguments: "",
        role: m.name,
        privilege: "ROLE",
      })
  }
  return {
    missingRoles: missing.rows.map((m) => m.name),
    functions: rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      identityArguments: r.identityArguments,
      owner: r.owner,
      acl: r.acl,
      executeByRole: r.executeByRole,
      schemaUsageByRole: r.schemaUsageByRole,
    })),
    crossCheckFailures,
  }
}
