import { quoteIdent } from "simetra/model"
import type { LockedTable } from "../../engine"
import type { ApplyTransaction } from "../port"
import { intentStep, type PlanStep } from "../steps"
import { tableKey } from "../table-key"

/**
 * Обмеження, окремий індекс чи послідовність таблиці одиниці з канонічною
 * формою без імені (рішення 4 плану П3-2a). Об'єкти копії й тіні з рівним
 * ключем еквівалентні: ім'я тіні копія отримує перейменуванням, а не
 * DROP+CREATE двигуна.
 */
export interface EquivalenceObject {
  kind: "constraint" | "index" | "sequence"
  schema: string
  /** Таблиця об'єкта; для послідовності — таблиця колонки-власника. */
  table: string
  name: string
  /**
   * `JSON.stringify` частин форми без імені. Обмеження — `[contype,
   * pg_get_constraintdef]`; індекс — частини, з яких складено визначення;
   * послідовність — `[колонка-власник, чи DEFAULT колонки вживає саме її]`.
   */
  key: string
  /** `indisvalid && indisready` / `convalidated`; послідовність — завжди. */
  valid: boolean
}

/**
 * Ключі одним запитом. Окремий індекс — не носій обмеження: носій іде разом
 * зі своїм обмеженням, а унікальне обмеження й унікальний індекс — різні
 * види ключа. `pg_get_indexdef(oid)` цілком містить ім'я, тож ключ індексу
 * складено з частин; `indnkeyatts` розрізняє `UNIQUE (a) INCLUDE (b)` і
 * `UNIQUE (a, b)`. `pg_get_indexdef(oid, k, …)` для ключової колонки не
 * містить класу операторів, а `(a text_pattern_ops)` і `(a)` — різні індекси,
 * тож класи (`indclass`) — окремою частиною, і так само параметри класу
 * (`attoptions` ключових колонок індексу, PG13+: `tsvector_ops (siglen = 32)`
 * і `(siglen = 64)` — різні індекси). Класи й колляції — іменами: копія
 * й тінь — різні бази, OID користувацьких об'єктів у них різні. Ім'я класу
 * не каже, чи він типовий для типу колонки, а форма `covered` (рішення 11
 * плану П3-3a1) покриває лише індекс з типовими класами, тож типовість
 * (`opcdefault`) — останньою окремою частиною. Послідовність — лише в схемі своєї
 * таблиці: крок перейменування адресує її схемою таблиці.
 */
const EQUIVALENCE_SQL = `
with t as (
  select c.oid, n.oid as nsp, x.schema, x.name as tbl
  from json_to_recordset($1::json) as x(schema text, name text)
  join pg_namespace n on n.nspname = x.schema
  join pg_class c on c.relnamespace = n.oid and c.relname = x.name
   and c.relkind in ('r', 'p')
)
select 'constraint' as kind, t.schema, t.tbl as "table", k.conname as name,
  json_build_array(k.contype, pg_get_constraintdef(k.oid)) as parts,
  k.convalidated as valid
from t join pg_constraint k on k.conrelid = t.oid
where k.contype in ('p', 'u', 'c', 'x', 'f')
union all
select 'index', t.schema, t.tbl, ic.relname,
  json_build_array(
    am.amname, i.indisunique, i.indnullsnotdistinct, i.indnkeyatts,
    (select json_agg(pg_get_indexdef(i.indexrelid, k, false) order by k)
       from generate_series(1, i.indnatts::int) as k),
    i.indoption::int2[],
    (select json_agg(quote_ident(on_.nspname) || '.' || quote_ident(oc.opcname)
                     order by u.ord)
       from unnest(i.indclass::oid[]) with ordinality as u(cls, ord)
       join pg_opclass oc on oc.oid = u.cls
       join pg_namespace on_ on on_.oid = oc.opcnamespace),
    (select json_agg(a.attoptions order by a.attnum)
       from pg_attribute a
       where a.attrelid = i.indexrelid and a.attnum between 1 and i.indnkeyatts),
    (select json_agg(case when u.coll = 0 then null
                     else quote_ident(cn.nspname) || '.' || quote_ident(co.collname) end
                     order by u.ord)
       from unnest(i.indcollation::oid[]) with ordinality as u(coll, ord)
       left join pg_collation co on co.oid = u.coll
       left join pg_namespace cn on cn.oid = co.collnamespace),
    pg_get_expr(i.indpred, i.indrelid),
    ic.reloptions,
    (select json_agg(oc.opcdefault order by u.ord)
       from unnest(i.indclass::oid[]) with ordinality as u(cls, ord)
       join pg_opclass oc on oc.oid = u.cls)),
  i.indisvalid and i.indisready
from t join pg_index i on i.indrelid = t.oid
join pg_class ic on ic.oid = i.indexrelid
join pg_am am on am.oid = ic.relam
where not exists (
  select from pg_constraint k
  where k.conindid = i.indexrelid and k.conrelid = i.indrelid
    and k.contype in ('p', 'u', 'x'))
union all
select 'sequence', t.schema, t.tbl, s.relname,
  json_build_array(a.attname, exists (
    select from pg_attrdef ad
    join pg_depend dd on dd.classid = 'pg_attrdef'::regclass
     and dd.objid = ad.oid and dd.refclassid = 'pg_class'::regclass
     and dd.refobjid = s.oid
    where ad.adrelid = t.oid and ad.adnum = a.attnum)),
  true
from t join pg_depend d on d.classid = 'pg_class'::regclass
 and d.refclassid = 'pg_class'::regclass and d.refobjid = t.oid
 and d.deptype in ('a', 'i')
join pg_class s on s.oid = d.objid and s.relkind = 'S' and s.relnamespace = t.nsp
join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
`

const KINDS = new Set<string>(["constraint", "index", "sequence"])

/**
 * Об'єкти еквівалентності таблиць `tables` (у поточних іменах бази). Запит у
 * точці збереження під `search_path = pg_catalog, pg_temp`, як відбиток:
 * `pg_get_*` кваліфікують імена схемою незалежно від сесії, а `search_path`
 * транзакції лишається незмінним.
 */
export async function readEquivalenceObjects(
  tx: ApplyTransaction,
  tables: readonly { schema: string; name: string }[]
): Promise<EquivalenceObject[]> {
  await tx.query("SAVEPOINT simetra_equivalence")
  await tx.query(
    "select set_config('search_path', 'pg_catalog, pg_temp', true)"
  )
  const rows = await tx.query(EQUIVALENCE_SQL, [
    JSON.stringify(tables.map((t) => ({ schema: t.schema, name: t.name }))),
  ])
  await tx.query("ROLLBACK TO SAVEPOINT simetra_equivalence")
  await tx.query("RELEASE SAVEPOINT simetra_equivalence")
  return rows.map((r) => {
    const { kind, schema, table, name, parts, valid } = r
    if (
      typeof kind !== "string" ||
      !KINDS.has(kind) ||
      typeof schema !== "string" ||
      typeof table !== "string" ||
      typeof name !== "string" ||
      typeof valid !== "boolean"
    )
      throw new Error("equivalence row has an unexpected shape")
    return {
      kind: kind as EquivalenceObject["kind"],
      schema,
      table,
      name,
      key: JSON.stringify(parts),
      valid,
    }
  })
}

/** Порівняння кодовими одиницями, як `COLLATE "C"`: не залежить від локалі. */
const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/** Присутність об'єкта: той самий вид, таблиця й ім'я. */
const identity = (o: EquivalenceObject, name = o.name): string =>
  JSON.stringify([o.kind, o.schema, o.table, name])

/**
 * Простори імен, у яких об'єкт з ім'ям `name` займає ім'я. Індекс і
 * послідовність — відношення схеми (`pg_class`); обмеження — обмеження
 * таблиці, а PK, UNIQUE і EXCLUDE ще й ім'я свого індексу-носія: перейменування
 * обмеження перейменовує й індекс.
 */
function spaces(o: EquivalenceObject, name: string): string[] {
  const relation = JSON.stringify(["relation", o.schema, name])
  if (o.kind !== "constraint") return [relation]
  const own = JSON.stringify(["constraint", o.schema, o.table, name])
  const [contype] = JSON.parse(o.key) as [string]
  return ["p", "u", "x"].includes(contype) ? [own, relation] : [own]
}

const clash = (a: readonly string[], b: readonly string[]): boolean =>
  a.some((s) => b.includes(s))

interface Move {
  of: EquivalenceObject
  from: string
  to: string
}

/**
 * Кроки канонічних імен (рішення 4): для кожного об'єкта тіні, чийого імені
 * на копії немає, кандидати — дійсні об'єкти копії того самого виду й
 * таблиці з рівним ключем, чиїх імен немає в тіні й які ще не зіставлено.
 * Обмеження й індекс беруть першого за ім'ям; послідовність — лише єдиного
 * кандидата: лічильник — дані, і вибір за ім'ям міг би віддати канонічне ім'я
 * чужому лічильнику. Незіставлене лишається DROP двигуна. Ціль, зайнята
 * об'єктом, що сам не перейменовується, звільняється тимчасовим іменем, яке
 * доживає до кроків двигуна (`tempNames`). `tablesNewToOld` — лише
 * перейменовані таблиці; блокування кроків — у старих іменах.
 */
export function canonicalRenames(
  clone: readonly EquivalenceObject[],
  shadow: readonly EquivalenceObject[],
  tablesNewToOld: ReadonlyMap<string, string>
): {
  steps: Omit<PlanStep, "id">[]
  tempNames: ReadonlyMap<string, string>
  /**
   * Перейменування в порядку кроків, зокрема відведення вбік: секція плану
   * показує саме їх, а не розбір SQL (R7a плану П3-2a). Таблиця — у новому
   * імені.
   */
  renames: CanonicalRename[]
} {
  const onClone = new Set(clone.map((o) => identity(o)))
  const inShadow = new Set(shadow.map((o) => identity(o)))
  const used = new Set<EquivalenceObject>()
  const matches: Move[] = []

  const ordered = [...shadow].sort(
    (a, b) =>
      byCodeUnit(a.kind, b.kind) ||
      byCodeUnit(a.schema, b.schema) ||
      byCodeUnit(a.table, b.table) ||
      byCodeUnit(a.name, b.name)
  )
  for (const s of ordered) {
    if (onClone.has(identity(s))) continue
    const candidates = clone
      .filter(
        (c) =>
          c.valid &&
          c.kind === s.kind &&
          c.schema === s.schema &&
          c.table === s.table &&
          c.key === s.key &&
          !inShadow.has(identity(c)) &&
          !used.has(c)
      )
      .sort((a, b) => byCodeUnit(a.name, b.name))
    if (candidates.length === 0) continue
    if (s.kind === "sequence" && candidates.length !== 1) continue
    const c = candidates[0]!
    used.add(c)
    matches.push({ of: c, from: c.name, to: s.name })
  }

  // Тимчасові імена — поза іменами копії: інакше «вільне» ім'я само
  // зайняло б чуже
  const taken = new Set(clone.map((o) => o.name))
  let n = 0
  const tmp = (): string => {
    let name: string
    do name = `simetra_tmp_${++n}`
    while (taken.has(name))
    return name
  }

  const moves: Move[] = []
  const tempNames = new Map<string, string>()
  for (const m of matches) {
    const target = spaces(m.of, m.to)
    for (const o of clone) {
      if (used.has(o) || !clash(spaces(o, o.name), target)) continue
      const aside = tmp()
      moves.push({ of: o, from: o.name, to: aside })
      used.add(o)
      tempNames.set(JSON.stringify([o.schema, o.table, aside]), o.name)
    }
  }

  // Ім'я, зайняте об'єктом, що сам перейменовується, звільняється раніше;
  // цикл розривається тимчасовим іменем, яке до кінця кроків знову зникає
  const pending = matches.map((m) => ({ ...m }))
  while (pending.length > 0) {
    const free = pending.findIndex(
      (r) =>
        !pending.some(
          (p) => p !== r && clash(spaces(p.of, p.from), spaces(r.of, r.to))
        )
    )
    if (free >= 0) {
      moves.push(pending.splice(free, 1)[0]!)
      continue
    }
    const first = pending[0]!
    const aside = tmp()
    moves.push({ of: first.of, from: first.from, to: aside })
    first.from = aside
  }

  const lockOf = (o: EquivalenceObject): LockedTable[] => {
    const old = tablesNewToOld.get(tableKey(o.schema, o.table))
    if (old === undefined) return [{ schema: o.schema, name: o.table }]
    const [schema, name] = JSON.parse(old) as [string, string]
    return [{ schema, name }]
  }
  const steps = moves.map((m) => intentStep(renameSql(m), lockOf(m.of)))
  const renames = moves.map((m): CanonicalRename => ({
    kind: m.of.kind,
    table: { schema: m.of.schema, name: m.of.table },
    from: m.from,
    to: m.to,
  }))
  return { steps, tempNames, renames }
}

/** Одне канонічне перейменування підоб'єкта таблиці одиниці. */
export interface CanonicalRename {
  kind: EquivalenceObject["kind"]
  table: { schema: string; name: string }
  from: string
  to: string
}

function renameSql({ of, from, to }: Move): string {
  const q = (name: string) => `${quoteIdent(of.schema)}.${quoteIdent(name)}`
  switch (of.kind) {
    case "constraint":
      return `ALTER TABLE ${q(of.table)} RENAME CONSTRAINT ${quoteIdent(from)} TO ${quoteIdent(to)}`
    case "index":
      return `ALTER INDEX ${q(from)} RENAME TO ${quoteIdent(to)}`
    case "sequence":
      return `ALTER SEQUENCE ${q(from)} RENAME TO ${quoteIdent(to)}`
  }
}
