import type { Node } from "libpg-query"
import type { SqlParser } from "simetra/compiler"
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
import { functionChangeRefusals, type WriteTable } from "./promotion/data"
import {
  backfillAction,
  notNullColumns,
  type NotNullColumn,
  type PlanAction,
  type PlanStep,
} from "./steps"
import { tableKey } from "./table-key"

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

/** Чи колонку покриває унікальний ключ чи унікальний індекс таблиці. */
const isUnique = (table: CatalogTable | undefined, column: string): boolean =>
  table !== undefined &&
  (table.uniques.some((u) => u.columns.includes(column)) ||
    table.indexes.some(
      (i) =>
        i.unique && i.keys.some((k) => "column" in k && k.column === column)
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
  return table.columns.find((c) => c.name === fill.column)?.default !== desired
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
  p: BackfillInput & { rows: (target: BackfillTarget) => number }
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
      (isUnique(site.table, target.column) ||
        isUnique(
          findTable(p.desired, target.table.schema, target.table.name),
          target.column
        )) &&
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
      }),
    ])
  }
  return {
    actions: ordered.flatMap((a, i) => [...(before.get(i) ?? []), a]),
    refusals,
  }
}

/**
 * Відмови кроків заповнення за кроками плану (Р13): default, що кличе
 * функцію моделі, яку змінює крок плану, — заповнення порахувало б інше
 * тіло. Тип запису не перевіряється: тимчасової таблиці немає.
 */
export function backfillStepRefusals(
  steps: readonly PlanStep[],
  parse: SqlParser
): EngineDiagnostic[] {
  return steps.flatMap((s) =>
    s.backfill === undefined
      ? []
      : functionChangeRefusals(
          s.id,
          s.backfill.default,
          steps,
          parse,
          "backfill"
        )
  )
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
