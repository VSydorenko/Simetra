import { z } from "zod"
import { metadataRefSchema } from "../schemas/metadata-ref"

/** Operators of a filter condition (P4-B spec §4.1). */
export const FILTER_OPERATORS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "isNull",
  "contains",
  "startsWith",
] as const

export type FilterOperator = (typeof FILTER_OPERATORS)[number]

/** Upper bound of values in one `in` condition. */
export const FILTER_IN_MAX = 200
/** Upper bound of filter tree depth; a condition alone has depth 1. */
export const FILTER_DEPTH_MAX = 8
/** Upper bound of filter tree nodes, combinators included. */
export const FILTER_NODES_MAX = 64

/** A leaf of the filter tree: one attribute, one operator. */
export interface FilterCondition {
  attribute: string
  op: FilterOperator
  value?: unknown
}

/** A read filter: a tree of `and`, `or`, `not` over conditions. */
export type Filter =
  { and: Filter[] } | { or: Filter[] } | { not: Filter } | FilterCondition

const conditionSchema = z
  .strictObject({
    attribute: z.string(),
    op: z.enum(FILTER_OPERATORS),
    value: z.unknown().optional(),
  })
  .superRefine((condition, ctx) => {
    const { op, value } = condition
    const fail = (message: string) =>
      ctx.addIssue({ code: "custom", path: ["value"], message })
    if (op === "isNull") {
      if (value !== undefined) fail("isNull takes no value")
    } else if (op === "in") {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > FILTER_IN_MAX
      ) {
        fail(`in takes an array of 1 to ${FILTER_IN_MAX} values`)
      }
    } else if (value === undefined) {
      fail(`${op} takes a value`)
    }
  })

const nodeSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(nodeSchema).min(1) }),
    z.strictObject({ or: z.array(nodeSchema).min(1) }),
    z.strictObject({ not: nodeSchema }),
    conditionSchema,
  ])
)

// Порядок гілок `nodeSchema`: гілку вузла обирає наявний ключ.
const NODE_KEYS = ["and", "or", "not", "attribute"] as const

const objectAt = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/**
 * Чи дерево в межах глибини й кількості вузлів. Рахує до розбору й
 * зупиняється на першому перевищенні: вороже дерево глибиною в тисячі не
 * доходить до рекурсивного розбору Zod.
 */
function withinLimits(root: unknown): boolean {
  let nodes = 0
  const walk = (value: unknown, depth: number): boolean => {
    if (++nodes > FILTER_NODES_MAX || depth > FILTER_DEPTH_MAX) return false
    const node = objectAt(value)
    if (node === undefined) return true
    // Усі наявні ключі, а не перший: вузол з `and` і `or` (чи `not`) суворий
    // union однаково відхилить, але лише після рекурсії Zod у глибину другого.
    for (const key of ["and", "or"] as const) {
      const children = node[key]
      if (
        Array.isArray(children) &&
        !children.every((child) => walk(child, depth + 1))
      ) {
        return false
      }
    }
    return "not" in node ? walk(node.not, depth + 1) : true
  }
  return walk(root, 1)
}

const valueAt = (root: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null
        ? (value as Record<PropertyKey, unknown>)[key]
        : undefined,
    root
  )

/**
 * Точне місце відмови. Суворий union Zod 4 на невідомому операторі чи полі
 * дає `invalid_union` на самому вузлі й губить шлях усередині; гілку вузла
 * обирає наявний ключ, тож шлях іде в помилки саме цієї гілки. Вузол без
 * жодного з ключів — невідомий вузол: відмова на його шляху.
 */
function located(
  issue: z.core.$ZodIssue,
  root: unknown,
  base: readonly PropertyKey[]
): { path: PropertyKey[]; message: string } {
  const path = [...base, ...issue.path]
  if (issue.code !== "invalid_union") return { path, message: issue.message }
  const node = objectAt(valueAt(root, path))
  const branch =
    node === undefined ? -1 : NODE_KEYS.findIndex((key) => key in node)
  const [inner] = branch === -1 ? [] : (issue.errors[branch] ?? [])
  return inner === undefined
    ? { path, message: "unknown filter node" }
    : located(inner, root, path)
}

/**
 * A read filter tree (P4-B spec §4.1): `{ and }`, `{ or }`, `{ not }` and
 * `{ attribute, op, value? }`, bounded in depth, nodes and `in` values.
 */
export const filterSchema: z.ZodType<Filter> = z.preprocess((value, ctx) => {
  if (!withinLimits(value)) {
    ctx.addIssue({
      code: "custom",
      message: `filter exceeds ${FILTER_DEPTH_MAX} levels or ${FILTER_NODES_MAX} nodes`,
    })
    return value
  }
  const parsed = nodeSchema.safeParse(value)
  if (!parsed.success) {
    const [issue] = parsed.error.issues
    if (issue !== undefined) {
      ctx.addIssue({ code: "custom", ...located(issue, value, []) })
    }
  }
  return value
}, nodeSchema)

/** Upper bound of one server read page (P4-B spec §4.1). */
export const READ_LIMIT_MAX = 200
/** Upper bound of `offset`; deeper pages go by keyset. */
export const READ_OFFSET_MAX = 10_000
/** Upper bound of a count; past it the count comes `capped`. */
export const READ_COUNT_CAP = 10_000
/** Upper bound of `orderBy` attributes, the key aside: the key may follow last. */
export const ORDER_BY_MAX = 4

/**
 * Sort order of a page: catalog attributes, then the key. The key goes only
 * last; without it the server appends the key ascending.
 */
export const orderBySchema = z
  .array(
    z.strictObject({
      attribute: z.string(),
      direction: z.enum(["asc", "desc"]),
      nulls: z.enum(["first", "last"]).optional(),
    })
  )
  .min(1)
  .max(ORDER_BY_MAX + 1)

export type OrderBy = z.infer<typeof orderBySchema>

/** Upper bound of `include` attributes in one read (P4-B decision В10). */
export const INCLUDE_MAX = 16
/**
 * Upper bound of lines of one tabular section a read returns whole; past it
 * the read is refused with `tabular-too-large`, never truncated.
 */
export const TABULAR_LINES_MAX = 5_000

/** Непорожній перелік імен, кожне — один раз (шлях відмови — на дублі). */
const uniqueNames = (max?: number) => {
  const names = z.array(z.string()).min(1)
  return (max === undefined ? names : names.max(max)).superRefine(
    (list, ctx) => {
      list.forEach((name, i) => {
        if (list.indexOf(name) !== i) {
          ctx.addIssue({ code: "custom", path: [i], message: "repeated name" })
        }
      })
    }
  )
}

/**
 * Single-target `Ref` attributes whose target rows come along with the read,
 * each named once.
 */
export const includeSchema = uniqueNames(INCLUDE_MAX)

const cardQuerySchema = z.strictObject({
  object: metadataRefSchema,
  id: z.guid(),
  /** `true` — every section; otherwise the named ones. */
  tabularSections: z.union([z.literal(true), uniqueNames()]).optional(),
  include: includeSchema.optional(),
})
const listQuerySchema = z.strictObject({
  object: metadataRefSchema,
  where: filterSchema.optional(),
  orderBy: orderBySchema.optional(),
  offset: z.int().min(0).max(READ_OFFSET_MAX).optional(),
  limit: z.int().min(1).max(READ_LIMIT_MAX),
  include: includeSchema.optional(),
})
const countQuerySchema = z.strictObject({
  object: metadataRefSchema,
  where: filterSchema.optional(),
  count: z.literal(true),
})

const ownerLinesQuerySchema = z.strictObject({
  object: metadataRefSchema,
  tabularSection: z.string(),
  owner: z.guid(),
})
const sectionListQuerySchema = z.strictObject({
  object: metadataRefSchema,
  tabularSection: z.string(),
  where: filterSchema.optional(),
  orderBy: orderBySchema.optional(),
  offset: z.int().min(0).max(READ_OFFSET_MAX).optional(),
  limit: z.int().min(1).max(READ_LIMIT_MAX),
})
const sectionCountQuerySchema = z.strictObject({
  object: metadataRefSchema,
  tabularSection: z.string(),
  where: filterSchema.optional(),
  count: z.literal(true),
})

/** The six forms of a read, in the order {@link queryFormSchema} expects. */
export type QueryForms = readonly [
  card: z.ZodType,
  list: z.ZodType,
  count: z.ZodType,
  ownerLines: z.ZodType,
  sectionList: z.ZodType,
  sectionCount: z.ZodType,
]

/**
 * Форму обирає наявний ключ: `tabularSection` — форми ТЧ (`owner` — «ТЧ
 * власника», `count` — лічильник, інакше сторінка); `id` — картка, `count` —
 * лічильник, інакше список. Індекс — у порядку {@link QueryForms}.
 */
function formIndex(value: unknown): 0 | 1 | 2 | 3 | 4 | 5 {
  const query = objectAt(value) ?? {}
  if ("tabularSection" in query) {
    if ("owner" in query) return 3
    return "count" in query ? 5 : 4
  }
  if ("id" in query) return 0
  return "count" in query ? 2 : 1
}

/**
 * A read query schema over its six forms: the form is picked by its keys
 * before parsing, so a refusal keeps its path. Shared by the logical and the
 * wire form of a read, so both pick a form by one rule. Суворий union Zod 4
 * губить шлях відмови (`invalid_union` на корені), тож union лишається для
 * типу й JSON-схеми входу MCP.
 */
export function queryFormSchema<const F extends QueryForms>(forms: F) {
  return z.preprocess((value, ctx) => {
    const parsed = forms[formIndex(value)].safeParse(value)
    if (!parsed.success) {
      const [issue] = parsed.error.issues
      if (issue !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        })
      }
    }
    return value
  }, z.union(forms))
}

/**
 * A server read (P4-B spec §4.1): a card by id (with its tabular sections),
 * a page by filter tree, or a capped count; a card and a page may include the
 * rows of `Ref` targets. A tabular section is read as the lines of one owner,
 * a page or a count.
 */
export const readQuerySchema = queryFormSchema([
  cardQuerySchema,
  listQuerySchema,
  countQuerySchema,
  ownerLinesQuerySchema,
  sectionListQuerySchema,
  sectionCountQuerySchema,
])

export type ReadQuery = z.infer<typeof readQuerySchema>

/** Rows of a read in the logical form: decoded, keyed by logical names. */
export interface ReadRows {
  rows: Record<string, unknown>[]
  /** Rows of included targets keyed `"<kind>.<name>"`. */
  included?: Record<string, Record<string, unknown>[]>
  /** The owner version read by the same statement as the tabular rows. */
  ownerVersion?: number
}

/** A count under RLS; `capped` — there are more than {@link READ_COUNT_CAP}. */
export interface ReadCount {
  count: number
  capped?: true
}

export type ReadResult = ReadRows | ReadCount

/** The result shape of a query: a count query counts, any other reads rows. */
export type ReadResultOf<Q> = Q extends { count: true } ? ReadCount : ReadRows
