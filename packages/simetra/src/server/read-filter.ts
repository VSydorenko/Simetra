import {
  UUID_TEXT,
  encodePair,
  isWithinType,
  type CommandError,
  type Filter,
  type FilterCondition,
  type FilterOperator,
  type RuntimeAttribute,
} from "simetra/model"
import { ident } from "./read"
import { encodeParam } from "./values"

/**
 * Фільтр-дерево запиту читання → умова SQL (спека П4-B §4.1, §4.2). Форму
 * дерева вже перевірив `filterSchema` T0; тут — проти каталогу: ім'я лише з
 * мапи колонок, оператор за типом, значення — тим самим кодуванням, що й
 * команда. Ідентифікатори — з каталогу через `ident`, значення — лише
 * зв'язаними параметрами.
 */

/** A column a filter may name: from the catalog, never from the query. */
export interface FilterColumn {
  /** Logical name in the query. */
  name: string
  column: string
  castType: string
  type: RuntimeAttribute["type"] | "Key" | "Version" | "Parent" | "LineNumber"
  /** The catalog attribute; absent for the key, version, parent and line number. */
  attribute?: RuntimeAttribute
  lazy: boolean
}

// Мітка пари — текст: її тип задає платформа, у каталозі `castType` немає.
const LABEL_CAST = "text"

const COMPARISON: Partial<Record<FilterOperator, string>> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
}

/** Частина умови: текст або значення, яке ще треба зв'язати. */
type Part = string | { value: string | null; cast: string }

class Refusal {
  constructor(readonly error: CommandError) {}
}

const refuse = (path: string, reason?: string): never => {
  throw new Refusal({
    code: "command.invalid",
    path,
    ...(reason === undefined ? {} : { reason }),
  })
}

/** Чи оператор має сенс для типу колонки (спека П4-B §4.1). */
function allows(column: FilterColumn, op: FilterOperator): boolean {
  const attribute = column.attribute
  const pair = attribute?.pair !== undefined
  const array = attribute?.array === true
  switch (op) {
    case "isNull":
      return true
    case "contains":
    case "startsWith":
      return (column.type === "String" || column.type === "Text") && !array
    case "eq":
    case "ne":
    case "in":
      // Json і масив рівністю не порівнюються; `Raw` пише лише платформа.
      return !array && column.type !== "Json" && column.type !== "Raw"
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return (
        !array &&
        !pair &&
        column.type !== "Json" &&
        column.type !== "Bytes" &&
        column.type !== "Raw"
      )
  }
}

/** Одне не-`null` скалярне значення як текст параметра. */
function scalar(column: FilterColumn, value: unknown, path: string): string {
  switch (column.type) {
    case "Key":
    case "Parent":
      return typeof value === "string" && UUID_TEXT.test(value)
        ? value
        : refuse(path)
    // Версія — `bigint`: безпечне ціле JS у його межах.
    case "Version":
      return Number.isSafeInteger(value) ? String(value) : refuse(path)
    // Номер рядка — `$n::integer`: значення поза int4 дало б 22003, тобто
    // command.internal замість відмови з шляхом.
    case "LineNumber":
      return typeof value === "number" &&
        isWithinType({ type: "Integer" }, value)
        ? String(value)
        : refuse(path)
    default: {
      const encoded = encodeParam(column.attribute!, value, path)
      return "error" in encoded ? refuse(path) : (encoded.value ?? refuse(path))
    }
  }
}

/** Рівність пари: мітка й id — дві рівності в дужках. */
function pairEquals(
  column: FilterColumn,
  value: unknown,
  path: string
): Part[] {
  const attribute = column.attribute!
  const pair = encodePair(attribute, value, path)
  if ("error" in pair) return refuse(path)
  return [
    `(${ident(attribute.pair!.typeColumn)} = `,
    { value: pair.value.label, cast: LABEL_CAST },
    ` AND ${ident(column.column)} = `,
    { value: pair.value.id, cast: column.castType },
    ")",
  ]
}

/** Екранування шаблону `ILIKE` (типовий `ESCAPE '\'`): значення — літерал. */
const escapePattern = (text: string) => text.replace(/[\\%_]/g, "\\$&")

function condition(
  node: FilterCondition,
  columns: ReadonlyMap<string, FilterColumn>,
  path: string
): Part[] {
  const column = columns.get(node.attribute)
  if (column === undefined) return refuse(`${path}.attribute`)
  // Списочна форма лінивої колонки не має (Рд25): фільтр за нею — відмова.
  if (column.lazy) return refuse(`${path}.attribute`, "lazy")
  const { op, value } = node
  if (!allows(column, op)) return refuse(`${path}.op`)
  const name = ident(column.column)
  const pairColumn = column.attribute?.pair
  const valuePath = `${path}.value`
  if (op === "isNull") {
    return pairColumn === undefined
      ? [`${name} IS NULL`]
      : [`(${ident(pairColumn.typeColumn)} IS NULL AND ${name} IS NULL)`]
  }
  // `= NULL` у тризначній логіці SQL мовчки дав би порожню множину (В5).
  const notNull = (item: unknown, at: string, reason?: string) => {
    if (item === null) refuse(at, reason)
    return item
  }
  if (op === "in") {
    const items = (value as unknown[]).map((item, i) =>
      notNull(item, `${valuePath}.${i}`, "use-isNull")
    )
    if (pairColumn !== undefined) {
      const pairs = items.map((item, i) =>
        pairEquals(column, item, `${valuePath}.${i}`)
      )
      return [
        "(",
        ...pairs.flatMap((p, i) => (i === 0 ? p : [" OR ", ...p])),
        ")",
      ]
    }
    // Параметр на елемент, а не літерал масиву Postgres: елемент не
    // розбирається синтаксисом масиву (`NULL`, кома, лапки, `\`).
    const elements = items.map((item, i): Part => ({
      value: scalar(column, item, `${valuePath}.${i}`),
      cast: column.castType,
    }))
    return [
      `${name} = ANY(ARRAY[`,
      ...elements.flatMap((e, i) => (i === 0 ? [e] : [", ", e])),
      "])",
    ]
  }
  if (op === "contains" || op === "startsWith") {
    const text = scalar(column, notNull(value, valuePath), valuePath)
    const pattern = `${op === "contains" ? "%" : ""}${escapePattern(text)}%`
    return [`${name} ILIKE `, { value: pattern, cast: "text" }]
  }
  notNull(
    value,
    valuePath,
    op === "eq" || op === "ne" ? "use-isNull" : undefined
  )
  if (pairColumn !== undefined) {
    const equals = pairEquals(column, value, valuePath)
    return op === "eq" ? equals : ["NOT ", ...equals]
  }
  return [
    `${name} ${COMPARISON[op]} `,
    { value: scalar(column, value, valuePath), cast: column.castType },
  ]
}

function node(
  filter: Filter,
  columns: ReadonlyMap<string, FilterColumn>,
  path: string
): Part[] {
  if ("not" in filter) {
    return ["NOT (", ...node(filter.not, columns, `${path}.not`), ")"]
  }
  if ("and" in filter || "or" in filter) {
    const [key, children] =
      "and" in filter
        ? (["and", filter.and] as const)
        : (["or", filter.or] as const)
    const parts = children.map((child, i) =>
      node(child, columns, `${path}.${key}.${i}`)
    )
    const glue = ` ${key.toUpperCase()} `
    return ["(", ...parts.flatMap((p, i) => (i === 0 ? p : [glue, ...p])), ")"]
  }
  return condition(filter, columns, path)
}

/**
 * Renders a filter tree against the catalog columns. Every refusal is
 * `command.invalid` with the input path and comes before any `bind`: the
 * statement's parameter list stays untouched.
 */
export function renderFilter(
  filter: Filter,
  columns: ReadonlyMap<string, FilterColumn>,
  bind: (value: string | null, cast: string) => string,
  path: string
): { sql: string } | { error: CommandError } {
  let parts: Part[]
  try {
    parts = node(filter, columns, path)
  } catch (error) {
    if (error instanceof Refusal) return { error: error.error }
    throw error
  }
  // Зв'язування — лише після перевірки всього дерева.
  return {
    sql: parts
      .map((part) =>
        typeof part === "string" ? part : bind(part.value, part.cast)
      )
      .join(""),
  }
}

/**
 * The owner id of a top-level `<parent> eq <id>` conjunct: the filter itself
 * or a direct operand of the root `and`. Під `or`, `not` чи `in` власник не
 * один, тож `undefined`.
 */
export function topLevelParentEq(
  filter: Filter | undefined,
  parentName: string
): unknown {
  if (filter === undefined) return undefined
  const conjuncts = "and" in filter ? filter.and : [filter]
  for (const conjunct of conjuncts) {
    if (
      "attribute" in conjunct &&
      conjunct.attribute === parentName &&
      conjunct.op === "eq"
    ) {
      return conjunct.value
    }
  }
  return undefined
}
