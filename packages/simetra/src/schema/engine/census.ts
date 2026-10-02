import { encodeId, type FactKind } from "@supabase/pg-delta"
import type pg from "pg"
import { localize } from "simetra/compiler"
import type { EngineDiagnostic, EngineScope } from "./port"
import {
  PROVIDER_SCHEMAS,
  SUPABASE_PROVIDER_EVENT_TRIGGERS,
  SUPABASE_PROVIDER_EXTENSIONS,
} from "./pg-delta/policy"

/**
 * Що двигун робить з об'єктами класу перепису (спайк E2a, крок 4,
 * «Відповідність класів перепису фактам двигуна»):
 * - `kind` — вид факту закріпленого двигуна; `match` — поле payload, що
 *   відрізняє клас, коли кілька класів ділять вид. Об'єкт класу з фактом
 *   мапер не губить: кожен факт стає полем моделі, SQL-одиницею або
 *   `engine.unrepresentable` з ім'ям об'єкта (`mapModel`, гілка «інакше»).
 *   Лічильник перепису звіряється з кількістю фактів класу — так ловиться
 *   пропуск окремих об'єктів покритого класу.
 * - `uncompared` — факт є, але лічильники принципово не порівнювані (причина).
 * - `kind: null` — факту немає: двигун класу не бачить зовсім, це тиха втрата.
 *   `global` — клас без схеми: межа не каже, чий об'єкт (застосунку чи
 *   провайдера), тож лише попередження, доки пресет провайдера не перелічить
 *   свої об'єкти класу.
 * Тип `FactKind` прив'язує таблицю до видів закріпленої версії: вид, якого
 * двигун не має, — помилка компіляції, а не тиха розбіжність.
 */
type CensusFact =
  | { kind: FactKind; match?: { field: string; value: string } }
  | { kind: FactKind; uncompared: string }
  | { kind: null; global?: true }

const CENSUS_FACTS = {
  table: { kind: "table" },
  view: { kind: "view" },
  materializedView: { kind: "materializedView" },
  sequence: { kind: "sequence" },
  foreignTable: { kind: "foreignTable" },
  index: { kind: "index" },
  "type.enum": { kind: "type", match: { field: "variant", value: "enum" } },
  "type.composite": {
    kind: "type",
    match: { field: "variant", value: "composite" },
  },
  "type.range": { kind: "type", match: { field: "variant", value: "range" } },
  "type.base": { kind: null },
  // `CREATE TYPE name` без тіла: заготовка під майбутній тип
  "type.shell": { kind: null },
  domain: { kind: "domain" },
  function: { kind: "function" },
  procedure: { kind: "procedure" },
  aggregate: { kind: "aggregate" },
  "constraint.exclusion": {
    kind: "constraint",
    match: { field: "type", value: "x" },
  },
  // Обмеження-тригер двигун тримає фактом `trigger` (рядок pg_trigger), а не
  // `constraint`; той самий рядок перепис уже рахує класом `trigger`
  "constraint.trigger": {
    kind: "trigger",
    uncompared: "the same pg_trigger row is counted and compared as trigger",
  },
  trigger: { kind: "trigger" },
  policy: { kind: "policy" },
  rule: { kind: "rule" },
  collation: { kind: "collation" },
  conversion: { kind: null },
  operator: { kind: null },
  operatorClass: { kind: null },
  operatorFamily: { kind: null },
  cast: { kind: null },
  textSearchConfiguration: { kind: null },
  textSearchDictionary: { kind: null },
  textSearchParser: { kind: null },
  textSearchTemplate: { kind: null },
  statistics: { kind: null },
  transform: { kind: null },
  publicationRel: { kind: "publicationRel" },
  publicationSchema: { kind: "publicationSchema" },
  defaultPrivilege: {
    kind: "defaultPrivilege",
    uncompared:
      "pg_default_acl holds one row per (role, schema, object type) for every grantee, the engine one fact per grantee",
  },
  extension: { kind: "extension" },
  // Факт `language` двигун має лише як ціль грантів; процедурну мову він
  // не витягує, а повідомляє `unmodeled_kind`
  language: { kind: null, global: true },
  accessMethod: { kind: null, global: true },
  eventTrigger: { kind: "eventTrigger" },
  foreignDataWrapper: { kind: "fdw" },
  server: { kind: "server" },
  subscription: { kind: "subscription" },
} as const satisfies Record<string, CensusFact>

/**
 * Стан заповнення матеріалізованого подання: факт двигуна його не несе, а дія
 * створення не містить `WITH NO DATA` — доведена прогалина двигуна (план E2a,
 * рішення 7), тож окремий клас перепису з власною діагностикою.
 */
const UNPOPULATED = "materializedView.unpopulated"

type TableClass = keyof typeof CENSUS_FACTS
export type CensusClass = TableClass | typeof UNPOPULATED

export interface CensusCount {
  class: CensusClass
  count: number
}

function entryOf(censusClass: CensusClass): CensusFact | undefined {
  return censusClass === UNPOPULATED ? undefined : CENSUS_FACTS[censusClass]
}

/** Вид факту двигуна для класу перепису; `null` — двигун класу не бачить. */
export function factKindOf(censusClass: CensusClass): FactKind | null {
  return entryOf(censusClass)?.kind ?? null
}

const TABLE_CLASSES = Object.keys(CENSUS_FACTS) as TableClass[]

/**
 * Класи перепису, об'єкти яких доходять до мапера фактами двигуна: їх
 * покриває модель (поле, одиниця або гучне `engine.unrepresentable`).
 * Похідне від `CENSUS_FACTS`, а не другий перелік.
 */
export const COVERED_CLASSES: readonly CensusClass[] = TABLE_CLASSES.filter(
  (c) => CENSUS_FACTS[c].kind !== null
)

/** Покриті класи, лічильник яких звіряється з фактами двигуна. */
const COMPARED_CLASSES: readonly TableClass[] = COVERED_CLASSES.flatMap((c) => {
  const entry = entryOf(c)
  return entry !== undefined && !("uncompared" in entry)
    ? [c as TableClass]
    : []
})

/**
 * Клас перепису, яким звіряється факт двигуна; `undefined` — факт не
 * рахується окремим класом (частина, сателіт, непорівнюваний клас).
 */
export function censusClassOfFact(fact: {
  id: { kind: string }
  payload: Record<string, unknown>
}): CensusClass | undefined {
  return COMPARED_CLASSES.find((c) => {
    const entry: CensusFact = CENSUS_FACTS[c]
    if (entry.kind !== fact.id.kind) return false
    const match = "match" in entry ? entry.match : undefined
    return match === undefined || fact.payload[match.field] === match.value
  })
}

/**
 * Звірка перепису з фактами двигуна тієї ж бази за кожним порівнюваним
 * класом: відсутній клас — нуль. Розбіжність — пропущені двигуном (або
 * зайві) об'єкти покритого класу, яких модель тихо не мала б.
 */
export function reconcileCensus(
  census: readonly CensusCount[],
  facts: ReadonlyMap<CensusClass, number>
): EngineDiagnostic[] {
  const counted = new Map(census.map((c) => [c.class, c.count]))
  return COMPARED_CLASSES.flatMap((c) => {
    const inCensus = counted.get(c) ?? 0
    const inEngine = facts.get(c) ?? 0
    return inCensus === inEngine
      ? []
      : [
          diagnostic("engine.census-mismatch", "error", {
            class: c,
            census: inCensus,
            engine: inEngine,
          }),
        ]
  })
}

/**
 * `unmodeled_kind` двигуна за міткою `context.kind` → клас перепису. Перепис
 * рахує ці класи в межі керування, тож про клас, який він уже назвав
 * помилкою, сигнал двигуна (бо той — без межі, на всю базу) не повторюється.
 */
const UNMODELED_KIND_CLASS: Readonly<Record<string, CensusClass>> = {
  cast: "cast",
  operator: "operator",
  "operator class": "operatorClass",
  "operator family": "operatorFamily",
  "text search configuration": "textSearchConfiguration",
  "text search dictionary": "textSearchDictionary",
  "text search parser": "textSearchParser",
  "text search template": "textSearchTemplate",
  "statistics object": "statistics",
  language: "language",
  transform: "transform",
}

export function censusClassOfUnmodeledKind(
  kind: string
): CensusClass | undefined {
  return UNMODELED_KIND_CLASS[kind]
}

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
  union all select '${UNPOPULATED}' from rel where relkind = 'm' and not relispopulated
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
    PROVIDER_SCHEMAS,
    SUPABASE_PROVIDER_EXTENSIONS,
    SUPABASE_PROVIDER_EVENT_TRIGGERS,
  ])
  return rows
}

/**
 * Незаповнені матеріалізовані подання керованих схем у формі ідентичності
 * двигуна: перепис їх лише рахує, а діагностика має назвати кожне.
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
  return rows.map((r) =>
    encodeId({ kind: "materializedView", schema: r.schema, name: r.name })
  )
}

function diagnostic(
  code:
    | "engine.unmodeled-class"
    | "engine.matview-unpopulated"
    | "engine.census-mismatch",
  severity: EngineDiagnostic["severity"],
  params: Record<string, string | number>,
  object?: string
): EngineDiagnostic {
  return {
    code,
    severity,
    message: localize({ code, params }, "en").message,
    ...(object === undefined ? {} : { object }),
  }
}

/** Класи з об'єктами в межі, яких двигун не бачить: кожен — тиха втрата. */
export function unmodeledClasses(
  census: readonly CensusCount[]
): Set<CensusClass> {
  return new Set(
    census.map((c) => c.class).filter((c) => entryOf(c)?.kind === null)
  )
}

/**
 * Діагностики перепису: клас без факту двигуна з об'єктами в межі — тиха
 * втрата; розбіжність лічильника покритого класу з фактами — пропуск окремих
 * об'єктів; незаповнене подання — стан, якого модель не виражає. Усі — error,
 * інакше звірка назвала б базу рівною бажаному стану; виняток — глобальні
 * класи без схеми (див. `CENSUS_FACTS`).
 */
export function censusDiagnostics(
  census: readonly CensusCount[],
  facts: ReadonlyMap<CensusClass, number>,
  unpopulated: readonly string[]
): EngineDiagnostic[] {
  const unmodeled = unmodeledClasses(census)
  const out = census
    .filter((c) => unmodeled.has(c.class))
    .map((c) => {
      const entry = entryOf(c.class)
      const global = entry !== undefined && "global" in entry
      return diagnostic(
        "engine.unmodeled-class",
        global ? "warning" : "error",
        { class: c.class, count: c.count }
      )
    })
  out.push(...reconcileCensus(census, facts))
  for (const view of unpopulated)
    out.push(diagnostic("engine.matview-unpopulated", "error", { view }, view))
  return out
}
