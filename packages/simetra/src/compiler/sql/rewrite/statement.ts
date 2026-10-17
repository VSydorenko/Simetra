import type {
  A_Const,
  A_Indirection,
  ColumnRef,
  CommonTableExpr,
  DeleteStmt,
  FuncCall,
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
  TypeCast,
  TypeName,
  UpdateStmt,
} from "libpg-query"
import { quoteIdent } from "simetra/model"
import type { SqlParser } from "../parse"
import { functionName } from "./catalog"
import { ColumnResolver } from "./columns"
import { RewriteContext } from "./context"
import {
  checkLiteral,
  checkRegclassLiteral,
  checkSequenceName,
} from "./literals"
import {
  aliasOf,
  bareName,
  coalesces,
  firstLocation,
  isRowExpansion,
  isStar,
  mentions,
  nameSource,
  outputName,
  resTarget,
  statementKind,
  stringList,
} from "./nodes"
import {
  checkNames,
  lockedRel,
  looseRangeVar,
  renameRelation,
  resolveTable,
  typeName,
} from "./relations"
import type {
  ContractChange,
  RenameMap,
  RewriteProblem,
  RewriteScope,
  TextEdit,
} from "./renames"
import {
  aliasShape,
  KEEP,
  leavesOf,
  levelHas,
  levelHasAfter,
  pushLevel,
  REPORTED,
  unproven,
  type Env,
  type Group,
  type Item,
  type Leaf,
  type Level,
  type OutputMode,
  type Outputs,
  type RefResult,
  type Shape,
} from "./sources"

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
  const ctx = new RewriteContext(text, map, scope)
  const rewriter = new StatementRewriter(ctx)
  const parsed = parse(text)
  if (!parsed.ok) {
    ctx.problem(
      "rewrite.unsupported",
      parsed.offset,
      `the statement does not parse: ${parsed.message}`
    )
  } else {
    for (const statement of parsed.statements) {
      rewriter.statement(statement.stmt, statement.start)
    }
  }
  return ctx.result()
}

/**
 * Обхід дерева оператора за його видами: області `FROM`, списки виводу,
 * підзапити й вирази. Імена колонок резолвить `ColumnResolver`, імена
 * відношень і рядки перевіряють `relations` і `literals`; усе записується в
 * спільний `RewriteContext`.
 */
class StatementRewriter {
  private readonly columns: ColumnResolver

  constructor(private readonly ctx: RewriteContext) {
    this.columns = new ColumnResolver(ctx)
  }

  /** Оператор верхнього рівня; `start` — його початок для відмови без позиції. */
  statement(stmt: Node, start: number): void {
    this.ctx.touches = mentions(stmt, this.ctx.promotedNames)
    const top: OutputMode = {
      alias: this.ctx.scope.topLevelOutput !== "ignore",
      names: this.ctx.scope.topLevelOutput !== "ignore",
      stars: this.ctx.scope.topLevelOutput !== "ignore",
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
      mentions(
        stmt,
        new Set([...this.ctx.promotedNames, ...this.ctx.renamedColumns])
      )
    ) {
      // Інші оператори несуть імена колонок і таблиць у вузлах без позицій
      // (DDL, `MERGE`, `COPY`): правити їх наосліп не можна.
      this.ctx.problem(
        "rewrite.unsupported",
        start,
        `${statementKind(stmt)} that names a promoted table or a renamed column is not rewritten`
      )
    } else this.walk(stmt, env)
  }

  // --- Оператори ---------------------------------------------------------

  /** `SELECT`; повертає імена виводу для CTE й підзапиту в `FROM`. */
  private select(stmt: SelectStmt, outer: Env, mode: OutputMode): Outputs {
    const env = this.withCtes(
      stmt.withClause?.ctes,
      stmt.withClause?.recursive,
      outer
    )
    if (stmt.op !== undefined && stmt.op !== "SETOP_NONE") {
      // Імена виводу операції над множинами — імена лівої гілки; праву ніхто
      // не читає за іменами, але кількість її колонок важить.
      const left = this.select(stmt.larg ?? {}, env, mode)
      const right = this.select(stmt.rarg ?? {}, env, {
        ...mode,
        names: false,
        top: false,
      })
      // Рядки дає кожна гілка: недоведена форма будь-якої робить недоведеним
      // вивід, хоч імена й беруться з лівої.
      const outputs: Outputs =
        right.shape.columns === undefined && left.shape.columns !== undefined
          ? { ...left, shape: right.shape }
          : left
      const { pre, post } = outputs
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
        coalesced: false,
      }
      for (const sort of stmt.sortClause ?? []) {
        const name =
          "SortBy" in sort && sort.SortBy.node !== undefined
            ? bareName(sort.SortBy.node)
            : undefined
        if (name !== undefined && pre.includes(name) && !post.includes(name)) {
          this.ctx.problem(
            "rewrite.unsupported",
            this.ctx.at(firstLocation(sort)),
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
      return { pre: names, post: names, shape: { columns: names } }
    }

    const level = this.fromLevel(stmt.fromClause ?? [], env)
    checkNames(this.ctx, level.items)
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
        if ("RangeVar" in rel) lockedRel(this.ctx, rel.RangeVar, level)
      }
    }
    return outputs
  }

  private insert(
    stmt: InsertStmt,
    outer: Env,
    mode: OutputMode
  ): Outputs | undefined {
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
    if (target === undefined) return undefined
    if (stmt.cols === undefined || stmt.cols.length === 0) {
      // Вставка без списку колонок — позиційна: промоція додає й перейменовує
      // колонки, тож відповідність значень колонкам змінюється.
      if (target.table !== undefined && stmt.selectStmt !== undefined) {
        this.ctx.change(
          "star",
          this.ctx.at(stmt.relation?.location),
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
    return this.returning(stmt.returningList, target, undefined, env, mode)
  }

  private update(
    stmt: UpdateStmt,
    outer: Env,
    mode: OutputMode
  ): Outputs | undefined {
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
    const level: Level = { ...fromLevel, items }
    checkNames(this.ctx, items)
    const inner = pushLevel(env, level)
    for (const node of stmt.targetList ?? []) {
      if (!("ResTarget" in node)) continue
      const t = node.ResTarget
      if (target !== undefined) this.targetName(t, target, inner)
      this.assignedValue(t, inner)
    }
    this.walk(stmt.whereClause, inner)
    return this.returning(stmt.returningList, target, fromLevel, env, mode)
  }

  private delete(
    stmt: DeleteStmt,
    outer: Env,
    mode: OutputMode
  ): Outputs | undefined {
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
    checkNames(this.ctx, items)
    this.walk(stmt.whereClause, pushLevel(env, { ...using, items }))
    return this.returning(stmt.returningList, target, using, env, mode)
  }

  /** `RETURNING`; повертає його вивід — для CTE, що читає оператор зміни даних. */
  private returning(
    list: Node[] | undefined,
    target: Leaf | undefined,
    from: Level | undefined,
    env: Env,
    mode: OutputMode
  ): Outputs | undefined {
    if (list === undefined) return undefined
    const items: Item[] = [
      ...(target === undefined ? [] : [{ leaf: target }]),
      ...(from?.items ?? []),
    ]
    const level: Level = {
      items,
      merged: new Set(),
      coalesced: from?.coalesced ?? false,
    }
    return this.outputList(
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
      coalesced: false,
    })
    const infer = clause.infer
    if (infer?.conname !== undefined && target.table !== undefined) {
      // Промоція перейменовує таблицю, а її обмеження й індекси — окремими
      // перейменуваннями плану: ім'я обмеження тут не доводиться.
      this.ctx.problem(
        "rewrite.unsupported",
        this.ctx.at(infer.location ?? clause.location),
        `ON CONFLICT ON CONSTRAINT ${infer.conname} names a constraint of promoted table "${target.table.from}", which the promotion renames separately; write ON CONFLICT (<columns>) instead`
      )
    }
    if (infer !== undefined) {
      for (const element of infer.indexElems ?? []) {
        if (!("IndexElem" in element)) continue
        const name = element.IndexElem.name
        if (name !== undefined && target.table?.columns.has(name)) {
          this.ctx.problem(
            "rewrite.unsupported",
            this.ctx.at(infer.location ?? clause.location),
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
      coalesced: false,
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
    const tokens = this.ctx.tokens(t.location, [name])
    if (tokens === undefined) return
    this.ctx.edit(tokens[0]!.start, tokens[0]!.end, quoteIdent(renamed))
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
      // бачить себе раніше, ніж вони відомі: самопосилання недоведене.
      for (const def of defs)
        if (def.ctename !== undefined) {
          visible.set(
            def.ctename,
            unproven(`the recursive CTE "${def.ctename}" inside its own body`)
          )
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

  private cte(def: CommonTableExpr, env: Env): Shape {
    const query = def.ctequery
    let outputs: Outputs | undefined
    if (query !== undefined) {
      if ("SelectStmt" in query)
        outputs = this.select(query.SelectStmt, env, KEEP)
      else if ("InsertStmt" in query)
        outputs = this.insert(query.InsertStmt, env, KEEP)
      else if ("UpdateStmt" in query)
        outputs = this.update(query.UpdateStmt, env, KEEP)
      else if ("DeleteStmt" in query)
        outputs = this.delete(query.DeleteStmt, env, KEEP)
      else this.walk(query, env)
    }
    if (outputs === undefined) {
      return unproven(
        `the CTE "${def.ctename ?? ""}", whose body has no output`
      )
    }
    return aliasShape(outputs.shape, stringList(def.aliascolnames))
  }

  /** Рівень `FROM`: кожне джерело бачить зовнішні рівні, `LATERAL` — і попередні джерела. */
  private fromLevel(from: Node[], env: Env): Level {
    const items: Item[] = []
    const merged = new Set<string>()
    for (const node of from) {
      items.push(...this.fromItem(node, env, items, merged))
    }
    return { items, merged, coalesced: from.some(coalesces) }
  }

  private fromItem(
    node: Node,
    env: Env,
    preceding: Item[],
    merged: Set<string>
  ): Item[] {
    const lateral = (): Env =>
      pushLevel(env, {
        items: [...preceding],
        merged: new Set(merged),
        coalesced: false,
      })
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
    // XMLTABLE, JSON_TABLE і будь-яке джерело, якого переписувач не знає:
    // вирази бачать попередні джерела, колонки не доведено.
    this.walk(node, lateral())
    return [
      {
        leaf: {
          refname: aliasOf(node),
          aliased: true,
          ...unproven(`the ${statementKind(node)} source in FROM`),
        },
      },
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
    const offset = this.ctx.at(
      firstLocation(join.rarg) ?? firstLocation(join.larg)
    )
    // Джерело з недоведеними колонками могло б дати змінене ім'я злиттю.
    const open = leaves.find(
      (l) => l.columns === undefined && l.unproven.reported !== true
    )?.unproven
    for (const name of using) {
      if (leaves.some((l) => l.table?.columns.has(name))) {
        this.ctx.problem(
          "rewrite.unsupported",
          offset,
          `renamed column "${name}" in a JOIN USING list has no position in the parse tree`
        )
      } else if (
        this.ctx.relevantColumn(name) &&
        leaves.some((l) => l.table !== undefined)
      ) {
        // Знята чи додана колонка змінює, з чим злиття зіставляє рядки.
        this.ctx.problem(
          "rewrite.unsupported",
          offset,
          `column "${name}" in a JOIN USING list is a column that the promotion adds, removes or renames`
        )
      } else if (open !== undefined && this.ctx.relevantColumn(name)) {
        this.ctx.problem(
          "rewrite.unsupported",
          offset,
          `column "${name}" in a JOIN USING list may come from ${open.source}: its columns are not proven, and the promotion changes that name`
        )
      }
      ownMerged.add(name)
    }
    if (join.isNatural === true) {
      // Промоція додає, знімає й перейменовує колонки: спільні імена сторін
      // змінюються, навіть коли жодна колонка не перейменована.
      if (leaves.some((l) => l.table !== undefined)) {
        this.ctx.problem(
          "rewrite.unsupported",
          offset,
          "a NATURAL JOIN matches columns by name, and the promotion changes the columns of one side"
        )
      } else if (open !== undefined) {
        this.ctx.problem(
          "rewrite.unsupported",
          offset,
          `a NATURAL JOIN matches columns by name, and ${open.source} has columns that are not proven`
        )
      }
    }
    // `ON` бачить лише джерела свого з'єднання і зовнішні рівні.
    this.walk(
      join.quals,
      pushLevel(env, { items: own, merged: ownMerged, coalesced: false })
    )
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
        this.ctx.problem(
          "rewrite.unsupported",
          offset,
          "a column alias list on a join that contains a promoted table maps columns by position"
        )
      }
      const group: Group = {
        refname: join.alias.aliasname,
        leaves,
        coalesced: coalesces({ JoinExpr: join }),
      }
      return [{ group }, ...extra]
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
    return {
      refname: sub.alias?.aliasname,
      aliased: true,
      ...(outputs === undefined
        ? unproven("a subquery in FROM that is not a SELECT")
        : aliasShape(outputs.shape, stringList(sub.alias?.colnames))),
    }
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
    const name = functionName(fn, this.ctx.tableNames)
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
      ...unproven(
        `the function-call source ${name?.name ?? "(unnamed)"}() in FROM`
      ),
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
      return {
        refname,
        aliased,
        ...aliasShape(shape, stringList(rv.alias?.colnames)),
      }
    }
    const resolved = resolveTable(
      this.ctx,
      rv.catalogname,
      rv.schemaname,
      relname,
      rv.location
    )
    if (resolved.failed) return { refname, aliased, ...REPORTED }
    const { schema, table, known } = resolved
    if (
      table !== undefined &&
      table.from !== table.to &&
      rv.schemaname === undefined &&
      rv.catalogname === undefined &&
      env.ctes.has(table.to)
    ) {
      // Нове ім'я некваліфікованої таблиці вже займає видимий CTE: після
      // перейменування посилання читало б CTE, а не таблицю.
      this.ctx.problem(
        "rewrite.ambiguous-name",
        this.ctx.at(rv.location),
        "capture"
      )
      return { refname, aliased, schema, relname, table, ...REPORTED }
    }
    if (table !== undefined) {
      renameRelation(this.ctx, rv, table)
      if (rv.alias?.colnames !== undefined) {
        this.ctx.problem(
          "rewrite.unsupported",
          this.ctx.at(rv.location),
          `a column alias list on promoted table "${table.from}" maps columns by position`
        )
        return {
          refname,
          aliased,
          schema,
          relname,
          table,
          ...REPORTED,
        }
      }
    }
    // Відношення поза моделлю (в'юха, таблиця провайдера, каталог) може
    // віддавати колонки промотованої таблиці: його колонки не доведено.
    const shape: Shape =
      known === undefined && table !== undefined
        ? unproven(
            `promoted table "${table.from}", whose columns before the promotion are not given`
          )
        : known === undefined
          ? unproven(
              `the relation "${[schema, relname].filter((n) => n !== undefined).join(".")}", which is not a table of the model`
            )
          : aliasShape({ columns: known }, stringList(rv.alias?.colnames))
    return {
      refname,
      aliased,
      schema,
      relname,
      table,
      ...shape,
      location: this.ctx.at(rv.location),
    }
  }

  /** Ціль `INSERT`/`UPDATE`/`DELETE`: CTE тут не відношення. */
  private targetLeaf(rv: RangeVar, env: Env): Leaf {
    return this.rangeVar(rv, { levels: env.levels, ctes: new Map() })
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
    // Колонки виводу як джерела: доведені, доки кожна ціль їх доводить.
    const columns: string[] = []
    let shape: Shape | undefined
    // `*` над недоведеним джерелом: кількість колонок теж не доведена.
    const unprovenStar = (offset: number, expansion: Shape) => {
      shape ??= expansion
      const why = expansion.unproven
      if (mode.stars && why !== undefined && why.reported !== true) {
        this.ctx.change(
          "star",
          offset,
          `a star expands ${why.source}: its columns are not proven, so the promotion may add, remove or rename them`
        )
      }
    }
    for (const [index, t] of targets.entries()) {
      const name = outputName(t)
      pre.push(name)
      const value = t.val
      if (
        value !== undefined &&
        "ColumnRef" in value &&
        isStar(value.ColumnRef)
      ) {
        const expansion = this.columns.starRef(value.ColumnRef, env, {
          level,
          mode,
        })
        const expanded = expansion.shape
        if (expanded.columns !== undefined) columns.push(...expanded.columns)
        else if (expansion.arity) {
          unprovenStar(this.ctx.at(value.ColumnRef.location), expanded)
        } else shape ??= expanded
        post.push(name)
        continue
      }
      if (value !== undefined && isRowExpansion(value)) {
        // `(вираз).*` розгортає складене значення невідомого типу.
        this.walk(value, env)
        unprovenStar(
          this.ctx.at(firstLocation(value)),
          unproven("the row expansion (…).* of a value of unknown type")
        )
        post.push(name)
        continue
      }
      // Будь-яка інша ціль — одна колонка; ім'я, якого `figureName` не
      // визначає, не доводить, що це не змінена колонка.
      if (name === undefined) {
        shape ??= unproven(
          `output column ${index + 1} of a subquery, whose name the rewrite does not determine`
        )
      } else columns.push(name)
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
        this.ctx.edit(result.end, result.end, ` AS ${quoteIdent(result.old)}`)
        post.push(name)
        continue
      }
      if (mode.names) {
        this.ctx.problem(
          "rewrite.unsupported",
          this.ctx.at(t.location),
          `the output column name "${result.old}" comes from a renamed column inside an expression; give it an explicit alias`
        )
      }
      post.push(undefined)
    }
    return { pre, post, shape: shape ?? { columns } }
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
      // Вхідна колонка в `GROUP BY` переважає ім'я виводу: колонка з цим
      // ім'ям, яку додає чи дає перейменування промоція, перехопила б його.
      if (levelHasAfter(level, name)) {
        this.ctx.problem(
          "rewrite.ambiguous-name",
          this.ctx.at(firstLocation(node)),
          "capture"
        )
        return
      }
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
      this.ctx.problem(
        "rewrite.unsupported",
        this.ctx.at(firstLocation(node)),
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
          const result = this.columns.columnRef(ref, env)
          if (result !== undefined) results?.set(ref, result)
          break
        }
        case "A_Const":
          checkLiteral(this.ctx, child as A_Const)
          break
        case "TypeCast":
          checkRegclassLiteral(this.ctx, child as TypeCast)
          this.walk(child, env, results)
          break
        case "SubLink":
          this.subLink(child as SubLink, env)
          break
        case "A_Indirection":
          this.indirection(child as A_Indirection, env, results)
          break
        case "FuncCall":
          this.columns.functionalNotation(child as FuncCall, env)
          checkSequenceName(this.ctx, child as FuncCall)
          this.walk(child, env, results)
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
          looseRangeVar(this.ctx, child as RangeVar)
          break
        // `TypeName` буває і обгорнутим вузлом, і прямим полем (`TypeCast.typeName`).
        case "TypeName":
        case "typeName": {
          const tn = child as TypeName
          this.walk([tn.typmods, tn.arrayBounds], env)
          typeName(this.ctx, tn)
          break
        }
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
    if (name !== undefined && this.ctx.relevantColumn(name)) {
      this.ctx.problem(
        "rewrite.unsupported",
        this.ctx.at(firstLocation(node.arg)),
        `field "${name}" of a parenthesized row value has no position in the parse tree`
      )
    }
    this.walk(node.arg, env, results)
    this.walk(node.indirection, env, results)
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
}

// --- Допоміжне ---------------------------------------------------------------

function definedNames(names: (string | undefined)[]): Set<string> {
  return new Set(names.filter((n): n is string => n !== undefined))
}
