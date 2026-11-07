import {
  INTEGER_TEXT,
  isTextEncodedType,
  ORDER_BY_MAX,
  READ_COUNT_CAP,
  readQuerySchema,
  type BaseCastType,
  type CommandError,
  type OrderBy,
  type ReadQuery,
  type ReadResult,
  type RuntimeAttribute,
  type RuntimeCatalog,
  type RuntimeObject,
} from "simetra/model"
import type { z } from "zod"
import { decodeRow } from "./decode"
import { renderFilter, type FilterColumn } from "./read-filter"

// Ключ і версія в каталозі без `castType`: їхній тип задає платформа.
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
  /** `rows` — a `row` text column per row; `count` — one row with `n`. */
  result: "rows" | "count"
}

// `jsonb_build_object` приймає до 100 аргументів: шматок — до 50 пар.
const PAIRS_PER_CALL = 50

/** Пара `'<колонка>', t."<колонка>"` проєкції, з текстовим приведенням Рт1. */
const pairOf = (column: string, cast?: string) =>
  `${literal(column)}, t.${ident(column)}${cast === undefined ? "" : `::${cast}`}`

const textCast = (attribute: RuntimeAttribute) =>
  !isTextEncodedType(attribute.pgType)
    ? undefined
    : attribute.array === true
      ? "text[]"
      : "text"

/**
 * Рядок картки — та сама форма, що й результат ядра (`to_jsonb` і
 * `numeric`/`bigint` текстом, Рт1), тож декодує його той самий `decodeRow`.
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
  const pairs = [pairOf(object.key), pairOf(object.versionColumn)]
  for (const attribute of object.attributes) {
    if (attribute.load === "lazy") continue
    if (attribute.pair !== undefined) {
      pairs.push(pairOf(attribute.pair.typeColumn))
    }
    pairs.push(pairOf(attribute.column, textCast(attribute)))
  }
  const calls: string[] = []
  for (let i = 0; i < pairs.length; i += PAIRS_PER_CALL) {
    calls.push(
      `jsonb_build_object(${pairs.slice(i, i + PAIRS_PER_CALL).join(", ")})`
    )
  }
  return calls.length === 1
    ? `${calls[0]}::text`
    : `(${calls.join(" || ")})::text`
}

/**
 * Колонки, які запит може назвати: реквізити, ключ і версія об'єкта — лише з
 * каталогу. Тип приведення — без модифікатора: `$n::character varying(10)`
 * обрізав би значення фільтра й знайшов би рядок з іншим значенням.
 */
function objectColumns(object: RuntimeObject): Map<string, FilterColumn> {
  const columns = new Map<string, FilterColumn>()
  columns.set(object.keyName, {
    name: object.keyName,
    column: object.key,
    castType: KEY_CAST,
    type: "Key",
    lazy: false,
  })
  columns.set(object.versionName, {
    name: object.versionName,
    column: object.versionColumn,
    castType: VERSION_CAST,
    type: "Version",
    lazy: false,
  })
  for (const attribute of object.attributes) {
    columns.set(attribute.name, {
      name: attribute.name,
      column: attribute.column,
      castType: attribute.castType,
      type: attribute.type,
      attribute,
      lazy: attribute.load === "lazy",
    })
  }
  return columns
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

/**
 * `ORDER BY` сторінки: реквізити запиту, потім ключ (В4) — порядок сталий, і
 * keyset-умові фільтра є на що спертися. Без явного `COLLATE` (Рд29). Ключ
 * не останнім і понад `ORDER_BY_MAX` реквізитів відхиляє будівник, а не
 * схема: ім'я ключа знає лише каталог.
 */
function orderClause(
  object: RuntimeObject,
  columns: ReadonlyMap<string, FilterColumn>,
  orderBy: OrderBy | undefined
): { sql: string } | { error: CommandError } {
  const entries = orderBy ?? []
  const keyAt = entries.findIndex((e) => e.attribute === object.keyName)
  if (keyAt !== -1 && keyAt !== entries.length - 1) {
    return invalid(`orderBy.${keyAt}`)
  }
  if (entries.length - (keyAt === -1 ? 0 : 1) > ORDER_BY_MAX) {
    return invalid("orderBy")
  }
  const terms: string[] = []
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
    terms.push(`${ident(column.column)}${direction}${nulls}`)
  }
  if (keyAt === -1) terms.push(ident(object.key))
  return { sql: terms.join(", ") }
}

/**
 * Builds the plan of a read form (P4-B spec §4.2) from the catalog and bound
 * parameters only; every refusal is `command.invalid` with its input path.
 */
function buildReadPlan(
  object: RuntimeObject,
  query: ReadQuery
): ReadPlan | { error: CommandError } {
  const params: (string | null)[] = []
  const bind = (value: string | null, cast: string) => {
    params.push(value)
    return `$${params.length}::${cast}`
  }
  const table = `${ident(object.table.schema)}.${ident(object.table.name)}`
  if ("id" in query) {
    const text =
      `SELECT ${cardProjection(object)} AS row FROM ${table} t` +
      ` WHERE ${ident(object.key)} = ${bind(query.id, KEY_CAST)} LIMIT 1`
    return { statement: { text, params }, result: "rows" }
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
    params.push(String(READ_COUNT_CAP + 1))
    const text =
      `SELECT count(*) AS n FROM (SELECT 1 FROM ${table} t${where}` +
      ` LIMIT $${params.length}) c`
    return { statement: { text, params }, result: "count" }
  }
  const order = orderClause(object, columns, query.orderBy)
  if ("error" in order) return order
  params.push(String(query.limit))
  let text =
    `SELECT ${listProjection(object)} AS row FROM ${table} t${where}` +
    ` ORDER BY ${order.sql} LIMIT $${params.length}`
  if (query.offset !== undefined) {
    params.push(String(query.offset))
    text += ` OFFSET $${params.length}`
  }
  return { statement: { text, params }, result: "rows" }
}

/**
 * Turns the rows of a plan's statement into the result. Throws on a row of
 * the wrong shape; the caller maps it to `command.internal`.
 */
export function readResult(
  object: RuntimeObject,
  plan: ReadPlan,
  rows: readonly Record<string, unknown>[]
): ReadResult {
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
    return count > READ_COUNT_CAP
      ? { count: READ_COUNT_CAP, capped: true }
      : { count }
  }
  return {
    rows: rows.map((r) => {
      if (typeof r.row !== "string") throw new Error("read row is not text")
      return decodeRow(object, r.row)
    }),
  }
}

/** The input path of the first Zod issue; `undefined` — the input root. */
export function issuePath(error: z.ZodError): string | undefined {
  const [issue] = error.issues
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
    return {
      error: {
        code: "command.invalid",
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
  const plan = buildReadPlan(object, parsed.data)
  return "error" in plan ? plan : { object, plan }
}
