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
  /**
   * Гілки індексного доступу: кожен `Bitmap Index Scan` під `Bitmap Heap Scan`
   * чи сам `Index Scan` / `Index Only Scan` — індекс і його `Index Cond`
   * (порожня, якщо індекс читається без умови).
   */
  arms: IndexArm[]
  /** `Parent Relationship`: `InitPlan`, `SubPlan`, `Outer`, … */
  parent?: string
  loops?: number
  filter?: string
}

/** Одна гілка індексного доступу вузла таблиці. */
export interface IndexArm {
  index: string
  condition: string
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

function access(node: Raw): Pick<PlanNode, "indexes" | "conditions" | "arms"> {
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
    // Гілка — вузол, що сам читає індекс (має `Index Name`): `BitmapOr` /
    // `BitmapAnd` лише зводять бітові карти своїх гілок.
    arms: parts.flatMap((p) => {
      const index = text(p["Index Name"])
      return index === undefined
        ? []
        : [{ index, condition: text(p["Index Cond"]) ?? "" }]
    }),
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

const subtree = (node: Raw): Raw[] => [node, ...children(node).flatMap(subtree)]

/**
 * Підплани, що виконуються більше одного разу й читають CTE (`CTE Scan` у
 * піддереві): корельований підзапит над матеріалізованим CTE перечитує його
 * на кожен зовнішній рядок — квадратично за обсягом CTE (Р2d2-22). Хешований
 * підплан виконується раз і сюди не потрапляє.
 */
export function correlatedCteSubPlans(plan: unknown): PlanNode[] {
  if (Array.isArray(plan)) return plan.flatMap(correlatedCteSubPlans)
  if (!isObject(plan)) return []
  if (isObject(plan.Plan)) return correlatedCteSubPlans(plan.Plan)
  if (typeof plan["Node Type"] !== "string") return []
  const loops = plan["Actual Loops"]
  const own =
    plan["Parent Relationship"] === "SubPlan" &&
    typeof loops === "number" &&
    loops > 1 &&
    subtree(plan).some((n) => n["Node Type"] === "CTE Scan")
      ? planNodes(plan).slice(0, 1)
      : []
  return [...own, ...children(plan).flatMap(correlatedCteSubPlans)]
}

/** Імена функцій, які план читає `Function Scan`. */
export const functionScans = (plan: unknown): string[] =>
  rawNodes(plan).flatMap((n) => text(n["Function Name"]) ?? [])

function rawNodes(plan: unknown): Raw[] {
  if (Array.isArray(plan)) return plan.flatMap(rawNodes)
  if (!isObject(plan)) return []
  if (isObject(plan.Plan)) return rawNodes(plan.Plan)
  return typeof plan["Node Type"] === "string" ? subtree(plan) : []
}
