/**
 * Читачі перепису спільні для будь-якого адаптера `SchemaEngine`, а не
 * специфічні для pg-delta, бо перепис є частиною порту (спека П2 §9).
 */
import type pg from "pg"
import {
  SUPABASE_EVENT_TRIGGERS,
  SUPABASE_EXTENSIONS,
  SUPABASE_SCHEMAS,
  type CensusCount,
  type EngineScope,
  type PropertyCount,
} from "simetra/schema"

/**
 * Простий запит до каталогу, що лише рахує об'єкти за класами в межі
 * керування (спека П2 §9; план E2a, рішення 8), — не читач. Виключення ті
 * самі, що й у фільтрі двигуна: члени розширень, внутрішні залежні об'єкти
 * (послідовність identity, конструктори й cast до мультидіапазону
 * діапазонного типу), масиви типів, рядкові типи таблиць, індекси обмежень. `$1` — керовані
 * схеми, `$2` — схеми пресета провайдера, `$3` — розширення провайдера,
 * `$4` — LIKE-шаблони тригерів подій провайдера.
 */
const CENSUS_SQL = `
with managed as (
  select oid from pg_namespace where nspname = any($1::text[])
), provider as (
  select oid from pg_namespace where nspname = any($2::text[])
), ext as (
  select classid, objid from pg_depend where deptype = 'e'
), internal as (
  select classid, objid from pg_depend where deptype = 'i'
), rel as (
  select c.* from pg_class c
  where c.relnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_class'::regclass and objid = c.oid)
), typ as (
  select t.* from pg_type t
  where t.typnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_type'::regclass and objid = t.oid)
), objects(class) as (
  select case c.relkind
           when 'r' then 'table' when 'p' then 'table' when 'v' then 'view'
           when 'm' then 'materializedView' when 'S' then 'sequence'
           when 'f' then 'foreignTable' else 'index' end
  from rel c
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
     or (c.relkind = 'S' and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
                                           and d.objid = c.oid and d.deptype = 'i'))
     -- conindid FK теж заповнений (індекс, на який він посилається), тож
     -- індекс обмеження — лише PK/UNIQUE/EXCLUDE своєї ж таблиці
     or (c.relkind in ('i', 'I') and not exists (
           select 1 from pg_constraint k join pg_index i on i.indexrelid = c.oid
           where k.conindid = c.oid and k.contype in ('p', 'u', 'x') and k.conrelid = i.indrelid))
  union all select case t.typtype when 'e' then 'type.enum' when 'd' then 'domain'
                                  when 'r' then 'type.range' when 'b' then 'type.base'
                                  when 'p' then 'type.shell'
                                  else 'type.composite' end
  from typ t
  where t.typtype in ('e', 'd', 'r', 'p')
     or (t.typtype = 'b' and not exists (select 1 from pg_type a where a.typarray = t.oid))
     or (t.typtype = 'c' and (select relkind from pg_class where oid = t.typrelid) = 'c')
  union all select case p.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end
  from pg_proc p
  where p.pronamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_proc'::regclass and objid = p.oid)
    and not exists (select 1 from internal where classid = 'pg_proc'::regclass and objid = p.oid)
  union all select case k.contype when 'x' then 'constraint.exclusion' when 't' then 'constraint.trigger' end
  from pg_constraint k join rel c on c.oid = k.conrelid
  where k.contype in ('x', 't') and k.conislocal
  union all select 'trigger'
  from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_proc f on f.oid = g.tgfoid
  -- тригер-клон секції (tgparentid) — частина тригера батьківської таблиці
  where not g.tgisinternal and g.tgparentid = 0
    and (c.relnamespace in (select oid from managed)
         or (c.relnamespace in (select oid from provider) and f.pronamespace not in (select oid from provider)))
  union all select 'policy'
  from pg_policy y join pg_class c on c.oid = y.polrelid
  where c.relnamespace in (select oid from managed) or c.relnamespace in (select oid from provider)
  union all select 'rule' from pg_rewrite w join rel c on c.oid = w.ev_class where w.rulename <> '_RETURN'
  union all select 'collation' from pg_collation x where x.collnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_collation'::regclass and objid = x.oid)
  union all select 'conversion' from pg_conversion x where x.connamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_conversion'::regclass and objid = x.oid)
  union all select 'operator' from pg_operator x where x.oprnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_operator'::regclass and objid = x.oid)
  union all select 'operatorClass' from pg_opclass x where x.opcnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_opclass'::regclass and objid = x.oid)
  union all select 'operatorFamily' from pg_opfamily x where x.opfnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_opfamily'::regclass and objid = x.oid)
  union all select 'cast' from pg_cast x
  where (x.castsource in (select oid from typ) or x.casttarget in (select oid from typ)
         or x.castfunc in (select oid from pg_proc where pronamespace in (select oid from managed)))
    and not exists (select 1 from ext where classid = 'pg_cast'::regclass and objid = x.oid)
    and not exists (select 1 from internal where classid = 'pg_cast'::regclass and objid = x.oid)
  union all select 'textSearchConfiguration' from pg_ts_config x where x.cfgnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_ts_config'::regclass and objid = x.oid)
  union all select 'textSearchDictionary' from pg_ts_dict x where x.dictnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_ts_dict'::regclass and objid = x.oid)
  union all select 'textSearchParser' from pg_ts_parser x where x.prsnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_ts_parser'::regclass and objid = x.oid)
  union all select 'textSearchTemplate' from pg_ts_template x where x.tmplnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_ts_template'::regclass and objid = x.oid)
  union all select 'statistics' from pg_statistic_ext x where x.stxnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_statistic_ext'::regclass and objid = x.oid)
  union all select 'transform' from pg_transform x where x.trftype in (select oid from typ)
  union all select 'publicationRel' from pg_publication_rel x join rel c on c.oid = x.prrelid
  union all select 'publicationSchema' from pg_publication_namespace x where x.pnnspid in (select oid from managed)
  union all select 'defaultPrivilege' from pg_default_acl x where x.defaclnamespace in (select oid from managed)
  union all select 'extension' from pg_extension x where not (x.extname = any($3::text[]))
  union all select 'language' from pg_language x where x.lanispl and x.lanname <> 'plpgsql'
    and not exists (select 1 from ext where classid = 'pg_language'::regclass and objid = x.oid)
  union all select 'accessMethod' from pg_am x where x.oid >= 16384
    and not exists (select 1 from ext where classid = 'pg_am'::regclass and objid = x.oid)
  union all select 'eventTrigger' from pg_event_trigger x where not (x.evtname like any($4::text[]))
    and not exists (select 1 from ext where classid = 'pg_event_trigger'::regclass and objid = x.oid)
  union all select 'foreignDataWrapper' from pg_foreign_data_wrapper x
    where not exists (select 1 from ext where classid = 'pg_foreign_data_wrapper'::regclass and objid = x.oid)
  union all select 'server' from pg_foreign_server x
  union all select 'subscription' from pg_subscription x
    where x.subdbid = (select oid from pg_database where datname = current_database())
)
select class, count(*)::int as count from objects group by class order by class
`

/** Пул адаптера або клієнт тесту в транзакції — запитам перепису байдуже. */
type Queryable = Pick<pg.ClientBase, "query">

/** Лічильники класів у межі керування; класи з нулем об'єктів відсутні. */
export async function readCensus(
  pool: Queryable,
  scope: EngineScope
): Promise<CensusCount[]> {
  const { rows } = await pool.query<CensusCount>(CENSUS_SQL, [
    scope.schemas,
    SUPABASE_SCHEMAS,
    SUPABASE_EXTENSIONS,
    SUPABASE_EVENT_TRIGGERS,
  ])
  return rows
}

/**
 * Рядок перепису для фізичних властивостей, яких двигун не читає (той самий
 * вузький запит до каталогу, план E2a, рішення 8): нетипове значення бачить
 * лише каталог, тож без лічильника звірка тихо назвала б базу рівною
 * бажаному стану. Типові значення — ті, що Postgres ставить сам: `attstorage`
 * типу колонки, порожній `attcompression`, `attstattarget` NULL (до PG17 —
 * `-1`), без `attoptions`, метод доступу heap, без `CLUSTER ON`. `$1` —
 * керовані схеми.
 */
const UNMODELED_PROPERTIES_SQL = `
with rel as (
  select c.* from pg_class c
  where c.relnamespace in (select oid from pg_namespace where nspname = any($1::text[]))
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
                      and d.objid = c.oid and d.deptype = 'e')
), col as (
  select a.*, t.typstorage
  from pg_attribute a join rel c on c.oid = a.attrelid join pg_type t on t.oid = a.atttypid
  where c.relkind in ('r', 'p', 'm', 'f') and a.attnum > 0 and not a.attisdropped
), objects(property) as (
  select 'column storage' from col where attstorage <> typstorage
  union all select 'column compression' from col where attcompression <> ''
  union all select 'column statistics target' from col where coalesce(attstattarget, -1) <> -1
  union all select 'column options' from col where attoptions is not null
  union all select 'table access method' from rel
  where relkind in ('r', 'p', 'm') and relam <> 0
    and relam <> (select oid from pg_am where amname = 'heap')
  union all select 'clustered index' from pg_index i join rel c on c.oid = i.indrelid
  where i.indisclustered
)
select property, count(*)::int as count from objects group by property order by property
`

/** Лічильники нетипових фізичних властивостей у межі; нульові відсутні. */
export async function readUnmodeledProperties(
  pool: Queryable,
  scope: EngineScope
): Promise<PropertyCount[]> {
  const { rows } = await pool.query<PropertyCount>(UNMODELED_PROPERTIES_SQL, [
    scope.schemas,
  ])
  return rows
}

/**
 * Незаповнені матеріалізовані подання керованих схем — ідентичності їхніх
 * одиниць моделі. Стан заповнення двигун не читає, а дія створення не несе
 * `WITH NO DATA` — доведена прогалина двигуна (план E2a, рішення 7), тож
 * вузький запит до каталогу; порівнюється він між базою й тінню.
 */
export async function readUnpopulatedViews(
  pool: Queryable,
  scope: EngineScope
): Promise<string[]> {
  const { rows } = await pool.query<{ schema: string; name: string }>(
    `select n.nspname as schema, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'm' and not c.relispopulated
        and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
                          and d.objid = c.oid and d.deptype = 'e')
        and n.nspname = any($1::text[])
      order by 1, 2`,
    [scope.schemas]
  )
  return rows.map((r) => `materializedView:${r.schema}.${r.name}`)
}
