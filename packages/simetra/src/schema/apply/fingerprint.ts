import type { DatabaseProvider } from "simetra/model"
import {
  SUPABASE_SURFACES,
  type EngineScope,
  type ProviderSurface,
} from "../engine"
import type { ApplyTransaction } from "./port"

/**
 * Версія формули відбитка. Відбитки різних версій не порівнюються: зміна
 * вмісту секції інакше виглядала б дрейфом (рішення 2 плану П3-1).
 */
export const FINGERPRINT_VERSION = 1

export const FINGERPRINT_SECTIONS = [
  "schemas",
  "relations",
  "columns",
  "constraints",
  "indexes",
  "views",
  "triggers",
  "policies",
  "functions",
  "types",
  "sequences",
  "acl",
  "defaultPrivileges",
  "extensions",
  "publications",
  "comments",
  "owner",
  "inventory",
] as const
export type FingerprintSection = (typeof FINGERPRINT_SECTIONS)[number]

/**
 * Посекційний SQL-відбиток каталогу в межі гейта. Незалежний від двигуна
 * свідок: ним гейт порівнює ціль, коли версія двигуна змінилась, а раннер —
 * стан під блокуваннями й результат перед `COMMIT`.
 */
export interface CatalogFingerprint {
  version: number
  /** Hex SHA-256 упорядкованих рядків кожної секції. */
  sections: Record<FingerprintSection, string>
}

export type FingerprintComparison =
  { comparable: false } | { comparable: true; differing: FingerprintSection[] }

/**
 * `owner: false` — для порівняння різних баз (копія, тінь): ролі сесії там
 * можуть бути іншими, а ім'я власника живе лише в секції `owner`.
 */
export function compareFingerprints(
  a: CatalogFingerprint,
  b: CatalogFingerprint,
  o: { owner: boolean }
): FingerprintComparison {
  if (a.version !== b.version) return { comparable: false }
  return {
    comparable: true,
    differing: FINGERPRINT_SECTIONS.filter(
      (s) => (o.owner || s !== "owner") && a.sections[s] !== b.sections[s]
    ),
  }
}

const SURFACES: Record<DatabaseProvider, readonly ProviderSurface[]> = {
  supabase: SUPABASE_SURFACES,
}

/** Glob поверхні як шаблон `LIKE`: літеральні `%`, `_` і `\` екрануються. */
function likePattern(glob: string): string {
  return glob
    .replace(/[\\%_]/g, "\\$&")
    .replace(/\*/g, "%")
    .replace(/\?/g, "_")
}

/**
 * Відбиток межі `scope`: схеми застосунку цілком плюс політики й тригери на
 * таблицях поверхні провайдера (§6.9). Читається в точці збереження під
 * `search_path = pg_catalog`: так `pg_get_*` і `::regclass` кваліфікують
 * імена схемою, а `search_path` транзакції лишається незмінним.
 */
export async function readFingerprint(
  tx: ApplyTransaction,
  scope: EngineScope
): Promise<CatalogFingerprint> {
  const surfaces = SURFACES[scope.provider].map((s) => ({
    schema: s.schema,
    table: likePattern(s.table),
    classes: s.classes,
  }))
  await tx.query("SAVEPOINT simetra_fingerprint")
  await tx.query("SET LOCAL search_path = pg_catalog")
  const rows = await tx.query(FINGERPRINT_SQL, [
    scope.schemas,
    JSON.stringify(surfaces),
  ])
  await tx.query("ROLLBACK TO SAVEPOINT simetra_fingerprint")
  await tx.query("RELEASE SAVEPOINT simetra_fingerprint")
  const row = rows[0]
  const sections = {} as Record<FingerprintSection, string>
  for (const section of FINGERPRINT_SECTIONS) {
    const hash = row?.[section]
    if (typeof hash !== "string")
      throw new Error(`fingerprint section ${section} is missing`)
    sections[section] = hash
  }
  return { version: FINGERPRINT_VERSION, sections }
}

/**
 * Хеш секції. `COLLATE "C"`: копія чи тінь на `shadowBase` з іншою
 * колляцією бази інакше впорядкувала б той самий вміст інакше. Вільний текст
 * у рядках (визначення, вирази, коментарі) береться в лапки `%L`, тож
 * перевід рядка всередині нього не зливається з роздільником рядків.
 */
const digest = (rows: string): string =>
  `encode(sha256(convert_to(coalesce((select string_agg(r, E'\\n' order by r collate "C") from (${rows}) as section(r)), ''), 'UTF8')), 'hex')`

/** Отримувач привілею: власник об'єкта — токеном, щоб `OWNER TO` не просочувався сюди. */
const grantee = (owner: string): string =>
  `case when x.grantee = ${owner} then '=owner' when x.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(x.grantee)) end`

/** Колляція колонки чи домену за ім'ям, не за OID. */
const collation = (oid: string): string =>
  `(select format('%I.%I', cn.nspname, co.collname) from pg_collation co join pg_namespace cn on cn.oid = co.collnamespace where co.oid = ${oid})`

/**
 * Рядки секцій. Жодних OID чи `attnum`: відбиток порівнюється між різними
 * базами, де ті самі об'єкти мають інші OID, а колонки — інший порядок.
 */
const SECTION_ROWS: Record<FingerprintSection, string> = {
  schemas: `select format('%I', n.nspname) from scope_ns n`,

  // Індекси — у своїй секції: інакше одна зміна індексу давала б дві секції
  relations: `
    select format('%s kind=%s rls=%s force=%s replident=%s options=%L persistence=%s',
      c.oid::regclass, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
      c.relreplident,
      (select string_agg(o, ',' order by o collate "C") from unnest(c.reloptions) o),
      c.relpersistence)
    from pg_class c join scope_ns n on n.oid = c.relnamespace
    where c.relkind not in ('i', 'I')`,

  // Колонки впорядковує сам хеш (за рядком), тож порядок колонок не входить
  columns: `
    select format('%s.%I type=%s notnull=%s default=%L identity=%L generated=%L collation=%L',
      c.oid::regclass, a.attname, format_type(a.atttypid, a.atttypmod),
      a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity,
      a.attgenerated, ${collation("a.attcollation")})
    from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join scope_ns n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attnum > 0 and not a.attisdropped
      and c.relkind not in ('i', 'I', 'S')`,

  constraints: `
    select format('%s %I %L', c.oid::regclass, k.conname, pg_get_constraintdef(k.oid))
    from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join scope_ns n on n.oid = c.relnamespace
    union all
    select format('domain %s %I %L', t.oid::regtype, k.conname, pg_get_constraintdef(k.oid))
    from pg_constraint k
      join pg_type t on t.oid = k.contypid
      join scope_ns n on n.oid = t.typnamespace`,

  // `relreplident = 'i'` у `relations` не каже, який саме індекс — це тут
  indexes: `
    select format('%L replident=%s', pg_get_indexdef(i.indexrelid), i.indisreplident)
    from pg_index i
      join pg_class c on c.oid = i.indrelid
      join scope_ns n on n.oid = c.relnamespace`,

  views: `
    select format('%s %L', c.oid::regclass, pg_get_viewdef(c.oid))
    from pg_class c join scope_ns n on n.oid = c.relnamespace
    where c.relkind in ('v', 'm')`,

  triggers: `
    select format('%L enabled=%s', pg_get_triggerdef(t.oid), t.tgenabled)
    from pg_trigger t
    where not t.tgisinternal
      and (t.tgrelid in (select oid from scope_rel)
        or t.tgrelid in (select oid from surface_rel where classes ? 'trigger'))`,

  policies: `
    select format('%s %I cmd=%s permissive=%s roles=%s using=%L check=%L',
      p.polrelid::regclass, p.polname, p.polcmd, p.polpermissive,
      (select string_agg(r, ',' order by r collate "C") from (
        select case when g = 0 then 'public' else quote_ident(pg_get_userbyid(g)) end
        from unnest(p.polroles) g) as roles(r)),
      pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))
    from pg_policy p
    where p.polrelid in (select oid from scope_rel)
      or p.polrelid in (select oid from surface_rel where classes ? 'policy')`,

  // `pg_get_functiondef` на агрегаті кидає «is an aggregate function», тож
  // агрегат — з `pg_aggregate`
  functions: `
    select format('%L', pg_get_functiondef(p.oid))
    from pg_proc p join scope_ns n on n.oid = p.pronamespace
    where p.prokind <> 'a'
    union all
    select format('aggregate %s trans=%s final=%s combine=%s state=%s init=%L',
      p.oid::regprocedure, a.aggtransfn::oid::regprocedure,
      a.aggfinalfn::oid::regprocedure, a.aggcombinefn::oid::regprocedure,
      format_type(a.aggtranstype, null), a.agginitval)
    from pg_aggregate a
      join pg_proc p on p.oid = a.aggfnoid
      join scope_ns n on n.oid = p.pronamespace`,

  types: `
    select format('enum %s %s', t.oid::regtype,
      (select string_agg(quote_literal(e.enumlabel), ',' order by e.enumsortorder)
       from pg_enum e where e.enumtypid = t.oid))
    from pg_type t join scope_ns n on n.oid = t.typnamespace
    where t.typtype = 'e'
    union all
    select format('domain %s base=%s notnull=%s default=%L collation=%L',
      t.oid::regtype, format_type(t.typbasetype, t.typtypmod), t.typnotnull,
      t.typdefault, ${collation("t.typcollation")})
    from pg_type t join scope_ns n on n.oid = t.typnamespace
    where t.typtype = 'd'`,

  // Без `last_value`/`is_called`: лічильник — дані, і вставка в ledger
  // інакше давала б хибний дрейф
  sequences: `
    select format('%s type=%s start=%s increment=%s min=%s max=%s cycle=%s',
      s.seqrelid::regclass, format_type(s.seqtypid, null), s.seqstart,
      s.seqincrement, s.seqmin, s.seqmax, s.seqcycle)
    from pg_sequence s where s.seqrelid in (select oid from scope_rel)`,

  // Без `grantor`. NULL-ACL — це типові привілеї (`acldefault`), а не
  // «жодних»: інакше відкликаний і повернений грант, що лишає явний ACL,
  // відрізнявся б від бази, де гранту не було ніколи
  acl: `
    select distinct format('%s %s %s %s grantable=%s',
      o.kind, o.ident, ${grantee("o.owner")}, x.privilege_type, x.is_grantable)
    from (
      select 'schema' as kind, format('%I', n.nspname) as ident,
        coalesce(n.nspacl, acldefault('n'::"char", n.nspowner)) as acl, n.nspowner as owner
      from scope_ns n
      union all
      select 'relation', c.oid::regclass::text,
        coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner)),
        c.relowner
      from scope_rel c where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      union all
      select 'column', format('%s.%I', c.oid::regclass, a.attname), a.attacl, c.relowner
      from pg_attribute a join scope_rel c on c.oid = a.attrelid
      where a.attnum > 0 and not a.attisdropped and a.attacl is not null
      union all
      select 'function', p.oid::regprocedure::text,
        coalesce(p.proacl, acldefault('f'::"char", p.proowner)), p.proowner
      from pg_proc p join scope_ns n on n.oid = p.pronamespace
      union all
      -- Типи масивів і рядків таблиць власного ACL не мають: грант на них
      -- Postgres відхиляє
      select 'type', t.oid::regtype::text,
        coalesce(t.typacl, acldefault('T'::"char", t.typowner)), t.typowner
      from pg_type t join scope_ns n on n.oid = t.typnamespace
      where not exists (select from pg_type e where e.typarray = t.oid)
        and (t.typrelid = 0 or t.typrelid in (select oid from scope_rel where relkind = 'c'))
    ) o cross join aclexplode(o.acl) x`,

  defaultPrivileges: `
    select distinct format('role=%s schema=%I objtype=%s grantee=%s privilege=%s grantable=%s',
      case when d.defaclrole = n.nspowner then '=owner'
        else quote_ident(pg_get_userbyid(d.defaclrole)) end,
      n.nspname, d.defaclobjtype, ${grantee("n.nspowner")}, x.privilege_type,
      x.is_grantable)
    from pg_default_acl d
      join scope_ns n on n.oid = d.defaclnamespace
      cross join aclexplode(d.defaclacl) x`,

  extensions: `
    select format('%I schema=%I', e.extname, n.nspname)
    from pg_extension e join scope_ns n on n.oid = e.extnamespace`,

  // `pg_publication_tables` розгортає й `FOR ALL TABLES`, і `TABLES IN SCHEMA`
  publications: `
    select format('%I %I.%I', pt.pubname, pt.schemaname, pt.tablename)
    from pg_publication_tables pt where pt.schemaname = any($1::text[])`,

  // Ідентичність коментованого об'єкта — за іменами (`pg_identify_object`);
  // у тригера й політики схеми немає, тож межу дає їхня таблиця
  comments: `
    select format('%s %s %L', io.type, io.identity, d.description)
    from pg_description d
      cross join lateral pg_identify_object(d.classoid, d.objoid, d.objsubid) io
    where case d.classoid
      when 'pg_namespace'::regclass then d.objoid in (select oid from scope_ns)
      when 'pg_trigger'::regclass then exists (
        select from pg_trigger t where t.oid = d.objoid
          and (t.tgrelid in (select oid from scope_rel)
            or t.tgrelid in (select oid from surface_rel where classes ? 'trigger')))
      when 'pg_policy'::regclass then exists (
        select from pg_policy p where p.oid = d.objoid
          and (p.polrelid in (select oid from scope_rel)
            or p.polrelid in (select oid from surface_rel where classes ? 'policy')))
      else io.schema = any($1::text[]) end`,

  owner: `
    select format('%s %s %s', o.kind, o.ident, quote_ident(pg_get_userbyid(o.owner)))
    from (
      select 'schema' as kind, format('%I', n.nspname) as ident, n.nspowner as owner from scope_ns n
      union all
      select 'relation', c.oid::regclass::text, c.relowner from scope_rel c
      union all
      select 'type', t.oid::regtype::text, t.typowner
      from pg_type t join scope_ns n on n.oid = t.typnamespace
      union all
      select 'function', p.oid::regprocedure::text, p.proowner
      from pg_proc p join scope_ns n on n.oid = p.pronamespace
      union all
      select 'operator', o.oid::regoperator::text, o.oprowner
      from pg_operator o join scope_ns n on n.oid = o.oprnamespace
      union all
      select 'opclass', format('%I.%I %I', n.nspname, c.opcname, am.amname), c.opcowner
      from pg_opclass c join scope_ns n on n.oid = c.opcnamespace
        join pg_am am on am.oid = c.opcmethod
      union all
      select 'opfamily', format('%I.%I %I', n.nspname, f.opfname, am.amname), f.opfowner
      from pg_opfamily f join scope_ns n on n.oid = f.opfnamespace
        join pg_am am on am.oid = f.opfmethod
      union all
      select 'collation', format('%I.%I %s', n.nspname, c.collname, c.collencoding), c.collowner
      from pg_collation c join scope_ns n on n.oid = c.collnamespace
      union all
      select 'tsconfig', format('%I.%I', n.nspname, c.cfgname), c.cfgowner
      from pg_ts_config c join scope_ns n on n.oid = c.cfgnamespace
      union all
      select 'tsdict', format('%I.%I', n.nspname, d.dictname), d.dictowner
      from pg_ts_dict d join scope_ns n on n.oid = d.dictnamespace
      union all
      select 'statistics', format('%I.%I', n.nspname, s.stxname), s.stxowner
      from pg_statistic_ext s join scope_ns n on n.oid = s.stxnamespace
      union all
      select 'extension', format('%I', e.extname), e.extowner
      from pg_extension e join scope_ns n on n.oid = e.extnamespace
    ) o`,

  // Лише наявність: класи, яких інші секції не описують, принаймні видно,
  // коли вони з'являються чи зникають
  inventory: `
    select format('pg_class %I %I', n.nspname, c.relname)
    from pg_class c join scope_ns n on n.oid = c.relnamespace
    union all
    select format('pg_type %I %I', n.nspname, t.typname)
    from pg_type t join scope_ns n on n.oid = t.typnamespace
    union all
    select format('pg_proc %I %I (%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes))
    from pg_proc p join scope_ns n on n.oid = p.pronamespace
    union all
    select format('pg_operator %I %I (%s, %s)', n.nspname, o.oprname,
      format_type(o.oprleft, null), format_type(o.oprright, null))
    from pg_operator o join scope_ns n on n.oid = o.oprnamespace
    union all
    select format('pg_opclass %I %I %I', n.nspname, c.opcname, am.amname)
    from pg_opclass c join scope_ns n on n.oid = c.opcnamespace
      join pg_am am on am.oid = c.opcmethod
    union all
    select format('pg_opfamily %I %I %I', n.nspname, f.opfname, am.amname)
    from pg_opfamily f join scope_ns n on n.oid = f.opfnamespace
      join pg_am am on am.oid = f.opfmethod
    union all
    select format('pg_collation %I %I %s', n.nspname, c.collname, c.collencoding)
    from pg_collation c join scope_ns n on n.oid = c.collnamespace
    union all
    select format('pg_ts_config %I %I', n.nspname, c.cfgname)
    from pg_ts_config c join scope_ns n on n.oid = c.cfgnamespace
    union all
    select format('pg_ts_dict %I %I', n.nspname, d.dictname)
    from pg_ts_dict d join scope_ns n on n.oid = d.dictnamespace
    union all
    select format('pg_ts_parser %I %I', n.nspname, p.prsname)
    from pg_ts_parser p join scope_ns n on n.oid = p.prsnamespace
    union all
    select format('pg_ts_template %I %I', n.nspname, t.tmplname)
    from pg_ts_template t join scope_ns n on n.oid = t.tmplnamespace
    union all
    select format('pg_statistic_ext %I %I', n.nspname, s.stxname)
    from pg_statistic_ext s join scope_ns n on n.oid = s.stxnamespace
    union all
    select format('pg_rewrite %I %I %I', n.nspname, c.relname, r.rulename)
    from pg_rewrite r
      join pg_class c on c.oid = r.ev_class
      join scope_ns n on n.oid = c.relnamespace
    where r.rulename <> '_RETURN'`,
}

/**
 * Один запит на всі секції: `$1` — схеми межі, `$2` — JSON поверхонь
 * провайдера з `table` як шаблоном `LIKE`.
 */
const FINGERPRINT_SQL = `
with
  scope_ns as (
    select oid, nspname, nspowner, nspacl from pg_namespace
    where nspname = any($1::text[])
  ),
  scope_rel as (
    select c.oid, c.relkind, c.relowner, c.relacl from pg_class c
    where c.relnamespace in (select oid from scope_ns)
  ),
  surface_rel as (
    select c.oid, s.value -> 'classes' as classes
    from jsonb_array_elements($2::jsonb) s
      join pg_namespace n on n.nspname = s.value ->> 'schema'
      join pg_class c on c.relnamespace = n.oid
        and c.relname like s.value ->> 'table'
  )
select
${FINGERPRINT_SECTIONS.map((s) => `  ${digest(SECTION_ROWS[s])} as "${s}"`).join(",\n")}`
