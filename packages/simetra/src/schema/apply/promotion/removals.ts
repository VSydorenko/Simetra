import type { Node } from "libpg-query"
import {
  unitSubjectKeys,
  type ConversionClass,
  type PromotionObject,
  type PromotionRecord,
  type SqlParser,
  type UnitSubjectKey,
} from "simetra/compiler"
import {
  quoteIdent,
  type CatalogColumn,
  type CatalogModel,
  type CatalogTable,
  type CatalogUnit,
} from "simetra/model"
import type {
  EngineAction,
  EngineDiagnostic,
  EngineObjectRef,
} from "../../engine"
import { applyDiagnostic } from "../diagnostic"
import { stepId, type PlanStep } from "../steps"
import { tableKey } from "../table-key"
import type { RenameIntent } from "./intent"

/**
 * Чим покрите видалення (рішення 7 плану П3-2a): клас конверсії з запису,
 * вилучена колонка, власна семантика видалення, мапінг колонки (тип,
 * `NOT NULL`, значення стандартного реквізиту) чи режим RLS запису; `null` —
 * непокрите, план відмовляє.
 */
export type RemovalCover =
  | ConversionClass
  | "retired"
  | "deleteSemantics"
  | "mapping"
  | "rowLevelSecurity"
  | null

/**
 * Запис класифікатора: що з прийнятої таблиці зникає (`missing`) чи
 * змінюється (`changed`) між копією після наміру й бажаною тінню. `path` —
 * лише для повідомлення, у старих іменах таблиці й об'єкта. `tables` —
 * таблиці одиниці, яких стосується запис, структурно й у нових іменах: за
 * ними `remove:<таблиця>` (рішення 8). Одиниця з кількома цілями (грант на
 * таблицю й ТЧ) називає кілька таблиць.
 */
export interface Removal {
  path: string
  kind: "missing" | "changed"
  covered: RemovalCover
  tables: { schema: string; name: string }[]
}

/** Запис таблиці до того, як класифікатор додасть саму таблицю. */
type TableRemoval = Omit<Removal, "tables">

/** Таблиця одиниці: схема, нове (на копії після наміру) і старе ім'я. */
interface UnitTable {
  schema: string
  name: string
  old: string
}

/**
 * Зведення імен копії після наміру до початкових: таблиця — через
 * `tablesNewToOld` (лише перейменовані, тож решта лишається собою), колонка
 * — через тимчасові імена й мапу колонок запису, обмеження й індекси —
 * через тимчасові імена канонічних перейменувань.
 */
interface OldNames {
  table(schema: string, table: string): string
  column(schema: string, table: string, name: string): string
  element(schema: string, table: string, name: string): string
}

const subKey = (schema: string, table: string, name: string): string =>
  JSON.stringify([schema, table, name])

function oldNames(record: PromotionRecord, intent: RenameIntent): OldNames {
  const renamedColumns = new Map(
    record.columns.map((c) => [subKey(c.schema, c.table, c.to), c.from])
  )
  const table = (schema: string, name: string): string => {
    const old = intent.tablesNewToOld.get(tableKey(schema, name))
    return old === undefined ? name : (JSON.parse(old) as string[])[1]!
  }
  const element = (schema: string, t: string, name: string): string =>
    intent.tempNames.get(subKey(schema, t, name)) ?? name
  return {
    table,
    element,
    column: (schema, t, name) =>
      intent.tempNames.get(subKey(schema, t, name)) ??
      renamedColumns.get(subKey(schema, t, name)) ??
      name,
  }
}

const unitTablesOf = (record: PromotionRecord): UnitTable[] =>
  record.tables.map((t) => ({ schema: t.schema, name: t.to, old: t.from }))

/** Канонічна JSON-форма: порядок полів не впливає на рівність. */
function canon(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        )
      : v
  )
}

const sameObject = (a: PromotionObject, b: PromotionObject): boolean =>
  canon(a) === canon(b)

/** Клас конверсії, що покриває об'єкт; перший у порядку запису. */
function classOf(
  record: PromotionRecord,
  object: PromotionObject
): ConversionClass | null {
  return (
    record.conversions.find((c) => c.objects.some((o) => sameObject(o, object)))
      ?.class ?? null
  )
}

const path = (...parts: readonly string[]): string => parts.join(".")

/**
 * Грант на колонки несе імена колонок у ключі (`update(code)`): копія після
 * наміру бачить нові імена, а запис — старі. Тож дерево гранту зводиться до
 * старих імен колонок до побудови ключа тим самим `unitSubjectKeys`, що й у
 * `promote`, — формат ключа один. Грант на кілька таблиць не зводиться: його
 * колонки не прив'язати до однієї таблиці, і ключ лишається непокритим.
 */
function withOldColumns(
  parse: SqlParser,
  schema: string,
  names: OldNames
): SqlParser {
  const rewrite = (stmt: Node): Node => {
    if (!("GrantStmt" in stmt)) return stmt
    const grant = stmt.GrantStmt
    const objects = grant.objects ?? []
    const only = objects.length === 1 ? objects[0]! : undefined
    if (only === undefined || !("RangeVar" in only)) return stmt
    const s = only.RangeVar.schemaname ?? schema
    const t = only.RangeVar.relname ?? ""
    return {
      GrantStmt: {
        ...grant,
        privileges: grant.privileges?.map((p): Node => {
          if (!("AccessPriv" in p) || p.AccessPriv.cols === undefined) return p
          const cols = p.AccessPriv.cols.map((c): Node =>
            "String" in c
              ? { String: { sval: names.column(s, t, c.String.sval ?? "") } }
              : c
          )
          return { AccessPriv: { ...p.AccessPriv, cols } }
        }),
      },
    }
  }
  return (text) => {
    const result = parse(text)
    if (!result.ok) return result
    return {
      ok: true,
      statements: result.statements.map((s) => ({
        ...s,
        stmt: rewrite(s.stmt),
      })),
    }
  }
}

/**
 * Ключі одиниці копії в старих іменах. Схема власника — `unit.schema`, як у
 * `promote` для одиниці без модуля: витяг кваліфікує цілі, тож порожньої
 * схеми цілі тут не буває. Ключ коментаря називає колонку — вона теж
 * зводиться до старого імені.
 */
function unitKeysInOldNames(
  unit: CatalogUnit,
  parse: SqlParser,
  names: OldNames
): { key: UnitSubjectKey; newTable: string }[] {
  return unitSubjectKeys(
    unit,
    withOldColumns(parse, unit.schema, names),
    unit.schema
  ).map((key) => ({
    newTable: key.table,
    key: {
      ...key,
      table: names.table(key.schema, key.table),
      name:
        key.class === "comment" && key.name !== ""
          ? names.column(key.schema, key.table, key.name)
          : key.name,
    },
  }))
}

/**
 * Нереалізоване оголошення (рішення 2 плану П3-2a): намір уже перейменував
 * таблицю чи колонку, тож дія двигуна, що її знищує або несе на ній
 * `dataLoss`, означає, що двигун бачить інший стан, ніж оголошено, — і
 * віддав би дані перейменованого об'єкта. Перевіряються лише кроки двигуна.
 */
export function unrealizedRenames(
  steps: readonly PlanStep[],
  intent: RenameIntent,
  record: PromotionRecord
): EngineDiagnostic[] {
  // Ключі `tablesNewToOld` — нові імена саме перейменованих таблиць
  const tables = [...intent.tablesNewToOld.keys()].map((k) => {
    const [schema, name] = JSON.parse(k) as [string, string]
    return { schema, name }
  })
  const columns = record.columns
    .filter((c) => c.from !== c.to)
    .map((c) => ({ schema: c.schema, table: c.table, name: c.to }))
  const renamed = [
    ...tables.map((t) => ({
      text: `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`,
      ref: { kind: "table", schema: t.schema, name: t.name },
    })),
    ...columns.map((c) => ({
      text: `${quoteIdent(c.schema)}.${quoteIdent(c.table)}.${quoteIdent(c.name)}`,
      ref: { kind: "column", schema: c.schema, table: c.table, name: c.name },
    })),
  ]
  const hit = new Set<string>()
  for (const step of steps) {
    if (step.origin !== "engine") continue
    for (const r of renamed) {
      const destroyed = step.destroyed.some((d) => sameRef(d, r.ref))
      // Лише структурні форми (рішення 15, R20): рядкова ідентичність
      // двигуна в T2 не відтворюється. `DROP COLUMN` адаптер називає
      // вжитою саму таблицю: втрату тоді несе знята колонка, і її перевіряє
      // рядок колонки — інакше зняття вилученої колонки (рішення 2,
      // очікуване) назвало б нереалізованою перейменовану таблицю
      const lossy =
        step.dataLoss &&
        step.consumed.some((d) => sameRef(d, r.ref)) &&
        !(r.ref.kind === "table" && dropsColumnOf(step, r.ref))
      if (destroyed || lossy) hit.add(r.text)
    }
  }
  const objects = renamed.map((r) => r.text).filter((t) => hit.has(t))
  return objects.length === 0
    ? []
    : [
        applyDiagnostic("plan.rename-not-realized", "error", {
          objects: objects.join(", "),
        }),
      ]
}

/** Крок знімає колонку таблиці `table`. */
const dropsColumnOf = (step: PlanStep, table: EngineObjectRef): boolean =>
  step.destroyed.some(
    (d) =>
      d.kind === "column" && d.schema === table.schema && d.table === table.name
  )

const sameRef = (a: EngineObjectRef, b: EngineObjectRef): boolean =>
  a.kind === b.kind &&
  a.schema === b.schema &&
  (a.table ?? "") === (b.table ?? "") &&
  a.name === b.name

/** Види об'єктів без даних, що висять на таблиці (рішення 3). */
const ADOPTED_KINDS: ReadonlySet<string> = new Set([
  "constraint",
  "index",
  "policy",
  "trigger",
  "rule",
])

/**
 * Id кроків двигуна, що знищують прийнятий об'єкт таблиці одиниці
 * (рішення 3 плану П3-2a): для них виняток «заміна» П3-1 не діє —
 * перевизначення під тим самим ім'ям лишається видаленням і створенням, і
 * частковий індекс, ставши повним, не пройде як `catalogOnly`. Рахується з
 * дій до `classifySteps`, бо його результат — вхід класифікатора.
 * `unitTables` — `tableKey` нових імен; `offset` — кількість кроків наміру.
 *
 * Припущення (рішення 15, R5): `clone` — та сама модель копії після наміру,
 * з якої двигун будував план. Тоді все, що дія знищує на таблиці одиниці,
 * у копії є, а намір лише перейменовує — тож кожен такий об'єкт прийнятий.
 * Тому політика, тригер і правило визнаються прийнятими за самою таблицею;
 * обмеження й індекс додатково шукаються в копії, бо їх адресу (індекс — без
 * таблиці) інакше не прив'язати до таблиці одиниці. Інша модель тут зламала
 * б висновок: новий об'єкт втратив би виняток, а прийнятий — проскочив.
 */
export function adoptedReplacements(
  actions: readonly EngineAction[],
  clone: CatalogModel,
  unitTables: ReadonlySet<string>,
  offset: number
): Set<string> {
  const tables = clone.tables.filter((t) =>
    unitTables.has(tableKey(t.schema, t.name))
  )
  const adopted = (ref: EngineObjectRef): boolean => {
    if (!ADOPTED_KINDS.has(ref.kind)) return false
    // Індекс у двигуна адресується схемою й іменем, без таблиці
    if (ref.kind === "index")
      return tables.some(
        (t) =>
          t.schema === ref.schema && t.indexes.some((i) => i.name === ref.name)
      )
    if (ref.table === undefined) return false
    const table = tables.find(
      (t) => t.schema === ref.schema && t.name === ref.table
    )
    if (table === undefined) return false
    if (ref.kind !== "constraint") return true
    return constraintNames(table).includes(ref.name)
  }
  const out = new Set<string>()
  actions.forEach((action, i) => {
    if (action.destroyed.some(adopted)) out.add(stepId(offset + i))
  })
  return out
}

const constraintNames = (t: CatalogTable): string[] => [
  ...(t.primaryKey === undefined ? [] : [t.primaryKey.name]),
  ...t.uniques.map((u) => u.name),
  ...t.checks.map((c) => c.name),
  ...t.foreignKeys.map((f) => f.name),
]

/** Поля колонки, зміну яких не покриває жоден запис (рішення 7). */
const UNCOVERED_COLUMN_FIELDS = ["identity", "generated", "collation"] as const

/**
 * Класи видалень (рішення 7 плану П3-2a): копія після наміру проти бажаної
 * тіні, лише таблиці одиниці й одиниці на них. Порівняння структурне —
 * схема й ім'я окремо, елементи за іменем і по властивостях, —
 * `diffCatalogModels` з його ключами `schema.name` не вживається. Порядок
 * детермінований: таблиці в порядку запису, далі одиниці за ідентичністю.
 */
export function classifyRemovals(p: {
  record: PromotionRecord
  intent: RenameIntent
  clone: CatalogModel
  desired: CatalogModel
  parse: SqlParser
}): Removal[] {
  const { record, intent, clone, desired, parse } = p
  const names = oldNames(record, intent)
  const out: Removal[] = []
  const unitTables = unitTablesOf(record)
  for (const u of unitTables) {
    const from = findTable(clone, u.schema, u.name)
    if (from === undefined) continue
    const to = findTable(desired, u.schema, u.name)
    if (to === undefined) {
      out.push({
        path: path("tables", u.schema, u.old),
        kind: "missing",
        covered: null,
        tables: [{ schema: u.schema, name: u.name }],
      })
      continue
    }
    out.push(
      ...tableRemovals(u, from, to, record, names).map((r) => ({
        ...r,
        tables: [{ schema: u.schema, name: u.name }],
      }))
    )
  }
  out.push(...unitRemovals(record, clone, desired, parse, names, unitTables))
  return out
}

const findTable = (
  model: CatalogModel,
  schema: string,
  name: string
): CatalogTable | undefined =>
  model.tables.find((t) => t.schema === schema && t.name === name)

function tableRemovals(
  u: UnitTable,
  from: CatalogTable,
  to: CatalogTable,
  record: PromotionRecord,
  names: OldNames
): TableRemoval[] {
  const out: TableRemoval[] = []
  const at = (...rest: string[]) => path("tables", u.schema, u.old, ...rest)
  const object = (o: PromotionObject) => classOf(record, o)
  const oldColumn = (c: string) => names.column(u.schema, u.name, c)
  const desiredColumns = new Set(to.columns.map((c) => c.name))
  const retired = (column: string): boolean =>
    !desiredColumns.has(column) &&
    record.retired.some(
      (r) =>
        r.schema === u.schema &&
        r.table === u.old &&
        r.column === oldColumn(column)
    )

  if (canon(from.primaryKey) !== canon(to.primaryKey))
    // Прийнятий ключ, що не став еквівалентним ключу виду, промоція 2a не
    // підтримує: жодний запис його не покриває
    out.push({ path: at("primaryKey"), kind: "changed", covered: null })

  if (from.rowLevelSecurity !== to.rowLevelSecurity)
    out.push({
      path: at("rowLevelSecurity"),
      kind: "changed",
      covered: record.rowLevelSecurity.some(
        (r) =>
          r.schema === u.schema &&
          r.table === u.old &&
          r.from === from.rowLevelSecurity &&
          r.to === to.rowLevelSecurity
      )
        ? "rowLevelSecurity"
        : null,
    })

  if (from.comment !== undefined && from.comment !== to.comment)
    out.push({
      path: at("comment"),
      kind: "changed",
      covered: object({ kind: "comment", schema: u.schema, table: u.old }),
    })

  for (const c of from.columns) {
    const target = to.columns.find((d) => d.name === c.name)
    const old = oldColumn(c.name)
    if (target === undefined) {
      out.push({
        path: at("columns", old),
        kind: "missing",
        covered: retired(c.name) ? "retired" : null,
      })
      continue
    }
    out.push(...columnChanges(u, c, target, old, record, at))
  }

  const constraint = (name: string): PromotionObject => ({
    kind: "constraint",
    schema: u.schema,
    table: u.old,
    name: names.element(u.schema, u.name, name),
  })
  const sections = [
    ["uniques", from.uniques, to.uniques],
    ["checks", from.checks, to.checks],
  ] as const
  for (const [section, a, b] of sections)
    for (const e of a) {
      const change = elementChange(e, b)
      if (change === undefined) continue
      out.push({
        path: at(section, names.element(u.schema, u.name, e.name)),
        kind: change,
        covered: object(constraint(e.name)),
      })
    }
  for (const fk of from.foreignKeys) {
    const change = elementChange(fk, to.foreignKeys)
    if (change === undefined) continue
    // FK, що зник разом із вилученою колонкою, покриває вилучення; FK, який
    // замінює власна семантика видалення виду на тих самих колонках, —
    // елемент `deleteSemantics`
    const own = record.deleteSemantics.some(
      (d) =>
        d.direction === "own" &&
        d.schema === u.schema &&
        d.table === u.name &&
        sameSet(d.columns, fk.columns)
    )
    out.push({
      path: at("foreignKeys", names.element(u.schema, u.name, fk.name)),
      kind: change,
      covered:
        object(constraint(fk.name)) ??
        (fk.columns.some(retired) ? "retired" : own ? "deleteSemantics" : null),
    })
  }
  for (const index of from.indexes) {
    const change = elementChange(index, to.indexes)
    if (change === undefined) continue
    const name = names.element(u.schema, u.name, index.name)
    out.push({
      path: at("indexes", name),
      kind: change,
      covered: object({
        kind: "index",
        schema: u.schema,
        table: u.old,
        name,
      }),
    })
  }
  return out
}

/**
 * Зміна елемента під тим самим ім'ям — теж видалення (рішення 3): прийнятий
 * об'єкт перевизначено, і він потребує класу так само, як зниклий.
 */
function elementChange<T extends { name: string }>(
  element: T,
  desired: readonly T[]
): Removal["kind"] | undefined {
  const same = desired.find((d) => d.name === element.name)
  if (same === undefined) return "missing"
  return canon(same) === canon(element) ? undefined : "changed"
}

function columnChanges(
  u: UnitTable,
  from: CatalogColumn,
  to: CatalogColumn,
  old: string,
  record: PromotionRecord,
  at: (...rest: string[]) => string
): TableRemoval[] {
  const out: TableRemoval[] = []
  const changed = (field: string, covered: RemovalCover) =>
    out.push({ path: at("columns", old, field), kind: "changed", covered })
  const onColumn = <
    T extends { schema: string; table: string; column: string },
  >(
    list: readonly T[]
  ): T[] =>
    list.filter(
      (r) =>
        r.schema === u.schema && r.table === u.name && r.column === from.name
    )

  if (from.type !== to.type)
    changed(
      "type",
      onColumn(record.typeChanges).some(
        (t) => t.from === from.type && t.to === to.type
      )
        ? "mapping"
        : null
    )
  if (from.notNull !== to.notNull)
    changed(
      "notNull",
      onColumn(from.notNull ? record.relaxed : record.tightened).length > 0
        ? "mapping"
        : null
    )
  if (from.default !== undefined && from.default !== to.default) {
    // Значення стандартного реквізиту заміщує вид (промоція-4, рішення 5):
    // його синтетичний id — `<власник>#<ім'я>`, у UUID реквізиту `#` немає.
    // Носій скоупу (id — UUID виду скоупу) сюди не потрапляє: значення скоупу
    // вид у базі не дає, тож його DEFAULT потребує класу (рішення 15, R21)
    const standard = record.columns.some(
      (c) =>
        c.schema === u.schema &&
        c.table === u.name &&
        c.to === from.name &&
        c.id.includes("#")
    )
    changed(
      "default",
      standard
        ? "mapping"
        : classOf(record, {
            kind: "default",
            schema: u.schema,
            table: u.old,
            column: old,
          })
    )
  }
  if (from.comment !== undefined && from.comment !== to.comment)
    changed(
      "comment",
      classOf(record, {
        kind: "comment",
        schema: u.schema,
        table: u.old,
        column: old,
      })
    )
  for (const field of UNCOVERED_COLUMN_FIELDS)
    if (canon(from[field]) !== canon(to[field])) changed(field, null)
  return out
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x))

/**
 * Одиниці копії, яких бажаний стан не має чи має з іншим текстом, і які
 * висять на таблиці одиниці. Одиниця покрита, коли клас має кожен її ключ на
 * таблиці одиниці: грант на основну таблицю й ТЧ — обидва. Одиниці без
 * цілі на таблиці одиниці (функції) класифікатор не стосується.
 */
function unitRemovals(
  record: PromotionRecord,
  clone: CatalogModel,
  desired: CatalogModel,
  parse: SqlParser,
  names: OldNames,
  unitTables: readonly UnitTable[]
): Removal[] {
  const wanted = new Map(desired.units.map((u) => [u.identity, u]))
  const onUnit = new Set(unitTables.map((t) => tableKey(t.schema, t.name)))
  return [...clone.units]
    .sort((a, b) =>
      a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0
    )
    .flatMap((unit): Removal[] => {
      const same = wanted.get(unit.identity)
      if (same !== undefined && same.sql === unit.sql) return []
      const keys = unitKeysInOldNames(unit, parse, names).filter((k) =>
        onUnit.has(tableKey(k.key.schema, k.newTable))
      )
      if (keys.length === 0) return []
      const classes = keys.map((k) =>
        classOf(record, { kind: "unit", ...k.key })
      )
      // Ключ із класом `removed` важить більше за інші класи тієї самої
      // одиниці: його зняття без дозволу `remove:` пройшло б (рішення 8)
      const removed = classes.includes("removed")
      const covered = classes.every((c) => c !== null)
        ? removed
          ? "removed"
          : classes[0]!
        : null
      const tables = keys
        .filter((_, i) => covered !== "removed" || classes[i] === "removed")
        .map((k) => ({ schema: k.key.schema, name: k.newTable }))
      return [
        {
          path: path("units", unit.identity),
          kind: same === undefined ? "missing" : "changed",
          covered,
          tables: tables.filter(
            (t, i) =>
              tables.findIndex(
                (o) => o.schema === t.schema && o.name === t.name
              ) === i
          ),
        },
      ]
    })
}

/** Відмова за непокритими видаленнями: одна діагностика з усіма шляхами. */
export function unclassifiedRemovals(
  removals: readonly Removal[]
): EngineDiagnostic[] {
  const paths = removals.filter((r) => r.covered === null).map((r) => r.path)
  return paths.length === 0
    ? []
    : [
        applyDiagnostic("plan.removal-unclassified", "error", {
          paths: paths.join(", "),
        }),
      ]
}

/**
 * Клас конверсії біля кроку — лише для показу (рішення 15, R6): дозволи й
 * класи кроків від нього не залежать. Знищене кроку зводиться до старих
 * імен і зіставляється з `conversions[].objects`. Гранти, коментарі й
 * значення за замовчуванням у `destroyed` не потрапляють (немає схеми й
 * імені), тож їх видно з оператора кроку: `REVOKE` — ключ гранту, який він
 * знімає, `COMMENT … IS NULL` — коментар, `DROP DEFAULT` — значення.
 */
export function stepConversions(
  steps: readonly PlanStep[],
  record: PromotionRecord,
  intent: RenameIntent,
  parse: SqlParser
): Map<string, ConversionClass> {
  const names = oldNames(record, intent)
  const out = new Map<string, ConversionClass>()
  for (const step of steps) {
    if (step.origin !== "engine") continue
    const objects = [
      ...step.destroyed.flatMap((ref) => refObjects(ref, record, names)),
      ...statementObjects(step.sql, parse, names),
    ]
    for (const o of objects) {
      const cls = classOf(record, o)
      if (cls !== null) {
        out.set(step.id, cls)
        break
      }
    }
  }
  return out
}

function refObjects(
  ref: EngineObjectRef,
  record: PromotionRecord,
  names: OldNames
): PromotionObject[] {
  if (ref.kind === "index")
    // Індекс двигуна без таблиці: кандидати — таблиці одиниці тієї схеми
    return record.tables
      .filter((t) => t.schema === ref.schema)
      .map((t) => ({
        kind: "index",
        schema: t.schema,
        table: t.from,
        name: names.element(t.schema, t.to, ref.name),
      }))
  if (ref.table === undefined) return []
  const table = names.table(ref.schema, ref.table)
  if (ref.kind === "constraint")
    return [
      {
        kind: "constraint",
        schema: ref.schema,
        table,
        name: names.element(ref.schema, ref.table, ref.name),
      },
    ]
  if (ref.kind === "policy" || ref.kind === "trigger")
    return [
      {
        kind: "unit",
        class: ref.kind,
        schema: ref.schema,
        table,
        name: ref.name,
      },
    ]
  return []
}

function statementObjects(
  sql: string,
  parse: SqlParser,
  names: OldNames
): PromotionObject[] {
  const parsed = parse(sql)
  if (!parsed.ok) return []
  return parsed.statements.flatMap(({ stmt }): PromotionObject[] => {
    if ("GrantStmt" in stmt && stmt.GrantStmt.is_grant !== true) {
      // `REVOKE` знімає грант: ключ — того гранту, що його зняття покриває
      const grant = { GrantStmt: { ...stmt.GrantStmt, is_grant: true } }
      return unitKeysInOldNames(
        {
          class: "grant",
          schema: "",
          name: "",
          identity: "",
          sql: "",
        },
        () => ({ ok: true, statements: [{ stmt: grant, start: 0, end: 0 }] }),
        names
      ).map(({ key }) => ({ kind: "unit", ...key }))
    }
    if ("CommentStmt" in stmt) {
      const { objtype, object } = stmt.CommentStmt
      const parts = object === undefined ? [] : listStrings(object)
      if (objtype === "OBJECT_TABLE" && parts.length === 2)
        return [
          {
            kind: "comment",
            schema: parts[0]!,
            table: names.table(parts[0]!, parts[1]!),
          },
        ]
      if (objtype === "OBJECT_COLUMN" && parts.length === 3)
        return [
          {
            kind: "comment",
            schema: parts[0]!,
            table: names.table(parts[0]!, parts[1]!),
            column: names.column(parts[0]!, parts[1]!, parts[2]!),
          },
        ]
      return []
    }
    if ("AlterTableStmt" in stmt) {
      const { relation, cmds } = stmt.AlterTableStmt
      const schema = relation?.schemaname
      const table = relation?.relname
      if (schema === undefined || table === undefined) return []
      return (cmds ?? []).flatMap((node): PromotionObject[] => {
        if (!("AlterTableCmd" in node)) return []
        const { subtype, def, name } = node.AlterTableCmd
        if (subtype !== "AT_ColumnDefault" || def !== undefined) return []
        if (name === undefined) return []
        return [
          {
            kind: "default",
            schema,
            table: names.table(schema, table),
            column: names.column(schema, table, name),
          },
        ]
      })
    }
    return []
  })
}

const listStrings = (node: Node): string[] =>
  "List" in node
    ? (node.List.items ?? []).map((n) =>
        "String" in n ? (n.String.sval ?? "") : ""
      )
    : []
