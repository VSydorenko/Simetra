/**
 * Обхід плану `EXPLAIN (FORMAT JSON)` для DB-перевірок форми плану: вузли
 * плоским списком з тим, що читають перевірки, — тип, таблиця, індекси й
 * умови індексного доступу (не `Filter`), відношення до батька.
 */

/** Вузол плану в тій формі, яку перевіряють тести. */
export interface PlanNode {
  type: string
  relation?: string
  /** Індекси вузла; для `Bitmap Heap Scan` — індекси його бітових карт. */
  indexes: string[]
  /** `Index Cond` і `Recheck Cond`; для `Bitmap Heap Scan` — і умови його бітових карт. */
  conditions: string[]
  /** `Parent Relationship`: `InitPlan`, `SubPlan`, `Outer`, … */
  parent?: string
  loops?: number
  filter?: string
}

type Raw = Record<string, unknown>

const isObject = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

const children = (node: Raw): Raw[] =>
  Array.isArray(node.Plans) ? node.Plans.filter(isObject) : []

/** Вузли бітових карт під `Bitmap Heap Scan`: вони читають індекс за нього. */
const BITMAP_PARTS = new Set(["Bitmap Index Scan", "BitmapAnd", "BitmapOr"])

function bitmapParts(node: Raw): Raw[] {
  return children(node)
    .filter((c) => BITMAP_PARTS.has(String(c["Node Type"])))
    .flatMap((c) => [c, ...bitmapParts(c)])
}

function access(node: Raw): Pick<PlanNode, "indexes" | "conditions"> {
  const own = [node]
  // Умова межі на `Bitmap Heap Scan` стоїть у дочірніх `Bitmap Index Scan`:
  // без них вузол таблиці мав би лише `Recheck Cond`.
  const parts =
    node["Node Type"] === "Bitmap Heap Scan"
      ? [...own, ...bitmapParts(node)]
      : own
  return {
    indexes: parts.flatMap((p) => text(p["Index Name"]) ?? []),
    conditions: parts.flatMap((p) =>
      [text(p["Index Cond"]), text(p["Recheck Cond"])].flatMap((c) => c ?? [])
    ),
  }
}

/** Усі вузли плану: результат `EXPLAIN (FORMAT JSON)`, його `Plan` чи вузол. */
export function planNodes(plan: unknown): PlanNode[] {
  if (Array.isArray(plan)) return plan.flatMap(planNodes)
  if (!isObject(plan)) return []
  if (isObject(plan.Plan)) return planNodes(plan.Plan)
  if (typeof plan["Node Type"] !== "string") return []
  const node: PlanNode = { type: plan["Node Type"], ...access(plan) }
  const relation = text(plan["Relation Name"])
  if (relation !== undefined) node.relation = relation
  const parent = text(plan["Parent Relationship"])
  if (parent !== undefined) node.parent = parent
  const loops = plan["Actual Loops"]
  if (typeof loops === "number") node.loops = loops
  const filter = text(plan.Filter)
  if (filter !== undefined) node.filter = filter
  return [node, ...children(plan).flatMap(planNodes)]
}

/**
 * Вузли-підплани (`Parent Relationship = 'SubPlan'`), зокрема хешовані:
 * корельований підзапит під OR Postgres може захешувати з одним циклом, тож
 * без умови на цикли.
 */
export const subPlans = (plan: unknown): PlanNode[] =>
  planNodes(plan).filter((n) => n.parent === "SubPlan")

/** Вузли, що читають таблицю `table`. */
export const scansOf = (plan: unknown, table: string): PlanNode[] =>
  planNodes(plan).filter((n) => n.relation === table)
