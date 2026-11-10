import type { Node } from "libpg-query"
import {
  platformTriggers,
  withoutLocations,
  type SqlParser,
} from "simetra/compiler"
import {
  KIND_REGISTRY,
  quoteIdent,
  type CatalogColumn,
  type CatalogModel,
  type CatalogTable,
  type MetadataKind,
  type PhysicalSnapshot,
} from "simetra/model"
import type { EngineAction, EngineDiagnostic } from "../engine"
import { createdByPlan } from "./carrier-backfill"
import { applyDiagnostic } from "./diagnostic"
import { ApplyDbError, type ApplyTransaction } from "./port"
import {
  functionChangeRefusals,
  type DataTable,
  type WriteTable,
} from "./promotion/data"
import { withoutRowTextCasts } from "./promotion/replacements"
import { BACKFILL_SETTINGS, withLocalSettings } from "./settings"
import {
  backfillAction,
  notNullColumns,
  nullDatum,
  type NotNullColumn,
  type PlanAction,
  type PlanStep,
} from "./steps"
import { tableKey } from "./table-key"
import { stringsOf } from "./type-guard"

/**
 * Що план рахує на цілі перед кроком, що робить колонку `NOT NULL`
 * (платформна спека §6.2 п. 4, §6.6): `nulls` — рядки з `NULL` у колонці
 * `SET NOT NULL`, `rows` — усі рядки таблиці `ADD COLUMN … NOT NULL` без
 * default. Імена — ті, в яких діють дії двигуна.
 */
export interface BackfillTarget {
  table: { schema: string; name: string }
  column: string
  count: "nulls" | "rows"
}

/** Що план знає до підрахунку. */
export interface BackfillInput {
  actions: readonly EngineAction[]
  parse: SqlParser
  /** Модель, від якої двигун будував дії, — вихідний стан плану. */
  source: CatalogModel
  /** Модель бажаного стану (витяг бажаної тіні): default, generated, identity. */
  desired: CatalogModel
  /** Знімок компілятора бажаного стану: походження таблиць, default видів, копії носіїв. */
  physical: PhysicalSnapshot
  /** Об'єкти моделі: вид таблиці — за `origin.objectId`. */
  objects: readonly { id: string; kind: MetadataKind }[]
  /**
   * Промоція цього плану: `tables` — `tableKey` таблиць одиниці,
   * `dataColumns` — `columnKey` колонок, які пишуть її кроки даних.
   */
  promotion?: {
    tables: ReadonlySet<string>
    dataColumns: ReadonlySet<string>
  }
}

/** Структурний ключ колонки, за правилом `tableKey`. */
export const columnKey = (schema: string, table: string, column: string) =>
  JSON.stringify([schema, table, column])

const qualified = (t: { schema: string; name: string }): string =>
  `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`

function statements(action: EngineAction, parse: SqlParser): Node[] {
  const result = parse(action.sql)
  // Нерозібрану дію план уже відхилив (`plan.unparsable-step`) до цього кроку
  if (!result.ok)
    throw new Error(`engine action does not parse: ${result.message}`)
  return result.statements.map((s) => s.stmt)
}

/** Двигун кваліфікує все; голе ім'я шукається в усіх схемах, як у `steps.ts`. */
const findTable = (
  model: CatalogModel,
  schema: string | undefined,
  name: string
): CatalogTable | undefined =>
  model.tables.find(
    (t) => t.name === name && (schema === undefined || t.schema === schema)
  )

/** Колонка, що стає `NOT NULL`, на наявній таблиці вихідного стану. */
interface Site {
  /** Позиція дії з `NOT NULL` у списку двигуна. */
  index: number
  table: CatalogTable
  target: BackfillTarget
}

/**
 * Колонки, що стають `NOT NULL` на наявній таблиці. Не рахуються (Р5):
 * таблиця, яку план створює чи перестворює; колонка, якої немає в моделі
 * вихідного стану чи яку план перестворює; колонка, уже `NOT NULL`; колонка
 * кроку даних промоції — її `NULL` заповнює сам крок даних; `ADD COLUMN`,
 * що сам дає значення (default, identity, generated).
 */
function notNullSites(p: BackfillInput): Site[] {
  const created = createdByPlan(p.actions)
  const seen = new Set<string>()
  const out: Site[] = []
  p.actions.forEach((action, index) => {
    for (const at of notNullColumns(statements(action, p.parse))) {
      const table = findTable(p.source, at.schema, at.table)
      if (table === undefined) continue
      if (created.tables.has(tableKey(table.schema, table.name))) continue
      const key = columnKey(table.schema, table.name, at.column)
      if (seen.has(key)) continue
      const live = table.columns.find((c) => c.name === at.column)
      if (at.via === "setNotNull") {
        if (live === undefined || live.notNull) continue
        if (created.columns.has(key)) continue
        if (p.promotion?.dataColumns.has(key) === true) continue
      } else if (at.filled || live !== undefined) continue
      seen.add(key)
      out.push({
        index,
        table,
        target: {
          table: { schema: table.schema, name: table.name },
          column: at.column,
          count: at.via === "setNotNull" ? "nulls" : "rows",
        },
      })
    }
  })
  return out
}

/** Що план має порахувати на цілі до `planBackfills` (Р5). */
export function backfillTargets(p: BackfillInput): BackfillTarget[] {
  return notNullSites(p).map((s) => s.target)
}

/** Чи оператор — `ALTER TABLE` цієї таблиці. */
function alterOf(
  stmt: Node,
  table: { schema: string; name: string }
): readonly Node[] | undefined {
  if (!("AlterTableStmt" in stmt)) return undefined
  const { relation, cmds, objtype } = stmt.AlterTableStmt
  if (objtype !== "OBJECT_TABLE" || relation?.relname !== table.name)
    return undefined
  if (relation.schemaname !== undefined && relation.schemaname !== table.schema)
    return undefined
  return cmds ?? []
}

/** Підкоманди `ALTER TABLE` дії над колонкою. */
function columnCmds(
  stmts: readonly Node[],
  table: { schema: string; name: string },
  column: string
): { subtype: string; set: boolean }[] {
  return stmts.flatMap((stmt) =>
    (alterOf(stmt, table) ?? []).flatMap((node) => {
      if (!("AlterTableCmd" in node)) return []
      const { subtype, name, def } = node.AlterTableCmd
      const added =
        subtype === "AT_AddColumn" &&
        def !== undefined &&
        "ColumnDef" in def &&
        def.ColumnDef.colname === column
      return name === column || added
        ? [{ subtype: subtype ?? "", set: def !== undefined }]
        : []
    })
  )
}

/** Чи дія змінює default колонки (`SET DEFAULT` чи `DROP DEFAULT`). */
const changesDefault = (cmds: readonly { subtype: string }[]): boolean =>
  cmds.some((c) => c.subtype === "AT_ColumnDefault")

/**
 * Чи дія чіпає колонку: підкоманда `ALTER TABLE` над нею чи структурна
 * ідентичність колонки серед створених, знятих чи вжитих об'єктів.
 */
function touches(
  action: EngineAction,
  stmts: readonly Node[],
  table: { schema: string; name: string },
  column: string
): boolean {
  if (columnCmds(stmts, table, column).length > 0) return true
  return [...action.produced, ...action.destroyed, ...action.consumed].some(
    (ref) =>
      ref.kind === "column" &&
      ref.schema === table.schema &&
      ref.table === table.name &&
      ref.name === column
  )
}

/** Колонка, яку план заповнює. */
interface Fill {
  table: { schema: string; name: string }
  column: string
}

const isSetNotNull = (stmts: readonly Node[], fill: Fill): boolean =>
  notNullColumns(stmts).some(
    (n: NotNullColumn) =>
      n.via === "setNotNull" &&
      n.column === fill.column &&
      n.table === fill.table.name &&
      (n.schema === undefined || n.schema === fill.table.schema)
  )

/**
 * Перестановка пари дій однієї колонки (платформна спека §6.6): двигун
 * ставить `SET DEFAULT` після `SET NOT NULL`, а заповнення мусить бачити
 * бажаний default. Дія `SET DEFAULT` переходить безпосередньо перед
 * `SET NOT NULL`, лише коли вона нічого іншого не робить, сама дія
 * `NOT NULL` іншого над колонкою не робить, між ними немає жодної дії над
 * колонкою (насамперед зміни типу: default типізований) і жодна з них не
 * створює того, що вживає `SET DEFAULT`. Інакше порядок лишається, і
 * перевірка порядку відмовляє.
 */
export function defaultsBeforeNotNull(
  actions: readonly EngineAction[],
  fills: readonly Fill[],
  parse: SqlParser
): EngineAction[] {
  const out = [...actions]
  for (const fill of fills) {
    const parsed = out.map((a) => statements(a, parse))
    const n = parsed.findIndex((stmts) => isSetNotNull(stmts, fill))
    if (n < 0) continue
    const d = parsed.findIndex(
      (stmts, i) =>
        i > n && changesDefault(columnCmds(stmts, fill.table, fill.column))
    )
    if (d < 0) continue
    const own = columnCmds(parsed[n]!, fill.table, fill.column)
    const moved = parsed[d]!
    const pure =
      moved.length > 0 &&
      moved.every((stmt) => {
        const cmds = alterOf(stmt, fill.table)
        return (
          cmds !== undefined &&
          cmds.length > 0 &&
          cmds.every(
            (node) =>
              "AlterTableCmd" in node &&
              node.AlterTableCmd.subtype === "AT_ColumnDefault" &&
              node.AlterTableCmd.name === fill.column &&
              node.AlterTableCmd.def !== undefined
          )
        )
      })
    const between = out.slice(n + 1, d)
    const needs = new Set(out[d]!.consumes)
    const clear =
      own.every((c) => c.subtype === "AT_SetNotNull") &&
      between.every(
        (a, i) =>
          !touches(a, parsed[n + 1 + i]!, fill.table, fill.column) &&
          !a.produces.some((id) => needs.has(id))
      )
    if (!pure || !clear) continue
    const [setDefault] = out.splice(d, 1)
    out.splice(n, 0, setDefault!)
  }
  return out
}

/**
 * Чи default бажаної колонки діє на момент кроку заповнення (Р2): кожна
 * зміна default колонки стоїть до дії `SET NOT NULL`, і остання з них його
 * ставить, а не знімає; без таких змін живий default дорівнює бажаному.
 */
function defaultInPlace(
  parsed: readonly Node[][],
  n: number,
  fill: Fill,
  live: CatalogColumn,
  desired: string
): boolean {
  const changes = parsed.flatMap((stmts, i) =>
    columnCmds(stmts, fill.table, fill.column)
      .filter((c) => c.subtype === "AT_ColumnDefault")
      .map((c) => ({ i, set: c.set }))
  )
  if (changes.some((c) => c.i >= n)) return false
  const last = changes.at(-1)
  return last === undefined ? live.default === desired : last.set
}

/** `gen_random_uuid()` — default `newUuid`: кожен рядок отримує своє значення. */
function isNewUuid(expression: string, parse: SqlParser): boolean {
  const result = parse(`SELECT ${expression}`)
  if (!result.ok) return false
  const stmt = result.statements[0]?.stmt
  if (stmt === undefined || !("SelectStmt" in stmt)) return false
  const targets = stmt.SelectStmt.targetList ?? []
  const value =
    targets.length === 1 && "ResTarget" in targets[0]!
      ? targets[0].ResTarget.val
      : undefined
  if (value === undefined || !("FuncCall" in value)) return false
  const names = (value.FuncCall.funcname ?? []).flatMap((n) =>
    "String" in n && n.String.sval !== undefined ? [n.String.sval] : []
  )
  return (
    (value.FuncCall.args ?? []).length === 0 &&
    names.at(-1) === "gen_random_uuid" &&
    (names.length === 1 || names[0] === "pg_catalog")
  )
}

/** Імена колонок усіх `ColumnRef` дерева: останнє поле посилання. */
function columnRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) columnRefs(n, out)
  else if (node !== null && typeof node === "object") {
    if ("ColumnRef" in node) {
      const name = stringsOf(
        (node as { ColumnRef: { fields?: Node[] } }).ColumnRef.fields
      ).at(-1)
      if (name !== undefined) out.push(name)
    }
    for (const v of Object.values(node)) columnRefs(v, out)
  }
  return out
}

/**
 * Чи вираз моделі (ключ чи предикат індексу) посилається на колонку — з
 * дерева розбору, а не з тексту. Нерозбірний вираз вважається таким, що
 * посилається: відмова плану краща за `23505` на кроці.
 */
function mentions(expression: string, column: string, parse: SqlParser) {
  const result = parse(`SELECT ${expression}`)
  return !result.ok || columnRefs(result.statements).includes(column)
}

/**
 * Чи колонку покриває унікальний ключ чи унікальний індекс таблиці: простий
 * ключ, вираз ключа над колонкою (`lower(c)`) чи предикат індексу, що на неї
 * посилається, — заповнення змінює і значення ключа, і те, які рядки
 * індекс охоплює.
 */
const isUnique = (
  table: CatalogTable | undefined,
  column: string,
  parse: SqlParser
): boolean =>
  table !== undefined &&
  // Первинний ключ — окреме поле каталогу, не елемент `uniques`
  (table.primaryKey?.columns.includes(column) === true ||
    table.uniques.some((u) => u.columns.includes(column)) ||
    table.indexes.some(
      (i) =>
        i.unique &&
        (i.keys.some((k) =>
          "column" in k
            ? k.column === column
            : mentions(k.expression, column, parse)
        ) ||
          (i.where !== undefined && mentions(i.where, column, parse)))
    ))

/**
 * Копія носія прав, що читає колонку (межа заповнення, спека промоції §4):
 * скопійована колонка-джерело чи колонка зв'язку `through`.
 */
function carrierReader(
  physical: PhysicalSnapshot,
  fill: Fill
): string | undefined {
  for (const t of physical.tables)
    for (const c of t.columns) {
      const copy = c.origin.copyOf
      if (copy === undefined) continue
      const source =
        copy.table.schema === fill.table.schema &&
        copy.table.name === fill.table.name &&
        copy.column === fill.column
      const through =
        t.schema === fill.table.schema &&
        t.name === fill.table.name &&
        copy.through === fill.column
      if (source || through) return `${qualified(t)}.${quoteIdent(c.name)}`
    }
  return undefined
}

/**
 * Default як дерево без приведень сталих і з одним записом значення сталої
 * (`undefined` — не розбирається). Знімок компілятора пише `''`, а каталог —
 * `''::text`; `-1` каталог друкує як `'-1'::integer`. Приведення сталої
 * знімається, бо обидва default належать одній колонці: тип сталої дає
 * тип колонки. Решта дерева — як є, тож інший вираз лишається іншим.
 */
function defaultTree(expression: string, parse: SqlParser): string | undefined {
  const result = parse(`SELECT ${expression}`)
  if (!result.ok || result.statements.length !== 1) return undefined
  const constant = (c: Record<string, unknown>): unknown => {
    if (c.isnull === true) return { null: true }
    const ival = c.ival as { ival?: number } | undefined
    if (ival !== undefined) return { value: String(ival.ival ?? 0) }
    const fval = c.fval as { fval?: string } | undefined
    if (fval !== undefined) return { value: fval.fval ?? "" }
    const sval = c.sval as { sval?: string } | undefined
    if (sval !== undefined) return { value: sval.sval ?? "" }
    const boolval = c.boolval as { boolval?: boolean } | undefined
    if (boolval !== undefined)
      return { value: String(boolval.boolval ?? false) }
    return c
  }
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip)
    if (node === null || typeof node !== "object") return node
    const n = node as Record<string, unknown>
    const cast = n.TypeCast as { arg?: Record<string, unknown> } | undefined
    if (cast?.arg !== undefined && "A_Const" in cast.arg) return strip(cast.arg)
    if ("A_Const" in n)
      return { A_Const: constant(n.A_Const as Record<string, unknown>) }
    return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, strip(v)]))
  }
  return JSON.stringify(strip(withoutLocations(result.statements[0]!.stmt)))
}

/**
 * Чи default бажаної колонки — той самий вираз, що default знімка
 * компілятора (Р3): канонічна форма `defaultTree` з обох боків, бо витяг
 * друкує default у формі каталогу, а знімок — у формі компілятора.
 */
export function sameDefault(
  snapshot: string | undefined,
  desired: string,
  parse: SqlParser
): boolean {
  if (snapshot === undefined) return false
  const a = defaultTree(snapshot, parse)
  return a !== undefined && a === defaultTree(desired, parse)
}

/**
 * Чи заповнення потребує дозволу (Р3): прийнята таблиця — поза таблицями
 * знімка (SQL-модуль), невідомого походження чи виду з фактом реєстру
 * «дані споживача»; таблиця виду, чий бажаний default розходиться з default
 * знімка компілятора, — теж, бо такий default не з закритої граматики.
 */
function needsPermission(
  p: BackfillInput,
  fill: Fill,
  desired: string
): boolean {
  const table = p.physical.tables.find(
    (t) => t.schema === fill.table.schema && t.name === fill.table.name
  )
  if (table === undefined) return true
  const kind = p.objects.find((o) => o.id === table.origin.objectId)?.kind
  if (kind === undefined || KIND_REGISTRY[kind].consumerData === true)
    return true
  return !sameDefault(
    table.columns.find((c) => c.name === fill.column)?.default,
    desired,
    p.parse
  )
}

const refusal = (
  code:
    | "plan.not-null-violation"
    | "plan.backfill-order"
    | "plan.backfill-unique"
    | "plan.backfill-carrier-source",
  params: Record<string, string | number>
): EngineDiagnostic => applyDiagnostic(code, "error", params)

/**
 * Кроки заповнення перед `NOT NULL` (платформна спека §6.6) — на рівні дій
 * двигуна, до `classifySteps`: id, сторожі й позиційні правила тоді
 * рахуються від остаточного списку. `rows` — кількість, яку план прочитав
 * для кожної цілі `backfillTargets`. `NULL` немає — дія лишається як є;
 * `NULL` є — відмова (Р6, Р9, межі) або синтетична дія заповнення
 * безпосередньо перед дією `SET NOT NULL`, з парою `SET DEFAULT` /
 * `SET NOT NULL`, переставленою за потреби (`defaultsBeforeNotNull`).
 */
export function planBackfills(
  p: BackfillInput & {
    rows: (target: BackfillTarget) => number
    /** Колонка під живим обмеженням `EXCLUDE` (`readBackfillCounts`). */
    excluded?: (target: BackfillTarget) => boolean
  }
): { actions: PlanAction[]; refusals: EngineDiagnostic[] } {
  const refusals: EngineDiagnostic[] = []
  const fills: (Fill & {
    rows: number
    default: string
    live: CatalogColumn
  })[] = []
  for (const site of notNullSites(p)) {
    const { target } = site
    const rows = p.rows(target)
    if (!Number.isInteger(rows) || rows < 0)
      throw new Error(`no row count for ${qualified(target.table)}`)
    if (rows === 0) continue
    const params = {
      table: qualified(target.table),
      column: quoteIdent(target.column),
      rows,
    }
    if (target.count === "rows") {
      refusals.push(
        refusal("plan.not-null-violation", { ...params, detail: "addColumn" })
      )
      continue
    }
    // Таблицю одиниці звіряє доказ збереження: заповнення дало б
    // `apply.preservation-failed`, тож це межа (Р3)
    if (
      p.promotion?.tables.has(
        tableKey(target.table.schema, target.table.name)
      ) === true
    ) {
      refusals.push(
        refusal("plan.not-null-violation", { ...params, detail: "promotion" })
      )
      continue
    }
    const desired = findTable(
      p.desired,
      target.table.schema,
      target.table.name
    )?.columns.find((c) => c.name === target.column)
    if (
      desired?.default === undefined ||
      desired.generated !== undefined ||
      desired.identity !== undefined
    ) {
      refusals.push(refusal("plan.not-null-violation", params))
      continue
    }
    const copy = carrierReader(p.physical, target)
    if (copy !== undefined) {
      refusals.push(
        refusal("plan.backfill-carrier-source", {
          table: params.table,
          column: params.column,
          copy,
        })
      )
      continue
    }
    if (
      rows > 1 &&
      (isUnique(site.table, target.column, p.parse) ||
        isUnique(
          findTable(p.desired, target.table.schema, target.table.name),
          target.column,
          p.parse
        ) ||
        p.excluded?.(target) === true) &&
      !isNewUuid(desired.default, p.parse)
    ) {
      refusals.push(refusal("plan.backfill-unique", params))
      continue
    }
    const live = site.table.columns.find((c) => c.name === target.column)!
    fills.push({ ...target, rows, default: desired.default, live })
  }

  const ordered = defaultsBeforeNotNull(p.actions, fills, p.parse)
  const parsed = ordered.map((a) => statements(a, p.parse))
  const before = new Map<number, PlanAction[]>()
  for (const fill of fills) {
    const n = parsed.findIndex((stmts) => isSetNotNull(stmts, fill))
    if (n < 0 || !defaultInPlace(parsed, n, fill, fill.live, fill.default)) {
      refusals.push(
        refusal("plan.backfill-order", {
          table: qualified(fill.table),
          column: quoteIdent(fill.column),
        })
      )
      continue
    }
    before.set(n, [
      ...(before.get(n) ?? []),
      backfillAction({
        table: fill.table,
        column: fill.column,
        rowsAtPlan: fill.rows,
        permission: needsPermission(p, fill, fill.default),
        default: fill.default,
        // Показаний перелік рахує `withShownTriggers` за остаточним списком
        // кроків: йому потрібні живі тригери й кроки до заповнення
        triggers: [],
      }),
    ])
  }
  return {
    actions: ordered.flatMap((a, i) => [...(before.get(i) ?? []), a]),
    refusals,
  }
}

/**
 * Тригери, які знімає `DROP TRIGGER` кроку, — за деревом оператора, як
 * класи кроків у `steps.ts`: `[схема?, таблиця, тригер]`.
 */
function droppedTriggers(
  step: PlanStep,
  parse: SqlParser
): { schema?: string; table: string; name: string }[] {
  const result = parse(step.sql)
  if (!result.ok)
    throw new Error(`plan step ${step.id} does not parse: ${result.message}`)
  return result.statements.flatMap(({ stmt }) => {
    if (!("DropStmt" in stmt)) return []
    const { removeType, objects } = stmt.DropStmt
    if (removeType !== "OBJECT_TRIGGER") return []
    return (objects ?? []).flatMap((object) => {
      const names = "List" in object ? stringsOf(object.List.items) : []
      const [name, table, schema] = [names.at(-1), names.at(-2), names.at(-3)]
      return name === undefined || table === undefined
        ? []
        : [{ schema, table, name }]
    })
  })
}

/**
 * Запобіжник прав, який знімає крок до заповнення (платформна спека §6.6,
 * спека промоції §7.2): ці тригери не лише перевіряють запис, а й ведуть
 * версію прав. Заповнення без тригера лишило б знімок прав клієнтів
 * старим, коли колонка входить в обчислення прав, і цього не було б
 * видно. Родина — з реєстру `platformTriggers()`, не з імені.
 */
function rightsGuardRefusals(
  steps: readonly PlanStep[],
  parse: SqlParser
): EngineDiagnostic[] {
  return steps.flatMap((step, index) => {
    if (step.backfill === undefined) return []
    const { table, column } = step.backfill
    const guards = new Set(
      platformTriggers(table)
        .filter((t) => t.family === "rightsGuards")
        .map((t) => t.trigger)
    )
    return steps.slice(0, index).flatMap((by) =>
      droppedTriggers(by, parse)
        .filter(
          (d) =>
            d.table === table.name &&
            (d.schema === undefined || d.schema === table.schema) &&
            guards.has(d.name)
        )
        .map((d) =>
          applyDiagnostic("plan.backfill-rights-guard", "error", {
            table: qualified(table),
            column: quoteIdent(column),
            step: step.id,
            by: by.id,
            trigger: quoteIdent(d.name),
          })
        )
    )
  })
}

/**
 * Відмови кроків заповнення за кроками плану (Р13): default, що кличе
 * функцію моделі, яку змінює крок плану, — заповнення порахувало б інше
 * тіло; запобіжник прав таблиці, який знімає крок до заповнення. Тип
 * запису не перевіряється: тимчасової таблиці немає.
 */
export function backfillStepRefusals(
  steps: readonly PlanStep[],
  parse: SqlParser
): EngineDiagnostic[] {
  return [
    ...steps.flatMap((s) =>
      s.backfill === undefined
        ? []
        : functionChangeRefusals(
            s.id,
            s.backfill.default,
            steps,
            parse,
            "backfill"
          )
    ),
    ...rightsGuardRefusals(steps, parse),
  ]
}

/**
 * Кроки заповнення як таблиці запису для спільних фактів (Р13): по таблиці
 * на крок, колонка відмови й колонка вхідного FK — колонка кроку. Імена —
 * імена кроку; план із промоцією перекладає їх у вихідні до читання.
 */
export function backfillWriteTables(steps: readonly PlanStep[]): WriteTable[] {
  return steps.flatMap((s) =>
    s.backfill === undefined
      ? []
      : [
          {
            before: {
              schema: s.backfill.table.schema,
              table: s.backfill.table.name,
            },
            step: s.id,
            columns: [
              {
                step: s.id,
                column: s.backfill.column,
                source: s.backfill.column,
              },
            ],
          },
        ]
  )
}

const EXCLUDED_SQL = `
select distinct x.i
from pg_catalog.json_to_recordset($1::pg_catalog.json)
  as x(i int, schema text, "table" text, "column" text)
join pg_catalog.pg_namespace n on n.nspname = x.schema
join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = x."table"
join pg_catalog.pg_attribute a
  on a.attrelid = c.oid and a.attname = x."column" and not a.attisdropped
join pg_catalog.pg_constraint k on k.conrelid = c.oid and k.contype = 'x'
join pg_catalog.pg_depend d
  on d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
 and d.refobjid = c.oid and d.refobjsubid = a.attnum
 and ((d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass and d.objid = k.oid)
   or (d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass and d.objid = k.conindid))
`

/** Що план прочитав на цілі для `planBackfills`; ключ — `columnKey` імен цілі. */
export interface BackfillCounts {
  rows: Map<string, number>
  /** Колонки під обмеженням `EXCLUDE`: модель каталогу його не несе. */
  excluded: Set<string>
}

/** Ключ цілі заповнення: колонка й вид підрахунку. */
export const backfillTargetKey = (t: BackfillTarget): string =>
  JSON.stringify([t.table.schema, t.table.name, t.column, t.count])

/**
 * Кількості цілей `backfillTargets` на цілі (платформна спека §6.2 п. 4):
 * `count(*)` рядків з `NULL` чи всіх рядків таблиці під
 * `BACKFILL_SETTINGS` — роль бачить усі рядки або дає гучне `42501`, а не
 * неправдивий нуль. Обмеження `EXCLUDE` на колонці — тією самою
 * транзакцією, структурно за залежностями `pg_depend` обмеження й його
 * індексу: модель каталогу його не несе (`engine.unrepresentable`). Цілі —
 * в іменах цілі; викликач відкриває транзакцію `READ ONLY` з відкатом.
 * Збій підрахунку — відмова `plan.backfill-count-failed` з SQLSTATE.
 */
export async function readBackfillCounts(
  tx: ApplyTransaction,
  targets: readonly BackfillTarget[]
): Promise<{ counts: BackfillCounts } | { refusal: EngineDiagnostic }> {
  const nulls = targets.filter((t) => t.count === "nulls")
  const excluded = new Set(
    nulls.length === 0
      ? []
      : (
          await tx.query<{ i: number }>(EXCLUDED_SQL, [
            JSON.stringify(
              nulls.map((t, i) => ({
                i,
                schema: t.table.schema,
                table: t.table.name,
                column: t.column,
              }))
            ),
          ])
        ).map((r) => backfillTargetKey(nulls[r.i]!))
  )
  let current: BackfillTarget | undefined
  try {
    const rows = await withLocalSettings(tx, BACKFILL_SETTINGS, async () => {
      const out = new Map<string, number>()
      for (const t of targets) {
        current = t
        const column = quoteIdent(t.column)
        const [row] = await tx.query<{ n: string | number }>(
          `SELECT pg_catalog.count(*) AS n FROM ${qualified(t.table)}${
            t.count === "nulls" ? ` WHERE ${nullDatum(column)}` : ""
          }`
        )
        if (row === undefined) throw new Error("count(*) returned no row")
        out.set(backfillTargetKey(t), Number(row.n))
      }
      current = undefined
      return out
    })
    return { counts: { rows, excluded } }
  } catch (error) {
    // Транзакцію після збою вже не продовжити, тож відмова — одна, за
    // ціллю, на якій впав підрахунок
    if (!(error instanceof ApplyDbError) || current === undefined) throw error
    return {
      refusal: applyDiagnostic("plan.backfill-count-failed", "error", {
        table: qualified(current.table),
        column: quoteIdent(current.column),
        sqlstate: error.sqlstate ?? "unknown",
        error: error.message,
      }),
    }
  }
}

/** Дерево `CREATE TRIGGER` з тексту каталогу без позицій і `::text` умови. */
function triggerTree(sql: string, parse: SqlParser): Node | undefined {
  const result = parse(sql)
  if (!result.ok || result.statements.length !== 1) return undefined
  const stmt = withoutLocations(result.statements[0]!.stmt) as Node
  return "CreateTrigStmt" in stmt ? withoutRowTextCasts(stmt) : undefined
}

const triggerIdentity = (
  table: { schema: string; name: string },
  name: string
): string => `trigger:${table.schema}.${table.name}.${name}`

/**
 * Чи тригер таблиці — платформний за визначенням (платформна спека §6.6):
 * його ім'я є в реєстрі `platformTriggers()` таблиці, бажаний тригер з цим
 * іменем кличе функцію реєстру, а живе визначення (`pg_get_triggerdef`, з
 * моделі каталогу) дорівнює бажаному деревом. Тригер з платформним іменем,
 * але іншим визначенням чи функцією — тригер користувача. `live` немає —
 * тригер створює крок плану, тож визначення бажане за побудовою. `desired`
 * — модель бажаного стану в іменах `table`.
 */
export function isPlatformTrigger(p: {
  table: { schema: string; name: string }
  name: string
  live?: string
  desired: CatalogModel
  parse: SqlParser
}): boolean {
  const entry = platformTriggers(p.table).find((t) => t.trigger === p.name)
  if (entry === undefined) return false
  const unit = p.desired.units.find(
    (u) =>
      u.class === "trigger" && u.identity === triggerIdentity(p.table, p.name)
  )
  const wanted = unit === undefined ? undefined : triggerTree(unit.sql, p.parse)
  if (wanted === undefined || !("CreateTrigStmt" in wanted)) return false
  const fn = stringsOf(wanted.CreateTrigStmt.funcname)
  if (fn.length !== 2 || fn[0] !== entry.function.schema) return false
  if (fn[1] !== entry.function.name) return false
  if (p.live === undefined) return true
  const live = triggerTree(p.live, p.parse)
  return live !== undefined && JSON.stringify(live) === JSON.stringify(wanted)
}

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/**
 * Показаний перелік тригерів кожного кроку заповнення (платформна спека
 * §6.6): тригери користувача таблиці в живій цілі на плані (`user` —
 * `readUserTriggers` за ім'ям цілі) разом із тими, що створюють кроки до
 * заповнення, без платформних за визначенням. Створений кроком тригер —
 * режиму `O`, як після `CREATE TRIGGER`. `liveName` — ім'я таблиці на
 * цілі, коли воно інше за ім'я кроку.
 */
export function withShownTriggers(
  steps: readonly PlanStep[],
  p: {
    user: (table: { schema: string; name: string }) => DataTable["triggers"]
    /** Модель живої цілі: визначення живих тригерів. */
    live: CatalogModel
    /** Модель бажаного стану в іменах кроків. */
    desired: CatalogModel
    parse: SqlParser
    liveName?: (t: { schema: string; name: string }) => {
      schema: string
      name: string
    }
  }
): PlanStep[] {
  const liveName = p.liveName ?? ((t) => t)
  return steps.map((step, index) => {
    if (step.backfill === undefined) return step
    const { table } = step.backfill
    const onTarget = liveName(table)
    const platform = (name: string, live?: string) =>
      isPlatformTrigger({
        table,
        name,
        live,
        desired: p.desired,
        parse: p.parse,
      })
    const shown = new Map<string, DataTable["triggers"][number]>()
    for (const t of p.user(onTarget)) {
      const def = p.live.units.find(
        (u) =>
          u.class === "trigger" &&
          u.identity === triggerIdentity(onTarget, t.name)
      )?.sql
      // Живий тригер без визначення в моделі — тригер користувача: вимкнути
      // показаний тригер безпечніше, ніж мовчки лишити чужий
      if (def === undefined || !platform(t.name, def)) shown.set(t.name, t)
    }
    for (const s of steps.slice(0, index))
      for (const r of s.produced)
        if (
          r.kind === "trigger" &&
          r.schema === table.schema &&
          r.table === table.name &&
          !shown.has(r.name) &&
          !platform(r.name)
        )
          shown.set(r.name, { name: r.name, enabled: "O" })
    return {
      ...step,
      backfill: {
        ...step.backfill,
        triggers: [...shown.values()].sort((a, b) =>
          byCodeUnit(a.name, b.name)
        ),
      },
    }
  })
}

/**
 * Поле `notNull` кроків двигуна з `SET NOT NULL` без заповнення перед ними
 * (платформна спека §6.6): `NULL` могли з'явитися після плану, зокрема від
 * `USING` зміни типу в тому самому плані. Колонка з кроком заповнення
 * безпосередньо перед кроком перевірки не має: заповнення в тій самій
 * транзакції під `ACCESS EXCLUSIVE` закриває вікно. Схему таблиці без
 * кваліфікації дає `lockedTables` кроку.
 */
export function withNotNullChecks(
  steps: readonly PlanStep[],
  parse: SqlParser
): PlanStep[] {
  return steps.map((step, index) => {
    if (step.origin !== "engine") return step
    const result = parse(step.sql)
    if (!result.ok)
      throw new Error(`plan step ${step.id} does not parse: ${result.message}`)
    const filled: Fill[] = []
    for (let i = index - 1; i >= 0 && steps[i]!.backfill !== undefined; i--)
      filled.push(steps[i]!.backfill!)
    const columns = notNullColumns(result.statements.map((s) => s.stmt))
      .filter((c) => c.via === "setNotNull")
      .map((c) => {
        const schema =
          c.schema ?? step.lockedTables.find((t) => t.name === c.table)?.schema
        if (schema === undefined)
          throw new Error(`plan step ${step.id}: no schema for ${c.table}`)
        return { table: { schema, name: c.table }, column: c.column }
      })
      .filter(
        (c) =>
          !filled.some(
            (f) =>
              f.column === c.column &&
              f.table.schema === c.table.schema &&
              f.table.name === c.table.name
          )
      )
    return columns.length === 0 ? step : { ...step, notNull: columns }
  })
}

/** Тригер таблиці на цілі перед кроком заповнення: внутрішні FK — поза ним. */
export interface LiveTrigger {
  name: string
  /** `tgenabled`: `O`, `A`, `R` чи `D`. */
  enabled: string
  /** `pg_get_triggerdef` під `search_path = pg_catalog`, як у витягу двигуна. */
  definition: string
}

const LIVE_TRIGGERS_SQL = `
select t.tgname::text as name, t.tgenabled::text as enabled,
  pg_catalog.pg_get_triggerdef(t.oid) as definition
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 and c.relname = $2 and not t.tgisinternal
`

/**
 * Не внутрішні тригери таблиці кроку заповнення (платформна спека §6.6) —
 * у транзакції застосування під уже взятим замком. Визначення — під
 * `search_path = pg_catalog`: двигун витягує їх так само, і лише тоді
 * функція тригера кваліфікована схемою, як у бажаній моделі, з якою
 * `isPlatformTrigger` порівнює дерево. Під шляхом сесії функція зі схеми
 * шляху друкувалася б без схеми, і платформний тригер став би тригером
 * користувача.
 */
export async function readLiveTriggers(
  tx: ApplyTransaction,
  table: { schema: string; name: string }
): Promise<LiveTrigger[]> {
  const rows = await withLocalSettings(
    tx,
    [{ name: "search_path", value: "pg_catalog" }],
    () =>
      tx.query<{ name: string; enabled: string; definition: string }>(
        LIVE_TRIGGERS_SQL,
        [table.schema, table.name]
      )
  )
  return rows.map((r) => ({ ...r })).sort((a, b) => byCodeUnit(a.name, b.name))
}

const firing = (t: LiveTrigger): t is LiveTrigger & { enabled: "O" | "A" } =>
  t.enabled === "O" || t.enabled === "A"

/**
 * Тригери, які вимикає крок заповнення (платформна спека §6.6, спека
 * промоції §7.2): живі ввімкнені тригери таблиці без платформних за
 * визначенням. Відмова, коли серед них є тригер поза показаним переліком
 * кроку (`unshown`): мовчки не вимикається жоден тригер, якого не показали.
 * Відмова й тоді, коли платформний тригер бажаного реєстру не живий чи не
 * ввімкнений (`platform`): вимкнений тригер носіїв чи сторож прав пропустив
 * би заповнення. Тригер, який створює пізніший крок (`later`), не
 * перевіряється: на час заповнення його ще немає. `desired` — бажана модель
 * в іменах кроку.
 */
export function backfillTriggers(p: {
  step: PlanStep
  live: readonly LiveTrigger[]
  later: readonly PlanStep[]
  desired: CatalogModel
  parse: SqlParser
}):
  | { ok: true; disable: DataTable["triggers"] }
  | { ok: false; reason: "unshown" | "platform"; triggers: string[] } {
  const facts = p.step.backfill
  if (facts === undefined)
    throw new Error(`plan step ${p.step.id} is not a backfill step`)
  const { table } = facts
  const platform = (name: string, live?: string) =>
    isPlatformTrigger({ table, name, live, desired: p.desired, parse: p.parse })
  const disable = p.live
    .filter(firing)
    .filter((t) => !platform(t.name, t.definition))
    .map((t) => ({ name: t.name, enabled: t.enabled }))
  const shown = new Set(facts.triggers.map((t) => t.name))
  const unshown = disable.filter((t) => !shown.has(t.name)).map((t) => t.name)
  if (unshown.length > 0)
    return { ok: false, reason: "unshown", triggers: unshown }
  const later = new Set(
    p.later.flatMap((s) =>
      s.produced
        .filter(
          (r) =>
            r.kind === "trigger" &&
            r.schema === table.schema &&
            r.table === table.name
        )
        .map((r) => r.name)
    )
  )
  const missing = platformTriggers(table)
    .map((e) => e.trigger)
    .filter((name) => !later.has(name) && platform(name))
    .filter(
      (name) =>
        !p.live.some(
          (t) => t.name === name && firing(t) && platform(t.name, t.definition)
        )
    )
  if (missing.length > 0)
    return { ok: false, reason: "platform", triggers: missing }
  return { ok: true, disable }
}
