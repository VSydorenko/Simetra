import type { ColumnRef, FuncCall, Node } from "libpg-query"
import { quoteIdent } from "simetra/model"
import { isBuiltinType, isConstant } from "./catalog"
import { sameTable, type RewriteContext } from "./context"
import { isStar, strings } from "./nodes"
import {
  survivesPromotion,
  type ContractChange,
  type RecordBinding,
} from "./renames"
import {
  columnsAfter,
  findByRefname,
  isRelation,
  leavesOf,
  locate,
  postRefname,
  REPORTED,
  starShape,
  unproven,
  type Env,
  type Item,
  type Leaf,
  type Level,
  type OutputMode,
  type RefResult,
  type Shape,
  type StarExpansion,
} from "./sources"

/**
 * Резолв посилань на колонки й записи (рішення 13–14): ім'я резолвиться за
 * рівнями `FROM` до промоції й після, а правка, відмова чи зміна контракту
 * записується в контекст. Обходу дерева тут немає — підзапити обходить
 * `StatementRewriter`, який і кличе цей резолв на кожен `ColumnRef`.
 */
export class ColumnResolver {
  constructor(private readonly ctx: RewriteContext) {}

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
      (this.ctx.scope.variables.has(renamed) ||
        this.ctx.scope.records.has(renamed))
    if (before !== after || shadowed) {
      this.ctx.problem(
        "rewrite.ambiguous-name",
        this.ctx.at(ref.location),
        "capture"
      )
      return null
    }
    return before
  }

  /** Посилання на колонку чи запис (рішення 13: резолв за областями `FROM`). */
  columnRef(ref: ColumnRef, env: Env): RefResult | undefined {
    if (isStar(ref)) {
      // `<ім'я>.*` поза списком виводу — ціле значення рядка.
      this.starRef(ref, env, undefined)
      return undefined
    }
    const names = strings(ref.fields ?? [])
    if (names === undefined || names.length === 0) return undefined
    if (names.length === 1) return this.unqualified(names[0]!, ref, env)
    if (names.length > 3) {
      if (names.some((n) => this.ctx.relevantName(n))) {
        this.ctx.problem(
          "rewrite.unsupported",
          this.ctx.at(ref.location),
          `a ${names.length}-part name that mentions a promoted table or a renamed column is not rewritten`
        )
      }
      return undefined
    }
    const found = this.qualified(names, env, ref, false)
    if (found === undefined) {
      // `a.b`, де `a` — не джерело й не запис: `a` — колонка складеного типу.
      if (!this.ctx.scope.variables.has(names[0]!)) {
        const inner = this.resolveUnqualified(names[0]!, ref, env, names)
        if (inner?.result !== undefined) {
          return { old: names.at(-1)!, end: inner.result.end }
        }
        // Кваліфікатор — ні джерело, ні запис, ні колонка: мітка блоку, ім'я
        // функції чи ALIAS PL/pgSQL. Запис за ним невідомий, тож змінене
        // поле не переписати й не пропустити мовчки.
        const offset = this.ctx.at(ref.location)
        const field = names.slice(1).find((n) => this.ctx.relevantColumn(n))
        const reported = this.ctx.reportedAt(offset)
        if (inner === undefined && field !== undefined && !reported) {
          this.ctx.problem(
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
   * Повертає колонки розгортання; `arity` — недоведена й кількість колонок
   * (а не лише їхні імена), тож `*` у списку виводу — зміна контракту.
   */
  starRef(
    ref: ColumnRef,
    env: Env,
    output: { level: Level; mode: OutputMode } | undefined
  ): StarExpansion {
    const offset = this.ctx.at(ref.location)
    const names = strings((ref.fields ?? []).slice(0, -1))
    if (names === undefined) {
      return { shape: unproven("a star the rewrite cannot read"), arity: true }
    }
    const report = (leaves: readonly Leaf[]) => {
      const promoted = leaves.filter((l) => l.table !== undefined)
      if (promoted.length === 0) return
      if (output === undefined) {
        this.ctx.change("wholeRow", offset)
        return
      }
      const exempt =
        output.mode.top &&
        leaves.length === 1 &&
        sameTable(promoted[0]!.table!, this.ctx.scope.intoRowtypeOf)
      if (output.mode.stars && !exempt) this.ctx.change("star", offset)
    }
    if (names.length === 0) {
      if (output === undefined) {
        return { shape: unproven("a bare star"), arity: true }
      }
      const leaves = output.level.items.flatMap(leavesOf)
      report(leaves)
      return starShape(leaves, output.level.coalesced)
    }
    const found = this.qualified(names, env, ref, true)
    if (found === undefined) {
      if (this.ctx.reportedAt(offset)) {
        return { shape: REPORTED, arity: false }
      }
      // Змінна поза `records` за контрактом `RewriteScope` не пов'язана з
      // промоцією: кількість її полів не змінюється, імена лише невідомі.
      if (this.ctx.scope.variables.has(names[0]!)) {
        return {
          shape: unproven(`the fields of variable "${names[0]}"`),
          arity: false,
        }
      }
      return {
        shape: unproven(`the expansion ${names.join(".")}.*`),
        arity: true,
      }
    }
    if (found.depth < names.length) {
      // `<джерело>.<колонка>.*` — розгортання складеної колонки: важить лише
      // ім'я самої колонки, а її тип невідомий.
      if ("record" in found) this.recordRef(found, names, ref)
      else this.qualifiedColumn(found, names, ref)
      return {
        shape: unproven(`the expansion of composite column ${names.join(".")}`),
        arity: true,
      }
    }
    if ("record" in found) {
      if (output === undefined || output.mode.stars) {
        this.recordWhole(
          found.record,
          offset,
          output === undefined ? "wholeRow" : "star"
        )
      }
      // Ціле значення запису промотованої таблиці вже звітується вище.
      return { shape: this.recordShape(found.record, found.name), arity: false }
    }
    report(found.leaves)
    const expansion = starShape(found.leaves, found.coalesced)
    if (output === undefined && expansion.arity) {
      for (const leaf of found.leaves) this.unprovenWholeRow(leaf, offset)
    }
    // `<таблиця>.*` без аліасу: кваліфікатор іде за перейменуванням таблиці.
    const table = found.renameQualifier ? found.leaves[0]?.table : undefined
    if (table !== undefined && table.from !== table.to) {
      const tokens = this.ctx.tokens(ref.location, names)
      const token = tokens?.[found.depth - 1]
      if (token !== undefined) {
        this.ctx.edit(token.start, token.end, quoteIdent(table.to))
      }
    }
    return expansion
  }

  /** Ціле значення рядка джерела з недоведеними колонками — як рядок промотованої таблиці. */
  private unprovenWholeRow(leaf: Leaf, offset: number): void {
    const why = leaf.unproven
    if (why === undefined || why.reported === true) return
    this.ctx.change(
      "wholeRow",
      offset,
      `a whole row of ${why.source}: its columns are not proven, so the promotion may change its fields`
    )
  }

  /**
   * `inn(c)` — функціональний запис поля `c.inn`: Postgres читає виклик
   * без схеми з одним аргументом складеного типу як поле. Аргумент, який не
   * доведено скалярним, із зміненим промоцією ім'ям функції — відмова.
   */
  functionalNotation(call: FuncCall, env: Env): void {
    const names = strings(call.funcname ?? [])
    const args = call.args ?? []
    const arg = args[0]
    if (
      names?.length !== 1 ||
      args.length !== 1 ||
      arg === undefined ||
      "NamedArgExpr" in arg ||
      call.agg_star === true ||
      call.agg_distinct === true ||
      call.func_variadic === true ||
      call.agg_order !== undefined ||
      call.agg_filter !== undefined ||
      call.over !== undefined
    ) {
      return
    }
    const field = names[0]!
    if (!this.ctx.relevantColumn(field) || this.scalarArgument(arg, env)) return
    this.ctx.problem(
      "rewrite.unsupported",
      this.ctx.at(call.location),
      `"${field}(…)" may be functional notation for the field "${field}" of a whole row, and the promotion changes that name; write it as a qualified column`
    )
  }

  /**
   * Аргумент доведено не цілим рядком: константа, приведення до вбудованого
   * скалярного типу, колонка таблиці моделі (поле запису промотованої
   * таблиці — теж її колонка) чи змінна поза `records`. Колонку підзапиту чи
   * CTE, вираз (`NULLIF(r, …)`) чи кваліфікатор, що не є джерелом (мітка
   * блоку, ім'я функції), не доведено: вони можуть нести цілий рядок.
   */
  private scalarArgument(node: Node, env: Env): boolean {
    if ("A_Const" in node || isConstant(node, this.ctx.tableNames)) return true
    if ("TypeCast" in node) {
      return isBuiltinType(node.TypeCast.typeName, this.ctx.tableNames)
    }
    if (!("ColumnRef" in node) || isStar(node.ColumnRef)) return false
    const names = strings(node.ColumnRef.fields ?? [])
    if (names === undefined || names.length === 0 || names.length > 3) {
      return false
    }
    const levels = [...env.levels].reverse()
    if (names.length === 1) {
      const name = names[0]!
      const at = locate(name, levels, false)
      if (at !== undefined) {
        if ("leaf" in at) return isRelation(at.leaf)
        if ("merged" in at)
          return at.merged.items.flatMap(leavesOf).every(isRelation)
        return false
      }
      return (
        this.ctx.scope.variables.has(name) && !this.ctx.scope.records.has(name)
      )
    }
    const column = names.at(-1)!
    if (names.length === 3) {
      const [schema, relname] = names as [string, string]
      for (const level of levels) {
        const leaf = level.items
          .flatMap((i) => ("leaf" in i ? [i.leaf] : []))
          .find(
            (l) => !l.aliased && l.schema === schema && l.relname === relname
          )
        if (leaf !== undefined) {
          return isRelation(leaf) && leaf.columns!.includes(column)
        }
      }
      return false
    }
    const qualifier = names[0]!
    const item = findByRefname(env.levels, qualifier, false)
    if (item !== undefined) {
      if (this.ctx.scope.variables.has(qualifier)) return false
      return (
        leavesOf(item).some(
          (l) => isRelation(l) && l.columns!.includes(column)
        ) && leavesOf(item).every(isRelation)
      )
    }
    return this.ctx.scope.records.has(qualifier)
  }

  /** Колонки запису PL/pgSQL для `r.*` у списку виводу. */
  private recordShape(record: RecordBinding, name: string): Shape {
    if ("trigger" in record) {
      return unproven(
        `the trigger record "${name}"`,
        record.trigger.some((t) => this.ctx.isPromoted(t))
          ? "rewrite.ambiguous-name"
          : "rewrite.unsupported"
      )
    }
    const { table } = record
    if (this.ctx.isPromoted(table)) {
      return unproven(
        `the record "${name}" of promoted table "${table.from}"`,
        "rewrite.ambiguous-name"
      )
    }
    const known = this.ctx.map.knownTables.get(`${table.schema}.${table.from}`)
    return known === undefined
      ? unproven(`the record "${name}" of a table outside the model`)
      : { columns: known }
  }

  /** Поле запису PL/pgSQL (`NEW.x`, `r.x`). */
  private recordRef(
    found: { record: RecordBinding; name: string; depth: number },
    names: string[],
    ref: ColumnRef
  ): RefResult | undefined {
    if (this.nestedField(names, found.depth, ref)) return undefined
    const tokens = this.ctx.tokens(ref.location, names)
    if (tokens === undefined) return undefined
    const field = names[found.depth]!
    const end = tokens.at(-1)!.end
    const target = this.recordField(found.record, found.name, field, ref)
    if (target === undefined) return { old: names.at(-1)!, end }
    const token = tokens[found.depth]!
    this.ctx.edit(token.start, token.end, quoteIdent(target))
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
    if (this.nestedField(names, depth, ref)) return undefined
    let leaf: Leaf | undefined = leaves.length === 1 ? leaves[0] : undefined
    if (leaves.length > 1) {
      // Псевдонім `JOIN`: колонку дає одне з внутрішніх джерел.
      const hits = leaves.filter((l) => l.columns?.includes(field) ?? false)
      const open = leaves.find((l) => l.columns === undefined)
      if (hits.length === 1 && open === undefined) leaf = hits[0]
      else if (open !== undefined) {
        // Недоведене джерело серед з'єднаних могло б дати це ім'я.
        this.unprovenProblem(ref, names.join("."), open, field)
        return undefined
      } else if (leaves.some((l) => l.table?.columns.has(field))) {
        this.ctx.problem(
          "rewrite.ambiguous-name",
          this.ctx.at(ref.location),
          `"${names.join(".")}" may refer to a renamed column of more than one joined table`
        )
        return undefined
      }
    }
    if (leaf !== undefined && leaf.columns === undefined) {
      // Колонки джерела не доведено (функція, `*` над такою, відношення поза
      // моделлю): змінене ім'я лише через нього не переписати й не пропустити.
      this.unprovenProblem(ref, names.join("."), leaf, field)
      return undefined
    }
    const renamed = leaf?.table?.columns.get(field)
    const target = renamed ?? field
    if (leaf?.table !== undefined && !survivesPromotion(leaf.table, target)) {
      this.ctx.removed(field, leaf.table, ref.location)
      return undefined
    }
    if (leaf !== undefined && leaves.length > 1) {
      // Псевдонім `JOIN`: після промоції ім'я має давати те саме джерело.
      const after = leaves.filter(
        (l) => columnsAfter(l)?.includes(target) ?? true
      )
      if (after.length !== 1 || after[0] !== leaf) {
        this.ctx.problem(
          "rewrite.ambiguous-name",
          this.ctx.at(ref.location),
          "capture"
        )
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
    const tokens = this.ctx.tokens(ref.location, names)
    if (tokens === undefined) return undefined
    if (renameQualifier) {
      const token = tokens[depth - 1]!
      this.ctx.edit(token.start, token.end, quoteIdent(qualifier.to))
    }
    const end = tokens.at(-1)!.end
    if (renamed === undefined) return { old: names.at(-1)!, end }
    const token = tokens[depth]!
    this.ctx.edit(token.start, token.end, quoteIdent(renamed))
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
    | {
        leaves: Leaf[]
        depth: number
        renameQualifier: boolean
        coalesced: boolean
      }
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
          return {
            leaves: [leaf],
            depth: 2,
            renameQualifier: true,
            coalesced: false,
          }
        }
      }
    }
    const first = names[0]!
    const item = this.source(first, env, ref)
    if (item === null) return undefined
    const record = this.ctx.scope.records.get(first)
    if (item !== undefined) {
      if (record !== undefined || this.ctx.scope.variables.has(first)) {
        if (
          record !== undefined ||
          leavesOf(item).some((l) => l.table !== undefined)
        ) {
          this.ctx.problem(
            "rewrite.ambiguous-name",
            this.ctx.at(ref.location),
            `"${first}" is both a source in FROM and a PL/pgSQL variable`
          )
        }
        return undefined
      }
      return "leaf" in item
        ? {
            leaves: [item.leaf],
            depth: 1,
            renameQualifier: !item.leaf.aliased,
            coalesced: false,
          }
        : {
            leaves: item.group.leaves,
            depth: 1,
            renameQualifier: false,
            coalesced: item.group.coalesced,
          }
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
    const offset = this.ctx.at(ref.location)
    const item = this.source(name, env, ref)
    if (item === null) return undefined
    if (item !== undefined) {
      if (leavesOf(item).some((l) => l.table !== undefined)) {
        this.ctx.change("wholeRow", offset)
      }
      const table =
        "leaf" in item && !item.leaf.aliased ? item.leaf.table : undefined
      if (table !== undefined && table.from !== table.to) {
        const tokens = this.ctx.tokens(ref.location, [name])
        if (tokens !== undefined) {
          this.ctx.edit(tokens[0]!.start, tokens[0]!.end, quoteIdent(table.to))
        }
      }
      return undefined
    }
    const record = this.ctx.scope.records.get(name)
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
    const offset = this.ctx.at(ref.location)
    const levels = [...env.levels].reverse()
    const capture = () => {
      this.ctx.problem("rewrite.ambiguous-name", offset, "capture")
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
    if ("failed" in before) return { result: undefined }
    if ("merged" in before) {
      // Злите `USING` ім'я — колонка свого рівня; ближча область, що після
      // промоції отримує таку колонку, перехопила б його.
      const after = locate(name, levels, true)
      if (
        after === undefined ||
        "failed" in after ||
        ("merged" in after && after.merged === before.merged)
      ) {
        return { result: undefined }
      }
      return capture()
    }
    if ("hits" in before) {
      const open = before.unknown[0]
      if (
        open !== undefined &&
        before.hits.length === 0 &&
        names.length === 1
      ) {
        // Ім'я джерела з недоведеними колонками — ціле значення його рядка.
        const item = findByRefname(env.levels, name, false)
        const whole = item === undefined ? undefined : leavesOf(item)[0]
        if (whole !== undefined) this.unprovenWholeRow(whole, offset)
      }
      if (open !== undefined) {
        this.unprovenProblem(ref, name, open, name)
        return { result: undefined }
      }
      if (
        this.ctx.relevantColumn(name) &&
        (this.ctx.touches || before.hits.some((h) => h.table !== undefined))
      ) {
        this.ctx.problem(
          "rewrite.ambiguous-name",
          offset,
          `column "${name}" exists in more than one table in FROM`
        )
      }
      return { result: undefined }
    }
    const leaf = before.leaf
    const renamed = leaf.table?.columns.get(name)
    const target = renamed ?? name
    if (this.ctx.scope.variables.has(name) && this.ctx.relevantColumn(name)) {
      this.ctx.problem(
        "rewrite.ambiguous-name",
        offset,
        `"${name}" is both a column and a PL/pgSQL variable or parameter`
      )
      return { result: undefined }
    }
    const after = locate(target, levels, true)
    if (after !== undefined && "failed" in after) return { result: undefined }
    if (leaf.table !== undefined && !survivesPromotion(leaf.table, target)) {
      // Знята колонка: без іншого джерела з цим ім'ям — відмова, з ним —
      // ім'я мовчки впало б у зовнішню область.
      if (after === undefined) {
        this.ctx.removed(name, leaf.table, ref.location)
        return { result: undefined }
      }
      return capture()
    }
    if (
      after === undefined ||
      !("leaf" in after) ||
      after.leaf !== leaf ||
      (target !== name && this.ctx.scope.variables.has(target))
    ) {
      return capture()
    }
    if (renamed === undefined) return { result: undefined }
    const tokens = this.ctx.tokens(ref.location, names)
    if (tokens === undefined) return { result: undefined }
    const token = tokens[0]!
    this.ctx.edit(token.start, token.end, quoteIdent(renamed))
    const end = tokens.at(-1)!.end
    return {
      result:
        names.length === 1
          ? { old: name, to: renamed, end }
          : { old: names.at(-1)!, end },
    }
  }

  /**
   * Змінене ім'я, яке може вести в джерело з недоведеними колонками, —
   * відмова; незмінене нічого не ламає. Про джерело з `reported` проблема вже є.
   */
  private unprovenProblem(
    ref: ColumnRef,
    text: string,
    leaf: Leaf,
    field: string
  ): void {
    const why = leaf.unproven
    if (why === undefined || why.reported === true) return
    if (!this.ctx.relevantColumn(field)) return
    this.ctx.problem(
      why.code,
      this.ctx.at(ref.location),
      `"${text}" may come from ${why.source}: its columns are not proven, and "${field}" is a column that the promotion changes; select the columns explicitly or give a function call a column definition list`
    )
  }

  /**
   * `<джерело>.<колонка>.<поле>`: тип колонки невідомий, тож змінене промоцією
   * ім'я поля не довести чужим — відмова (`true`).
   */
  private nestedField(names: string[], depth: number, ref: ColumnRef): boolean {
    const nested = names
      .slice(depth + 1)
      .find((n) => this.ctx.relevantColumn(n))
    if (nested === undefined) return false
    this.ctx.problem(
      "rewrite.unsupported",
      this.ctx.at(ref.location),
      `"${names.join(".")}": "${nested}" is a field of "${names[depth]}", whose type the rewrite does not know, and the promotion changes that name`
    )
    return true
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
      if (this.ctx.isPromoted(table) && !survivesPromotion(table, target)) {
        this.ctx.removed(field, table, ref.location)
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
      this.ctx.problem(
        "rewrite.trigger-binding",
        this.ctx.at(ref.location),
        record.trigger.length === 0
          ? `${name.toUpperCase()}.${field}: the function is not bound to promoted tables by triggers or subscriptions`
          : `${name.toUpperCase()}.${field}: the tables the function is bound to do not rename the column the same way`
      )
      return undefined
    }
    const target = [...targets][0]!
    const gone = record.trigger.find(
      (t) => this.ctx.isPromoted(t) && !survivesPromotion(t, target)
    )
    if (gone !== undefined) {
      this.ctx.removed(field, gone, ref.location)
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
      if (this.ctx.isPromoted(record.table)) this.ctx.change(reason, offset)
      return
    }
    if (record.trigger.length === 0) {
      this.ctx.problem(
        "rewrite.trigger-binding",
        offset,
        "the whole trigger record is used, and the function is not bound to promoted tables"
      )
      return
    }
    if (record.trigger.some((t) => this.ctx.isPromoted(t))) {
      this.ctx.change(reason, offset)
    }
  }
}
