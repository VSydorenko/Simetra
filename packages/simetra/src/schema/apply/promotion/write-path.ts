import type { ApplyTransaction } from "../port"

/**
 * Шлях запису через API до таблиць одиниці на живій цілі (рішення 10 плану
 * П3-2a, Пр21 наживо): `promote` бачив лише дерево одиниць, а ціль могла
 * отримати грант, політику чи типові привілеї повз метадані. Шлях запису
 * після промоції — відкрите питання (§17), тож будь-що з переліку — відмова.
 *
 * - привілей запису ролі API на таблицю (`PUBLIC` ролі успадковують, тож
 *   `has_table_privilege` ловить і його), окремо — на колонки, коли
 *   табличного немає;
 * - політика команди запису (`INSERT`, `UPDATE`, `DELETE`, `ALL`), що
 *   стосується ролі API, ролі, членом якої вона є, чи `PUBLIC`;
 * - типові привілеї на таблиці, що дають запис ролі API, ролі, членом якої
 *   вона є, чи `PUBLIC`: схемні — для схеми одиниці, глобальні — ролі, що
 *   застосовує (`current_user`): таблиці, які створює план, їх успадкують.
 *   Членство важить так само, як у політиці: привілей ролі-групи роль API
 *   успадковує.
 *
 * Роль, якої в базі немає, привілеїв не має: вона й не перевіряється.
 * `schema`/`name` — таблиця знахідки; у типових привілеїв таблиці немає, є
 * лише схема (`aclSchema`, `NULL` — глобальні).
 */
const WRITE_PATH_SQL = `
with t as (
  select c.oid, x.schema, x.name, c.relnamespace as nsp
  from pg_catalog.json_to_recordset($1::pg_catalog.json) as x(schema text, name text)
  join pg_catalog.pg_namespace n on n.nspname = x.schema
  join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = x.name
), r as (
  select a.oid, a.rolname from pg_catalog.pg_roles a
  where a.rolname = any ($2::text[])
), tbl(privilege) as (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'))
select pg_catalog.format('grant %s to %s on %s.%s', p.privilege,
  pg_catalog.quote_ident(r.rolname), pg_catalog.quote_ident(t.schema),
  pg_catalog.quote_ident(t.name)) as detail,
  t.schema, t.name, null::text as "aclSchema"
from t cross join r cross join tbl p
where pg_catalog.has_table_privilege(r.oid, t.oid, p.privilege)
union all
select pg_catalog.format('column grant %s to %s on %s.%s', p.privilege,
  pg_catalog.quote_ident(r.rolname), pg_catalog.quote_ident(t.schema),
  pg_catalog.quote_ident(t.name)),
  t.schema, t.name, null
from t cross join r cross join (values ('INSERT'), ('UPDATE')) as p(privilege)
where not pg_catalog.has_table_privilege(r.oid, t.oid, p.privilege)
  and pg_catalog.has_any_column_privilege(r.oid, t.oid, p.privilege)
union all
select pg_catalog.format('policy %s.%s.%s (%s)', pg_catalog.quote_ident(t.schema),
  pg_catalog.quote_ident(t.name), pg_catalog.quote_ident(pol.polname),
  case pol.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE'
    when 'd' then 'DELETE' else 'ALL' end),
  t.schema, t.name, null
from t join pg_catalog.pg_policy pol on pol.polrelid = t.oid
where pol.polcmd = any (array['a', 'w', 'd', '*']::"char"[])
  and exists (
    select from pg_catalog.unnest(pol.polroles) as pr(oid)
    where pr.oid = 0
      or exists (select from r
        where pg_catalog.pg_has_role(r.oid, pr.oid, 'MEMBER')))
union all
select pg_catalog.format('default privileges of %s%s grant %s to %s',
  pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(d.defaclrole)),
  case when d.defaclnamespace = 0 then ''
    else pg_catalog.format(' in schema %s', pg_catalog.quote_ident(n.nspname)) end,
  e.privilege_type,
  case when e.grantee = 0 then 'PUBLIC'
    else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(e.grantee)) end),
  null, null, n.nspname::text
from pg_catalog.pg_default_acl d
left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
cross join lateral pg_catalog.aclexplode(d.defaclacl) as e
where d.defaclobjtype = 'r'
  and e.privilege_type = any (array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
  and (e.grantee = 0
    or exists (select from r
      where pg_catalog.pg_has_role(r.oid, e.grantee, 'MEMBER')))
  and (d.defaclnamespace = any (array(select nsp from t))
    or (d.defaclnamespace = 0
      and d.defaclrole = (
        select a.oid from pg_catalog.pg_roles a
        where a.rolname = current_user)))
`

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

interface TableName {
  schema: string
  name: string
}

/** Відкритий шлях запису й таблиці одиниці, яких він стосується. */
export interface WritePath {
  detail: string
  /**
   * Таблиці знахідки. Типові привілеї стосуються всіх таблиць одиниці своєї
   * схеми (глобальні — усіх): саме там план створює й перебудовує таблиці.
   */
  tables: TableName[]
}

/**
 * Відкриті шляхи запису до таблиць `tables` (старі імена — так їх бачить
 * ціль) для ролей `apiRoles`; порожньо — шляху немає. Викликач відкриває
 * транзакцію `READ ONLY` на цілі. Порядок — за кодовими одиницями тексту.
 */
export async function readWritePath(
  tx: ApplyTransaction,
  p: {
    tables: readonly TableName[]
    apiRoles: readonly string[]
  }
): Promise<WritePath[]> {
  if (p.tables.length === 0) return []
  const rows = await tx.query<{
    detail: string
    schema: string | null
    name: string | null
    aclSchema: string | null
  }>(WRITE_PATH_SQL, [
    JSON.stringify(p.tables.map((t) => ({ schema: t.schema, name: t.name }))),
    p.apiRoles,
  ])
  const found = new Map<string, WritePath>()
  for (const row of rows) {
    const tables =
      row.schema !== null && row.name !== null
        ? [{ schema: row.schema, name: row.name }]
        : p.tables.filter(
            (t) => row.aclSchema === null || t.schema === row.aclSchema
          )
    const known = found.get(row.detail)
    found.set(row.detail, {
      detail: row.detail,
      tables: [...(known?.tables ?? []), ...tables],
    })
  }
  return [...found.values()].sort((a, b) => byCodeUnit(a.detail, b.detail))
}
