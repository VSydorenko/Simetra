import {
  unitTargets,
  type PromotionFacts,
  type PromotionRecord,
  type SqlParser,
} from "simetra/compiler"
import { quoteIdent, type CatalogModel, type CatalogUnit } from "simetra/model"
import type { ApplyTransaction } from "../port"
import { comparePermissionItems, type PermissionItem } from "../steps"
import { tableKey } from "../table-key"
import type { DataTable } from "./data"
import type { RenameIntent } from "./intent"
import type { Removal } from "./removals"

/**
 * Зміна доступу до таблиці одиниці (рішення 8 плану П3-2a): що міняється в
 * RLS, політиках і грантах і чиї чужі об'єкти бачать таблицю через неї.
 * Гейт статичний: дозвіл потрібен на саму зміну, без перевірки
 * «роль × дія × рядок».
 */
export interface AccessChange {
  /** Нове ім'я таблиці. */
  table: { schema: string; name: string }
  rowLevelSecurity?: { from: "off" | "forced"; to: "enabled" }
  /** `missing|extra|changed <identity>` одиниць класу `policy`. */
  policies: string[]
  /** `missing|extra|changed <identity>` одиниць класу `grant`. */
  grants: string[]
  /** `policy <кваліфіковане ім'я>`, `view <кваліфіковане ім'я>`. */
  dependents: string[]
}

const qualified = (...parts: readonly string[]): string =>
  parts.map(quoteIdent).join(".")

const byCodeUnits = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/** Одиниці класу на таблиці — за ідентичністю. */
function unitsOn(
  model: CatalogModel,
  cls: CatalogUnit["class"],
  schema: string,
  table: string,
  parse: SqlParser
): Map<string, CatalogUnit> {
  return new Map(
    model.units
      .filter(
        (u) =>
          u.class === cls &&
          unitTargets(u, parse).some(
            (t) => t.schema === schema && t.object === table
          )
      )
      .map((u) => [u.identity, u])
  )
}

/**
 * Зниклі, нові й змінені одиниці класу між копією після наміру й бажаною
 * тінню, у порядку ідентичностей за кодовими одиницями.
 */
function unitChanges(
  clone: ReadonlyMap<string, CatalogUnit>,
  desired: ReadonlyMap<string, CatalogUnit>
): string[] {
  const identities = [...new Set([...clone.keys(), ...desired.keys()])].sort(
    byCodeUnits
  )
  return identities.flatMap((identity) => {
    const was = clone.get(identity)
    const now = desired.get(identity)
    if (was === undefined) return [`extra ${identity}`]
    if (now === undefined) return [`missing ${identity}`]
    return was.sql === now.sql ? [] : [`changed ${identity}`]
  })
}

/**
 * Зміни доступу таблиць одиниці. Режим RLS — із запису (там він має клас
 * переходу), політики й гранти — з одиниць копії й тіні. Залежні — з
 * `readAccessDependents`, що читав ціль, де таблиця ще має старе ім'я: ключ
 * — `tableKey` старого імені (`tablesNewToOld`, для неперейменованої —
 * той самий).
 */
export function accessChanges(p: {
  record: PromotionRecord
  intent: RenameIntent
  clone: CatalogModel
  desired: CatalogModel
  dependents: ReadonlyMap<string, readonly string[]>
  parse: SqlParser
}): AccessChange[] {
  const { record, intent, clone, desired, dependents, parse } = p
  return record.tables.flatMap((t): AccessChange[] => {
    const rls = record.rowLevelSecurity.find(
      (r) => r.schema === t.schema && r.table === t.from
    )
    const units = (cls: CatalogUnit["class"]) =>
      unitChanges(
        unitsOn(clone, cls, t.schema, t.to, parse),
        unitsOn(desired, cls, t.schema, t.to, parse)
      )
    const policies = units("policy")
    const grants = units("grant")
    if (rls === undefined && policies.length === 0 && grants.length === 0)
      return []
    const key = tableKey(t.schema, t.to)
    return [
      {
        table: { schema: t.schema, name: t.to },
        ...(rls === undefined
          ? {}
          : { rowLevelSecurity: { from: rls.from, to: rls.to } }),
        policies,
        grants,
        dependents: [
          ...(dependents.get(intent.tablesNewToOld.get(key) ?? key) ?? []),
        ],
      },
    ]
  })
}

/**
 * Чужі об'єкти, чия видимість іде за таблицею: політики інших таблиць, що
 * читають її у `USING`/`WITH CHECK` (`pg_depend` → `pg_policy`), в'юхи з
 * `security_invoker` (`pg_depend` → `pg_rewrite`), а для `forced → enabled`
 * — ще й в'юхи без нього: вони читають із правами власника, а власник
 * перестає підпадати під політики. Матеріалізовані в'юхи не враховано: їх
 * дані вже збережено, читання RLS не проходить.
 */
const DEPENDENTS_SQL = `
with t as (
  select c.oid, x.schema, x.name, x.forced
  from json_to_recordset($1::json) as x(schema text, name text, forced boolean)
  join pg_namespace n on n.nspname = x.schema
  join pg_class c on c.relnamespace = n.oid and c.relname = x.name
)
select distinct t.schema as "tableSchema", t.name as "tableName",
  'policy' as kind, pn.nspname as schema, pc.relname as "table",
  p.polname as name
from t
join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = t.oid
 and d.classid = 'pg_policy'::regclass
join pg_policy p on p.oid = d.objid and p.polrelid <> t.oid
join pg_class pc on pc.oid = p.polrelid
join pg_namespace pn on pn.oid = pc.relnamespace
union
select distinct t.schema, t.name, 'view', vn.nspname, null, v.relname
from t
join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = t.oid
 and d.classid = 'pg_rewrite'::regclass
join pg_rewrite r on r.oid = d.objid
join pg_class v on v.oid = r.ev_class and v.oid <> t.oid and v.relkind = 'v'
join pg_namespace vn on vn.oid = v.relnamespace
where t.forced or coalesce((
  select o.option_value::boolean
  from pg_options_to_table(v.reloptions) as o
  where o.option_name = 'security_invoker'), false)
`

/**
 * Залежні таблиць на живій цілі; викликач відкриває транзакцію `READ ONLY`.
 * Ключ — `tableKey` переданого імені; таблиця без залежних — порожній
 * список. Порядок — за кодовими одиницями.
 */
export async function readAccessDependents(
  tx: ApplyTransaction,
  tables: readonly { schema: string; name: string; forcedToEnabled: boolean }[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(
    tables.map((t) => [tableKey(t.schema, t.name), []])
  )
  if (tables.length === 0) return out
  const rows = await tx.query<{
    tableSchema: string
    tableName: string
    kind: "policy" | "view"
    schema: string
    table: string | null
    name: string
  }>(DEPENDENTS_SQL, [
    JSON.stringify(
      tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        forced: t.forcedToEnabled,
      }))
    ),
  ])
  for (const row of rows) {
    const name =
      row.table === null
        ? qualified(row.schema, row.name)
        : qualified(row.schema, row.table, row.name)
    out
      .get(tableKey(row.tableSchema, row.tableName))
      ?.push(`${row.kind} ${name}`)
  }
  for (const list of out.values()) list.sort(byCodeUnits)
  return out
}

/**
 * Пункти дозволу промоції (рішення 8 плану П3-2a), імена — нові й
 * кваліфіковані `quoteIdent`:
 * - `access:<таблиця>` — на кожну зміну доступу;
 * - `delete:<таблиця>.<обмеження>` — на кожен елемент семантики видалення.
 *   Лише з виведених фактів (рішення 15, R3): власні звірено із записом під
 *   час виявлення переходу, вхідні — тільки виведені;
 * - `remove:<таблиця>` — на таблицю, де щось видаляється з класом
 *   `removed`: крок такого видалення буває `catalogOnly` і дозволу сам не
 *   просить. Один пункт на таблицю — переглядається перелік;
 * - `repair:<таблиця>` — на таблицю з ремонтом (рішення 3 плану П3-2b-2):
 *   кожна ремонтована колонка з виразом. Конверсія, розщеплення й
 *   дозаповнення наявних значень не змінюють, тож дозволу не просять.
 */
export function promotionPermissionItems(
  access: readonly AccessChange[],
  deleteSemantics: PromotionFacts["deleteSemantics"],
  removals: readonly Removal[],
  data: readonly Pick<DataTable, "after" | "columns">[]
): PermissionItem[] {
  const items = new Map<string, string[]>()
  const add = (token: string, summary: readonly string[]) =>
    items.set(token, [...(items.get(token) ?? []), ...summary])
  for (const a of access)
    add(`access:${qualified(a.table.schema, a.table.name)}`, [
      ...(a.rowLevelSecurity === undefined
        ? []
        : [
            `rowLevelSecurity ${a.rowLevelSecurity.from} → ${a.rowLevelSecurity.to}`,
          ]),
      ...a.policies,
      ...a.grants,
      ...a.dependents.map((d) => `dependent ${d}`),
    ])
  for (const d of deleteSemantics)
    add(
      `delete:${qualified(d.schema, d.table)}.${
        // У виведених фактах обмеження названо завжди; без імені пункт
        // адресує колонки FK, щоб токен лишився однозначним
        d.constraint === undefined
          ? `(${d.columns.map(quoteIdent).join(",")})`
          : quoteIdent(d.constraint)
      }`,
      [
        `${d.direction} (${d.columns.map(quoteIdent).join(", ")}) → ${quoteIdent(d.target)}: on delete ${d.from} → ${d.to}`,
      ]
    )
  for (const r of removals)
    if (r.covered === "removed")
      for (const t of r.tables)
        add(`remove:${qualified(t.schema, t.name)}`, [r.path])
  for (const t of data)
    for (const c of t.columns)
      if (c.kind === "repair")
        add(`repair:${qualified(t.after.schema, t.after.table)}`, [
          `${quoteIdent(c.column)} ← ${c.expression}`,
        ])
  return [...items]
    .map(([token, summary]) => ({ token, summary }))
    .sort(comparePermissionItems)
}
