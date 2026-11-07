import {
  INTEGER_TEXT,
  UUID_TEXT,
  isTextEncodedType,
  ORDER_BY_MAX,
  READ_COUNT_CAP,
  TABULAR_LINES_MAX,
  isPlainObject,
  readQuerySchema,
  type BaseCastType,
  type CommandError,
  type OrderBy,
  type ReadQuery,
  type ReadResult,
  type ReadRows,
  type RuntimeAttribute,
  type RuntimeCatalog,
  type RuntimeObject,
  type RuntimeSection,
} from "simetra/model"
import type { z } from "zod"
import { decodeCardRow, decodeLine, decodeSafeInteger, parse } from "./decode"
import {
  renderFilter,
  topLevelParentEq,
  type FilterColumn,
} from "./read-filter"

const KEY_CAST: BaseCastType = "uuid"
const VERSION_CAST: BaseCastType = "bigint"

/** An identifier quoted for SQL text. */
export const ident = (name: string) => `"${name.replaceAll('"', '""')}"`
/** A string literal quoted for SQL text. */
export const literal = (text: string) => `'${text.replaceAll("'", "''")}'`

/** A statement of a read: catalog identifiers and bound parameters only. */
export interface ReadStatement {
  text: string
  params: (string | null)[]
}

/**
 * The checked plan of one read: its statement and how its rows become the
 * result. `readRows` і `ctx.read` виконують той самий план — двері читання
 * не розходяться формою.
 */
export interface ReadPlan {
  statement: ReadStatement
  /**
   * `rows` — a `row` text column per row, a card also `tabular`; `lines` — at
   * most one row with `tabular` and `owner_version`; `count` — one row with `n`.
   */
  result: "rows" | "lines" | "count"
  /** Sections the `tabular` column carries, keyed by their table name. */
  sections?: RuntimeSection[]
  /** A count of one owner's lines: not capped. */
  uncapped?: true
  /** Targets read after the first statement by the ids its rows reference. */
  include?: IncludeStep[]
}

/** One `include` target: the attributes whose ids its statement reads. */
export interface IncludeStep {
  target: RuntimeObject
  /** Logical names of the `Ref` attributes of the read object. */
  attributes: string[]
}

// `jsonb_build_object` приймає до 100 аргументів: шматок — до 50 пар.
const PAIRS_PER_CALL = 50

const tableOf = (owner: { table: { schema: string; name: string } }) =>
  `${ident(owner.table.schema)}.${ident(owner.table.name)}`

/** Пара `'<колонка>', <alias>."<колонка>"` проєкції, з текстовим приведенням Рт1. */
const pairOf = (column: string, cast?: string, alias = "t") =>
  `${literal(column)}, ${alias}.${ident(column)}${cast === undefined ? "" : `::${cast}`}`

const textCast = (attribute: RuntimeAttribute) =>
  !isTextEncodedType(attribute.pgType)
    ? undefined
    : attribute.array === true
      ? "text[]"
      : "text"

/** Пари звичайних колонок реквізитів: лінивих немає, пара — дві колонки. */
function attributePairs(
  attributes: readonly RuntimeAttribute[],
  alias: string
): string[] {
  return attributes.flatMap((attribute) => {
    if (attribute.load === "lazy") return []
    const column = pairOf(attribute.column, textCast(attribute), alias)
    return attribute.pair === undefined
      ? [column]
      : [pairOf(attribute.pair.typeColumn, undefined, alias), column]
  })
}

/** `jsonb` з пар, шматками по {@link PAIRS_PER_CALL}. */
function jsonbOf(pairs: readonly string[]): string {
  const calls: string[] = []
  for (let i = 0; i < pairs.length; i += PAIRS_PER_CALL) {
    calls.push(
      `jsonb_build_object(${pairs.slice(i, i + PAIRS_PER_CALL).join(", ")})`
    )
  }
  return calls.length === 1 ? calls[0]! : `(${calls.join(" || ")})`
}

/**
 * Рядок картки — та сама форма, що й результат ядра (`to_jsonb` і
 * `numeric`/`bigint` текстом, Рт1), тож декодує його той самий декодер шапки.
 * Картка віддає й ліниві колонки (Рд25).
 */
function cardProjection(object: RuntimeObject): string {
  const text = object.attributes.flatMap((a) => {
    const cast = textCast(a)
    return cast === undefined ? [] : [pairOf(a.column, cast)]
  })
  return text.length === 0
    ? "to_jsonb(t)::text"
    : `(to_jsonb(t) || jsonb_build_object(${text.join(", ")}))::text`
}

/**
 * Рядок списку — явний перелік звичайних колонок (спека П4-B §4.2): ні
 * `to_jsonb(t)`, що розпакував би з TOAST ліниві тіла, ні лінивої колонки з
 * текстовим приведенням. Ключі ті самі, що в картки, тож декодер один.
 */
function listProjection(object: RuntimeObject): string {
  return `${jsonbOf([
    pairOf(object.key),
    pairOf(object.versionColumn),
    ...attributePairs(object.attributes, "t"),
  ])}::text`
}

/** Рядок ТЧ — той самий явний перелік; реквізити ТЧ лінивими не бувають. */
function lineProjection(section: RuntimeSection, alias: string): string {
  return jsonbOf([
    pairOf(section.key, undefined, alias),
    pairOf(section.parent, undefined, alias),
    pairOf(section.lineNumber, undefined, alias),
    ...attributePairs(section.attributes, alias),
  ])
}

/**
 * Колонки FK рядка ТЧ на власника й колонки власника, на які вони
 * посилаються; схема каталогу гарантує, що FK є і має `references`.
 */
function parentKeyOf(section: RuntimeSection): [string, string][] {
  const fk = section.constraints.find(
    (c) => c.name === section.parentConstraint
  )
  return (fk?.columns ?? []).map((column, i) => [column, fk!.references![i]!])
}

/**
 * Корельований підзапит рядків однієї ТЧ власника `t`: межа
 * `TABULAR_LINES_MAX + 1` усередині, тож зайвий рядок каже, що межу перейдено.
 * Кореляція — за всіма колонками FK: для складеного FK скоупу інакше не
 * працює похідний індекс `(org_id, parent_id)`.
 */
function linesOf(section: RuntimeSection, limit: string): string {
  const line = ident(section.lineNumber)
  const key = ident(section.key)
  const correlated = parentKeyOf(section)
    .map(([column, target]) => `s.${ident(column)} = t.${ident(target)}`)
    .join(" AND ")
  return (
    `(SELECT coalesce(jsonb_agg(${lineProjection(section, "l")} ORDER BY l.${line}, l.${key}), '[]')` +
    ` FROM (SELECT * FROM ${tableOf(section)} s WHERE ${correlated}` +
    ` ORDER BY s.${line}, s.${key} LIMIT ${limit}) l)`
  )
}

/**
 * Колонка `tabular` — ТЧ за ім'ям таблиці — окремо від рядка шапки: колонка
 * власника з ім'ям `tabular` її не затирає. Власник і його ТЧ — один
 * оператор, тобто один знімок (спека П4-B §4.2).
 */
const tabularColumn = (sections: readonly RuntimeSection[], limit: string) =>
  `${jsonbOf(sections.map((s) => `${literal(s.table.name)}, ${linesOf(s, limit)}`))}::text AS tabular`

/**
 * Колонки, які запит може назвати: реквізити, ключ і версія об'єкта — лише з
 * каталогу. Тип приведення — без модифікатора: `$n::character varying(10)`
 * обрізав би значення фільтра й знайшов би рядок з іншим значенням.
 */
function objectColumns(object: RuntimeObject): Map<string, FilterColumn> {
  const columns = attributeColumns(object.attributes)
  columns.set(object.keyName, platformColumn(object.keyName, object.key, "Key"))
  columns.set(
    object.versionName,
    platformColumn(object.versionName, object.versionColumn, "Version")
  )
  return columns
}

/** Колонки ТЧ як цілі списку: власник, номер рядка, ключ і реквізити ТЧ. */
function sectionColumns(section: RuntimeSection): Map<string, FilterColumn> {
  const columns = attributeColumns(section.attributes)
  columns.set(
    section.keyName,
    platformColumn(section.keyName, section.key, "Key")
  )
  columns.set(
    section.parentName,
    platformColumn(section.parentName, section.parent, "Parent")
  )
  columns.set(
    section.lineNumberName,
    platformColumn(section.lineNumberName, section.lineNumber, "LineNumber")
  )
  return columns
}

// Ключ, власник, версія й номер рядка в каталозі без `castType`: їхній тип
// задає платформа.
const PLATFORM_CAST: Record<
  "Key" | "Parent" | "Version" | "LineNumber",
  BaseCastType
> = {
  Key: KEY_CAST,
  Parent: KEY_CAST,
  Version: VERSION_CAST,
  LineNumber: "integer",
}

const platformColumn = (
  name: string,
  column: string,
  type: keyof typeof PLATFORM_CAST
): FilterColumn => ({
  name,
  column,
  castType: PLATFORM_CAST[type],
  type,
  lazy: false,
})

function attributeColumns(
  attributes: readonly RuntimeAttribute[]
): Map<string, FilterColumn> {
  return new Map(
    attributes.map((attribute) => [
      attribute.name,
      {
        name: attribute.name,
        column: attribute.column,
        castType: attribute.castType,
        type: attribute.type,
        attribute,
        lazy: attribute.load === "lazy",
      },
    ])
  )
}

/** Чи колонка сортується: скаляр з порядком (спека П4-B §4.1). */
const sortable = (column: FilterColumn) =>
  column.attribute?.array !== true &&
  column.attribute?.pair === undefined &&
  column.type !== "Json" &&
  column.type !== "Bytes" &&
  column.type !== "Raw"

const invalid = (path: string, reason?: string): { error: CommandError } => ({
  error: {
    code: "command.invalid",
    path,
    ...(reason === undefined ? {} : { reason }),
  },
})

/** Ключ цілі сортування: останній і обов'язковий терм (В4). */
interface OrderKey {
  name: string
  column: string
}

/**
 * `ORDER BY` сторінки: реквізити запиту (без них — типовий порядок форми),
 * потім ключ (В4) — порядок сталий, і keyset-умові фільтра є на що
 * спертися. Без явного `COLLATE` (Рд29). Ключ не останнім і понад
 * `ORDER_BY_MAX` реквізитів відхиляє будівник, а не схема: ім'я ключа знає
 * лише каталог. Кожен член — з аліасом `t`: голе ім'я в `ORDER BY` Postgres
 * спершу шукає серед вихідних колонок, і колонка `row` списку чи `r`
 * сторінки ТЧ сортувала б за текстом jsonb, а `LIMIT` брав би чужу сторінку.
 */
function orderClause(
  key: OrderKey,
  columns: ReadonlyMap<string, FilterColumn>,
  orderBy: OrderBy | undefined,
  defaults: readonly string[] = []
): { sql: string } | { error: CommandError } {
  const entries = orderBy ?? []
  const keyAt = entries.findIndex((e) => e.attribute === key.name)
  if (keyAt !== -1 && keyAt !== entries.length - 1) {
    return invalid(`orderBy.${keyAt}`)
  }
  if (entries.length - (keyAt === -1 ? 0 : 1) > ORDER_BY_MAX) {
    return invalid("orderBy")
  }
  const terms: string[] =
    orderBy === undefined ? defaults.map((column) => `t.${ident(column)}`) : []
  for (const [i, entry] of entries.entries()) {
    const column = columns.get(entry.attribute)
    const path = `orderBy.${i}.attribute`
    if (column === undefined) return invalid(path)
    // Списочна форма лінивої колонки не має (Рд25).
    if (column.lazy) return invalid(path, "lazy")
    if (!sortable(column)) return invalid(path)
    const direction = entry.direction === "desc" ? " DESC" : ""
    const nulls =
      entry.nulls === undefined ? "" : ` NULLS ${entry.nulls.toUpperCase()}`
    terms.push(`t.${ident(column.column)}${direction}${nulls}`)
  }
  if (keyAt === -1) terms.push(`t.${ident(key.column)}`)
  return { sql: terms.join(", ") }
}

/**
 * Кроки `include`: реквізит — одноцільовий `Ref` з ціллю в каталозі;
 * реквізити з тією самою ціллю діляться одним оператором. Лінивий `Ref` у
 * списку — відмова (В11): колонки немає в проєкції, тож `included` мовчки
 * був би порожнім.
 */
function includeSteps(
  catalog: RuntimeCatalog,
  object: RuntimeObject,
  names: readonly string[],
  list: boolean
): IncludeStep[] | { error: CommandError } {
  const steps: IncludeStep[] = []
  for (const [i, name] of names.entries()) {
    const path = `include.${i}`
    const attribute = object.attributes.find((a) => a.name === name)
    if (attribute?.ref === undefined) return invalid(path)
    const targetId = attribute.ref.object
    const target = catalog.objects.find((o) => o.id === targetId)
    if (target === undefined) return invalid(path)
    if (list && attribute.load === "lazy") return invalid(path, "lazy")
    const step = steps.find((s) => s.target === target)
    if (step === undefined) steps.push({ target, attributes: [name] })
    else step.attributes.push(name)
  }
  return steps
}

/**
 * Builds the plan of a read form (P4-B spec §4.2) from the catalog and bound
 * parameters only; every refusal is `command.invalid` with its input path.
 */
function buildReadPlan(
  catalog: RuntimeCatalog,
  object: RuntimeObject,
  query: ReadQuery
): ReadPlan | { error: CommandError } {
  const plan =
    "tabularSection" in query
      ? buildSectionPlan(object, query)
      : buildObjectPlan(object, query)
  if ("error" in plan || !("include" in query) || query.include === undefined) {
    return plan
  }
  const include = includeSteps(catalog, object, query.include, !("id" in query))
  return "error" in include ? include : { ...plan, include }
}

/** Зв'язування параметрів одного оператора: `$n` за порядком. */
function binder() {
  const params: (string | null)[] = []
  const bind = (value: string | null, cast?: string) => {
    params.push(value)
    return `$${params.length}${cast === undefined ? "" : `::${cast}`}`
  }
  return { params, bind }
}

type ObjectQuery = Exclude<ReadQuery, { tabularSection: string }>
type SectionQuery = Extract<ReadQuery, { tabularSection: string }>

/** ТЧ картки: `true` — усі, інакше названі. */
function cardSections(
  object: RuntimeObject,
  selected: true | readonly string[] | undefined
): RuntimeSection[] | { error: CommandError } {
  if (selected === undefined) return []
  if (selected === true) return object.tabularSections
  const sections: RuntimeSection[] = []
  for (const [i, name] of selected.entries()) {
    const section = object.tabularSections.find((s) => s.name === name)
    if (section === undefined) return invalid(`tabularSections.${i}`)
    sections.push(section)
  }
  return sections
}

/** Межа рядків однієї ТЧ: зайвий рядок каже, що межу перейдено. */
const LINES_LIMIT = String(TABULAR_LINES_MAX + 1)

function buildObjectPlan(
  object: RuntimeObject,
  query: ObjectQuery
): ReadPlan | { error: CommandError } {
  const { params, bind } = binder()
  const table = tableOf(object)
  if ("id" in query) {
    const sections = cardSections(object, query.tabularSections)
    if ("error" in sections) return sections
    const id = bind(query.id, KEY_CAST)
    const tabular =
      sections.length === 0
        ? ""
        : `, ${tabularColumn(sections, bind(LINES_LIMIT))}`
    const text =
      `SELECT ${cardProjection(object)} AS row${tabular} FROM ${table} t` +
      ` WHERE ${ident(object.key)} = ${id} LIMIT 1`
    return {
      statement: { text, params },
      result: "rows",
      ...(sections.length === 0 ? {} : { sections }),
    }
  }
  const columns = objectColumns(object)
  let where = ""
  if (query.where !== undefined) {
    const rendered = renderFilter(query.where, columns, bind, "where")
    if ("error" in rendered) return rendered
    where = ` WHERE ${rendered.sql}`
  }
  if ("count" in query) {
    // Межа `READ_COUNT_CAP + 1` усередині: лічильник не сканує понад неї, а
    // зайвий рядок каже, що межу перейдено.
    const limit = bind(String(READ_COUNT_CAP + 1))
    const text = `SELECT count(*) AS n FROM (SELECT 1 FROM ${table} t${where} LIMIT ${limit}) c`
    return { statement: { text, params }, result: "count" }
  }
  const order = orderClause(
    { name: object.keyName, column: object.key },
    columns,
    query.orderBy
  )
  if ("error" in order) return order
  let text =
    `SELECT ${listProjection(object)} AS row FROM ${table} t${where}` +
    ` ORDER BY ${order.sql} LIMIT ${bind(String(query.limit))}`
  if (query.offset !== undefined) {
    text += ` OFFSET ${bind(String(query.offset))}`
  }
  return { statement: { text, params }, result: "rows" }
}

/**
 * Форми ТЧ (спека П4-B §4.1): «ТЧ власника» — рядок власника з його версією
 * й корельованим підзапитом ТЧ; сторінка й лічильник — над таблицею ТЧ тими
 * самими правилами, що й список об'єкта.
 */
function buildSectionPlan(
  object: RuntimeObject,
  query: SectionQuery
): ReadPlan | { error: CommandError } {
  const section = object.tabularSections.find(
    (s) => s.name === query.tabularSection
  )
  if (section === undefined) return invalid("tabularSection")
  const { params, bind } = binder()
  const owner = tableOf(object)
  const sections = [section]
  if ("owner" in query) {
    const id = bind(query.owner, KEY_CAST)
    const text =
      `SELECT t.${ident(object.versionColumn)}::text AS owner_version, ` +
      `${tabularColumn(sections, bind(LINES_LIMIT))} FROM ${owner} t` +
      ` WHERE ${ident(object.key)} = ${id} LIMIT 1`
    return { statement: { text, params }, result: "lines", sections }
  }
  const columns = sectionColumns(section)
  let where = ""
  // Значення вже перевірене фільтром як UUID колонки власника.
  const parent = topLevelParentEq(query.where, section.parentName)
  // Id власника зв'язується раз і лише там, де оператор його згадує:
  // незгаданий параметр Postgres відхиляє.
  let ownerParam: string | undefined
  const ownerId = () => (ownerParam ??= bind(parent as string, KEY_CAST))
  if (query.where !== undefined) {
    const rendered = renderFilter(query.where, columns, bind, "where")
    if ("error" in rendered) return rendered
    where = ` WHERE ${rendered.sql}`
    if (typeof parent === "string") {
      // Решта колонок складеного FK — з того самого рядка власника: умова
      // за `(org_id, parent_id)` бере похідний індекс.
      for (const [column, target] of parentKeyOf(section)) {
        if (column === section.parent) continue
        where +=
          ` AND ${ident(column)} = (SELECT o.${ident(target)} FROM ${owner} o` +
          ` WHERE o.${ident(object.key)} = ${ownerId()})`
      }
    }
  }
  const table = tableOf(section)
  if ("count" in query) {
    // Лічильник одного власника обмежений самою ТЧ; інший — межею 10 000.
    if (typeof parent === "string") {
      const text = `SELECT count(*) AS n FROM ${table} t${where}`
      return { statement: { text, params }, result: "count", uncapped: true }
    }
    const limit = bind(String(READ_COUNT_CAP + 1))
    const text = `SELECT count(*) AS n FROM (SELECT 1 FROM ${table} t${where} LIMIT ${limit}) c`
    return { statement: { text, params }, result: "count" }
  }
  const order = orderClause(
    { name: section.keyName, column: section.key },
    columns,
    query.orderBy,
    [section.lineNumber]
  )
  if ("error" in order) return order
  // Версія власника — тим самим оператором, тобто з того самого знімка.
  const ownerVersion =
    typeof parent !== "string"
      ? ""
      : `(SELECT o.${ident(object.versionColumn)}::text FROM ${owner} o` +
        ` WHERE o.${ident(object.key)} = ${ownerId()}) AS owner_version, `
  let inner =
    `SELECT ${lineProjection(section, "t")} AS r, row_number() OVER (ORDER BY ${order.sql}) AS n` +
    ` FROM ${table} t${where} ORDER BY ${order.sql} LIMIT ${bind(String(query.limit))}`
  if (query.offset !== undefined) {
    inner += ` OFFSET ${bind(String(query.offset))}`
  }
  const text =
    `SELECT ${ownerVersion}jsonb_build_object(${literal(section.table.name)},` +
    ` coalesce(jsonb_agg(x.r ORDER BY x.n), '[]'))::text AS tabular FROM (${inner}) x`
  return { statement: { text, params }, result: "lines", sections }
}

/**
 * Оператор цілі `include`: id з декодованих рядків першого оператора,
 * унікальні, без `null`; без id оператора немає. Параметр на id, як `in`
 * фільтра. Рядок цілі — та сама проєкція, що й її власний список.
 */
function includeStatement(
  step: IncludeStep,
  rows: readonly Record<string, unknown>[]
): ReadStatement | undefined {
  const ids: string[] = []
  for (const row of rows) {
    for (const name of step.attributes) {
      const id = row[name]
      if (id === null || id === undefined) continue
      if (typeof id !== "string" || !UUID_TEXT.test(id)) {
        throw new Error("include id is not a UUID")
      }
      if (!ids.includes(id)) ids.push(id)
    }
  }
  if (ids.length === 0) return undefined
  const { target } = step
  const placeholders = ids.map((_, i) => `$${i + 1}::${KEY_CAST}`)
  return {
    text:
      `SELECT ${listProjection(target)} AS row FROM ${tableOf(target)} t` +
      ` WHERE ${ident(target.key)} = ANY(ARRAY[${placeholders.join(", ")}])`,
    params: ids,
  }
}

const textOf = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new Error(`read ${what} is not text`)
  return value
}

const decodeRows = (
  object: RuntimeObject,
  rows: readonly Record<string, unknown>[]
): Record<string, unknown>[] =>
  rows.map((r) => decodeCardRow(object, textOf(r.row, "row")))

/**
 * ТЧ з колонки `tabular`. Понад `TABULAR_LINES_MAX` рядків — відмова, а не
 * обрізання (Рд27): межу перевіряє T3 до повернення.
 */
function decodeSections(
  sections: readonly RuntimeSection[],
  column: unknown
):
  | { lines: Record<string, Record<string, unknown>[]> }
  | { error: CommandError } {
  const tabular = parse(textOf(column, "tabular"))
  if (!isPlainObject(tabular)) throw new Error("read tabular is not an object")
  const out: Record<string, Record<string, unknown>[]> = {}
  for (const section of sections) {
    const lines = tabular[section.table.name]
    if (!Array.isArray(lines)) throw new Error("read lines are not an array")
    if (lines.length > TABULAR_LINES_MAX) {
      return invalid(section.name, "tabular-too-large")
    }
    out[section.name] = lines.map((line: unknown) => decodeLine(section, line))
  }
  return { lines: out }
}

/** Runs one statement of a read in its transaction; `object` — its phase. */
export type ReadStatementRunner = (
  statement: ReadStatement,
  object: RuntimeObject
) => Promise<readonly Record<string, unknown>[]>

/**
 * Executes a plan through `run` — the first statement, then one statement per
 * `include` target, all in the caller's transaction — and builds the result;
 * a tabular section over `TABULAR_LINES_MAX` lines is an `error`. Throws what
 * `run` throws, and on a row of the wrong shape; the caller maps the latter
 * to `command.internal`.
 */
export async function executeRead(
  object: RuntimeObject,
  plan: ReadPlan,
  run: ReadStatementRunner
): Promise<ReadResult | { error: CommandError }> {
  const result = readResult(object, plan, await run(plan.statement, object))
  if (plan.include === undefined || !("rows" in result)) return result
  const included: NonNullable<ReadRows["included"]> = {}
  for (const step of plan.include) {
    const statement = includeStatement(step, result.rows)
    const key = `${step.target.kind}.${step.target.name}`
    included[key] =
      statement === undefined
        ? []
        : decodeRows(step.target, await run(statement, step.target))
  }
  return { ...result, included }
}

function readResult(
  object: RuntimeObject,
  plan: ReadPlan,
  rows: readonly Record<string, unknown>[]
): ReadResult | { error: CommandError } {
  if (plan.result === "count") {
    // `count(*)` — `bigint`, драйвер віддає його текстом.
    const n = rows[0]?.n
    const count = typeof n === "string" && INTEGER_TEXT.test(n) ? Number(n) : n
    if (
      rows.length !== 1 ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count)
    ) {
      throw new Error("read count is not an integer")
    }
    return plan.uncapped !== true && count > READ_COUNT_CAP
      ? { count: READ_COUNT_CAP, capped: true }
      : { count }
  }
  const sections = plan.sections ?? []
  if (plan.result === "lines") {
    // Невидимий власник «ТЧ власника» — порожня відповідь без версії.
    const [row] = rows
    if (rows.length > 1) throw new Error("read lines answered several rows")
    if (row === undefined) return { rows: [] }
    const decoded = decodeSections(sections, row.tabular)
    if ("error" in decoded) return decoded
    const version = row.owner_version
    return {
      rows: decoded.lines[sections[0]!.name]!,
      ...(version === null || version === undefined
        ? {}
        : { ownerVersion: decodeSafeInteger(version) }),
    }
  }
  const out: Record<string, unknown>[] = []
  for (const row of rows) {
    const head = decodeCardRow(object, textOf(row.row, "row"))
    if (sections.length > 0) {
      const decoded = decodeSections(sections, row.tabular)
      if ("error" in decoded) return decoded
      head.tabularSections = decoded.lines
    }
    out.push(head)
  }
  return { rows: out }
}

const reasonOf = (issue: z.core.$ZodIssue): string | undefined => {
  const reason = (issue as { params?: { reason?: unknown } }).params?.reason
  return typeof reason === "string" ? reason : undefined
}

/**
 * The issue a refusal reports: the first one with a `params.reason`, else
 * the first one.
 */
export function decidingIssue(error: z.ZodError): z.core.$ZodIssue | undefined {
  // Причина межі важливіша за порядок: issue сусідніх полів не мають ховати,
  // що вхід завеликий.
  return (
    error.issues.find((issue) => reasonOf(issue) !== undefined) ??
    error.issues[0]
  )
}

/** The `params.reason` of the first Zod issue that carries one. */
export function issueReason(error: z.ZodError): string | undefined {
  const issue = decidingIssue(error)
  return issue === undefined ? undefined : reasonOf(issue)
}

/** The input path of the deciding Zod issue; `undefined` — the input root. */
export function issuePath(error: z.ZodError): string | undefined {
  const issue = decidingIssue(error)
  return issue === undefined || issue.path.length === 0
    ? undefined
    : issue.path.join(".")
}

/**
 * Checks a read query against the catalog and builds its plan; every
 * failure is `command.invalid` before the database.
 */
export function prepareRead(
  catalog: RuntimeCatalog,
  query: unknown
): { object: RuntimeObject; plan: ReadPlan } | { error: CommandError } {
  let parsed: ReturnType<typeof readQuerySchema.safeParse>
  try {
    parsed = readQuerySchema.safeParse(query)
  } catch {
    // Геттер, що кидає, чи відкликаний `Proxy` у запиті.
    return { error: { code: "command.invalid" } }
  }
  if (!parsed.success) {
    const path = issuePath(parsed.error)
    const reason = issueReason(parsed.error)
    return {
      error: {
        code: "command.invalid",
        ...(reason === undefined ? {} : { reason }),
        ...(path === undefined ? {} : { path }),
      },
    }
  }
  const { object: ref } = parsed.data
  const object = catalog.objects.find(
    (o) => o.kind === ref.kind && o.name === ref.name
  )
  if (object === undefined) {
    return { error: { code: "command.invalid", path: "object" } }
  }
  const plan = buildReadPlan(catalog, object, parsed.data)
  return "error" in plan ? plan : { object, plan }
}
