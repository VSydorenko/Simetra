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
 * Читання CTE, виконане більше одного разу (`CTE Scan` з `Actual Loops > 1`):
 * матеріалізований CTE перечитується на кожен зовнішній рядок — квадратично
 * за обсягом CTE (спека прав §5.4). Так виглядає і корельований підплан
 * над CTE, і внутрішній бік вкладеного циклу (`Nested Loop`, зокрема anti
 * join `NOT EXISTS`), тож перевірка не залежить від форми вузла, що
 * повторює читання. Хешований підплан і бік хеш-з'єднання читають CTE раз.
 */
export function repeatedCteScans(
  plan: unknown,
  constants: ReadonlySet<string> = new Set()
): { cte: string; loops: number }[] {
  return rawPaths(plan).flatMap(({ node, path }) => {
    const loops = node["Actual Loops"]
    return node["Node Type"] === "CTE Scan" &&
      typeof loops === "number" &&
      loops > 1 &&
      !(constants.size > 0 && loopsOverConstants(path, node, constants))
      ? [{ cte: text(node["CTE Name"]) ?? "", loops }]
      : []
  })
}

/**
 * Чи кожне повторення читання `node` дає зовнішня сторона `Nested Loop`,
 * виведена лише зі сталих функцій `constants` (рішення архітекторки плану
 * Права-3): тоді число циклів — розмір сталої компіляції, а не скоупів, і
 * вартість лінійна за CTE. Судить дерево плану, а не текст: шлях від вузла
 * до кореня не перетинає `SubPlan` (корельований підплан повторюється на
 * рядок даних), кожен `Nested Loop`, у внутрішній стороні якого лежить
 * вузол, має зовнішню сторону, всі листки якої — `Function Scan` сталих
 * функцій чи `Result`, і такий цикл є хоч один — інакше повторення нічим не
 * пояснене.
 */
function loopsOverConstants(
  path: readonly Raw[],
  node: Raw,
  constants: ReadonlySet<string>
): boolean {
  let child = node
  let looped = false
  for (const ancestor of [...path].reverse()) {
    const relation = text(child["Parent Relationship"])
    if (relation === "SubPlan") return false
    if (ancestor["Node Type"] === "Nested Loop" && relation === "Inner") {
      const outer = children(ancestor).find(
        (c) => c["Parent Relationship"] === "Outer"
      )
      if (outer === undefined || !constantSubtree(outer, constants))
        return false
      looped = true
    }
    child = ancestor
  }
  return looped
}

/**
 * Піддерево виведене лише зі сталих функцій: кожен листок (з листками
 * `InitPlan` / `SubPlan` теж — вони в `Plans`) — `Function Scan` однієї з
 * `constants` чи `Result` без входів.
 */
function constantSubtree(node: Raw, constants: ReadonlySet<string>): boolean {
  return subtree(node)
    .filter((n) => children(n).length === 0)
    .every((leaf) =>
      leaf["Node Type"] === "Function Scan"
        ? constants.has(text(leaf["Function Name"]) ?? "")
        : leaf["Node Type"] === "Result"
    )
}

/** Вузли плану з їхніми предками від кореня. */
function rawPaths(plan: unknown): { node: Raw; path: Raw[] }[] {
  const walk = (node: Raw, path: Raw[]): { node: Raw; path: Raw[] }[] => [
    { node, path },
    ...children(node).flatMap((c) => walk(c, [...path, node])),
  ]
  if (Array.isArray(plan)) return plan.flatMap(rawPaths)
  if (!isObject(plan)) return []
  if (isObject(plan.Plan)) return rawPaths(plan.Plan)
  return typeof plan["Node Type"] === "string" ? walk(plan, []) : []
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
