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
 * звіркою семантики виведення (`observed*`); зміни стану між знімком і
 * свіжим каталогом ловить відбиток прав (`FINGERPRINT_SQL`).
 *
 * Ідентичність аргументів (`pg_get_function_identity_arguments`) читає кеш;
 * зміну типів аргументів ловить відбиток (`proargtypes`).
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

/**
 * Відбиток прав: `$1` — схеми межі, `$2` — ролі профілю. Лише рядки каталогу
 * (`pg_namespace`, `pg_proc`, `pg_roles`, `pg_auth_members`) і `aclexplode`
 * над масивом ACL, без функцій каталожного кешу (`aclitem` у тексті,
 * `pg_get_*`): у знімку вони показали б свіжіший стан, і відбиток знімка
 * збігся б зі свіжим там, де знімок застарів. Відсутність теж стан: схема чи
 * роль профілю без рядка лишається в відбитку з `null`, а поява й зникнення
 * функції змінюють їхній набір. Членство — усі ребра, досяжні від ролей
 * профілю, з `inherit_option`; ролі — усі, на які посилаються відбиток (oid,
 * ім'я, `rolsuper`): ім'я ролі у фактах ACL теж береться зі знімка. `jsonb`
 * упорядковує ключі сам, масиви впорядковано явно, тож текст канонічний.
 */
const FINGERPRINT_SQL = `
with recursive schemas as (
  select s.name, n.oid, n.nspowner, n.nspacl
  from unnest($1::text[]) as s(name)
  left join pg_namespace n on n.nspname = s.name
), funcs as (
  select p.oid, p.pronamespace, p.proname, p.proargtypes, p.proowner, p.proacl,
         p.prosecdef, p.proconfig, p.prokind
  from pg_proc p
  where p.pronamespace in (select oid from schemas where oid is not null)
), profile as (
  select r.name, x.oid, x.rolsuper
  from unnest($2::text[]) as r(name)
  left join pg_roles x on x.rolname = r.name
), edges(member, roleid, inherit) as (
  select m.member, m.roleid, m.inherit_option
  from pg_auth_members m
  where m.member in (select oid from profile where oid is not null)
  union
  select m.member, m.roleid, m.inherit_option
  from edges e join pg_auth_members m on m.member = e.roleid
), acls(acl) as (
  select nspacl from schemas union all select proacl from funcs
), referenced(oid) as (
  select oid from profile where oid is not null
  union select roleid from edges
  union select nspowner from schemas where nspowner is not null
  union select proowner from funcs
  union select a.grantor from acls, aclexplode(acls.acl) a
  union select a.grantee from acls, aclexplode(acls.acl) a where a.grantee <> 0
)
select jsonb_build_object(
  'schemas', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', s.name, 'oid', s.oid::bigint, 'owner', s.nspowner::bigint,
      'acl', case when s.nspacl is null then null else coalesce((
        select jsonb_agg(jsonb_build_array(a.grantor::bigint, a.grantee::bigint, a.privilege_type, a.is_grantable)
          order by a.grantor, a.grantee, a.privilege_type, a.is_grantable)
        from aclexplode(s.nspacl) a), '[]'::jsonb) end
    ) order by s.name), '[]'::jsonb)
    from schemas s
  ),
  'functions', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'oid', f.oid::bigint, 'schema', f.pronamespace::bigint, 'name', f.proname,
      'arguments', f.proargtypes::text, 'owner', f.proowner::bigint,
      'definer', f.prosecdef, 'config', to_jsonb(f.proconfig), 'kind', f.prokind::text,
      'acl', case when f.proacl is null then null else coalesce((
        select jsonb_agg(jsonb_build_array(a.grantor::bigint, a.grantee::bigint, a.privilege_type, a.is_grantable)
          order by a.grantor, a.grantee, a.privilege_type, a.is_grantable)
        from aclexplode(f.proacl) a), '[]'::jsonb) end
    ) order by f.oid), '[]'::jsonb)
    from funcs f
  ),
  'profile', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', p.name, 'oid', p.oid::bigint, 'superuser', p.rolsuper
    ) order by p.name), '[]'::jsonb)
    from profile p
  ),
  'membership', (
    select coalesce(jsonb_agg(jsonb_build_array(e.member::bigint, e.roleid::bigint, e.inherit)
      order by e.member, e.roleid, e.inherit), '[]'::jsonb)
    from edges e
  ),
  'roles', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'oid', r.oid::bigint, 'name', x.rolname, 'superuser', x.rolsuper
    ) order by r.oid), '[]'::jsonb)
    from referenced r left join pg_roles x on x.oid = r.oid
  )
)::text as fingerprint
`

/** Канонічний текст відбитка прав (`FINGERPRINT_SQL`) на клієнті `client`. */
export async function readRightsFingerprint(
  client: pg.ClientBase,
  scope: EngineScope,
  roles: readonly string[] = profileRoles(scope.provider)
): Promise<string> {
  const { rows } = await client.query<{ fingerprint: string }>(
    FINGERPRINT_SQL,
    [[...scope.schemas], [...roles]]
  )
  return rows[0]!.fingerprint
}

interface FactRow extends FunctionExecuteFact {
  observedExecute: Record<string, boolean>
  observedUsage: Record<string, boolean>
}

/**
 * Факти `EXECUTE` на клієнті `snapshot` відкритої транзакції — тієї самої, що
 * й extract (знімок один); лише читання каталогу. Після них відбиток прав
 * знімка звіряється з відбитком на `fresh` — іншому з'єднанні поза знімком,
 * тобто зі свіжим каталогом: тека має відповідати стану бази на мить цього
 * перечитування, а не лише власному знімку. Зміна між читаннями, що
 * повернулась назад (ABA), прийнятна: стан на мить перечитування той самий.
 */
export async function readExecuteFacts(
  snapshot: pg.ClientBase,
  fresh: pg.ClientBase,
  scope: EngineScope,
  roles: readonly string[] = profileRoles(scope.provider)
): Promise<ExecuteFacts> {
  const { rows } = await snapshot.query<FactRow>(FACTS_SQL, [
    [...scope.schemas],
    [...roles],
  ])
  const missing = await snapshot.query<{ name: string }>(MISSING_SQL, [
    [...roles],
  ])
  const before = await readRightsFingerprint(snapshot, scope, roles)
  const after = await readRightsFingerprint(fresh, scope, roles)
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
    catalogChanged: before !== after,
  }
}
