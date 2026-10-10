import type { CompiledModel } from "../../compile"
import type { SqlParser } from "../../sql/parse"
import type { PromoteInput } from "../inputs"
import { CATALOG_FUNCTIONS } from "./catalog-functions"
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
  | "unknownFunction"
  | "unqualifiedFunction"
  | "castToTime"
  | "nondeterministicWindow"
  | "unknownColumn"

/** Ключ цілі кроку в множині змаплених цілей: `"<to> <name>"`. */
export const fillTargetKey = (target: FillStep["target"]) =>
  `${target.to} ${target.name}`

/**
 * Функції моделі для виразу (рішення 12): `immutable` — кваліфіковані імена,
 * усі визначення яких явно IMMUTABLE і не повертають множину; `bare` — голі
 * імена всіх функцій і агрегатів моделі: лише щоб назвати причину відмови
 * некваліфікованого виклику.
 */
export interface ModelFunctions {
  immutable: ReadonlySet<string>
  bare: ReadonlySet<string>
}

type FunctionKind = "f" | "a" | "w"

/**
 * Доведено детерміновані функції каталогу — знімок живого `pg_catalog`
 * (`catalog-functions.ts`). Решта каталогу — не доведена: STABLE залежить від
 * сеансу, VOLATILE — від виклику, а розширення — від версії, яку видно лише
 * в базі.
 */
const CATALOG_KINDS: ReadonlyMap<string, FunctionKind> = new Map(
  (
    Object.entries(CATALOG_FUNCTIONS) as [FunctionKind, readonly string[]][]
  ).flatMap(([kind, names]) => names.map((name) => [name, kind] as const))
)

/**
 * Час транзакції — єдиний виняток з IMMUTABLE: стабільний у межах кроку,
 * тож дозаповнення нової колонки ним допустиме, а ремонт наявних даних — ні,
 * він мусить бути детермінованим (рішення 15).
 */
const NOW_FUNCTIONS: ReadonlySet<string> = new Set([
  "now",
  "transaction_timestamp",
  "statement_timestamp",
])

/** Ключові слова часу транзакції (`current_timestamp`, `localtime`, …). */
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
 * Типи дати й часу: рядки `'now'`, `'today'`, `'tomorrow'`, `'yesterday'`
 * при приведенні до них — той самий час транзакції, що й `now()`. Приведення
 * буває й неявним (`coalesce(created_at, 'now')`: невідомий літерал бере тип
 * колонки), а типів компілятор не виводить, тож такий рядок читає час
 * транзакції будь-де у виразі.
 */
const DATETIME_TYPES: ReadonlySet<string> = new Set([
  "date",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
])
const NOW_STRINGS: ReadonlySet<string> = new Set([
  "now",
  "today",
  "tomorrow",
  "yesterday",
])

/**
 * Відомі причини відмови лише для повідомлення: недоведене відхиляє знімок,
 * а ці назви кажуть автору, чому саме.
 */
const VOLATILE_NAMES: ReadonlySet<string> = new Set([
  "random",
  "random_normal",
  "gen_random_uuid",
  "uuid_generate_v4",
  "clock_timestamp",
  "timeofday",
  "nextval",
  "setval",
])
const SET_RETURNING_NAMES: ReadonlySet<string> = new Set([
  "generate_series",
  "generate_subscripts",
  "json_array_elements",
  "jsonb_array_elements",
  "json_each",
  "jsonb_each",
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

interface FunctionNode {
  returnType?: { setof?: boolean }
  parameters?: { FunctionParameter?: { mode?: string } }[]
  is_procedure?: boolean
  options?: {
    DefElem?: { defname?: string; arg?: { String?: { sval?: string } } }
  }[]
}

/**
 * Функції моделі (рішення 12): доведено детермінована лише явно IMMUTABLE
 * функція без `SETOF`/`TABLE`. Ім'я, яке має хоч одне інше визначення чи
 * агрегат, — недоведене: перевантаження Postgres обирає за типами, яких
 * компілятор не виводить. Крок даних П3 виконує з `search_path = pg_catalog,
 * pg_temp`, тож функцію моделі вираз кличе лише кваліфікованою.
 */
export function modelFunctions(model: CompiledModel): ModelFunctions {
  const immutable = new Set<string>()
  const other = new Set<string>()
  const bare = new Set<string>()
  for (const unit of model.sqlUnits) {
    const tree = unit.tree as {
      CreateFunctionStmt?: FunctionNode
      DefineStmt?: { kind?: string }
    }
    const fn = tree.CreateFunctionStmt
    if (fn === undefined && tree.DefineStmt?.kind !== "OBJECT_AGGREGATE") {
      continue
    }
    const volatility = fn?.options
      ?.map((o) => o.DefElem)
      .find((o) => o?.defname === "volatility")?.arg?.String?.sval
    const proven =
      fn !== undefined &&
      fn.is_procedure !== true &&
      volatility === "immutable" &&
      fn.returnType?.setof !== true &&
      !(fn.parameters ?? []).some(
        (p) => p.FunctionParameter?.mode === "FUNC_PARAM_TABLE"
      )
    ;(proven ? immutable : other).add(`${unit.schema}.${unit.name}`)
    bare.add(unit.name)
  }
  for (const name of other) immutable.delete(name)
  return { immutable, bare }
}

/**
 * Вид кроку `fill` і колонки, значення яких читає його вираз (рішення 12, 15).
 * Вираз розбирається як `SELECT <вираз> FROM <схема>.<таблиця>` у старих
 * іменах — саме так П3 виконує його в `UPDATE … FROM (SELECT <ключ>, <вираз>
 * …)` до перейменувань, тож форма, яку парсер приймає тут, — та, що
 * виконається там. `mapped` — ключі цілей, змаплених з колонок
 * (`fillTargetKey`), `retired` — старі імена виведених колонок, `key` —
 * одноколонковий первинний ключ таблиці (немає — кроку не адресувати рядки),
 * `functions` — функції моделі.
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
  functions: ModelFunctions
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

  const walker = new ExpressionWalker(table, functions)
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
  // Приведення не-літерала до дати чи часу може прочитати час транзакції
  // (`lower('now')::timestamptz`), а без виводу типів цього не довести.
  if (kind === "repair" && walker.castsToTime) return { reason: "castToTime" }
  return { kind, columns }
}

/**
 * Обхід дерева виразу: колонки, значення яких він читає, і перша заборонена
 * форма. Колонки визначення вікна (`PARTITION BY`, `ORDER BY`) лише
 * впорядковують рядки: вони перевіряються, але виду кроку не задають —
 * нумерація рядків ТЧ за власником є дозаповненням, а не розщепленням
 * власника. Аргументи віконної функції — прочитані значення. Приведення й
 * оператори волатильністю не перевіряються: це вимагало б виводу типів.
 */
class ExpressionWalker {
  readonly columns = new Set<string>()
  readsNow = false
  /** Вираз приводить не рядковий літерал до типу дати чи часу. */
  castsToTime = false
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
    private readonly functions: ModelFunctions
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
        // Решта ключових слів (`current_user`, `current_schema`, …) —
        // STABLE: залежить від сеансу, а не від рядка.
        if (!NOW_VALUE_FUNCTIONS.has(String((value as { op?: string }).op))) {
          return "unknownFunction"
        }
        this.readsNow = true
        return undefined
      case "A_Const":
        if (nowString(value as { sval?: { sval?: string } })) {
          this.readsNow = true
        }
        break
      case "TypeCast":
        if (castsNonLiteralToTime(value as TypeCastNode)) {
          this.castsToTime = true
        }
        break
      case "JsonFuncExpr": {
        // `json_value(… RETURNING timestamptz)` — приведення результату функції.
        const output = (
          value as { output?: { typeName?: { names?: unknown } } }
        ).output
        if (isTimeType(output?.typeName?.names)) this.castsToTime = true
        break
      }
      case "FuncCall": {
        const call = value as Record<string, unknown>
        const problem = this.call(call)
        if (problem !== undefined) return problem
        return this.withWindow(call, call.over)
      }
      case "JsonArrayAgg":
      case "JsonObjectAgg": {
        // Агрегат SQL/JSON — агрегат без імені функції: ті самі правила вікна.
        const node = value as { constructor?: Record<string, unknown> }
        const over = node.constructor?.over
        if (over === undefined) return "aggregate"
        const problem = this.windowOrder(over)
        if (problem !== undefined) return problem
        const { constructor, ...rest } = node
        const inner = this.walk(rest)
        if (inner !== undefined) return inner
        return this.withWindow(constructor ?? {}, over)
      }
    }
    return this.walk(value)
  }

  /** Обхід вузла з вікном: поза вікном — читання, у вікні — лише порядок. */
  private withWindow(
    node: Record<string, unknown>,
    over: unknown
  ): FillProblem | undefined {
    const rest = Object.fromEntries(
      Object.entries(node).filter(([key]) => key !== "over")
    )
    const inner = this.walk(rest)
    if (inner !== undefined) return inner
    this.window += 1
    try {
      return this.walk(over)
    } finally {
      this.window -= 1
    }
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

  /**
   * Вид функції, якщо вона доведено детермінована: знімок каталогу для
   * некваліфікованої чи `pg_catalog`-функції, явно IMMUTABLE функція моделі
   * за кваліфікованим ім'ям. П3 виконує крок з `search_path = pg_catalog,
   * pg_temp`, тож некваліфіковане ім'я — завжди функція каталогу, а не моделі.
   */
  private kindOf(names: readonly string[]): FunctionKind | undefined {
    const name = names.at(-1)!
    if (names.length > 2) return undefined
    if (names.length === 2 && names[0] !== "pg_catalog") {
      return this.functions.immutable.has(names.join(".")) ? "f" : undefined
    }
    if (NOW_FUNCTIONS.has(name)) {
      this.readsNow = true
      return "f"
    }
    return CATALOG_KINDS.get(name)
  }

  private call(fn: Record<string, unknown>): FillProblem | undefined {
    const names = strings(fn.funcname)
    if (names === undefined) return "syntax"
    const kind = this.kindOf(names)
    if (kind === undefined) {
      const name = names.at(-1)!
      return VOLATILE_NAMES.has(name)
        ? "volatile"
        : SET_RETURNING_NAMES.has(name)
          ? "setReturning"
          : names.length === 1 && this.functions.bare.has(name)
            ? "unqualifiedFunction"
            : "unknownFunction"
    }
    const aggregate =
      kind === "a" || AGGREGATE_MARKERS.some((m) => fn[m] !== undefined)
    if (fn.over === undefined) {
      if (aggregate) return "aggregate"
      // Віконна функція без `OVER` Postgres не виконає.
      return kind === "w" ? "syntax" : undefined
    }
    // `OVER` у звичайної функції Postgres відхиляє.
    if (kind === "f" && !aggregate) return "syntax"
    return this.windowOrder(fn.over)
  }

  /** Унікальний ключ у порядку вікна робить порядок рядків повним. */
  private windowOrder(over: unknown): FillProblem | undefined {
    const orderClause = (over as { orderClause?: unknown[] }).orderClause ?? []
    const ordered = orderClause.some((sort) => {
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

interface TypeCastNode {
  arg?: unknown
  typeName?: { names?: unknown[] }
}

const isTimeType = (names: unknown) => {
  const type = strings(names)?.at(-1)
  return type !== undefined && DATETIME_TYPES.has(type)
}

/**
 * Рядок, слово якого — `now`, `today`, `tomorrow` чи `yesterday` (без
 * урахування регістру, з будь-якими розділювачами: `'yesterday 10:00'`).
 */
function nowString(value: { sval?: { sval?: string } }): boolean {
  const sval = value.sval?.sval
  return (
    sval !== undefined &&
    sval
      .toLowerCase()
      .split(/[^a-z]+/)
      .some((word) => NOW_STRINGS.has(word))
  )
}

/**
 * Приведення не-літерала до типу дати чи часу в будь-якій формі (`::`,
 * `CAST`, `timestamptz '…'`, через проміжні приведення й `COLLATE`): без
 * виводу типів не довести, що значення — не рядок `'now'`. Сам літерал
 * судить `nowString`.
 */
function castsNonLiteralToTime(cast: TypeCastNode): boolean {
  if (!isTimeType(cast.typeName?.names)) return false
  let arg = cast.arg
  for (;;) {
    if (!isRecordNode(arg)) return true
    if ("TypeCast" in arg) {
      arg = (arg.TypeCast as TypeCastNode).arg
      continue
    }
    if ("CollateClause" in arg) {
      arg = (arg.CollateClause as { arg?: unknown }).arg
      continue
    }
    return !("A_Const" in arg)
  }
}
