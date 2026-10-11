import type { Alias, ColumnRef, Node, ResTarget } from "libpg-query"

/** Читання вузлів дерева libpg-query, що не залежить від промоції. */

/** Рядковий літерал під приведеннями й `COLLATE`; інший вузол — `undefined`. */
export function stringLiteral(node: Node | undefined): string | undefined {
  let arg = node
  while (arg !== undefined && ("TypeCast" in arg || "CollateClause" in arg)) {
    arg = "TypeCast" in arg ? arg.TypeCast.arg : arg.CollateClause.arg
  }
  return arg !== undefined && "A_Const" in arg
    ? arg.A_Const.sval?.sval
    : undefined
}

export function isStar(ref: ColumnRef): boolean {
  const last = ref.fields?.at(-1)
  return last !== undefined && "A_Star" in last
}

/** Поля-рядки вузла; `undefined`, якщо серед них є не рядок. */
export function strings(nodes: readonly Node[]): string[] | undefined {
  const out: string[] = []
  for (const node of nodes) {
    if (!("String" in node) || node.String.sval === undefined) return undefined
    out.push(node.String.sval)
  }
  return out
}

export function stringList(nodes: Node[] | undefined): string[] | undefined {
  return nodes === undefined ? undefined : strings(nodes)
}

export function resTarget(node: Node): ResTarget {
  return "ResTarget" in node ? node.ResTarget : {}
}

/** `JOIN … USING`/`NATURAL JOIN` у дереві `FROM` (без підзапитів — у них свій рівень). */
export function coalesces(node: Node): boolean {
  if (!("JoinExpr" in node)) return false
  const join = node.JoinExpr
  return (
    join.isNatural === true ||
    (join.usingClause?.length ?? 0) > 0 ||
    (join.larg !== undefined && coalesces(join.larg)) ||
    (join.rarg !== undefined && coalesces(join.rarg))
  )
}

/** `(вираз).*` — розгортання складеного значення в кілька колонок. */
export function isRowExpansion(node: Node): boolean {
  return (
    "A_Indirection" in node &&
    (node.A_Indirection.indirection ?? []).some((n) => "A_Star" in n)
  )
}

/** Голе одноіменне посилання (`ORDER BY name`). */
export function bareName(node: Node): string | undefined {
  if (!("ColumnRef" in node)) return undefined
  const names = strings(node.ColumnRef.fields ?? [])
  return names?.length === 1 ? names[0] : undefined
}

/**
 * Ім'я колонки виводу за правилами `FigureColname` Postgres для форм, що
 * трапляються в тілах функцій; невідома форма — `undefined` (невідоме ім'я
 * робить колонки підзапиту невідомими, а не вгаданими).
 */
export function outputName(t: ResTarget): string | undefined {
  if (t.name !== undefined) return t.name
  return t.val === undefined ? undefined : figureName(t.val)
}

function figureName(node: Node): string | undefined {
  if ("ColumnRef" in node) {
    const last = node.ColumnRef.fields?.at(-1)
    return last !== undefined && "String" in last ? last.String.sval : undefined
  }
  if ("TypeCast" in node) {
    const inner =
      node.TypeCast.arg === undefined
        ? undefined
        : figureName(node.TypeCast.arg)
    return (
      inner ??
      node.TypeCast.typeName?.names
        ?.flatMap((n) => ("String" in n ? [n.String.sval ?? ""] : []))
        .at(-1)
    )
  }
  if ("CollateClause" in node) {
    return node.CollateClause.arg === undefined
      ? undefined
      : figureName(node.CollateClause.arg)
  }
  if (isRowExpansion(node)) return undefined
  if ("A_Indirection" in node) {
    const field = (node.A_Indirection.indirection ?? [])
      .flatMap((n) => ("String" in n ? [n.String.sval] : []))
      .at(-1)
    if (field !== undefined) return field
    return node.A_Indirection.arg === undefined
      ? undefined
      : figureName(node.A_Indirection.arg)
  }
  if ("FuncCall" in node) {
    return (node.FuncCall.funcname ?? [])
      .flatMap((n) => ("String" in n ? [n.String.sval] : []))
      .at(-1)
  }
  if ("CaseExpr" in node) return "case"
  if ("CoalesceExpr" in node) return "coalesce"
  if ("A_ArrayExpr" in node) return "array"
  if ("RowExpr" in node) return "row"
  if ("SubLink" in node) {
    const link = node.SubLink
    if (link.subLinkType === "EXISTS_SUBLINK") return "exists"
    if (link.subLinkType === "ARRAY_SUBLINK") return "array"
    if (
      link.subLinkType === "EXPR_SUBLINK" &&
      link.subselect !== undefined &&
      "SelectStmt" in link.subselect
    ) {
      const first = link.subselect.SelectStmt.targetList?.[0]
      return first === undefined ? undefined : outputName(resTarget(first))
    }
    return undefined
  }
  if ("A_Const" in node) return "?column?"
  return undefined
}

/**
 * Посилання, з якого Postgres бере ім'я колонки виводу (`FigureColname`):
 * приведення типу, колація й індекс його не змінюють. Поле складеного
 * значення (`(x).f`) дає ім'я поля, а не посилання.
 */
export function nameSource(node: Node | undefined): ColumnRef | undefined {
  if (node === undefined) return undefined
  if ("ColumnRef" in node) return node.ColumnRef
  if ("TypeCast" in node) return nameSource(node.TypeCast.arg)
  if ("CollateClause" in node) return nameSource(node.CollateClause.arg)
  if ("A_Indirection" in node) {
    const field = (node.A_Indirection.indirection ?? []).some(
      (n) => "String" in n
    )
    return field ? undefined : nameSource(node.A_Indirection.arg)
  }
  return undefined
}

export function aliasOf(node: Node): string | undefined {
  const inner = Object.values(node)[0] as { alias?: Alias } | undefined
  return inner?.alias?.aliasname
}

export function firstLocation(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstLocation(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.location === "number" && record.location >= 0)
    return record.location
  for (const child of Object.values(record)) {
    const found = firstLocation(child)
    if (found !== undefined) return found
  }
  return undefined
}

/** Дерево згадує одне з імен (як ім'я відношення, колонки чи рядок імені). */
export function mentions(value: unknown, names: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((v) => mentions(v, names))
  if (typeof value !== "object" || value === null) return false
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      if (
        (key === "sval" ||
          key === "relname" ||
          key === "name" ||
          key === "colname") &&
        names.has(child)
      ) {
        return true
      }
    } else if (mentions(child, names)) return true
  }
  return false
}

export function statementKind(stmt: Node): string {
  return Object.keys(stmt)[0] ?? "statement"
}
