import type {
  A_Const,
  A_Indirection,
  Alias,
  ColumnRef,
  CommonTableExpr,
  DeleteStmt,
  InsertStmt,
  JoinExpr,
  Node,
  OnConflictClause,
  RangeFunction,
  RangeSubselect,
  RangeVar,
  ResTarget,
  SelectStmt,
  SubLink,
  TypeName,
  UpdateStmt,
} from "libpg-query"
import { quoteIdent } from "simetra/model"
import { byteOffsets, type SqlParser } from "../parse"
import { lexChain, type Token } from "./lex"
import { resolveTableName, type TableResolution } from "./tables"
import type {
  ContractChange,
  RecordBinding,
  RenameMap,
  RewriteProblem,
  RewriteScope,
  TableRename,
  TextEdit,
} from "./renames"

/**
 * Джерело рядків у `FROM`. `columns` — імена колонок до промоції в порядку
 * таблиці; `undefined` — невідомі (функція, `*` підзапиту, таблиця поза
 * моделлю): така область не доводить, куди веде некваліфіковане ім'я.
 * `failed` — джерело, про яке вже є проблема: подальші невизначеності через
 * нього не множать відмов.
 */
interface Leaf {
  refname: string | undefined
  aliased: boolean
  schema?: string
  relname?: string
  table?: TableRename
  columns: readonly string[] | undefined
  failed?: boolean
  /** Індекс UTF-16 відношення в тексті — для відмови за ім'ям джерела. */
  location?: number
  /**
   * Джерело з недоведеною формою рядка: виклик функції (`unnest` масиву
   * рядків чи функція, що повертає рядок промотованої таблиці, віддає її
   * колонки) або похідне джерело, вивід якого розгортає `*` над таким.
   * Значення — опис першопричини для відмови.
   */
  unproven?: string
}

/** `JOIN` з псевдонімом: внутрішні імена сховані, колонки — їхнє об'єднання. */
interface Group {
  refname: string
  leaves: Leaf[]
}

type Item = { leaf: Leaf } | { group: Group }

/** Рівень запиту: його `FROM` і колонки, злиті `USING`. */
interface Level {
  items: Item[]
  merged: ReadonlySet<string>
}

interface Env {
  /** Від зовнішнього рівня до внутрішнього. */
  levels: readonly Level[]
  /** Видимі CTE: ім'я → колонки виводу (`undefined` — невідомі). */
  ctes: ReadonlyMap<string, CteShape>
}

/** Як обробляється список виводу. */
interface OutputMode {
  /** Вставляти ` AS <старе>` за голим посиланням на перейменовану колонку. */
  alias: boolean
  /** Імена виводу хтось читає: ім'я, сховане у виразі, — відмова. */
  names: boolean
  /** Кількість і порядок колонок спостерігаються: `*` — зміна контракту. */
  stars: boolean
  /** Верхній список оператора: тут діє `intoRowtypeOf`. */
  top: boolean
}

/** Підсумок обробки посилання на колонку — для ` AS <старе>`. */
interface RefResult {
  /** Ім'я колонки виводу, яке дає посилання до правок. */
  old: string
  /** Нове ім'я, коли правка змінює саме його (останнє поле). */
  to?: string
  /** Індекс одразу за останнім токеном посилання. */
  end: number
}

/** Імена списку виводу до правок і після; `undefined` — ім'я невідоме. */
interface Outputs {
  pre: (string | undefined)[]
  post: (string | undefined)[]
  /** Вивід розгортає `*` над джерелом з недоведеною формою (`Leaf.unproven`). */
  unproven?: string
}

/** Колонки CTE; `unproven` — як у `Leaf`. */
interface CteShape {
  columns: readonly string[] | undefined
  unproven?: string
}

const KEEP: OutputMode = { alias: true, names: true, stars: true, top: false }

const CHANGE_DETAILS: Readonly<Record<ContractChange["reason"], string>> = {
  star: "a star expands the columns of the promoted table, which the promotion adds, removes and renames",
  wholeRow:
    "a whole row of the promoted table changes its fields with the promotion",
  signature: "the signature names the row type of the promoted table",
}

/**
 * Переписує текст SQL (один чи кілька операторів) під нові фізичні імена
 * промотованих таблиць (спека промоції §6, рішення 13 плану).
 *
 * Правки — лише токени імен, які резолв довів, і вставки ` AS <старе>`:
 * позиції беруться з `location` дерева libpg-query (байти UTF-8 від початку
 * всього розібраного тексту), а межі токена — з самого тексту від цієї
 * позиції. Коментарі, літерали й розкладка лишаються байт у байт, бо їх
 * ніхто не перевидає (deparse не вживається). Місце, яке резолв не довів, —
 * проблема, а не пропуск: переписаний текст із мовчки пропущеним посиланням
 * зламав би функцію вже в базі.
 */
export function rewriteStatementText(
  text: string,
  parse: SqlParser,
  map: RenameMap,
  scope: RewriteScope
): {
  edits: TextEdit[]
  problems: RewriteProblem[]
  contractChanges: ContractChange[]
} {
  const rewriter = new StatementRewriter(text, map, scope)
  const parsed = parse(text)
  if (!parsed.ok) {
    rewriter.problem(
      "rewrite.unsupported",
      parsed.offset,
      `the statement does not parse: ${parsed.message}`
    )
  } else {
    for (const statement of parsed.statements) {
      rewriter.statement(statement.stmt, statement.start)
    }
  }
  return rewriter.result()
}

class StatementRewriter {
  private readonly toIndex: (byte: number) => number
  private readonly edits = new Map<string, TextEdit>()
  private readonly problems = new Map<string, RewriteProblem>()
  private readonly changes = new Map<string, ContractChange>()
  /** Старі імена перейменованих колонок усіх промотованих таблиць. */
  private readonly renamedColumns = new Set<string>()
  private readonly promotedNames = new Set<string>()
  /**
   * Імена, резолв яких промоція може змінити: старі й нові імена
   * перейменувань, додані й зняті колонки.
   */
  private readonly changedColumns = new Set<string>()
  private readonly labels: ReadonlySet<string>
  /** Оператор згадує промотовану таблицю: невизначеність імені тут важить. */
  private touches = false

  constructor(
    private readonly text: string,
    private readonly map: RenameMap,
    private readonly scope: RewriteScope
  ) {
    this.toIndex = byteOffsets(text)
    for (const table of map.tables) {
      this.promotedNames.add(table.from)
      const before = map.knownTables.get(`${table.schema}.${table.from}`) ?? []
      for (const [old, renamed] of table.columns) {
        this.renamedColumns.add(old)
        this.changedColumns.add(old).add(renamed)
      }
      for (const column of table.columnsAfter) {
        if (!before.includes(column)) this.changedColumns.add(column)
      }
      for (const column of before) {
        if (!table.columnsAfter.has(table.columns.get(column) ?? column)) {
          this.changedColumns.add(column)
        }
      }
    }
    this.labels = new Set(scope.labels)
  }

  result(): {
    edits: TextEdit[]
    problems: RewriteProblem[]
    contractChanges: ContractChange[]
  } {
    const byOffset = <T extends { offset: number }>(a: T, b: T) =>
      a.offset - b.offset
    return {
      edits: [...this.edits.values()].sort((a, b) => a.start - b.start),
      problems: [...this.problems.values()].sort(byOffset),
      contractChanges: [...this.changes.values()].sort(byOffset),
    }
  }

  problem(code: RewriteProblem["code"], offset: number, detail: string): void {
    // Той самий вузол буває досяжним двома шляхами (джерело `(a, b) = …`
    // спільне для обох цілей) — одна проблема на місце.
    this.problems.set(`${code}@${offset}@${detail}`, { code, offset, detail })
  }

  private change(
    reason: ContractChange["reason"],
    offset: number,
    detail: string = CHANGE_DETAILS[reason]
  ): void {
    this.changes.set(`${reason}@${offset}`, { offset, reason, detail })
  }

  private edit(start: number, end: number, text: string): void {
    this.edits.set(`${start}:${end}:${text}`, { start, end, text })
  }

  /** Оператор верхнього рівня; `start` — його початок для відмови без позиції. */
  statement(stmt: Node, start: number): void {
    this.touches = mentions(stmt, this.promotedNames)
    const top: OutputMode = {
      alias: this.scope.topLevelOutput !== "ignore",
      names: this.scope.topLevelOutput !== "ignore",
      stars: this.scope.topLevelOutput !== "ignore",
      top: true,
    }
    const env: Env = { levels: [], ctes: new Map() }
    if ("SelectStmt" in stmt) this.select(stmt.SelectStmt, env, top)
    else if ("InsertStmt" in stmt) this.insert(stmt.InsertStmt, env, top)
    else if ("UpdateStmt" in stmt) this.update(stmt.UpdateStmt, env, top)
    else if ("DeleteStmt" in stmt) this.delete(stmt.DeleteStmt, env, top)
    else if ("CallStmt" in stmt) this.walk(stmt.CallStmt, env)
    else if ("TruncateStmt" in stmt) this.walk(stmt.TruncateStmt, env)
    else if ("LockStmt" in stmt) this.walk(stmt.LockStmt, env)
    else if (
      mentions(stmt, new Set([...this.promotedNames, ...this.renamedColumns]))
    ) {
      // Інші оператори несуть імена колонок і таблиць у вузлах без позицій
      // (DDL, `MERGE`, `COPY`): правити їх наосліп не можна.
      this.problem(
        "rewrite.unsupported",
        start,
        `${statementKind(stmt)} that names a promoted table or a renamed column is not rewritten`
      )
    } else this.walk(stmt, env)
  }

  // --- Оператори ---------------------------------------------------------

  /** `SELECT`; повертає імена виводу для CTE й підзапиту в `FROM`. */
  private select(
    stmt: SelectStmt,
    outer: Env,
    mode: OutputMode
  ): Outputs | undefined {
    const env = this.withCtes(
      stmt.withClause?.ctes,
      stmt.withClause?.recursive,
      outer
    )
    if (stmt.op !== undefined && stmt.op !== "SETOP_NONE") {
      // Імена виводу операції над множинами — імена лівої гілки; праву ніхто
      // не читає за іменами, але кількість її колонок важить.
      const outputs = this.select(stmt.larg ?? {}, env, mode)
      this.select(stmt.rarg ?? {}, env, { ...mode, names: false, top: false })
      const pre = outputs?.pre ?? []
      const post = outputs?.post ?? []
      // `ORDER BY` операції над множинами бачить лише імена виводу.
      const level: Level = {
        items: [
          {
            leaf: {
              refname: undefined,
              aliased: true,
              columns: [...definedNames(pre)],
            },
          },
        ],
        merged: new Set(),
      }
      for (const sort of stmt.sortClause ?? []) {
        const name =
          "SortBy" in sort && sort.SortBy.node !== undefined
            ? bareName(sort.SortBy.node)
            : undefined
        if (name !== undefined && pre.includes(name) && !post.includes(name)) {
          this.problem(
            "rewrite.unsupported",
            this.at(firstLocation(sort)),
            `ORDER BY "${name}" refers to an output column whose name the rewrite changes`
          )
        } else this.walk(sort, pushLevel(env, level))
      }
      this.walk([stmt.limitOffset, stmt.limitCount], env)
      return outputs
    }
    if (stmt.valuesLists !== undefined) {
      this.walk(stmt.valuesLists, env)
      const first = stmt.valuesLists[0]
      const width =
        first !== undefined && "List" in first
          ? (first.List.items?.length ?? 0)
          : 0
      const names = Array.from({ length: width }, (_, i) => `column${i + 1}`)
      return { pre: names, post: names }
    }

    const level = this.fromLevel(stmt.fromClause ?? [], env)
    this.checkNames(level.items)
    const inner = pushLevel(env, level)
    const targets = (stmt.targetList ?? []).map((t) => resTarget(t))
    const outputs = this.outputList(targets, inner, level, mode)
    this.walk(stmt.whereClause, inner)
    for (const group of stmt.groupClause ?? []) {
      this.groupItem(group, inner, level, outputs)
    }
    this.walk(stmt.havingClause, inner)
    this.walk(stmt.windowClause, inner)
    for (const sort of stmt.sortClause ?? []) {
      const by = "SortBy" in sort ? sort.SortBy : undefined
      if (by === undefined) this.walk(sort, inner)
      else {
        if (by.node !== undefined)
          this.outputNameOrExpr(by.node, inner, outputs)
        this.walk(by.useOp, inner)
      }
    }
    for (const distinct of stmt.distinctClause ?? []) {
      this.outputNameOrExpr(distinct, inner, outputs)
    }
    this.walk([stmt.limitOffset, stmt.limitCount], inner)
    for (const locking of stmt.lockingClause ?? []) {
      if (!("LockingClause" in locking)) continue
      for (const rel of locking.LockingClause.lockedRels ?? []) {
        if ("RangeVar" in rel) this.lockedRel(rel.RangeVar, level)
      }
    }
    return outputs
  }

  private insert(stmt: InsertStmt, outer: Env, mode: OutputMode): void {
    const env = this.withCtes(
      stmt.withClause?.ctes,
      stmt.withClause?.recursive,
      outer
    )
    const target =
      stmt.relation === undefined
        ? undefined
        : this.targetLeaf(stmt.relation, env)
    // Ціль `INSERT` не видна його джерелу: `SELECT` бачить лише зовнішні рівні.
    if (stmt.selectStmt !== undefined && "SelectStmt" in stmt.selectStmt) {
      this.select(stmt.selectStmt.SelectStmt, env, {
        alias: true,
        names: false,
        stars: true,
        top: false,
      })
    }
    if (target === undefined) return
    if (stmt.cols === undefined || stmt.cols.length === 0) {
      // Вставка без списку колонок — позиційна: промоція додає й перейменовує
      // колонки, тож відповідність значень колонкам змінюється.
      if (target.table !== undefined && stmt.selectStmt !== undefined) {
        this.change(
          "star",
          this.at(stmt.relation?.location),
          "an INSERT without a column list is positional, and the promotion adds or removes columns of the table"
        )
      }
    }
    for (const col of stmt.cols ?? []) {
      if ("ResTarget" in col) this.targetName(col.ResTarget, target, env)
    }
    if (stmt.onConflictClause !== undefined) {
      this.onConflict(stmt.onConflictClause, target, env)
    }
    this.returning(stmt.returningList, target, [], env, mode)
  }

  private update(stmt: UpdateStmt, outer: Env, mode: OutputMode): void {
    const env = this.withCtes(
      stmt.withClause?.ctes,
      stmt.withClause?.recursive,
      outer
    )
    const target =
      stmt.relation === undefined
        ? undefined
        : this.targetLeaf(stmt.relation, env)
    const fromLevel = this.fromLevel(stmt.fromClause ?? [], env)
    const items: Item[] = [
      ...(target === undefined ? [] : [{ leaf: target }]),
      ...fromLevel.items,
    ]
    const level: Level = { items, merged: fromLevel.merged }
    this.checkNames(items)
    const inner = pushLevel(env, level)
    for (const node of stmt.targetList ?? []) {
      if (!("ResTarget" in node)) continue
      const t = node.ResTarget
      if (target !== undefined) this.targetName(t, target, inner)
      this.assignedValue(t, inner)
    }
    this.walk(stmt.whereClause, inner)
    this.returning(stmt.returningList, target, fromLevel.items, env, mode)
  }

  private delete(stmt: DeleteStmt, outer: Env, mode: OutputMode): void {
    const env = this.withCtes(
      stmt.withClause?.ctes,
      stmt.withClause?.recursive,
      outer
    )
    const target =
      stmt.relation === undefined
        ? undefined
        : this.targetLeaf(stmt.relation, env)
    const using = this.fromLevel(stmt.usingClause ?? [], env)
    const items: Item[] = [
      ...(target === undefined ? [] : [{ leaf: target }]),
      ...using.items,
    ]
    this.checkNames(items)
    this.walk(stmt.whereClause, pushLevel(env, { items, merged: using.merged }))
    this.returning(stmt.returningList, target, using.items, env, mode)
  }

  private returning(
    list: Node[] | undefined,
    target: Leaf | undefined,
    extra: Item[],
    env: Env,
    mode: OutputMode
  ): void {
    if (list === undefined) return
    const items: Item[] = [
      ...(target === undefined ? [] : [{ leaf: target }]),
      ...extra,
    ]
    const level: Level = { items, merged: new Set() }
    this.outputList(
      list.map((t) => resTarget(t)),
      pushLevel(env, level),
      level,
      mode
    )
  }

  private onConflict(clause: OnConflictClause, target: Leaf, env: Env): void {
    const excluded: Leaf = { ...target, refname: "excluded", aliased: true }
    const targetOnly = pushLevel(env, {
      items: [{ leaf: target }],
      merged: new Set(),
    })
    const infer = clause.infer
    if (infer !== undefined) {
      for (const element of infer.indexElems ?? []) {
        if (!("IndexElem" in element)) continue
        const name = element.IndexElem.name
        if (name !== undefined && target.table?.columns.has(name)) {
          this.problem(
            "rewrite.unsupported",
            this.at(infer.location ?? clause.location),
            `renamed column "${name}" in an ON CONFLICT inference list has no position in the parse tree`
          )
        }
        this.walk(element.IndexElem.expr, targetOnly)
      }
      this.walk(infer.whereClause, targetOnly)
    }
    const inner = pushLevel(env, {
      items: [{ leaf: target }, { leaf: excluded }],
      merged: new Set(),
    })
    for (const node of clause.targetList ?? []) {
      if (!("ResTarget" in node)) continue
      this.targetName(node.ResTarget, target, inner)
      this.assignedValue(node.ResTarget, inner)
    }
    this.walk(clause.whereClause, inner)
  }

  /** Значення присвоєння; джерело `(a, b) = (…)` спільне для всіх цілей — один обхід. */
  private assignedValue(t: ResTarget, env: Env): void {
    const value = t.val
    if (value !== undefined && "MultiAssignRef" in value) {
      if (value.MultiAssignRef.colno === 1)
        this.walk(value.MultiAssignRef.source, env)
      return
    }
    this.walk(t.indirection, env)
    this.walk(value, env)
  }

  /** Ім'я колонки цілі в `INSERT (…)`, `SET` чи `DO UPDATE SET`. */
  private targetName(t: ResTarget, target: Leaf, env: Env): void {
    const name = t.name
    if (name === undefined) return
    this.walk(t.indirection, env)
    const renamed = target.table?.columns.get(name)
    if (renamed === undefined) return
    const tokens = this.tokens(t.location, [name])
    if (tokens === undefined) return
    this.edit(tokens[0]!.start, tokens[0]!.end, quoteIdent(renamed))
  }

  // --- FROM ---------------------------------------------------------------

  /** CTE оператора; тіло бачить попередні CTE, а `WITH RECURSIVE` — усі. */
  private withCtes(
    ctes: Node[] | undefined,
    recursive: boolean | undefined,
    outer: Env
  ): Env {
    if (ctes === undefined || ctes.length === 0) return outer
    const visible = new Map(outer.ctes)
    const defs = ctes.flatMap((c) =>
      "CommonTableExpr" in c ? [c.CommonTableExpr] : []
    )
    if (recursive === true) {
      // Колонки рекурсивного CTE — з його нерекурсивної частини, але тіло
      // бачить себе; невідомі колонки під час обходу тіла лише гучніші.
      for (const def of defs)
        if (def.ctename !== undefined) {
          visible.set(def.ctename, { columns: undefined })
        }
    }
    for (const def of defs) {
      const shape = this.cte(def, {
        levels: outer.levels,
        ctes: new Map(visible),
      })
      if (def.ctename !== undefined) visible.set(def.ctename, shape)
    }
    return { levels: outer.levels, ctes: visible }
  }

  private cte(def: CommonTableExpr, env: Env): CteShape {
    const query = def.ctequery
    let outputs: (string | undefined)[] | undefined
    let unproven: string | undefined
    if (query !== undefined) {
      if ("SelectStmt" in query) {
        const selected = this.select(query.SelectStmt, env, KEEP)
        outputs = selected?.pre
        unproven = selected?.unproven
      } else if ("InsertStmt" in query) this.insert(query.InsertStmt, env, KEEP)
      else if ("UpdateStmt" in query) this.update(query.UpdateStmt, env, KEEP)
      else if ("DeleteStmt" in query) this.delete(query.DeleteStmt, env, KEEP)
      else this.walk(query, env)
      if (outputs === undefined) outputs = this.dmlOutputs(query)
    }
    const aliases = stringList(def.aliascolnames)
    const columns = completeNames(outputs, aliases)
    return unproven === undefined ? { columns } : { columns, unproven }
  }

  /** Імена `RETURNING` оператора зміни даних у CTE. */
  private dmlOutputs(query: Node): (string | undefined)[] | undefined {
    const list =
      "InsertStmt" in query
        ? query.InsertStmt.returningList
        : "UpdateStmt" in query
          ? query.UpdateStmt.returningList
          : "DeleteStmt" in query
            ? query.DeleteStmt.returningList
            : undefined
    return list?.map((t) => outputName(resTarget(t)))
  }

  /** Рівень `FROM`: кожне джерело бачить зовнішні рівні, `LATERAL` — і попередні джерела. */
  private fromLevel(from: Node[], env: Env): Level {
    const items: Item[] = []
    const merged = new Set<string>()
    for (const node of from) {
      items.push(...this.fromItem(node, env, items, merged))
    }
    return { items, merged }
  }

  private fromItem(
    node: Node,
    env: Env,
    preceding: Item[],
    merged: Set<string>
  ): Item[] {
    const lateral = (): Env =>
      pushLevel(env, { items: [...preceding], merged: new Set(merged) })
    if ("RangeVar" in node) return [{ leaf: this.rangeVar(node.RangeVar, env) }]
    if ("JoinExpr" in node)
      return this.join(node.JoinExpr, env, preceding, merged)
    if ("RangeSubselect" in node)
      return [{ leaf: this.subselect(node.RangeSubselect, env, lateral) }]
    if ("RangeFunction" in node)
      return [{ leaf: this.rangeFunction(node.RangeFunction, lateral()) }]
    if ("RangeTableSample" in node) {
      const sample = node.RangeTableSample
      this.walk([sample.args, sample.repeatable], lateral())
      return sample.relation === undefined
        ? []
        : this.fromItem(sample.relation, env, preceding, merged)
    }
    // XMLTABLE, JSON_TABLE: вирази бачать попередні джерела, колонки невідомі.
    this.walk(node, lateral())
    return [
      { leaf: { refname: aliasOf(node), aliased: true, columns: undefined } },
    ]
  }

  private join(
    join: JoinExpr,
    env: Env,
    preceding: Item[],
    merged: Set<string>
  ): Item[] {
    const own: Item[] = []
    const ownMerged = new Set<string>()
    if (join.larg !== undefined)
      own.push(...this.fromItem(join.larg, env, preceding, ownMerged))
    if (join.rarg !== undefined) {
      own.push(
        ...this.fromItem(join.rarg, env, [...preceding, ...own], ownMerged)
      )
    }
    const leaves = own.flatMap(leavesOf)
    const using = stringList(join.usingClause) ?? []
    const offset = this.at(firstLocation(join.rarg) ?? firstLocation(join.larg))
    for (const name of using) {
      if (leaves.some((l) => l.table?.columns.has(name))) {
        this.problem(
          "rewrite.unsupported",
          offset,
          `renamed column "${name}" in a JOIN USING list has no position in the parse tree`
        )
      }
      ownMerged.add(name)
    }
    if (
      join.isNatural === true &&
      leaves.some((l) => l.table !== undefined && l.table.columns.size > 0)
    ) {
      this.problem(
        "rewrite.unsupported",
        offset,
        "a NATURAL JOIN matches columns by name, and the promotion renames columns of one side"
      )
    }
    // `ON` бачить лише джерела свого з'єднання і зовнішні рівні.
    this.walk(join.quals, pushLevel(env, { items: own, merged: ownMerged }))
    for (const name of ownMerged) merged.add(name)
    const usingAlias = join.join_using_alias?.aliasname
    const extra: Item[] =
      usingAlias === undefined
        ? []
        : [{ leaf: { refname: usingAlias, aliased: true, columns: using } }]
    if (join.alias?.aliasname !== undefined) {
      if (
        join.alias.colnames !== undefined &&
        leaves.some((l) => l.table !== undefined)
      ) {
        this.problem(
          "rewrite.unsupported",
          offset,
          "a column alias list on a join that contains a promoted table maps columns by position"
        )
      }
      return [{ group: { refname: join.alias.aliasname, leaves } }, ...extra]
    }
    return [...own, ...extra]
  }

  private subselect(sub: RangeSubselect, env: Env, lateral: () => Env): Leaf {
    const query = sub.subquery
    const outputs =
      query !== undefined && "SelectStmt" in query
        ? this.select(
            query.SelectStmt,
            sub.lateral === true ? lateral() : env,
            KEEP
          )
        : undefined
    const leaf: Leaf = {
      refname: sub.alias?.aliasname,
      aliased: true,
      columns: completeNames(outputs?.pre, stringList(sub.alias?.colnames)),
    }
    if (outputs?.unproven !== undefined) leaf.unproven = outputs.unproven
    return leaf
  }

  /**
   * Виклик функції в `FROM`. Форму рядка доводять лише список визначень
   * колонок (`AS x(a int, …)`) і відома скалярна функція каталогу; список
   * псевдонімів (`AS x(a, b)`) перейменовує лише перші колонки складеного
   * результату, тож форми не доводить.
   */
  private rangeFunction(fn: RangeFunction, env: Env): Leaf {
    this.walk(fn.functions, env)
    this.walk(fn.coldeflist, env)
    const name = functionName(fn)
    const refname = fn.alias?.aliasname ?? name?.name
    const ordinality = fn.ordinality === true ? ["ordinality"] : []
    if (fn.coldeflist !== undefined) {
      const defined = fn.coldeflist.flatMap((c) =>
        "ColumnDef" in c && c.ColumnDef.colname !== undefined
          ? [c.ColumnDef.colname]
          : []
      )
      return { refname, aliased: true, columns: [...defined, ...ordinality] }
    }
    if (
      name !== undefined &&
      (fn.functions?.length ?? 0) === 1 &&
      name.scalar
    ) {
      // Скалярний результат — одна колонка з ім'ям псевдоніма чи функції.
      const column =
        stringList(fn.alias?.colnames)?.[0] ?? fn.alias?.aliasname ?? name.name
      return { refname, aliased: true, columns: [column, ...ordinality] }
    }
    return {
      refname,
      aliased: true,
      columns: undefined,
      unproven: `the function-call source ${name?.name ?? "(unnamed)"}()`,
    }
  }

  /** Відношення в `FROM`: CTE, промотована таблиця чи таблиця моделі. */
  private rangeVar(rv: RangeVar, env: Env): Leaf {
    const relname = rv.relname ?? ""
    const refname = rv.alias?.aliasname ?? relname
    const aliased = rv.alias !== undefined
    if (
      rv.schemaname === undefined &&
      rv.catalogname === undefined &&
      env.ctes.has(relname)
    ) {
      const shape = env.ctes.get(relname)!
      const leaf: Leaf = {
        refname,
        aliased,
        columns: completeNames(shape.columns, stringList(rv.alias?.colnames)),
      }
      if (shape.unproven !== undefined) leaf.unproven = shape.unproven
      return leaf
    }
    const resolved = this.resolveTable(
      rv.catalogname,
      rv.schemaname,
      relname,
      rv.location
    )
    if (resolved.failed)
      return { refname, aliased, columns: undefined, failed: true }
    const { schema, table, known } = resolved
    if (table !== undefined) {
      this.renameRelation(rv, table)
      if (rv.alias?.colnames !== undefined) {
        this.problem(
          "rewrite.unsupported",
          this.at(rv.location),
          `a column alias list on promoted table "${table.from}" maps columns by position`
        )
        return {
          refname,
          aliased,
          schema,
          relname,
          table,
          columns: undefined,
          failed: true,
        }
      }
    }
    const aliases = stringList(rv.alias?.colnames)
    const columns =
      known === undefined
        ? undefined
        : aliases === undefined
          ? known
          : [...aliases, ...known.slice(aliases.length)]
    return {
      refname,
      aliased,
      schema,
      relname,
      table,
      columns,
      location: this.at(rv.location),
    }
  }

  /**
   * Перейменована таблиця без аліасу змінює видиме ім'я свого елемента
   * `FROM`; ім'я, яке вже займає інший елемент того самого рівня, — помилка
   * Postgres після промоції.
   */
  private checkNames(items: readonly Item[]): void {
    for (const item of items) {
      if (!("leaf" in item)) continue
      const { leaf } = item
      const table = leaf.table
      if (table === undefined || leaf.aliased || table.from === table.to)
        continue
      if (items.some((o) => o !== item && postRefname(o) === table.to)) {
        this.problem("rewrite.ambiguous-name", leaf.location ?? 0, "capture")
      }
    }
  }

  /**
   * Джерело за видимим ім'ям, резолвлене двічі — до промоції й після (рішення
   * 14). Різні відповіді чи нове ім'я, яке вже займає змінна або запис, —
   * захоплення: `null` (відмову записано). `undefined` — такого джерела немає.
   */
  private source(
    name: string,
    env: Env,
    ref: ColumnRef
  ): Item | undefined | null {
    const before = findByRefname(env.levels, name, false)
    const renamed = (before === undefined ? name : postRefname(before)) ?? name
    const after = findByRefname(env.levels, renamed, true)
    const shadowed =
      renamed !== name &&
      (this.scope.variables.has(renamed) || this.scope.records.has(renamed))
    if (before !== after || shadowed) {
      this.problem("rewrite.ambiguous-name", this.at(ref.location), "capture")
      return null
    }
    return before
  }

  /** Ціль `INSERT`/`UPDATE`/`DELETE`: CTE тут не відношення. */
  private targetLeaf(rv: RangeVar, env: Env): Leaf {
    return this.rangeVar(rv, { levels: env.levels, ctes: new Map() })
  }

  /** Ім'я таблиці за правилом `resolveTableName`; відмову записано як проблему. */
  private resolveTable(
    catalog: string | undefined,
    schema: string | undefined,
    relname: string,
    location: number | undefined
  ): TableResolution {
    const resolved = resolveTableName(
      this.map,
      this.scope.searchPath,
      catalog,
      schema,
      relname
    )
    if (resolved.failed) {
      this.problem(resolved.code, this.at(location), resolved.detail)
    }
    return resolved
  }

  private renameRelation(rv: RangeVar, table: TableRename): void {
    if (table.from === table.to) return
    const names = [rv.catalogname, rv.schemaname, rv.relname].filter(
      (n) => n !== undefined
    )
    const tokens = this.tokens(rv.location, names)
    const last = tokens?.at(-1)
    if (last !== undefined)
      this.edit(last.start, last.end, quoteIdent(table.to))
  }

  /** `FOR UPDATE OF <ім'я>`: ім'я таблиці без псевдоніма слідує за її перейменуванням. */
  private lockedRel(rv: RangeVar, level: Level): void {
    const item = findByRefname([level], rv.relname ?? "", false)
    const leaf = item !== undefined && "leaf" in item ? item.leaf : undefined
    const table = leaf?.table
    if (
      leaf === undefined ||
      table === undefined ||
      leaf.aliased ||
      table.from === table.to
    )
      return
    const tokens = this.tokens(rv.location, [rv.relname ?? ""])
    if (tokens !== undefined)
      this.edit(tokens[0]!.start, tokens[0]!.end, quoteIdent(table.to))
  }

  // --- Список виводу --------------------------------------------------------

  /**
   * Список виводу: імена до правок (`pre`) і після (`post`). Голе посилання на
   * перейменовану колонку отримує ` AS <старе>` — форма запису, RPC і
   * підзапиту не змінюється, як Postgres робить для в'юх.
   */
  private outputList(
    targets: ResTarget[],
    env: Env,
    level: Level,
    mode: OutputMode
  ): Outputs {
    const pre: (string | undefined)[] = []
    const post: (string | undefined)[] = []
    let unproven: string | undefined
    for (const t of targets) {
      const name = outputName(t)
      pre.push(name)
      const value = t.val
      if (
        value !== undefined &&
        "ColumnRef" in value &&
        isStar(value.ColumnRef)
      ) {
        this.starRef(value.ColumnRef, env, { level, mode })
        unproven ??= starUnproven(value.ColumnRef, env, level)
        post.push(name)
        continue
      }
      const results = new Map<ColumnRef, RefResult>()
      this.walk(value, env, results)
      const source = nameSource(value)
      const result = source === undefined ? undefined : results.get(source)
      if (t.name !== undefined || result?.to === undefined) {
        post.push(name)
        continue
      }
      if (!mode.alias) {
        post.push(result.to)
        continue
      }
      // Голе посилання без дужок: ` AS` одразу за ним. У дужках чи у виразі
      // кінця цілі в дереві немає — вставка наосліп зламала б вираз.
      const bare = value !== undefined && "ColumnRef" in value
      if (bare && t.location === source?.location) {
        this.edit(result.end, result.end, ` AS ${quoteIdent(result.old)}`)
        post.push(name)
        continue
      }
      if (mode.names) {
        this.problem(
          "rewrite.unsupported",
          this.at(t.location),
          `the output column name "${result.old}" comes from a renamed column inside an expression; give it an explicit alias`
        )
      }
      post.push(undefined)
    }
    return unproven === undefined ? { pre, post } : { pre, post, unproven }
  }

  /** `GROUP BY <ім'я>`: спершу вхідна колонка свого рівня, потім ім'я виводу. */
  private groupItem(
    node: Node,
    env: Env,
    level: Level,
    outputs: Outputs
  ): void {
    const name = bareName(node)
    if (
      name !== undefined &&
      !levelHas(level, name) &&
      outputs.pre.includes(name)
    ) {
      this.outputNameOrExpr(node, env, outputs)
      return
    }
    this.walk(node, env)
  }

  /**
   * `ORDER BY`/`DISTINCT ON`: голе ім'я спершу шукається серед імен виводу
   * (правило SQL92 у `findTargetlistEntrySQL92`).
   */
  private outputNameOrExpr(node: Node, env: Env, outputs: Outputs): void {
    const name = bareName(node)
    if (name === undefined || !outputs.pre.includes(name)) {
      this.walk(node, env)
      return
    }
    // Ім'я посилається на вивід. Вивід зберіг ім'я — правити нічого. Якщо
    // синтетичний верхній список змінив його (без ` AS`), посилання йде за
    // ним як за вхідною колонкою — це те саме значення.
    if (outputs.post.includes(name)) return
    const indexes = outputs.pre.flatMap((n, i) => (n === name ? [i] : []))
    if (indexes.every((i) => outputs.post[i] !== undefined))
      this.walk(node, env)
    else {
      this.problem(
        "rewrite.unsupported",
        this.at(firstLocation(node)),
        `ORDER BY "${name}" refers to an output column whose name the rewrite changes`
      )
    }
  }

  // --- Вирази -------------------------------------------------------------

  /**
   * Загальний обхід виразу. `results` збирає підсумки посилань на колонки —
   * список виводу читає їх для ` AS <старе>`.
   */
  private walk(
    value: unknown,
    env: Env,
    results?: Map<ColumnRef, RefResult>
  ): void {
    if (Array.isArray(value)) {
      for (const item of value) this.walk(item, env, results)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (typeof child !== "object" || child === null) continue
      switch (key) {
        case "ColumnRef": {
          const ref = child as ColumnRef
          const result = this.columnRef(ref, env)
          if (result !== undefined) results?.set(ref, result)
          break
        }
        case "A_Const":
          this.literal(child as A_Const)
          break
        case "SubLink":
          this.subLink(child as SubLink, env)
          break
        case "A_Indirection":
          this.indirection(child as A_Indirection, env, results)
          break
        case "SelectStmt":
          this.select(child as SelectStmt, env, KEEP)
          break
        case "InsertStmt":
          this.insert(child as InsertStmt, env, KEEP)
          break
        case "UpdateStmt":
          this.update(child as UpdateStmt, env, KEEP)
          break
        case "DeleteStmt":
          this.delete(child as DeleteStmt, env, KEEP)
          break
        case "RangeVar":
          this.looseRangeVar(child as RangeVar)
          break
        // `TypeName` буває і обгорнутим вузлом, і прямим полем (`TypeCast.typeName`).
        case "TypeName":
        case "typeName":
          this.typeName(child as TypeName, env)
          break
        default:
          this.walk(child, env, results)
      }
    }
  }

  /**
   * `(<вираз>).поле`: поля непрямого доступу в дереві без позицій, тож поле з
   * іменем перейменованої колонки не можна ні довести чужим, ні переписати.
   */
  private indirection(
    node: A_Indirection,
    env: Env,
    results: Map<ColumnRef, RefResult> | undefined
  ): void {
    const field = (node.indirection ?? []).find((n) => "String" in n)
    const name =
      field !== undefined && "String" in field ? field.String.sval : undefined
    if (name !== undefined && this.relevantColumn(name)) {
      this.problem(
        "rewrite.unsupported",
        this.at(firstLocation(node.arg)),
        `field "${name}" of a parenthesized row value has no position in the parse tree`
      )
    }
    this.walk(node.arg, env, results)
    this.walk(node.indirection, env, results)
  }

  /** Відношення поза `FROM` (`TRUNCATE`, `LOCK`): лише ім'я таблиці. */
  private looseRangeVar(rv: RangeVar): void {
    const resolved = this.resolveTable(
      rv.catalogname,
      rv.schemaname,
      rv.relname ?? "",
      rv.location
    )
    if (!resolved.failed && resolved.table !== undefined) {
      this.renameRelation(rv, resolved.table)
    }
  }

  private subLink(link: SubLink, env: Env): void {
    this.walk(link.testexpr, env)
    const query = link.subselect
    if (query === undefined || !("SelectStmt" in query)) {
      this.walk(query, env)
      return
    }
    // Список виводу `EXISTS` ніхто не читає; `IN`/`ANY` порівнюють колонки за
    // позицією; скалярний підзапит і `ARRAY` віддають ім'я й значення колонки.
    const kind = link.subLinkType
    const mode: OutputMode =
      kind === "EXISTS_SUBLINK"
        ? { alias: true, names: false, stars: false, top: false }
        : kind === "EXPR_SUBLINK" || kind === "ARRAY_SUBLINK"
          ? KEEP
          : { alias: true, names: false, stars: true, top: false }
    this.select(query.SelectStmt, env, mode)
  }

  /** Рядковий літерал, рівний мітці споживача (рішення 4): дані кодують об'єкт старою міткою. */
  private literal(constant: A_Const): void {
    const value = constant.sval?.sval
    if (value === undefined || !this.labels.has(value)) return
    this.problem(
      "rewrite.label-literal",
      this.at(constant.location),
      `string literal '${value}' equals a consumer label of the promoted object`
    )
  }

  /** Тип рядка промотованої таблиці (`::app.t`, `app.t.col%TYPE`) — те саме ім'я відношення. */
  private typeName(tn: TypeName, env: Env): void {
    this.walk([tn.typmods, tn.arrayBounds], env)
    const names = strings(tn.names ?? [])
    if (names === undefined) return
    const relation = tn.pct_type === true ? names.slice(0, -1) : names
    const relname = relation.at(-1)
    if (relname === undefined || !this.promotedNames.has(relname)) return
    if (relation.length > 3) {
      this.problem(
        "rewrite.unsupported",
        this.at(tn.location),
        `a ${relation.length}-part name of promoted table "${relname}" is not rewritten`
      )
      return
    }
    const catalog = relation.length === 3 ? relation[0] : undefined
    const schema = relation.length >= 2 ? relation.at(-2) : undefined
    const resolved = this.resolveTable(catalog, schema, relname, tn.location)
    if (resolved.failed || resolved.table === undefined) return
    const table = resolved.table
    const column = tn.pct_type === true ? names.at(-1)! : undefined
    const renamed = column === undefined ? undefined : table.columns.get(column)
    if (column !== undefined && !table.columnsAfter.has(renamed ?? column)) {
      this.removed(column, table, tn.location)
      return
    }
    const tokens = this.tokens(tn.location, names)
    if (tokens === undefined) return
    const relToken = tokens[relation.length - 1]!
    if (table.from !== table.to) {
      this.edit(relToken.start, relToken.end, quoteIdent(table.to))
    }
    const colToken = tokens.at(-1)!
    if (renamed !== undefined) {
      this.edit(colToken.start, colToken.end, quoteIdent(renamed))
    }
    // Значення типу рядка промотованої таблиці отримує поля виду.
    if (column === undefined) this.change("wholeRow", this.at(tn.location))
  }

  /** Посилання на зняту колонку (без нового імені): правити нема на що. */
  private removed(
    column: string,
    table: TableRename,
    location: number | undefined
  ): void {
    this.problem(
      "rewrite.unsupported",
      this.at(location),
      `column "${column}" of promoted table "${table.from}" is removed by the promotion`
    )
  }

  /** Посилання на колонку чи запис (рішення 13: резолв за областями `FROM`). */
  private columnRef(ref: ColumnRef, env: Env): RefResult | undefined {
    if (isStar(ref)) {
      // `<ім'я>.*` поза списком виводу — ціле значення рядка.
      this.starRef(ref, env, undefined)
      return undefined
    }
    const names = strings(ref.fields ?? [])
    if (names === undefined || names.length === 0) return undefined
    if (names.length === 1) return this.unqualified(names[0]!, ref, env)
    if (names.length > 3) {
      if (names.some((n) => this.relevantName(n))) {
        this.problem(
          "rewrite.unsupported",
          this.at(ref.location),
          `a ${names.length}-part name that mentions a promoted table or a renamed column is not rewritten`
        )
      }
      return undefined
    }
    const found = this.qualified(names, env, ref, false)
    if (found === undefined) {
      // `a.b`, де `a` — не джерело й не запис: `a` — колонка складеного типу.
      if (!this.scope.variables.has(names[0]!)) {
        const inner = this.resolveUnqualified(names[0]!, ref, env, names)
        if (inner?.result !== undefined) {
          return { old: names.at(-1)!, end: inner.result.end }
        }
        // Кваліфікатор — ні джерело, ні запис, ні колонка: мітка блоку, ім'я
        // функції чи ALIAS PL/pgSQL. Запис за ним невідомий, тож змінене
        // поле не переписати й не пропустити мовчки.
        const offset = this.at(ref.location)
        const field = names.slice(1).find((n) => this.relevantColumn(n))
        const reported = [...this.problems.values()].some(
          (p) => p.offset === offset
        )
        if (inner === undefined && field !== undefined && !reported) {
          this.problem(
            "rewrite.unsupported",
            offset,
            `"${names.join(".")}": "${names[0]}" is neither a source in FROM nor a known record (a block label, the function name or an ALIAS), and "${field}" is a column that the promotion changes`
          )
        }
      }
      return undefined
    }
    if ("record" in found) return this.recordRef(found, names, ref)
    return this.qualifiedColumn(found, names, ref)
  }

  /**
   * `*` чи `<ім'я>.*`. `output` — у списку виводу: там це `star` (з винятком
   * `intoRowtypeOf` у верхньому списку), поза ним — ціле значення рядка.
   */
  private starRef(
    ref: ColumnRef,
    env: Env,
    output: { level: Level; mode: OutputMode } | undefined
  ): void {
    const offset = this.at(ref.location)
    const names = strings((ref.fields ?? []).slice(0, -1))
    if (names === undefined) return
    const report = (leaves: readonly Leaf[]) => {
      const promoted = leaves.filter((l) => l.table !== undefined)
      if (promoted.length === 0) return
      if (output === undefined) {
        this.change("wholeRow", offset)
        return
      }
      const exempt =
        output.mode.top &&
        leaves.length === 1 &&
        sameTable(promoted[0]!.table!, this.scope.intoRowtypeOf)
      if (output.mode.stars && !exempt) this.change("star", offset)
    }
    if (names.length === 0) {
      if (output !== undefined) report(output.level.items.flatMap(leavesOf))
      return
    }
    const found = this.qualified(names, env, ref, true)
    if (found === undefined) return
    if (found.depth < names.length) {
      // `<джерело>.<колонка>.*` — розгортання складеної колонки: важить лише
      // ім'я самої колонки.
      if ("record" in found) this.recordRef(found, names, ref)
      else this.qualifiedColumn(found, names, ref)
      return
    }
    if ("record" in found) {
      if (output === undefined || output.mode.stars) {
        this.recordWhole(
          found.record,
          offset,
          output === undefined ? "wholeRow" : "star"
        )
      }
      return
    }
    report(found.leaves)
    // `<таблиця>.*` без аліасу: кваліфікатор іде за перейменуванням таблиці.
    const table = found.renameQualifier ? found.leaves[0]?.table : undefined
    if (table === undefined || table.from === table.to) return
    const tokens = this.tokens(ref.location, names)
    const token = tokens?.[found.depth - 1]
    if (token !== undefined) {
      this.edit(token.start, token.end, quoteIdent(table.to))
    }
  }

  /** Поле запису PL/pgSQL (`NEW.x`, `r.x`). */
  private recordRef(
    found: { record: RecordBinding; name: string; depth: number },
    names: string[],
    ref: ColumnRef
  ): RefResult | undefined {
    const tokens = this.tokens(ref.location, names)
    if (tokens === undefined) return undefined
    const field = names[found.depth]!
    const end = tokens.at(-1)!.end
    const target = this.recordField(found.record, found.name, field, ref)
    if (target === undefined) return { old: names.at(-1)!, end }
    const token = tokens[found.depth]!
    this.edit(token.start, token.end, quoteIdent(target))
    return found.depth === names.length - 1
      ? { old: field, to: target, end }
      : { old: names.at(-1)!, end }
  }

  /** Колонка джерела, знайденого за кваліфікатором; далі — поля складеного значення. */
  private qualifiedColumn(
    found: { leaves: Leaf[]; depth: number; renameQualifier: boolean },
    names: string[],
    ref: ColumnRef
  ): RefResult | undefined {
    const { leaves, depth } = found
    const field = names[depth]!
    let leaf: Leaf | undefined = leaves.length === 1 ? leaves[0] : undefined
    if (leaves.length > 1) {
      // Псевдонім `JOIN`: колонку дає одне з внутрішніх джерел.
      const hits = leaves.filter((l) => l.columns?.includes(field) ?? false)
      const unknown = leaves.filter((l) => l.columns === undefined)
      const fn = unknown.find((l) => l.unproven !== undefined)
      if (hits.length === 1 && unknown.length === 0) leaf = hits[0]
      else if (fn !== undefined && this.relevantColumn(field)) {
        this.unprovenProblem(ref, names.join("."), fn.unproven!, field)
        return undefined
      } else if (leaves.some((l) => l.table?.columns.has(field))) {
        this.problem(
          "rewrite.ambiguous-name",
          this.at(ref.location),
          `"${names.join(".")}" may refer to a renamed column of more than one joined table`
        )
        return undefined
      }
    }
    if (
      leaf?.unproven !== undefined &&
      leaf.columns === undefined &&
      this.relevantColumn(field)
    ) {
      // Оператор може не згадувати таблицю (`unnest(a)` параметра-масиву),
      // а функція — віддавати її рядки: мовчки лишене ім'я зламалося б.
      this.unprovenProblem(ref, names.join("."), leaf.unproven, field)
      return undefined
    }
    if (
      leaf !== undefined &&
      leaf.table === undefined &&
      leaf.columns === undefined &&
      leaf.failed !== true &&
      this.touches &&
      this.relevantColumn(field)
    ) {
      // Джерело з невідомими колонками (`*` підзапиту, функція) може віддавати
      // колонки промотованої таблиці під новими іменами.
      this.problem(
        "rewrite.ambiguous-name",
        this.at(ref.location),
        `"${names.join(".")}" refers to a source whose columns are unknown`
      )
      return undefined
    }
    const renamed = leaf?.table?.columns.get(field)
    const target = renamed ?? field
    if (leaf?.table !== undefined && !leaf.table.columnsAfter.has(target)) {
      this.removed(field, leaf.table, ref.location)
      return undefined
    }
    if (leaf !== undefined && leaves.length > 1) {
      // Псевдонім `JOIN`: після промоції ім'я має давати те саме джерело.
      const after = leaves.filter(
        (l) => columnsAfter(l)?.includes(target) ?? true
      )
      if (after.length !== 1 || after[0] !== leaf) {
        this.problem("rewrite.ambiguous-name", this.at(ref.location), "capture")
        return undefined
      }
    }
    const qualifier = found.renameQualifier ? leaves[0]?.table : undefined
    const renameQualifier =
      qualifier !== undefined && qualifier.from !== qualifier.to
    if (renamed === undefined && !renameQualifier) {
      // Правити нічого; кінець потрібен лише для ` AS`, а його тут немає.
      return undefined
    }
    const tokens = this.tokens(ref.location, names)
    if (tokens === undefined) return undefined
    if (renameQualifier) {
      const token = tokens[depth - 1]!
      this.edit(token.start, token.end, quoteIdent(qualifier.to))
    }
    const end = tokens.at(-1)!.end
    if (renamed === undefined) return { old: names.at(-1)!, end }
    const token = tokens[depth]!
    this.edit(token.start, token.end, quoteIdent(renamed))
    return depth === names.length - 1
      ? { old: field, to: renamed, end }
      : { old: names.at(-1)!, end }
  }

  /**
   * Джерело за кваліфікатором: `схема.таблиця` без псевдоніма, ім'я джерела
   * (від внутрішнього рівня до зовнішнього) чи запис PL/pgSQL. `depth` —
   * індекс поля-колонки в `names`. Збіг джерела й змінної — неоднозначність:
   * PL/pgSQL (`variable_conflict = error`) теж відмовить.
   */
  private qualified(
    names: string[],
    env: Env,
    ref: ColumnRef,
    star: boolean
  ):
    | { leaves: Leaf[]; depth: number; renameQualifier: boolean }
    | { record: RecordBinding; name: string; depth: number }
    | undefined {
    if (names.length >= (star ? 2 : 3)) {
      const [schema, relname] = names as [string, string]
      for (const level of [...env.levels].reverse()) {
        const leaf = level.items
          .flatMap((i) => ("leaf" in i ? [i.leaf] : []))
          .find(
            (l) => !l.aliased && l.schema === schema && l.relname === relname
          )
        if (leaf !== undefined) {
          return { leaves: [leaf], depth: 2, renameQualifier: true }
        }
      }
    }
    const first = names[0]!
    const item = this.source(first, env, ref)
    if (item === null) return undefined
    const record = this.scope.records.get(first)
    if (item !== undefined) {
      if (record !== undefined || this.scope.variables.has(first)) {
        if (
          record !== undefined ||
          leavesOf(item).some((l) => l.table !== undefined)
        ) {
          this.problem(
            "rewrite.ambiguous-name",
            this.at(ref.location),
            `"${first}" is both a source in FROM and a PL/pgSQL variable`
          )
        }
        return undefined
      }
      return "leaf" in item
        ? { leaves: [item.leaf], depth: 1, renameQualifier: !item.leaf.aliased }
        : { leaves: item.group.leaves, depth: 1, renameQualifier: false }
    }
    if (record !== undefined) return { record, name: first, depth: 1 }
    return undefined
  }

  /** Некваліфіковане ім'я: колонка, ціле значення джерела чи запису, змінна. */
  private unqualified(
    name: string,
    ref: ColumnRef,
    env: Env
  ): RefResult | undefined {
    const resolved = this.resolveUnqualified(name, ref, env, [name])
    if (resolved !== undefined) return resolved.result
    // Не колонка жодного рівня: ціле значення джерела чи запису.
    const offset = this.at(ref.location)
    const item = this.source(name, env, ref)
    if (item === null) return undefined
    if (item !== undefined) {
      if (leavesOf(item).some((l) => l.table !== undefined)) {
        this.change("wholeRow", offset)
      }
      const table =
        "leaf" in item && !item.leaf.aliased ? item.leaf.table : undefined
      if (table !== undefined && table.from !== table.to) {
        const tokens = this.tokens(ref.location, [name])
        if (tokens !== undefined) {
          this.edit(tokens[0]!.start, tokens[0]!.end, quoteIdent(table.to))
        }
      }
      return undefined
    }
    const record = this.scope.records.get(name)
    if (record !== undefined) this.recordWhole(record, offset, "wholeRow")
    return undefined
  }

  /**
   * Резолв некваліфікованої колонки за рівнями `FROM` (як `colNameToVar`):
   * перший рівень, де ім'я знайдено, і є відповіддю. `undefined` — ім'я не
   * колонка жодного рівня; `result: undefined` — колонка, але правити нічого
   * (чи відмова вже записана). Ім'я — перше поле `names`.
   */
  private resolveUnqualified(
    name: string,
    ref: ColumnRef,
    env: Env,
    names: string[]
  ): { result: RefResult | undefined } | undefined {
    const offset = this.at(ref.location)
    const levels = [...env.levels].reverse()
    const capture = () => {
      this.problem("rewrite.ambiguous-name", offset, "capture")
      return { result: undefined }
    }
    // Резолв двічі — за каталогом до промоції й після (рішення 14): ім'я, що
    // після промоції веде в інше джерело, — захоплення, а не правка.
    const before = locate(name, levels, false)
    if (before === undefined) {
      // Не колонка: змінна, ціле значення чи невідоме. Колонка з цим ім'ям,
      // що з'являється після промоції, перехопила б посилання.
      const after = locate(name, levels, true)
      if (
        after !== undefined &&
        ("leaf" in after || ("hits" in after && after.hits.length > 0))
      ) {
        return capture()
      }
      return undefined
    }
    if ("merged" in before || "failed" in before) return { result: undefined }
    if ("hits" in before) {
      const fn = before.unknown.find((l) => l.unproven !== undefined)
      if (fn !== undefined && this.relevantColumn(name)) {
        this.unprovenProblem(ref, name, fn.unproven!, name)
        return { result: undefined }
      }
      if (
        this.relevantColumn(name) &&
        (this.touches || before.hits.some((h) => h.table !== undefined))
      ) {
        this.problem(
          "rewrite.ambiguous-name",
          offset,
          before.hits.length > 1
            ? `column "${name}" exists in more than one table in FROM`
            : `column "${name}" may come from a source whose columns are unknown`
        )
      }
      return { result: undefined }
    }
    const leaf = before.leaf
    const renamed = leaf.table?.columns.get(name)
    const target = renamed ?? name
    if (this.scope.variables.has(name) && this.relevantColumn(name)) {
      this.problem(
        "rewrite.ambiguous-name",
        offset,
        `"${name}" is both a column and a PL/pgSQL variable or parameter`
      )
      return { result: undefined }
    }
    const after = locate(target, levels, true)
    if (after !== undefined && "failed" in after) return { result: undefined }
    if (leaf.table !== undefined && !leaf.table.columnsAfter.has(target)) {
      // Знята колонка: без іншого джерела з цим ім'ям — відмова, з ним —
      // ім'я мовчки впало б у зовнішню область.
      if (after === undefined) {
        this.removed(name, leaf.table, ref.location)
        return { result: undefined }
      }
      return capture()
    }
    if (
      after === undefined ||
      !("leaf" in after) ||
      after.leaf !== leaf ||
      (target !== name && this.scope.variables.has(target))
    ) {
      return capture()
    }
    if (renamed === undefined) return { result: undefined }
    const tokens = this.tokens(ref.location, names)
    if (tokens === undefined) return { result: undefined }
    const token = tokens[0]!
    this.edit(token.start, token.end, quoteIdent(renamed))
    const end = tokens.at(-1)!.end
    return {
      result:
        names.length === 1
          ? { old: name, to: renamed, end }
          : { old: names.at(-1)!, end },
    }
  }

  private unprovenProblem(
    ref: ColumnRef,
    text: string,
    source: string,
    field: string
  ): void {
    this.problem(
      "rewrite.unsupported",
      this.at(ref.location),
      `"${text}" may come from ${source} in FROM, whose row shape is not proven, and "${field}" is a column that the promotion changes; give the call a column definition list or select the columns explicitly`
    )
  }

  /** Ім'я, резолв якого промоція може змінити. */
  private relevantColumn(name: string): boolean {
    return this.changedColumns.has(name)
  }

  private relevantName(name: string): boolean {
    return this.promotedNames.has(name) || this.relevantColumn(name)
  }

  /** Нове ім'я поля запису; `undefined` — поле не змінюється чи прив'язка не доведена. */
  private recordField(
    record: RecordBinding,
    name: string,
    field: string,
    ref: ColumnRef
  ): string | undefined {
    if ("table" in record) {
      const { table } = record
      const target = table.columns.get(field) ?? field
      if (this.isPromoted(table) && !table.columnsAfter.has(target)) {
        this.removed(field, table, ref.location)
        return undefined
      }
      return target === field ? undefined : target
    }
    // `NEW.x` переписується, лише коли всі таблиці прив'язки однаково
    // перейменовують поле: одне тіло обслуговує їх усі.
    const targets = new Set(
      record.trigger.map((t) => t.columns.get(field) ?? field)
    )
    if (record.trigger.length === 0 || targets.size !== 1) {
      this.problem(
        "rewrite.trigger-binding",
        this.at(ref.location),
        record.trigger.length === 0
          ? `${name.toUpperCase()}.${field}: the function is not bound to promoted tables by triggers or subscriptions`
          : `${name.toUpperCase()}.${field}: the tables the function is bound to do not rename the column the same way`
      )
      return undefined
    }
    const target = [...targets][0]!
    const gone = record.trigger.find(
      (t) => this.isPromoted(t) && !t.columnsAfter.has(target)
    )
    if (gone !== undefined) {
      this.removed(field, gone, ref.location)
      return undefined
    }
    return target === field ? undefined : target
  }

  /** Ціле значення запису: форма рядка промотованої таблиці змінюється. */
  private recordWhole(
    record: RecordBinding,
    offset: number,
    reason: ContractChange["reason"]
  ): void {
    if ("table" in record) {
      if (this.isPromoted(record.table)) this.change(reason, offset)
      return
    }
    if (record.trigger.length === 0) {
      this.problem(
        "rewrite.trigger-binding",
        offset,
        "the whole trigger record is used, and the function is not bound to promoted tables"
      )
      return
    }
    if (record.trigger.some((t) => this.isPromoted(t))) {
      this.change(reason, offset)
    }
  }

  /** Промотована — таблиця з мапи; тотожний запис прив'язки (`from === to`) — ні. */
  private isPromoted(table: TableRename): boolean {
    return this.map.tables.some((t) => sameTable(t, table))
  }

  // --- Позиції ---------------------------------------------------------------

  /** Індекс UTF-16 за байтовою позицією libpg-query; без позиції — початок тексту. */
  private at(location: number | undefined): number {
    return location === undefined || location < 0 ? 0 : this.toIndex(location)
  }

  /**
   * Токени ланцюжка `a.b.c` від позиції вузла. Кожен токен звіряється з іменем
   * з дерева: розбіжність означає, що позиція вказує не на ім'я (наприклад,
   * `U&"…"`), і правка була б наосліп — тоді відмова.
   */
  private tokens(
    location: number | undefined,
    names: readonly string[]
  ): Token[] | undefined {
    if (location === undefined || location < 0) {
      this.problem(
        "rewrite.unsupported",
        0,
        `a reference to "${names.join(".")}" has no position in the parse tree`
      )
      return undefined
    }
    const start = this.toIndex(location)
    const tokens = lexChain(this.text, start, names.length)
    if (tokens === undefined || tokens.some((t, i) => t.value !== names[i])) {
      this.problem(
        "rewrite.unsupported",
        start,
        `the text at the position of "${names.join(".")}" is not a plain or quoted identifier`
      )
      return undefined
    }
    return tokens
  }
}

// --- Допоміжне ---------------------------------------------------------------

function pushLevel(env: Env, level: Level): Env {
  return { levels: [...env.levels, level], ctes: env.ctes }
}

function leavesOf(item: Item): Leaf[] {
  return "leaf" in item ? [item.leaf] : item.group.leaves
}

/**
 * Джерело за видимим ім'ям, від внутрішнього рівня до зовнішнього; `after` —
 * за іменами після промоції (таблиця без аліасу бачиться під новим ім'ям).
 */
function findByRefname(
  levels: readonly Level[],
  name: string,
  after: boolean
): Item | undefined {
  for (const level of [...levels].reverse()) {
    const found = level.items.find(
      (i) => (after ? postRefname(i) : preRefname(i)) === name
    )
    if (found !== undefined) return found
  }
  return undefined
}

function preRefname(item: Item): string | undefined {
  return "leaf" in item ? item.leaf.refname : item.group.refname
}

function postRefname(item: Item): string | undefined {
  if (!("leaf" in item)) return item.group.refname
  const { leaf } = item
  return !leaf.aliased && leaf.table !== undefined
    ? leaf.table.to
    : leaf.refname
}

/** Колонки джерела після промоції; `undefined` — невідомі. */
function columnsAfter(leaf: Leaf): readonly string[] | undefined {
  return leaf.table !== undefined ? [...leaf.table.columnsAfter] : leaf.columns
}

/** Де резолвиться некваліфікована колонка (як `colNameToVar`). */
type Located =
  | { leaf: Leaf }
  | { merged: true }
  | { failed: true }
  | { hits: Leaf[]; unknown: Leaf[] }

/**
 * Перший рівень (від внутрішнього), де ім'я — колонка; `after` — за колонками
 * після промоції. Джерело, про яке вже є відмова, зупиняє пошук: невизначеність
 * через нього відмов не множить.
 */
function locate(
  name: string,
  innermostFirst: readonly Level[],
  after: boolean
): Located | undefined {
  for (const level of innermostFirst) {
    if (level.merged.has(name)) return { merged: true }
    const leaves = level.items.flatMap(leavesOf)
    if (leaves.some((l) => l.failed)) return { failed: true }
    const columns = (l: Leaf) => (after ? columnsAfter(l) : l.columns)
    const hits = leaves.filter((l) => columns(l)?.includes(name) ?? false)
    const unknown = leaves.filter((l) => columns(l) === undefined)
    if (hits.length === 0 && unknown.length === 0) continue
    if (hits.length === 1 && unknown.length === 0) return { leaf: hits[0]! }
    return { hits, unknown }
  }
  return undefined
}

function levelHas(level: Level, name: string): boolean {
  return (
    level.merged.has(name) ||
    level.items
      .flatMap(leavesOf)
      .some((l) => l.columns === undefined || l.columns.includes(name))
  )
}

function sameTable(a: TableRename, b: TableRename | undefined): boolean {
  return b !== undefined && a.schema === b.schema && a.from === b.from
}

function isStar(ref: ColumnRef): boolean {
  const last = ref.fields?.at(-1)
  return last !== undefined && "A_Star" in last
}

/** Поля-рядки вузла; `undefined`, якщо серед них є не рядок. */
function strings(nodes: readonly Node[]): string[] | undefined {
  const out: string[] = []
  for (const node of nodes) {
    if (!("String" in node) || node.String.sval === undefined) return undefined
    out.push(node.String.sval)
  }
  return out
}

function stringList(nodes: Node[] | undefined): string[] | undefined {
  return nodes === undefined ? undefined : strings(nodes)
}

function resTarget(node: Node): ResTarget {
  return "ResTarget" in node ? node.ResTarget : {}
}

function definedNames(names: (string | undefined)[]): Set<string> {
  return new Set(names.filter((n): n is string => n !== undefined))
}

/** Колонки джерела з імен виводу й списку псевдонімів; невідоме ім'я — невідомі колонки. */
function completeNames(
  outputs: readonly (string | undefined)[] | undefined,
  aliases: string[] | undefined
): string[] | undefined {
  if (outputs === undefined) return undefined
  const merged = outputs.map((n, i) => aliases?.[i] ?? n)
  return merged.every((n) => n !== undefined) ? (merged as string[]) : undefined
}

/** Голе одноіменне посилання (`ORDER BY name`). */
function bareName(node: Node): string | undefined {
  if (!("ColumnRef" in node)) return undefined
  const names = strings(node.ColumnRef.fields ?? [])
  return names?.length === 1 ? names[0] : undefined
}

/**
 * Ім'я колонки виводу за правилами `FigureColname` Postgres для форм, що
 * трапляються в тілах функцій; невідома форма — `undefined` (невідоме ім'я
 * робить колонки підзапиту невідомими, а не вгаданими).
 */
function outputName(t: ResTarget): string | undefined {
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
function nameSource(node: Node | undefined): ColumnRef | undefined {
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

function aliasOf(node: Node): string | undefined {
  const inner = Object.values(node)[0] as { alias?: Alias } | undefined
  return inner?.alias?.aliasname
}

/**
 * Функції каталогу, що повертають множину скалярів: їхній рядок — одна
 * колонка, промотованої таблиці в ньому немає.
 */
const SCALAR_SET_FUNCTIONS: ReadonlySet<string> = new Set([
  "generate_series",
  "generate_subscripts",
  "regexp_split_to_table",
  "string_to_table",
  "unnest",
])

/** Ім'я першої функції в `FROM`; `scalar` — відома скалярна функція каталогу. */
function functionName(
  fn: RangeFunction
): { name: string; scalar: boolean } | undefined {
  const first = fn.functions?.[0]
  if (first === undefined || !("List" in first)) return undefined
  const call = first.List.items?.[0]
  if (call === undefined || !("FuncCall" in call)) return undefined
  const names = (call.FuncCall.funcname ?? []).flatMap((n) =>
    "String" in n && n.String.sval !== undefined ? [n.String.sval] : []
  )
  const name = names.at(-1)
  if (name === undefined) return undefined
  // Функція каталогу доводить форму лише над константами: перевантаження
  // застосунку (`app.generate_series(app.t[])` за `search_path`) Postgres
  // обирає за типом аргументу, а тип константи — завжди тип каталогу.
  const args = call.FuncCall.args ?? []
  const scalar =
    (names.length === 1 || names[0] === "pg_catalog") &&
    SCALAR_SET_FUNCTIONS.has(name) &&
    (name !== "unnest" || args.length === 1) &&
    call.FuncCall.agg_star !== true &&
    call.FuncCall.func_variadic !== true &&
    args.every(isConstant)
  return { name, scalar }
}

/** Константний вираз: літерал, його приведення, `ARRAY[…]` і арифметика над ними. */
function isConstant(node: Node): boolean {
  if ("A_Const" in node) return true
  if ("TypeCast" in node) {
    return node.TypeCast.arg !== undefined && isConstant(node.TypeCast.arg)
  }
  if ("A_ArrayExpr" in node) {
    return (node.A_ArrayExpr.elements ?? []).every(isConstant)
  }
  if ("A_Expr" in node && node.A_Expr.kind === "AEXPR_OP") {
    const { lexpr, rexpr } = node.A_Expr
    return (
      (lexpr === undefined || isConstant(lexpr)) &&
      rexpr !== undefined &&
      isConstant(rexpr)
    )
  }
  return false
}

/**
 * Перше джерело з недоведеною формою, над яким розгортається `*`
 * (усі джерела рівня) чи `x.*` (джерело `x`; невідоме — усі джерела рівня).
 */
function starUnproven(
  ref: ColumnRef,
  env: Env,
  level: Level
): string | undefined {
  const names = strings((ref.fields ?? []).slice(0, -1)) ?? []
  const qualifier = names.at(-1)
  const item =
    qualifier === undefined
      ? undefined
      : findByRefname(env.levels, qualifier, false)
  const leaves =
    item === undefined ? level.items.flatMap(leavesOf) : leavesOf(item)
  return leaves.find((l) => l.unproven !== undefined)?.unproven
}

function firstLocation(value: unknown): number | undefined {
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
function mentions(value: unknown, names: ReadonlySet<string>): boolean {
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

function statementKind(stmt: Node): string {
  return Object.keys(stmt)[0] ?? "statement"
}
