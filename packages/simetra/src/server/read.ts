import {
  INTEGER_TEXT,
  UUID_TEXT,
  isTextEncodedType,
  LIMIT_REASONS,
  ORDER_BY_MAX,
  READ_COUNT_CAP,
  TABULAR_LINES_MAX,
  isPlainObject,
  jsonbBuildObject,
  knownFormAllowed,
  knownSchema,
  metadataRefSchema,
  readQuerySchema,
  type BaseCastType,
  type CommandError,
  type KnownVersions,
  type OrderBy,
  type ReadPartValue,
  type ReadQuery,
  type ReadRows,
  type RuntimeAttribute,
  type RuntimeCatalog,
  type RuntimeObject,
  type RuntimeSection,
} from "simetra/model"
import type { z } from "zod"
import {
  KNOWN_MARKER,
  decodeReadRow,
  decodeReadRowOrMarker,
  decodeSafeInteger,
  linesWire,
  parse,
} from "./decode"
import { withObject } from "./errors"
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
 * A list or card statement with `known`, in parts (P4-B spec §4.1): whether
 * its rows may be markers depends on the epoch of the database, known only
 * inside the transaction, so {@link renderKnown} joins the parts at run time.
 */
export interface KnownStatement {
  /** Projection of a full row and of a marker of a row the client holds. */
  row: string
  marker: string
  /** The read table with its alias `t`, and its key and version columns. */
  from: string
  key: string
  version: string
  /** `WHERE`, order and limit after `FROM`. */
  tail: string
  params: (string | null)[]
}

/**
 * The checked plan of one read: its statement — in parts when the read has
 * `known` — and how its rows become the result. `readRows` і `ctx.read`
 * виконують той самий план — двері читання не розходяться формою.
 */
export type ReadPlan = ReadPlanResult &
  (
    | { statement: ReadStatement; known?: undefined }
    | { statement: KnownStatement; known: KnownVersions }
  )

interface ReadPlanResult {
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

/**
 * Пари колонок реквізитів: пара — дві колонки; ліниві — лише з `withLazy`
 * (картка їх віддає, список — ні).
 */
function attributePairs(
  attributes: readonly RuntimeAttribute[],
  alias: string,
  withLazy = false
): string[] {
  return attributes.flatMap((attribute) => {
    if (attribute.load === "lazy" && !withLazy) return []
    const column = pairOf(attribute.column, textCast(attribute), alias)
    return attribute.pair === undefined
      ? [column]
      : [pairOf(attribute.pair.typeColumn, undefined, alias), column]
  })
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
  // Приведень буває понад 50 — шматки, як у списку: інакше понад 100
  // аргументів `jsonb_build_object`.
  return text.length === 0
    ? "to_jsonb(t)::text"
    : `(to_jsonb(t) || ${jsonbBuildObject(text)})::text`
}

/**
 * Рядок списку — явний перелік звичайних колонок (спека П4-B §4.2): ні
 * `to_jsonb(t)`, що розпакував би з TOAST ліниві тіла, ні лінивої колонки з
 * текстовим приведенням. Ключі ті самі, що в картки, тож декодер один.
 */
function listProjection(object: RuntimeObject): string {
  return `${jsonbBuildObject([
    pairOf(object.key),
    pairOf(object.versionColumn),
    ...attributePairs(object.attributes, "t"),
  ])}::text`
}

// Позиція в `known` від нуля: `WITH ORDINALITY` рахує від одиниці.
const KNOWN_POSITION = "simetra_known.simetra_known_position - 1"

/**
 * Маркер незмінного рядка (спека П4-B §4.1): позиція в `known`, а в об'єкта з
 * копіями — `{ $known, <колонки copy> }` з тими самими приведеннями, що в
 * рядку: копія змінюється без версії, тож клієнт не може її тримати. Ключа в
 * частковому маркері немає — цим його й відрізняє декодер. `undefined` —
 * колонка копії зветься `$known` і затерла б позицію: тоді читання повне.
 */
function markerProjection(
  object: RuntimeObject,
  card: boolean
): string | undefined {
  const copies = object.attributes.filter((a) => a.copy === true)
  if (
    copies.some(
      (a) => a.column === KNOWN_MARKER || a.pair?.typeColumn === KNOWN_MARKER
    )
  ) {
    return undefined
  }
  const pairs = attributePairs(copies, "t", card)
  return pairs.length === 0
    ? `(${KNOWN_POSITION})::text`
    : `${jsonbBuildObject([`${literal(KNOWN_MARKER)}, ${KNOWN_POSITION}`, ...pairs])}::text`
}

/** Рядок ТЧ — той самий явний перелік; реквізити ТЧ лінивими не бувають. */
function lineProjection(section: RuntimeSection, alias: string): string {
  return jsonbBuildObject([
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
  `${jsonbBuildObject(sections.map((s) => `${literal(s.table.name)}, ${linesOf(s, limit)}`))}::text AS tabular`

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
  query: ReadQuery,
  known: KnownVersions | undefined
): ReadPlan | { error: CommandError } {
  // Форму з `known` уже перевірив `prepareRead`: ТЧ його не мають.
  const plan =
    "tabularSection" in query
      ? buildSectionPlan(object, query)
      : buildObjectPlan(object, query, known)
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

const rowsText = (row: string, from: string, tail: string) =>
  `SELECT ${row} AS row FROM ${from}${tail}`

/**
 * План рядків списку чи картки без ТЧ: з `known` — частинами для
 * `renderKnown`, інакше готовим оператором.
 */
function rowsPlan(
  object: RuntimeObject,
  row: string,
  tail: string,
  params: (string | null)[],
  known: KnownVersions | undefined,
  card: boolean
): ReadPlan {
  const from = `${tableOf(object)} t`
  const marker =
    known === undefined ? undefined : markerProjection(object, card)
  if (known === undefined || marker === undefined) {
    return {
      statement: { text: rowsText(row, from, tail), params },
      result: "rows",
    }
  }
  return {
    statement: {
      row,
      marker,
      from,
      key: object.key,
      version: object.versionColumn,
      tail,
      params,
    },
    known,
    result: "rows",
  }
}

function buildObjectPlan(
  object: RuntimeObject,
  query: ObjectQuery,
  known: KnownVersions | undefined
): ReadPlan | { error: CommandError } {
  const { params, bind } = binder()
  const table = tableOf(object)
  if ("id" in query) {
    const sections = cardSections(object, query.tabularSections)
    if ("error" in sections) return sections
    const id = bind(query.id, KEY_CAST)
    // Ключ — з аліасом `t`: умовне читання приєднує `simetra_known`.
    const tail = ` WHERE t.${ident(object.key)} = ${id} LIMIT 1`
    if (sections.length === 0) {
      return rowsPlan(object, cardProjection(object), tail, params, known, true)
    }
    const tabular = `, ${tabularColumn(sections, bind(LINES_LIMIT))}`
    const text = `SELECT ${cardProjection(object)} AS row${tabular} FROM ${table} t${tail}`
    return { statement: { text, params }, result: "rows", sections }
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
  let tail = `${where} ORDER BY ${order.sql} LIMIT ${bind(String(query.limit))}`
  if (query.offset !== undefined) {
    tail += ` OFFSET ${bind(String(query.offset))}`
  }
  return rowsPlan(object, listProjection(object), tail, params, known, false)
}

/** `known` плану, коли епоха бази транзакції — його епоха й не `NULL`. */
const knownIn = (
  plan: ReadPlan,
  dbEpoch: string | null
): KnownVersions | undefined =>
  plan.known !== undefined && dbEpoch !== null && plan.known.epoch === dbEpoch
    ? plan.known
    : undefined

/**
 * The statement of a plan in a transaction whose database epoch is
 * `dbEpoch` (P4-B spec §4.1): with `known` of that epoch, rows the client
 * holds at the same version come as markers; otherwise — and always for a
 * plan without `known` — the plain statement. `where`, RLS and order do not
 * change: the marker only replaces the projection of a row already selected.
 */
export function renderKnown(
  plan: ReadPlan,
  dbEpoch: string | null
): ReadStatement {
  if (plan.known === undefined) return plan.statement
  const { row, marker, from, key, version, tail, params } = plan.statement
  const known = knownIn(plan, dbEpoch)
  if (known === undefined) return { text: rowsText(row, from, tail), params }
  // Масиви — текстом масиву Postgres: порт приймає лише `string | null`.
  // Ключі — UUID, версії — цілі (перевірено `knownSchema`), тож лапки не
  // потрібні. Ключі без повторів: рядок має щонайбільше один збіг, і `JOIN`
  // не множить рядків.
  const keys = `$${params.length + 1}::${KEY_CAST}[]`
  const versions = `$${params.length + 2}::${VERSION_CAST}[]`
  const text =
    `SELECT CASE WHEN t.${ident(version)} = simetra_known.simetra_known_version` +
    ` THEN ${marker} ELSE ${row} END AS row FROM ${from}` +
    ` LEFT JOIN unnest(${keys}, ${versions}) WITH ORDINALITY` +
    ` AS simetra_known(simetra_known_key, simetra_known_version, simetra_known_position)` +
    ` ON simetra_known.simetra_known_key = t.${ident(key)}${tail}`
  return {
    text,
    params: [
      ...params,
      `{${known.keys.join(",")}}`,
      `{${known.versions.join(",")}}`,
    ],
  }
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
  rows.map((r) => decodeReadRow(object, textOf(r.row, "row")))

/**
 * ТЧ з колонки `tabular` у формі передачі (за id ТЧ) — декодує їх
 * `decodeReadRow`. Понад `TABULAR_LINES_MAX` рядків — відмова, а не
 * обрізання (Рд27): межу перевіряє T3 до декодування.
 */
function decodeSections(
  object: RuntimeObject,
  sections: readonly RuntimeSection[],
  column: unknown
): { wire: Record<string, unknown> } | { error: CommandError } {
  const tabular = parse(textOf(column, "tabular"))
  if (!isPlainObject(tabular)) throw new Error("read tabular is not an object")
  const out = new Map<string, unknown>()
  for (const section of sections) {
    const lines = tabular[section.table.name]
    if (!Array.isArray(lines)) throw new Error("read lines are not an array")
    if (lines.length > TABULAR_LINES_MAX) {
      return {
        error: withObject(
          invalid(section.name, "tabular-too-large").error,
          object
        ),
      }
    }
    out.set(section.id, linesWire(section, lines))
  }
  return { wire: Object.fromEntries(out) }
}

/** Runs one statement of a read in its transaction; `object` — its phase. */
export type ReadStatementRunner = (
  statement: ReadStatement,
  object: RuntimeObject
) => Promise<readonly Record<string, unknown>[]>

/**
 * Executes a plan through `run` — the first statement, rendered for the
 * transaction's database epoch `dbEpoch` ({@link renderKnown}), then one
 * statement per `include` target, all in the caller's transaction — and
 * builds the result; a tabular section over `TABULAR_LINES_MAX` lines is an
 * `error`. Throws what `run` throws, and on a row of the wrong shape (a
 * marker the statement could not answer among them); the caller maps the
 * latter to `command.internal`.
 */
export async function executeRead(
  object: RuntimeObject,
  plan: ReadPlan,
  run: ReadStatementRunner,
  dbEpoch: string | null
): Promise<ReadPartValue | { error: CommandError }> {
  const rows = await run(renderKnown(plan, dbEpoch), object)
  // Маркер — лише від умовного оператора: інакше позицій нема.
  const known = knownIn(plan, dbEpoch)?.keys.length ?? 0
  const result = readResult(object, plan, rows, known)
  if (plan.include === undefined || !("rows" in result)) return result
  // `known` з `include` не буває (known-form), тож маркерів серед рядків нема.
  const read = result.rows as Record<string, unknown>[]
  const included: NonNullable<ReadRows["included"]> = {}
  for (const step of plan.include) {
    const statement = includeStatement(step, read)
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
  rows: readonly Record<string, unknown>[],
  known: number
): ReadPartValue | { error: CommandError } {
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
    const decoded = decodeSections(object, sections, row.tabular)
    if ("error" in decoded) return decoded
    // Рядки ТЧ декодує той самий `decodeRow`, що й картку: власник без голови.
    const { tabularSections } = decodeReadRow(object, "{}", decoded.wire) as {
      tabularSections: Record<string, Record<string, unknown>[]>
    }
    const version = row.owner_version
    return {
      rows: tabularSections[sections[0]!.name]!,
      ...(version === null || version === undefined
        ? {}
        : { ownerVersion: decodeSafeInteger(version) }),
    }
  }
  // Картка з ТЧ `known` не має (known-form), тож маркер буває лише без ТЧ.
  if (sections.length === 0) {
    return {
      rows: rows.map((r) =>
        decodeReadRowOrMarker(object, textOf(r.row, "row"), known)
      ),
    }
  }
  const out: Record<string, unknown>[] = []
  for (const row of rows) {
    const decoded = decodeSections(object, sections, row.tabular)
    if ("error" in decoded) return decoded
    out.push(decodeReadRow(object, textOf(row.row, "row"), decoded.wire))
  }
  return { rows: out }
}

// `disposed` — суто клієнтська причина: сервер ніколи її не несе, тож issue з
// нею не має вважатися межею й витісняти справжню причину.
const LIMIT_REASON_VALUES: ReadonlySet<string> = new Set(
  Object.values(LIMIT_REASONS).filter(
    (reason) => reason !== LIMIT_REASONS.disposed
  )
)

const reasonOf = (issue: z.core.$ZodIssue): string | undefined => {
  const reason = (issue as { params?: { reason?: unknown } }).params?.reason
  return typeof reason === "string" ? reason : undefined
}

// Issue об'єднання (`invalid_union`) ховає помилки гілок у `errors` з шляхами
// відносно самого об'єднання. Розгортаємо їх у плоский список листків: шлях
// кожного дістає префікс шляху об'єднання, бо відмова називає поле входу, а не
// місце в гілці. Гілку, що не збіглася з дискримінатором (`invalid_value` на
// одному сегменті від кореня гілки, тобто літерал `type`), відкидаємо: відправник
// мав на увазі іншу форму, і її issue лише ховали б справжню відмову. Так само
// відкидаємо гілку, що забороняє наявне поле (`z.never()` — `operation` чи
// `batch` запиту `run`): пакет інакше звітував би відсутню `operation`. Якщо
// відкинуто всі гілки, лишаємо всі.
const withPath = (
  issue: z.core.$ZodIssue,
  prefix: readonly PropertyKey[]
): z.core.$ZodIssue =>
  prefix.length === 0 ? issue : { ...issue, path: [...prefix, ...issue.path] }

const leavesOf = (
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[]
): z.core.$ZodIssue[] =>
  issues.flatMap((issue) => {
    if (issue.code !== "invalid_union" || issue.errors.length === 0) {
      return [withPath(issue, prefix)]
    }
    const root = [...prefix, ...issue.path]
    const branches = issue.errors.map((branch) => ({
      leaves: leavesOf(branch, root),
      // Заборонене поле — лише власна issue гілки: `never` вкладеного
      // об'єднання відкидає його гілку, а не зовнішню.
      forbids: branch.some(
        (own) =>
          own.code === "invalid_type" &&
          own.expected === "never" &&
          own.path.length === 1
      ),
    }))
    const matched = branches.filter(
      ({ leaves, forbids }) =>
        !forbids &&
        !leaves.some(
          (leaf) =>
            leaf.code === "invalid_value" &&
            leaf.path.length === root.length + 1
        )
    )
    const kept = (matched.length > 0 ? matched : branches).flatMap(
      (branch) => branch.leaves
    )
    return kept.length > 0 ? kept : [withPath(issue, prefix)]
  })

/**
 * The issue a refusal reports, with its path from the parsed root. Branches
 * of a union are searched in order, those that failed on their discriminator
 * left out: the first issue whose `params.reason` is a limit reason, else the
 * first with any reason, else the first issue.
 */
export function decidingIssue(error: z.ZodError): z.core.$ZodIssue | undefined {
  // Причина межі важливіша за порядок: issue сусідніх полів не мають ховати,
  // що вхід завеликий. Порядок гілок у схемі фіксований, тож вибір
  // детермінований. Без причини лишається перша issue, як і до розгортання.
  const all = leavesOf(error.issues, [])
  return (
    all.find((issue) => LIMIT_REASON_VALUES.has(reasonOf(issue) ?? "")) ??
    all.find((issue) => reasonOf(issue) !== undefined) ??
    all[0]
  )
}

/**
 * Шлях відмови схеми операції — одна форма для логічного шару й конверта
 * (спека П4-B §4.0): перший сегмент шляху ТЧ — сама ТЧ, тож структурний
 * `tabularSections` прибирається, лише коли за ним щось лишається (хибний
 * сам контейнер зберігає шлях). Шлях — від операції: індекс операції пакета
 * викликач відрізає сам і повертає, коли `object` назвати не може.
 */
export function operationRefusalPath(path: readonly PropertyKey[]): string[] {
  const segments = path.map(String)
  return segments[0] === "tabularSections" && segments.length > 1
    ? segments.slice(1)
    : segments
}

/** The `params.reason` of the first Zod issue that carries one. */
export function issueReason(error: z.ZodError): string | undefined {
  const issue = decidingIssue(error)
  return issue === undefined ? undefined : reasonOf(issue)
}

/**
 * Checks a read query, and the rows it knows when it is a part of a `read`
 * request, against the catalog and builds its plan; every failure is
 * `command.invalid` before the database. `known` is allowed only where
 * `knownFormAllowed` allows it, else `reason: "known-form"`.
 */
export function prepareRead(
  catalog: RuntimeCatalog,
  query: unknown,
  known?: unknown
): { object: RuntimeObject; plan: ReadPlan } | { error: CommandError } {
  let parsed: ReturnType<typeof readQuerySchema.safeParse>
  try {
    parsed = readQuerySchema.safeParse(query)
  } catch {
    // Геттер, що кидає, чи відкликаний `Proxy` у запиті.
    return { error: { code: "command.invalid" } }
  }
  if (!parsed.success)
    return { error: readRefusal(catalog, query, parsed.error) }
  const object = objectOf(catalog, parsed.data.object)
  // Невідомий об'єкт — виняток правила `object`: прив'язати шлях нема до чого.
  if (object === undefined) {
    return { error: { code: "command.invalid", path: "object" } }
  }
  const versions = checkKnown(parsed.data, known)
  if (versions !== undefined && "error" in versions) {
    return { error: withObject(versions.error, object) }
  }
  const plan = buildReadPlan(catalog, object, parsed.data, versions)
  // Шляхи будівника й фільтра — відносно об'єкта запиту.
  return "error" in plan
    ? { error: withObject(plan.error, object) }
    : { object, plan }
}

/**
 * `known` частини: спершу форма запиту (як препроцесор конверта), потім
 * сама схема. Будівник пише ключі й версії в текст масиву, тож без цієї
 * перевірки до бази не йде нічого.
 */
function checkKnown(
  query: ReadQuery,
  known: unknown
): KnownVersions | { error: CommandError } | undefined {
  if (known === undefined) return undefined
  if (!knownFormAllowed(query)) return invalid("known", "known-form")
  let parsed: ReturnType<typeof knownSchema.safeParse>
  try {
    parsed = knownSchema.safeParse(known)
  } catch {
    return invalid("known")
  }
  if (parsed.success) return parsed.data
  const path = (decidingIssue(parsed.error)?.path ?? []).map(String)
  return invalid(["known", ...path].join("."), issueReason(parsed.error))
}

const objectOf = (
  catalog: RuntimeCatalog,
  ref: { kind: string; name: string }
): RuntimeObject | undefined =>
  catalog.objects.find((o) => o.kind === ref.kind && o.name === ref.name)

/**
 * Відмова схеми запиту: `object` — лише коли сирий `object` відомий каталогу
 * (читання — у `try`: геттер чи `Proxy` може кинути). Ключ картки `{ object,
 * id }` у шляху — `keyName` об'єкта (спека П4-B §4.0): структурне `id` на
 * дроті не відрізнити від колонки ключа `id`.
 */
function readRefusal(
  catalog: RuntimeCatalog,
  query: unknown,
  error: z.ZodError
): CommandError {
  const reason = issueReason(error)
  const segments = (decidingIssue(error)?.path ?? []).map(String)
  let object: RuntimeObject | undefined
  try {
    const ref = metadataRefSchema.safeParse(
      (query as { object?: unknown } | null | undefined)?.object
    )
    object = ref.success ? objectOf(catalog, ref.data) : undefined
  } catch {
    object = undefined
  }
  if (object !== undefined && segments[0] === "id") {
    segments[0] = object.keyName
  }
  const refusal: CommandError = {
    code: "command.invalid",
    ...(reason === undefined ? {} : { reason }),
    ...(segments.length === 0 ? {} : { path: segments.join(".") }),
  }
  return object === undefined ? refusal : withObject(refusal, object)
}
