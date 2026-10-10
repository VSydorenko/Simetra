import type { CompiledModel } from "../../compile"
import type { SqlParser } from "../../sql/parse"
import type { PromoteInput } from "../inputs"
import type { PromotionRecord } from "./record"

type FillStep = PromoteInput["fill"][number]
type StepKind = PromotionRecord["dataSteps"][number]["kind"]

/** Причина, з якої вираз `fill` не стає кроком даних (рішення 12). */
export type FillProblem =
  | "noKey"
  | "syntax"
  | "subquery"
  | "aggregate"
  | "foreignTable"
  | "multipleTargets"
  | "multipleStatements"
  | "setReturning"
  | "volatile"
  | "nondeterministicWindow"
  | "unknownColumn"

/** Ключ цілі кроку в множині змаплених цілей: `"<to> <name>"`. */
export const fillTargetKey = (target: FillStep["target"]) =>
  `${target.to} ${target.name}`

/**
 * Волатильні функції каталогу (рішення 12): крок виконується один раз над
 * наявними рядками, і повтор плану мусить дати ті самі дані.
 */
const VOLATILE_FUNCTIONS: ReadonlySet<string> = new Set([
  "random",
  "random_normal",
  "gen_random_uuid",
  "uuid_generate_v4",
  "clock_timestamp",
  "timeofday",
  "nextval",
  "setval",
])

/**
 * Час транзакції: стабільний у межах кроку, тож дозаповнення нової колонки
 * ним допустиме, а ремонт наявних даних — ні: він мусить бути
 * детермінованим (рішення 15).
 */
const NOW_FUNCTIONS: ReadonlySet<string> = new Set([
  "now",
  "transaction_timestamp",
  "statement_timestamp",
])

/**
 * Ключові слова часу (`current_timestamp`, `localtimestamp`, …) парсер дає
 * окремим вузлом; `current_time` і `localtime` — той самий час транзакції.
 */
const NOW_VALUE_FUNCTIONS: ReadonlySet<string> = new Set([
  "SVFOP_CURRENT_DATE",
  "SVFOP_CURRENT_TIME",
  "SVFOP_CURRENT_TIME_N",
  "SVFOP_CURRENT_TIMESTAMP",
  "SVFOP_CURRENT_TIMESTAMP_N",
  "SVFOP_LOCALTIME",
  "SVFOP_LOCALTIME_N",
  "SVFOP_LOCALTIMESTAMP",
  "SVFOP_LOCALTIMESTAMP_N",
])

/**
 * Агрегати каталогу. Агрегат без `OVER` згортає таблицю в один рядок, а крок
 * задає значення кожного рядка; з `OVER` він — віконна функція.
 */
const AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  "any_value",
  "array_agg",
  "avg",
  "bit_and",
  "bit_or",
  "bit_xor",
  "bool_and",
  "bool_or",
  "corr",
  "count",
  "covar_pop",
  "covar_samp",
  "every",
  "json_agg",
  "json_agg_strict",
  "json_object_agg",
  "json_object_agg_strict",
  "json_object_agg_unique",
  "json_object_agg_unique_strict",
  "jsonb_agg",
  "jsonb_agg_strict",
  "jsonb_object_agg",
  "jsonb_object_agg_strict",
  "jsonb_object_agg_unique",
  "jsonb_object_agg_unique_strict",
  "max",
  "min",
  "mode",
  "percentile_cont",
  "percentile_disc",
  "range_agg",
  "range_intersect_agg",
  "regr_avgx",
  "regr_avgy",
  "regr_count",
  "regr_intercept",
  "regr_r2",
  "regr_slope",
  "regr_sxx",
  "regr_sxy",
  "regr_syy",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "string_agg",
  "sum",
  "var_pop",
  "var_samp",
  "variance",
  "xmlagg",
])

/** Функції, що існують лише з `OVER`: без нього Postgres їх відхиляє. */
const WINDOW_FUNCTIONS: ReadonlySet<string> = new Set([
  "cume_dist",
  "dense_rank",
  "first_value",
  "lag",
  "last_value",
  "lead",
  "nth_value",
  "ntile",
  "percent_rank",
  "rank",
  "row_number",
])

/** Функції каталогу, що повертають множину: крок задає одне значення рядка. */
const SET_RETURNING_FUNCTIONS: ReadonlySet<string> = new Set([
  "aclexplode",
  "generate_series",
  "generate_subscripts",
  "json_array_elements",
  "json_array_elements_text",
  "json_each",
  "json_each_text",
  "json_object_keys",
  "json_populate_recordset",
  "json_to_recordset",
  "jsonb_array_elements",
  "jsonb_array_elements_text",
  "jsonb_each",
  "jsonb_each_text",
  "jsonb_object_keys",
  "jsonb_path_query",
  "jsonb_populate_recordset",
  "jsonb_to_recordset",
  "pg_options_to_table",
  "regexp_matches",
  "regexp_split_to_table",
  "string_to_table",
  "unnest",
])

const AGGREGATE_MARKERS = [
  "agg_star",
  "agg_distinct",
  "agg_order",
  "agg_filter",
  "agg_within_group",
] as const

/** Поля `SelectStmt` форми `SELECT <вираз> FROM <таблиця>`; решта — інша форма. */
const PLAIN_SELECT: Readonly<Record<string, string | undefined>> = {
  targetList: undefined,
  fromClause: undefined,
  op: "SETOP_NONE",
  limitOption: "LIMIT_OPTION_DEFAULT",
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`

const strings = (nodes: unknown): string[] | undefined => {
  if (!Array.isArray(nodes)) return undefined
  const out: string[] = []
  for (const node of nodes) {
    const sval = (node as { String?: { sval?: string } }).String?.sval
    if (sval === undefined) return undefined
    out.push(sval)
  }
  return out
}

const isRecordNode = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Функції моделі з явною `VOLATILE` (рішення 12): кваліфіковане ім'я й голе
 * — некваліфікований виклик може резолвитись у будь-яку схему `search_path`,
 * тож голе ім'я відмовляє консервативно.
 */
export function modelVolatileFunctions(model: CompiledModel): Set<string> {
  const names = new Set<string>()
  for (const unit of model.sqlUnits) {
    const fn = (
      unit.tree as {
        CreateFunctionStmt?: {
          options?: {
            DefElem?: { defname?: string; arg?: { String?: { sval?: string } } }
          }[]
        }
      }
    ).CreateFunctionStmt
    const volatility = fn?.options
      ?.map((o) => o.DefElem)
      .find((o) => o?.defname === "volatility")?.arg?.String?.sval
    if (volatility !== "volatile") continue
    names.add(unit.name)
    names.add(`${unit.schema}.${unit.name}`)
  }
  return names
}

/**
 * Вид кроку `fill` і колонки, значення яких читає його вираз (рішення 12, 15).
 * Вираз розбирається як `SELECT <вираз> FROM <схема>.<таблиця>` у старих
 * іменах — саме так П3 виконує його в `UPDATE … FROM (SELECT <ключ>, <вираз>
 * …)` до перейменувань, тож форма, яку парсер приймає тут, — та, що
 * виконається там. `mapped` — ключі цілей, змаплених з колонок
 * (`fillTargetKey`), `retired` — старі імена виведених колонок, `key` —
 * одноколонковий первинний ключ таблиці (немає — кроку не адресувати рядки),
 * `volatileFunctions` — функції моделі з явною `VOLATILE`.
 */
export function fillStepKind(
  step: FillStep,
  mapped: ReadonlySet<string>,
  retired: ReadonlySet<string>,
  parse: SqlParser,
  table: {
    schema: string
    name: string
    key?: string
    columns: readonly string[]
  },
  volatileFunctions: ReadonlySet<string>
): { kind: StepKind; columns: string[] } | { reason: FillProblem } {
  if (table.key === undefined) return { reason: "noKey" }
  // Перевод рядка перед FROM: коментар `--` у виразі не ковтає таблицю.
  const parsed = parse(
    `SELECT ${step.expression}\nFROM ${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
  )
  if (!parsed.ok) return { reason: "syntax" }
  if (parsed.statements.length !== 1) return { reason: "multipleStatements" }
  const select = (parsed.statements[0]!.stmt as { SelectStmt?: unknown })
    .SelectStmt
  if (!isRecordNode(select)) return { reason: "syntax" }
  for (const [field, value] of Object.entries(select)) {
    if (!Object.hasOwn(PLAIN_SELECT, field)) {
      // Об'єднання й CTE несуть другий запит; решта — інша форма оператора.
      return {
        reason:
          field === "withClause" || field === "larg" ? "subquery" : "syntax",
      }
    }
    const expected = PLAIN_SELECT[field]
    if (expected !== undefined && value !== expected) {
      return { reason: field === "op" ? "subquery" : "syntax" }
    }
  }
  const from = select.fromClause as unknown[] | undefined
  const range = (from?.[0] as { RangeVar?: Record<string, unknown> })?.RangeVar
  if (
    from?.length !== 1 ||
    range === undefined ||
    range.schemaname !== table.schema ||
    range.relname !== table.name ||
    range.alias !== undefined
  ) {
    return { reason: "foreignTable" }
  }
  const targets = select.targetList as unknown[] | undefined
  if (targets?.length !== 1) return { reason: "multipleTargets" }
  const target = (targets[0] as { ResTarget?: Record<string, unknown> })
    .ResTarget
  // Ім'я виводу П3 дає саме: `AS` у виразі зламав би його обгортку.
  if (target === undefined || target.name !== undefined) {
    return { reason: "syntax" }
  }

  const walker = new ExpressionWalker(table, volatileFunctions)
  const problem = walker.walk(target.val)
  if (problem !== undefined) return { reason: problem }
  const columns = [...walker.columns]
  const kind: StepKind = mapped.has(fillTargetKey(step.target))
    ? "repair"
    : columns.some((c) => retired.has(c))
      ? "conversion"
      : columns.length > 0
        ? "split"
        : "backfill"
  if (kind === "repair" && walker.readsNow) return { reason: "volatile" }
  return { kind, columns }
}

/**
 * Обхід дерева виразу: колонки, значення яких він читає, і перша заборонена
 * форма. Колонки визначення вікна (`PARTITION BY`, `ORDER BY`) лише
 * впорядковують рядки: нумерація рядків ТЧ за власником — дозаповнення, а не
 * розщеплення власника.
 */
class ExpressionWalker {
  readonly columns = new Set<string>()
  readsNow = false
  /** Глибина всередині визначення вікна. */
  private window = 0
  private readonly known: ReadonlySet<string>

  constructor(
    private readonly table: {
      schema: string
      name: string
      key?: string
      columns: readonly string[]
    },
    private readonly volatileFunctions: ReadonlySet<string>
  ) {
    this.known = new Set(table.columns)
  }

  walk(node: unknown): FillProblem | undefined {
    if (Array.isArray(node)) {
      for (const item of node) {
        const problem = this.walk(item)
        if (problem !== undefined) return problem
      }
      return undefined
    }
    if (!isRecordNode(node)) return undefined
    for (const [type, value] of Object.entries(node)) {
      const problem = this.visit(type, value)
      if (problem !== undefined) return problem
    }
    return undefined
  }

  private visit(type: string, value: unknown): FillProblem | undefined {
    switch (type) {
      case "SubLink":
      case "SelectStmt":
      case "RangeVar":
      case "RangeSubselect":
        return "subquery"
      // Параметр П3 не прив'язує, а `GROUPING` існує лише з `GROUP BY`.
      case "ParamRef":
        return "syntax"
      case "GroupingFunc":
        return "aggregate"
      case "ColumnRef":
        return this.column(value as { fields?: unknown[] })
      case "SQLValueFunction":
        if (NOW_VALUE_FUNCTIONS.has(String((value as { op?: string }).op))) {
          this.readsNow = true
        }
        return undefined
      case "FuncCall": {
        const call = value as Record<string, unknown>
        const problem = this.call(call)
        if (problem !== undefined) return problem
        const { over, ...rest } = call
        const inner = this.walk(rest)
        if (inner !== undefined) return inner
        this.window += 1
        try {
          return this.walk(over)
        } finally {
          this.window -= 1
        }
      }
    }
    return this.walk(value)
  }

  private read(name: string): void {
    if (this.window === 0) this.columns.add(name)
  }

  /** Колонка своєї таблиці: голе ім'я або кваліфіковане таблицею (і схемою). */
  private column(ref: { fields?: unknown[] }): FillProblem | undefined {
    const fields = ref.fields ?? []
    const star = fields.length > 0 && "A_Star" in (fields.at(-1) as object)
    const names = strings(star ? fields.slice(0, -1) : fields)
    if (names === undefined) return "syntax"
    const qualifier = star ? names : names.slice(0, -1)
    if (!this.ownQualifier(qualifier)) return "foreignTable"
    if (star) {
      for (const c of this.table.columns) this.read(c)
      return undefined
    }
    const name = names.at(-1)!
    if (this.known.has(name)) {
      this.read(name)
      return undefined
    }
    // Голе ім'я таблиці без такої колонки — увесь рядок.
    if (names.length === 1 && name === this.table.name) {
      for (const c of this.table.columns) this.read(c)
      return undefined
    }
    return "unknownColumn"
  }

  private ownQualifier(qualifier: readonly string[]): boolean {
    const { schema, name } = this.table
    if (qualifier.length === 0) return true
    if (qualifier.length === 1) return qualifier[0] === name
    return (
      qualifier.length === 2 && qualifier[0] === schema && qualifier[1] === name
    )
  }

  private call(fn: Record<string, unknown>): FillProblem | undefined {
    const names = strings(fn.funcname)
    if (names === undefined) return "syntax"
    const name = names.at(-1)!
    // Функція каталогу — некваліфікована чи з `pg_catalog`; інша схема —
    // функція застосунку з тим самим ім'ям.
    const builtin =
      names.length === 1 || (names.length === 2 && names[0] === "pg_catalog")
    const qualified = names.join(".")
    if (
      (builtin && VOLATILE_FUNCTIONS.has(name)) ||
      this.volatileFunctions.has(qualified)
    ) {
      return "volatile"
    }
    if (builtin && NOW_FUNCTIONS.has(name)) this.readsNow = true
    if (builtin && SET_RETURNING_FUNCTIONS.has(name)) return "setReturning"
    const over = fn.over as
      { orderClause?: unknown[]; refname?: string } | undefined
    if (over === undefined) {
      if (
        AGGREGATE_MARKERS.some((m) => fn[m] !== undefined) ||
        (builtin && AGGREGATE_FUNCTIONS.has(name))
      ) {
        return "aggregate"
      }
      if (builtin && WINDOW_FUNCTIONS.has(name)) return "syntax"
      return undefined
    }
    // Унікальний ключ у порядку вікна робить порядок рядків повним.
    const ordered = (over.orderClause ?? []).some((sort) => {
      const node = (sort as { SortBy?: { node?: unknown } }).SortBy?.node
      const fields = (node as { ColumnRef?: { fields?: unknown[] } })?.ColumnRef
        ?.fields
      const names = strings(fields)
      return (
        names !== undefined &&
        names.at(-1) === this.table.key &&
        this.ownQualifier(names.slice(0, -1))
      )
    })
    return ordered ? undefined : "nondeterministicWindow"
  }
}
