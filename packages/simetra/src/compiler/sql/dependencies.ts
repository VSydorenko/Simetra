import type { PhysicalSnapshot } from "simetra/model"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import type { SqlParser } from "./parse"
import { FUNCTION_CLASSES, type SqlUnit, type SqlUnitClass } from "./units"

/** Вузол порядку створення: об'єкт моделі або SQL-одиниця. */
export type CreationNode =
  | { type: "enumType"; schema: string; name: string }
  | { type: "table"; schema: string; name: string }
  | { type: "unit"; identity: string }

/** Порядок типів вузлів у tie-break. */
const TYPE_ORDER: Readonly<Record<CreationNode["type"], number>> = {
  enumType: 0,
  table: 1,
  unit: 2,
}

/** Простір імен, у якому шукається посилання. */
type Space = "relation" | "function" | "type"

/** Посилання з дерева розбору: ім'я як у тексті, кваліфіковане чи ні. */
interface Reference {
  space: Space
  names: readonly string[]
}

/** Чим вузол є для `GRANT … ON ALL … IN SCHEMA`. */
type Category = "relation" | "sequence" | "function" | "none"

interface GraphNode {
  label: string
  node: CreationNode
  schema: string
  /** `name` вузла моделі або ідентичність одиниці — друга частина tie-break. */
  key: string
  unit?: SqlUnit
}

/** Функції-складові агрегату: у дереві вони — `TypeName`, а не виклик. */
const AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  "sfunc",
  "finalfunc",
  "combinefunc",
  "serialfunc",
  "deserialfunc",
  "msfunc",
  "minvfunc",
  "mfinalfunc",
])

const ALL_IN_SCHEMA: Readonly<Record<string, Category>> = {
  OBJECT_TABLE: "relation",
  OBJECT_SEQUENCE: "sequence",
  OBJECT_FUNCTION: "function",
  OBJECT_PROCEDURE: "function",
  OBJECT_ROUTINE: "function",
}

/** Об'єкти коментаря, що є відношенням або його членом. */
const RELATION_COMMENTS: ReadonlySet<string> = new Set([
  "OBJECT_TABLE",
  "OBJECT_VIEW",
  "OBJECT_MATVIEW",
  "OBJECT_SEQUENCE",
  "OBJECT_FOREIGN_TABLE",
  "OBJECT_COLUMN",
  "OBJECT_TRIGGER",
  "OBJECT_POLICY",
  "OBJECT_RULE",
  "OBJECT_TABCONSTRAINT",
])

/** Коментар члена відношення: остання частина імені — сам член. */
const MEMBER_COMMENTS: ReadonlySet<string> = new Set([
  "OBJECT_COLUMN",
  "OBJECT_TRIGGER",
  "OBJECT_POLICY",
  "OBJECT_RULE",
  "OBJECT_TABCONSTRAINT",
])

/** Коментар тригера чи політики залежить і від самої одиниці. */
const UNIT_COMMENTS: Readonly<Record<string, SqlUnitClass>> = {
  OBJECT_TRIGGER: "trigger",
  OBJECT_POLICY: "policy",
}

/**
 * Спільний порядок створення таблиць моделі й SQL-одиниць (спека П2 §8.3):
 * детермінований топологічний порядок залежностей часу створення.
 * Розширення — перші вузли взагалі: їхні типи й функції потрібні колонкам і
 * `DEFAULT`, а залежності від них не відстежуються. Серед решти готових
 * вузлів tie-break — (тип вузла, схема, ім'я чи ідентичність); він лише
 * впорядковує незалежні вузли, тож кожна залежність — ребро.
 *
 * Посилання на об'єкти поза моделлю (`auth.users`, вбудовані функції)
 * ігноруються; некваліфіковане ім'я Postgres резолвить за `search_path`,
 * якого компілятор не знає, тож воно дає ребро до кожного однойменного
 * об'єкта моделі: пропущене ребро ламало б порядок. Ім'я CTE у своїй області
 * видимості — не відношення моделі. Тіла plpgsql не аналізуються — Postgres
 * не перевіряє їх при створенні.
 *
 * Обмеження FK поза порядком створення (спека П2 §8.3): рендер виводить їх
 * окремими `ALTER TABLE … ADD CONSTRAINT` після всіх таблиць, тож взаємні
 * посилання таблиць циклом не є. Будь-який цикл решти ребер —
 * `sql.dependency-cycle`.
 */
export function creationOrder(
  physical: PhysicalSnapshot,
  units: readonly SqlUnit[],
  parse: SqlParser,
  fileOf: (unit: SqlUnit) => string
): { order: CreationNode[]; diagnostics: Diagnostic[] } {
  const graph = new Graph(physical, units, parse)
  return graph.sort(fileOf)
}

class Graph {
  private readonly nodes = new Map<string, GraphNode>()
  /** Залежний → залежності. */
  private readonly deps = new Map<string, Set<string>>()
  private readonly index = new Map<Space, Map<string, string[]>>([
    ["relation", new Map()],
    ["function", new Map()],
    ["type", new Map()],
  ])
  private readonly categories = new Map<string, Category>()

  constructor(
    physical: PhysicalSnapshot,
    private readonly units: readonly SqlUnit[],
    private readonly parse: SqlParser
  ) {
    for (const type of physical.enumTypes) {
      const label = this.add({ type: "enumType", ...pick(type) }, type.name)
      this.register("type", type.schema, type.name, label)
    }
    for (const table of physical.tables) {
      const label = this.add({ type: "table", ...pick(table) }, table.name)
      this.register("relation", table.schema, table.name, label)
      // Таблиця — ще й складений тип (`RETURNS SETOF <таблиця>`).
      this.register("type", table.schema, table.name, label)
      this.categories.set(label, "relation")
    }
    for (const unit of units) this.addUnit(unit)

    for (const table of physical.tables) this.tableEdges(table)
    for (const unit of units) this.unitEdges(unit)
  }

  private add(node: CreationNode, key: string, unit?: SqlUnit): string {
    const schema = node.type === "unit" ? (unit?.schema ?? "") : node.schema
    const label = labelOf(node)
    this.nodes.set(label, {
      label,
      node,
      schema,
      key,
      ...(unit === undefined ? {} : { unit }),
    })
    this.deps.set(label, new Set())
    return label
  }

  private addUnit(unit: SqlUnit): void {
    const label = this.add(
      { type: "unit", identity: unit.identity },
      unit.identity,
      unit
    )
    const { schema, name } = unit
    if (FUNCTION_CLASSES.has(unit.class)) {
      this.register("function", schema, name, label)
      this.categories.set(label, "function")
    } else if (unit.class === "view" || unit.class === "materializedView") {
      this.register("relation", schema, name, label)
      this.register("type", schema, name, label)
      this.categories.set(label, "relation")
    } else if (unit.class === "sequence") {
      this.register("relation", schema, name, label)
      this.categories.set(label, "sequence")
    } else if (unit.class === "domain") {
      this.register("type", schema, name, label)
    }
  }

  /** Під кваліфікованим ім'ям і під голим — для некваліфікованих посилань. */
  private register(space: Space, schema: string, name: string, label: string) {
    const byName = this.index.get(space)!
    for (const key of [`${schema}.${name}`, name]) {
      const labels = byName.get(key) ?? []
      labels.push(label)
      byName.set(key, labels)
    }
  }

  private resolve(ref: Reference): string[] {
    const name = ref.names.at(-1)
    if (name === undefined || name === "") return []
    const key = ref.names.length > 1 ? `${ref.names.at(-2)}.${name}` : `${name}`
    return this.index.get(ref.space)!.get(key) ?? []
  }

  private edge(dependent: string, dependency: string): void {
    if (dependent !== dependency) this.deps.get(dependent)!.add(dependency)
  }

  private edges(dependent: string, refs: readonly Reference[]): void {
    for (const ref of refs) {
      for (const dependency of this.resolve(ref)) {
        this.edge(dependent, dependency)
      }
    }
  }

  // --- Ребра таблиць -------------------------------------------------------

  private tableEdges(table: PhysicalSnapshot["tables"][number]): void {
    const label = labelOf({ type: "table", ...pick(table) })
    const expressions: string[] = []
    for (const column of table.columns) {
      this.edges(label, this.typeReferences(column.type))
      if (column.default !== undefined) expressions.push(column.default)
      if (column.generated !== undefined) {
        expressions.push(column.generated.expression)
      }
    }
    for (const check of table.checks) expressions.push(check.expression)
    for (const index of table.indexes) {
      if (index.where !== undefined) expressions.push(index.where)
      for (const key of index.keys) {
        if ("expression" in key) expressions.push(key.expression)
      }
    }
    for (const expression of expressions) {
      this.edges(label, this.statementReferences(`SELECT (${expression})`))
    }
  }

  /** Тип колонки у формі `format_type()`: імена дає той самий парсер. */
  private typeReferences(type: string): Reference[] {
    return this.statementReferences(`SELECT NULL::${type}`)
  }

  private statementReferences(text: string): Reference[] {
    const parsed = this.parse(text)
    // Невалідний вираз — не справа порядку: його не створить і Postgres.
    if (!parsed.ok) return []
    const refs: Reference[] = []
    for (const statement of parsed.statements) {
      this.collect(statement.stmt, refs, NO_CTES)
    }
    return refs
  }

  // --- Ребра одиниць -------------------------------------------------------

  private unitEdges(unit: SqlUnit): void {
    // Розширення — перші; що використовує їх, не відстежується.
    if (unit.class === "extension") return
    const label = unit.identity
    const refs: Reference[] = []
    this.collect(unit.tree, refs, NO_CTES)
    this.edges(label, refs)

    const tree = unit.tree as Record<string, Record<string, unknown>>
    const comment = tree.CommentStmt
    if (comment !== undefined) {
      const objtype = String(comment.objtype)
      if (RELATION_COMMENTS.has(objtype)) {
        // Частини імені — з дерева: ім'я в лапках може містити крапку.
        // Без схеми ім'я некваліфіковане й резолвиться як решта таких.
        const object = comment.object as Record<string, Record<string, unknown>>
        const parts = strings(object?.List?.items)
        const relation = MEMBER_COMMENTS.has(objtype)
          ? parts.slice(0, -1)
          : parts
        this.edges(label, [{ space: "relation", names: relation }])
      }
      const cls = UNIT_COMMENTS[objtype]
      if (cls !== undefined) {
        const target = `${cls}:${unit.name}`
        if (this.nodes.has(target)) this.edge(label, target)
      }
    }
    const grant = tree.GrantStmt
    if (grant?.targtype === "ACL_TARGET_ALL_IN_SCHEMA") {
      const category = ALL_IN_SCHEMA[String(grant.objtype)] ?? "none"
      const schemas = new Set(strings(grant.objects))
      for (const [other, cat] of this.categories) {
        const node = this.nodes.get(other)!
        if (cat === category && schemas.has(node.schema)) {
          this.edge(label, other)
        }
      }
    }
  }

  /**
   * Посилання з дерева розбору. Форма вузла, а не шлях до нього: `RangeVar`
   * і `TypeName` бувають і обгорнутими вузлами, і прямими полями
   * (`CreateTrigStmt.relation`, `TypeCast.typeName`). `ctes` — імена CTE в
   * області видимості: некваліфіковане таке ім'я — CTE, а не відношення.
   */
  private collect(
    value: unknown,
    refs: Reference[],
    ctes: ReadonlySet<string>
  ): void {
    if (Array.isArray(value)) {
      for (const item of value) this.collect(item, refs, ctes)
      return
    }
    if (typeof value !== "object" || value === null) return
    const node = value as Record<string, unknown>
    // Область CTE — увесь оператор з `WITH`, разом із тілами CTE (рекурсивне
    // посилається на себе); вкладені оператори її успадковують.
    const own = cteNames(node.withClause)
    if (own.length > 0) ctes = new Set([...ctes, ...own])

    const cte =
      typeof node.relname === "string" &&
      node.schemaname === undefined &&
      ctes.has(node.relname)
    if (typeof node.relname === "string" && !cte) {
      refs.push({
        space: "relation",
        names: [
          ...(typeof node.schemaname === "string" ? [node.schemaname] : []),
          node.relname,
        ],
      })
    }
    if (Array.isArray(node.names) && "typemod" in node) {
      const names = strings(node.names)
      // `t.col%TYPE` — тип колонки відношення.
      refs.push(
        node.pct_type === true
          ? { space: "relation", names: names.slice(0, -1) }
          : { space: "type", names }
      )
    }
    if (Array.isArray(node.objname)) {
      refs.push({ space: "function", names: strings(node.objname) })
    }
    const call = node.FuncCall as Record<string, unknown> | undefined
    if (call !== undefined) {
      const names = strings(call.funcname)
      refs.push({ space: "function", names })
      if (names.at(-1) === "nextval") {
        const sequence = this.sequenceArgument(call.args)
        if (sequence !== undefined) refs.push(sequence)
      }
    }
    const trigger = node.CreateTrigStmt as Record<string, unknown> | undefined
    if (trigger !== undefined) {
      refs.push({ space: "function", names: strings(trigger.funcname) })
    }
    const define = node.DefineStmt as Record<string, unknown> | undefined
    if (define?.kind === "OBJECT_AGGREGATE") {
      for (const element of defElems(define.definition)) {
        if (!AGGREGATE_FUNCTIONS.has(String(element.defname))) continue
        const arg = element.arg as Record<string, Record<string, unknown>>
        if (arg?.TypeName !== undefined) {
          refs.push({ space: "function", names: strings(arg.TypeName.names) })
        }
      }
    }
    const fn = node.CreateFunctionStmt as Record<string, unknown> | undefined
    if (fn !== undefined) this.sqlBody(fn, refs)
    for (const element of defElems(node.options)) {
      // `OWNED BY [схема.]таблиця.колонка` у `CREATE`/`ALTER SEQUENCE`.
      if (element.defname !== "owned_by") continue
      const arg = element.arg as Record<string, Record<string, unknown>>
      const names = strings(arg?.List?.items)
      if (names.length > 1) {
        refs.push({ space: "relation", names: names.slice(0, -1) })
      }
    }

    for (const child of Object.values(node)) this.collect(child, refs, ctes)
  }

  /**
   * Тіло `LANGUAGE sql` у формі рядка Postgres перевіряє при створенні
   * (`check_function_bodies`), тож воно — залежності функції. Тіло
   * `BEGIN ATOMIC`/`RETURN` уже розібране в дереві й обходиться загально.
   */
  private sqlBody(fn: Record<string, unknown>, refs: Reference[]): void {
    const options = defElems(fn.options)
    const language = options.find((o) => o.defname === "language")
    const arg = language?.arg as Record<string, Record<string, unknown>>
    if (String(arg?.String?.sval ?? "").toLowerCase() !== "sql") return
    const as = options.find((o) => o.defname === "as")?.arg as
      Record<string, Record<string, unknown>> | undefined
    const [body] = strings(as?.List?.items)
    if (body === undefined) return
    refs.push(...this.statementReferences(body))
  }

  /** `nextval('s')` чи `nextval('s'::regclass)`: ім'я послідовності — рядок. */
  private sequenceArgument(args: unknown): Reference | undefined {
    if (!Array.isArray(args)) return undefined
    let arg = args[0] as Record<string, Record<string, unknown>> | undefined
    if (arg?.TypeCast !== undefined) {
      arg = arg.TypeCast.arg as Record<string, Record<string, unknown>>
    }
    const literal = arg?.A_Const?.sval as { sval?: string } | undefined
    if (literal?.sval === undefined) return undefined
    // Текст `regclass` — те саме ім'я, що в SQL: розбір дає регістр і лапки.
    const [type] = this.typeReferences(literal.sval)
    return type === undefined
      ? undefined
      : { space: "relation", names: type.names }
  }

  // --- Сортування ----------------------------------------------------------

  sort(fileOf: (unit: SqlUnit) => string): {
    order: CreationNode[]
    diagnostics: Diagnostic[]
  } {
    const all = [...this.nodes.values()].sort(compareNodes)
    const extensions = all.filter((n) => n.unit?.class === "extension")
    const order: CreationNode[] = extensions.map((n) => n.node)
    const diagnostics: Diagnostic[] = []

    const rest = all.filter((n) => n.unit?.class !== "extension")
    const emitted = new Set(extensions.map((n) => n.label))
    const dependents = new Map<string, string[]>()
    const pending = new Map<string, number>()
    for (const node of rest) {
      let count = 0
      for (const dependency of this.deps.get(node.label)!) {
        if (emitted.has(dependency)) continue
        count++
        const list = dependents.get(dependency) ?? []
        list.push(node.label)
        dependents.set(dependency, list)
      }
      pending.set(node.label, count)
    }
    const ready = rest.filter((n) => pending.get(n.label) === 0)

    const emit = (node: GraphNode) => {
      emitted.add(node.label)
      order.push(node.node)
      for (const dependent of dependents.get(node.label) ?? []) {
        const left = pending.get(dependent)! - 1
        pending.set(dependent, left)
        if (left === 0 && !emitted.has(dependent)) {
          insertSorted(ready, this.nodes.get(dependent)!)
        }
      }
    }

    while (emitted.size < this.nodes.size) {
      const next = ready.shift()
      if (next !== undefined) {
        if (!emitted.has(next.label)) emit(next)
        continue
      }
      const remaining = rest.find((n) => !emitted.has(n.label))!
      const cycle = this.findCycle(remaining, emitted)
      diagnostics.push(cycleDiagnostic(cycle, fileOf))
      // Цикл названо; розриваємо його на першій одиниці, щоб знайти решту.
      emit(cycle[0]!)
    }
    return { order, diagnostics }
  }

  /**
   * Цикл серед невипущених вузлів: готових немає, тож у кожного з них є
   * невипущена залежність, і хода назад замикається. Повертає вузли від
   * першої одиниці циклу за порядком.
   */
  private findCycle(
    start: GraphNode,
    emitted: ReadonlySet<string>
  ): GraphNode[] {
    const path: GraphNode[] = []
    const seen = new Map<string, number>()
    let current = start
    while (!seen.has(current.label)) {
      seen.set(current.label, path.length)
      path.push(current)
      current = [...this.deps.get(current.label)!]
        .filter((dependency) => !emitted.has(dependency))
        .map((dependency) => this.nodes.get(dependency)!)
        .sort(compareNodes)[0]!
    }
    const cycle = path.slice(seen.get(current.label))
    const units = cycle.filter((n) => n.unit !== undefined).sort(compareNodes)
    const first = cycle.indexOf(units[0] ?? cycle[0]!)
    return [...cycle.slice(first), ...cycle.slice(0, first)]
  }
}

function cycleDiagnostic(
  cycle: readonly GraphNode[],
  fileOf: (unit: SqlUnit) => string
): Diagnostic {
  const first = cycle[0]!
  const labels = [...cycle, first].map((n) => n.label)
  return diagnostic(
    "sql.dependency-cycle",
    first.unit === undefined ? "" : fileOf(first.unit),
    "",
    {
      identity: first.label,
      cycle: labels.join(" -> "),
      ...(first.unit?.line === undefined ? {} : { line: first.unit.line }),
    }
  )
}

function labelOf(node: CreationNode): string {
  return node.type === "unit"
    ? node.identity
    : `${node.type}:${node.schema}.${node.name}`
}

function pick(object: { schema: string; name: string }) {
  return { schema: object.schema, name: object.name }
}

function compareNodes(a: GraphNode, b: GraphNode): number {
  return (
    TYPE_ORDER[a.node.type] - TYPE_ORDER[b.node.type] ||
    compareStrings(a.schema, b.schema) ||
    compareStrings(a.key, b.key)
  )
}

function insertSorted(list: GraphNode[], node: GraphNode): void {
  let low = 0
  let high = list.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (compareNodes(list[middle]!, node) < 0) low = middle + 1
    else high = middle
  }
  list.splice(low, 0, node)
}

const NO_CTES: ReadonlySet<string> = new Set()

function cteNames(withClause: unknown): string[] {
  const ctes = (withClause as { ctes?: unknown } | undefined)?.ctes
  if (!Array.isArray(ctes)) return []
  return ctes.flatMap((n) => {
    const name = (n as { CommonTableExpr?: { ctename?: string } })
      .CommonTableExpr?.ctename
    return name === undefined ? [] : [name]
  })
}

function strings(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return []
  return nodes.map((n) => {
    const string = (n as { String?: { sval?: string } }).String
    return string?.sval ?? ""
  })
}

function defElems(nodes: unknown): Record<string, unknown>[] {
  if (!Array.isArray(nodes)) return []
  return nodes.flatMap((n) => {
    const element = (n as { DefElem?: Record<string, unknown> }).DefElem
    return element === undefined ? [] : [element]
  })
}
