import type { RuleCode } from "../../diagnostics"
import { byteOffsets, type SqlParser } from "../parse"
import type {
  PlpgsqlExpression,
  PlpgsqlFunction,
  PlpgsqlStatement,
  PlpgsqlVariable,
} from "../plpgsql"
import { lexChain, plainWords, skipTrivia, type Token } from "./lex"
import {
  applyEdits,
  type ContractChange,
  type RecordBinding,
  type RenameMap,
  type RewriteScope,
  type TableRename,
  type TextEdit,
} from "./renames"
import { rewriteStatementText } from "./statement"
import { resolveTableName } from "./tables"
import { changedFields, lexTypeRef, rewriteTypeRef } from "./type-ref"

/** Відмова в тексті одиниці; `offset` — індекс UTF-16 у `unitSql`. */
export interface BodyFinding {
  code: RuleCode
  offset: number
  detail: string
}

export interface PlpgsqlBodyContext {
  parse: SqlParser
  map: RenameMap
  labels: readonly string[]
  searchPath: readonly string[] | undefined
  /** Таблиці прив'язки тригерами й підписками; `undefined` — не прив'язана. */
  triggerTables: readonly TableRename[] | undefined
  /** Параметри сигнатури рядкового типу промотованої таблиці. */
  params: ReadonlyMap<string, TableRename>
  /** Сигнатура називає промотовану таблицю (зокрема безіменним параметром). */
  signatureTouches: boolean
}

export interface PlpgsqlBodyRewrite {
  /** Правки в індексах `unitSql`. */
  edits: TextEdit[]
  problems: BodyFinding[]
  /** Зміни контракту в індексах `unitSql`. */
  contractChanges: ContractChange[]
  /**
   * Звіряє повторний розбір переписаного тексту з очікуваним: послідовність
   * текстів виразів і типів змінних має дорівнювати вихідній з тими самими
   * правками. Розбіжність означає, що правку розміщено не там.
   */
  verify: (rewritten: PlpgsqlFunction) => BodyFinding | undefined
}

/** Що шукається в тілі: необов'язкове ключове слово (без регістру) і текст. */
interface Pattern {
  keyword: string
  text: string
  /** `SELECT … INTO`: пробіл зразка — будь-який символ (там стояло `INTO …`). */
  wildcardSpaces: boolean
}

/** Вираз чи тип змінної з правками у власних координатах. */
interface Item {
  lineno: number
  /** Текст, з яким звіряється повторний розбір (запит виразу чи тип). */
  text: string
  pattern: Pattern
  /** Позиція `q` у `text` лежить у тілі на `збіг + q + delta`. */
  delta: number
  edits: TextEdit[]
  problems: { code: RuleCode; offset: number; detail: string }[]
  changes: ContractChange[]
  key: { expression: PlpgsqlExpression } | { variable: PlpgsqlVariable }
}

const SELECT = "SELECT "
/**
 * `CASE x WHEN a, b` Postgres розбирає як `"__Case__Variable_N__" IN (a, b)`:
 * у тексті тіла лежить лише вміст дужок.
 */
const CASE_PREFIX = /^"__Case__Variable_\d+__" IN \(/

/**
 * Переписує тіло PL/pgSQL (рішення 1, 13): кожен вираз переписується
 * окремо переписувачем оператора, а його правки розміщуються в тілі за
 * текстом виразу — у порядку тексту (стабільне сортування за `lineno`),
 * кожен після попереднього збігу й не раніше початку свого рядка.
 * `lineno` не впорядковує вирази одного рядка, тож розміщення лише
 * пропонує місце, а доводить його `verify` повторним розбором.
 */
export function rewritePlpgsqlBody(
  unitSql: string,
  body: { start: number; end: number },
  fn: PlpgsqlFunction,
  ctx: PlpgsqlBodyContext
): PlpgsqlBodyRewrite {
  const lineStarts = [body.start, body.start]
  for (let i = body.start; i < body.end; i++) {
    if (unitSql[i] === "\n") lineStarts.push(i + 1)
  }
  // Рядок 1 — рядок відкривального `$тег$`; 0 (неявний `RETURN`) — початок тіла.
  const lineStart = (lineno: number) =>
    lineStarts[lineno] ?? (lineno <= 0 ? body.start : body.end)
  const lineFirstToken = (lineno: number) => {
    let i = lineStart(lineno)
    while (unitSql[i] === " " || unitSql[i] === "\t") i++
    return i
  }

  const variables = new Set(
    fn.variables.filter((v) => v.kind !== "recfield").map((v) => v.name)
  )
  const records = new Map<string, RecordBinding>()
  for (const [name, table] of ctx.params) records.set(name, { table })
  for (const v of fn.variables) {
    // `NEW`/`OLD` є лише в тригерній функції; поля переписуються, коли
    // прив'язки однаково перейменовують колонку (рішення 13).
    if (v.kind === "rec" && (v.name === "new" || v.name === "old")) {
      records.set(v.name, { trigger: [...(ctx.triggerTables ?? [])] })
    }
  }

  const declared = fn.variables.filter(
    (v) =>
      v.kind === "var" && v.lineno !== undefined && v.typeText !== undefined
  )
  const typeContext = () => ({
    map: ctx.map,
    searchPath: ctx.searchPath,
    variables,
    records,
  })
  // Перший прохід: змінні рядкового типу промотованої таблиці — записи з
  // відомою формою; лише потім типи `запис.поле%TYPE` бачать їх.
  for (const v of declared) {
    const lexed = lexTypeRef(v.typeText!, 0)
    if (lexed === undefined) continue
    const { rowOf } = rewriteTypeRef(
      lexed.tokens,
      lexed.suffix,
      typeContext(),
      lexed.array
    )
    if (rowOf !== undefined && lexed.suffix !== "type") {
      records.set(v.name, { table: rowOf })
    }
  }

  // Записи рядка промотованої таблиці до зняття затінених: цикл `FOR r IN
  // <курсор>` оголошує власний `r`, і такий збіг імен треба побачити.
  const rowNames = new Set(
    [...records].flatMap(([name, binding]) =>
      promotedRow(binding, ctx) === undefined ? [] : [name]
    )
  )
  // Ім'я, оголошене двічі (параметр і змінна, зовнішній і вкладений блок),
  // за самим ім'ям не каже, який запис стоїть за посиланням: прив'язки немає,
  // а змінене поле через нього — відмова.
  const counts = new Map<string, number>()
  for (const name of fn.variables
    .filter((v) => v.kind !== "recfield")
    .map((v) => v.name)) {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const unknown = new Map<string, string>()
  for (const [name, count] of counts) {
    if (count < 2) continue
    records.delete(name)
    unknown.set(
      name,
      `"${name}" is declared more than once (shadowed), so the record behind the reference is not proven`
    )
  }
  // Параметр поліморфного типу може нести рядок промотованої таблиці, а
  // форму його переписувач не знає.
  for (const v of fn.variables) {
    if (v.kind !== "var" || v.typeText === undefined || records.has(v.name)) {
      continue
    }
    if (isPolymorphic(v.typeText) && !unknown.has(v.name)) {
      unknown.set(
        v.name,
        `"${v.name}" has the polymorphic type ${v.typeText}, so the row behind it is not proven`
      )
    }
  }
  inferRecords(fn, records, unknown, ctx)
  const fields = changedFields(ctx.map)
  const scope: RewriteScope = {
    ...(ctx.searchPath === undefined ? {} : { searchPath: ctx.searchPath }),
    variables,
    records,
    labels: ctx.labels,
  }

  const problems: BodyFinding[] = []
  problems.push(
    ...cursorFills(fn, records, rowNames, ctx, (lineno) =>
      lineFirstToken(lineno)
    )
  )
  for (const line of fn.dynamicSqlLines) {
    problems.push({
      code: "rewrite.dynamic-sql",
      offset: lineFirstToken(line),
      detail:
        "the statement runs SQL built at run time, which static analysis cannot see",
    })
  }

  const items: Item[] = []
  // Оголошення йдуть у порядку тексту: тип змінної, потім її значення за
  // замовчуванням; службові `declare` стоять у списку поза порядком дерева.
  const declarations = new Set(
    fn.statements.filter((s) => s.type === "declare")
  )
  const declarationItems = (s: PlpgsqlStatement) => {
    declarations.delete(s)
    for (const e of s.expressions) {
      items.push(expressionItem(s, e, scope, unknown, fields, ctx))
    }
  }
  for (const v of declared) {
    items.push(typeItem(v, typeContext()))
    for (const s of [...declarations]) {
      if (s.target?.variable === v.name) declarationItems(s)
    }
  }
  for (const s of [...declarations]) declarationItems(s)
  for (const s of fn.statements) {
    if (s.type !== "declare") {
      for (const e of s.expressions) {
        if (skipped(s, e, records)) continue
        items.push(expressionItem(s, e, scope, unknown, fields, ctx))
      }
    }
    problems.push(
      ...targetProblems(
        s,
        scope,
        unknown,
        fields,
        ctx,
        lineFirstToken(s.lineno)
      )
    )
  }
  items.sort((a, b) => a.lineno - b.lineno)

  const edits: TextEdit[] = []
  const contractChanges: ContractChange[] = []
  const expectedExpressions = new Map<PlpgsqlExpression, string>()
  const expectedTypes = new Map<PlpgsqlVariable, string>()
  let cursor = body.start
  for (const item of items) {
    const from = Math.max(cursor, lineStart(item.lineno))
    const match = find(unitSql, from, body.end, item.pattern)
    if (match !== undefined) {
      cursor = match + item.pattern.keyword.length + item.pattern.text.length
    } else if (item.edits.length > 0) {
      problems.push({
        code: "rewrite.verification-failed",
        offset: lineFirstToken(item.lineno),
        detail: `"${short(item.text)}" is not found in the body after the previous statement`,
      })
    }
    const at = (q: number) =>
      match === undefined
        ? lineFirstToken(item.lineno)
        : Math.max(match, match + q + item.delta)
    if (match !== undefined) {
      for (const e of item.edits) {
        edits.push({ start: at(e.start), end: at(e.end), text: e.text })
      }
    }
    for (const p of item.problems) problems.push({ ...p, offset: at(p.offset) })
    for (const c of item.changes)
      contractChanges.push({ ...c, offset: at(c.offset) })
    const expected = applyEdits(item.text, item.edits)
    if ("expression" in item.key)
      expectedExpressions.set(item.key.expression, expected)
    else expectedTypes.set(item.key.variable, expected)
  }

  // `ALIAS FOR` дерево не показує: ім'я псевдоніма не видно ні як змінну
  // (захоплення колонкою), ні як запис. Функцію, що торкається промоції
  // (правки, параметр чи прив'язка промотованої таблиці, її ім'я в тілі),
  // з ним не доведено.
  const alias = aliasDeclaration(unitSql, body)
  const touches =
    edits.length > 0 ||
    ctx.signatureTouches ||
    (ctx.triggerTables ?? []).some((t) =>
      ctx.map.tables.some((p) => p.schema === t.schema && p.from === t.from)
    ) ||
    [...plainWords(unitSql, body.start, body.end)].some((w) =>
      ctx.map.tables.some((t) => t.from === w.value)
    )
  if (alias !== undefined && touches) {
    problems.push({
      code: "rewrite.unsupported",
      offset: alias,
      detail:
        "the body declares an ALIAS FOR, which the parse tree does not expose, so names through it cannot be proven; replace the alias with the variable or parameter it names",
    })
  }

  const verify = (rewritten: PlpgsqlFunction): BodyFinding | undefined => {
    const fail = (lineno: number, detail: string): BodyFinding => ({
      code: "rewrite.verification-failed",
      offset: lineFirstToken(lineno),
      detail,
    })
    const before = fn.statements.flatMap((s) => s.expressions)
    const after = rewritten.statements.flatMap((s) => s.expressions)
    if (before.length !== after.length) {
      return fail(
        0,
        `the rewritten body has ${after.length} expressions instead of ${before.length}`
      )
    }
    for (let i = 0; i < before.length; i++) {
      const expected = expectedExpressions.get(before[i]!) ?? before[i]!.query
      if (after[i]!.query !== expected) {
        return fail(
          before[i]!.lineno,
          `expected "${short(expected)}", found "${short(after[i]!.query)}"`
        )
      }
    }
    if (fn.variables.length !== rewritten.variables.length) {
      return fail(0, "the rewritten body declares other variables")
    }
    for (let i = 0; i < fn.variables.length; i++) {
      const v = fn.variables[i]!
      const expected = expectedTypes.get(v) ?? v.typeText
      if (rewritten.variables[i]!.typeText !== expected) {
        return fail(
          v.lineno ?? 0,
          `expected the type of "${v.name}" to be "${expected ?? ""}"`
        )
      }
    }
    return undefined
  }

  return { edits, problems, contractChanges, verify }
}

/**
 * Записи без відомої форми (`record`) отримують форму таблиці, коли кожне
 * їх заповнення — `SELECT *` рівно однієї промотованої таблиці (`SELECT …
 * INTO`, `FOR … IN SELECT`). Решта — невідомої форми: переписувач оператора
 * вважає змінну поза `records` не пов'язаною з промоцією, тож поле такого
 * запису, що збігається зі зміненою колонкою, відмовляє викликач.
 */
function inferRecords(
  fn: PlpgsqlFunction,
  records: Map<string, RecordBinding>,
  unknown: Map<string, string>,
  ctx: PlpgsqlBodyContext
): void {
  for (const v of fn.variables) {
    if (records.has(v.name) || unknown.has(v.name)) continue
    if (v.kind !== "rec" && v.typeText?.toLowerCase() !== "record") continue
    const fills = fn.statements.filter(
      (s) => s.type !== "declare" && s.target?.variable === v.name
    )
    const tables = fills.map((s) => {
      if (s.type !== "execsql" && s.type !== "fors") return undefined
      const query = s.expressions.find(
        (e) => e.role === "statement" && (s.type === "fors" || e.into === true)
      )
      return query === undefined ? undefined : singleTableStar(query.query, ctx)
    })
    const first = tables[0]
    if (first !== undefined && tables.every((t) => t === first)) {
      records.set(v.name, { table: first })
    } else unknown.set(v.name, `record "${v.name}" has no proven row shape`)
  }
}

/** `SELECT *` (чи `<джерело>.*`) з однієї промотованої таблиці без псевдонімів колонок. */
function singleTableStar(
  query: string,
  ctx: PlpgsqlBodyContext
): TableRename | undefined {
  const parsed = ctx.parse(query)
  if (!parsed.ok || parsed.statements.length !== 1) return undefined
  const stmt = parsed.statements[0]!.stmt
  if (!("SelectStmt" in stmt)) return undefined
  const select = stmt.SelectStmt
  if (select.withClause !== undefined) return undefined
  if (select.op !== undefined && select.op !== "SETOP_NONE") return undefined
  const from = select.fromClause ?? []
  const targets = select.targetList ?? []
  if (from.length !== 1 || targets.length !== 1) return undefined
  const source = from[0]!
  const target = targets[0]!
  if (!("RangeVar" in source) || !("ResTarget" in target)) return undefined
  const rv = source.RangeVar
  const value = target.ResTarget.val
  if (value === undefined || !("ColumnRef" in value)) return undefined
  const ref = value.ColumnRef.fields ?? []
  if (ref.length === 0 || !("A_Star" in ref.at(-1)!)) return undefined
  if (ref.length > 2) return undefined
  if (ref.length === 2) {
    const qualifier = ref[0]!
    const name = "String" in qualifier ? qualifier.String.sval : undefined
    if (name !== (rv.alias?.aliasname ?? rv.relname)) return undefined
  }
  if (rv.alias?.colnames !== undefined || rv.relname === undefined) {
    return undefined
  }
  const resolved = resolveTableName(
    ctx.map,
    ctx.searchPath,
    rv.catalogname,
    rv.schemaname,
    rv.relname
  )
  return resolved.failed ? undefined : resolved.table
}

/**
 * Позиційне заповнення запису рядкового типу промотованої таблиці: промоція
 * знімає колонки й дописує нові в кінець, тож значення за позицією мовчки
 * лягли б не в ті поля.
 */
function positionalFill(offset: number): BodyFinding {
  return {
    code: "rewrite.unsupported",
    offset,
    detail:
      "positional fill of a row of the promoted table: the promotion removes and appends columns, so values by position would land in other fields; fill the record with SELECT * of that table or assign its fields by name",
  }
}

/**
 * Запит, що заповнює запис цілим рядком тієї самої таблиці: `SELECT *` (чи
 * `<джерело>.*`) однієї таблиці або `RETURNING *` зміни лише цієї таблиці.
 */
function fillsWholeRow(
  query: string,
  table: TableRename,
  ctx: PlpgsqlBodyContext
): boolean {
  const star = singleTableStar(query, ctx)
  if (star !== undefined) return sameTable(star, table)
  const parsed = ctx.parse(query)
  if (!parsed.ok || parsed.statements.length !== 1) return false
  const stmt = parsed.statements[0]!.stmt
  const change =
    "InsertStmt" in stmt
      ? { ...stmt.InsertStmt, extra: undefined }
      : "UpdateStmt" in stmt
        ? { ...stmt.UpdateStmt, extra: stmt.UpdateStmt.fromClause }
        : "DeleteStmt" in stmt
          ? { ...stmt.DeleteStmt, extra: stmt.DeleteStmt.usingClause }
          : undefined
  const rv = change?.relation
  if (change === undefined || rv?.relname === undefined) return false
  if (change.withClause !== undefined) return false
  const resolved = resolveTableName(
    ctx.map,
    ctx.searchPath,
    rv.catalogname,
    rv.schemaname,
    rv.relname
  )
  if (resolved.failed || resolved.table === undefined) return false
  if (!sameTable(resolved.table, table)) return false
  const list = change.returningList ?? []
  const only = list.length === 1 ? list[0] : undefined
  const value =
    only !== undefined && "ResTarget" in only ? only.ResTarget.val : undefined
  if (value === undefined || !("ColumnRef" in value)) return false
  const fields = value.ColumnRef.fields ?? []
  if (fields.length === 0 || !("A_Star" in fields.at(-1)!)) return false
  if (fields.length === 1) return (change.extra?.length ?? 0) === 0
  const qualifier = fields.length === 2 ? fields[0]! : undefined
  const name =
    qualifier !== undefined && "String" in qualifier
      ? qualifier.String.sval
      : undefined
  return name !== undefined && name === (rv.alias?.aliasname ?? rv.relname)
}

/** Значення присвоєння — конструктор рядка (`ROW(…)` чи `(a, b)`). */
function rowConstructor(value: string, parse: SqlParser): boolean {
  const parsed = parse(`${SELECT}${value}`)
  if (!parsed.ok || parsed.statements.length !== 1) return false
  const stmt = parsed.statements[0]!.stmt
  const target =
    "SelectStmt" in stmt ? stmt.SelectStmt.targetList?.[0] : undefined
  let node =
    target !== undefined && "ResTarget" in target
      ? target.ResTarget.val
      : undefined
  // Конструктор під приведенням (`(…)::t`) чи в скалярному підзапиті
  // (`(SELECT ROW(…))`) — той самий позиційний рядок.
  for (;;) {
    if (node === undefined) return false
    if ("RowExpr" in node) return true
    if ("TypeCast" in node) {
      node = node.TypeCast.arg
      continue
    }
    const select =
      "SubLink" in node &&
      node.SubLink.subLinkType === "EXPR_SUBLINK" &&
      node.SubLink.subselect !== undefined &&
      "SelectStmt" in node.SubLink.subselect
        ? node.SubLink.subselect.SelectStmt
        : undefined
    const only =
      select?.targetList?.length === 1 ? select.targetList[0] : undefined
    if (only === undefined || !("ResTarget" in only)) return false
    node = only.ResTarget.val
  }
}

/**
 * Таблиця, чий рядок несе запис: `%ROWTYPE` чи параметр промотованої таблиці
 * або `NEW`/`OLD`, прив'язані до неї. `null` — прив'язка до кількох таблиць,
 * серед яких промотована: цілого рядка однієї таблиці там не довести.
 * `undefined` — запис не несе рядка промотованої таблиці.
 */
function promotedRow(
  binding: RecordBinding | undefined,
  ctx: PlpgsqlBodyContext
): TableRename | null | undefined {
  if (binding === undefined) return undefined
  if ("table" in binding) return binding.table
  const promoted = binding.trigger.some((t) =>
    ctx.map.tables.some((p) => sameTable(p, t))
  )
  if (!promoted) return undefined
  return binding.trigger.length === 1 ? binding.trigger[0]! : null
}

/**
 * Заповнення запису рядка промотованої таблиці з курсора: `FETCH … INTO r`
 * доводиться лише запитом зв'язаного курсора — `SELECT *` тієї самої
 * таблиці; курсор без запиту в оголошенні (`refcursor`) чи оголошений двічі
 * — не доведений. `FOR r IN <курсор>` оголошує власний запис `r` і ховає
 * однойменний запис рядка промотованої таблиці: за самим ім'ям тіло не
 * каже, яку форму читає.
 */
function cursorFills(
  fn: PlpgsqlFunction,
  records: ReadonlyMap<string, RecordBinding>,
  rowNames: ReadonlySet<string>,
  ctx: PlpgsqlBodyContext,
  offsetOf: (lineno: number) => number
): BodyFinding[] {
  const declared = new Map<string, number>()
  for (const v of fn.variables) {
    declared.set(v.name, (declared.get(v.name) ?? 0) + 1)
  }
  const queries = new Map<string, string>()
  for (const s of fn.statements) {
    if (s.type !== "declare" || s.target === undefined) continue
    const query = s.expressions.find((e) => e.role === "statement")
    if (query !== undefined) queries.set(s.target.variable, query.query)
  }
  const found: BodyFinding[] = []
  for (const s of fn.statements) {
    const target = s.target?.variable
    if (target === undefined || s.cursor === undefined) continue
    if (s.type === "forc") {
      if (rowNames.has(target)) {
        found.push({
          code: "rewrite.unsupported",
          offset: offsetOf(s.lineno),
          detail: `the loop record "${target}" of FOR … IN ${s.cursor} shadows the variable "${target}" that holds a row of the promoted table, so the row shape behind the name is not proven; rename the loop record`,
        })
      }
      continue
    }
    if (s.type !== "fetch") continue
    const row = promotedRow(records.get(target), ctx)
    if (row === undefined) continue
    const query =
      (declared.get(s.cursor) ?? 0) === 1 ? queries.get(s.cursor) : undefined
    if (
      row === null ||
      query === undefined ||
      !fillsWholeRow(query, row, ctx)
    ) {
      found.push({ ...positionalFill(0), offset: offsetOf(s.lineno) })
    }
  }
  return found
}

function sameTable(a: TableRename, b: TableRename): boolean {
  return a.schema === b.schema && a.from === b.from
}

/** Поліморфні псевдотипи: тип аргументу обирає викликач. */
const POLYMORPHIC_TYPES: ReadonlySet<string> = new Set([
  "anyelement",
  "anyarray",
  "anynonarray",
  "anyenum",
  "anyrange",
  "anymultirange",
  "anycompatible",
  "anycompatiblearray",
  "anycompatiblenonarray",
  "anycompatiblerange",
  "anycompatiblemultirange",
])

/** Тип — поліморфний псевдотип (з `pg_catalog.` чи без, у лапках чи без). */
export function isPolymorphic(type: string): boolean {
  const name = type
    .trim()
    .replace(/^"?pg_catalog"?\./i, "")
    .replace(/^"(.*)"$/, "$1")
    .toLowerCase()
  return POLYMORPHIC_TYPES.has(name)
}

/** `RETURN NEW`/`RETURN OLD` тригера віддає сам рядок таблиці: форма за визначенням її. */
function skipped(
  s: PlpgsqlStatement,
  e: PlpgsqlExpression,
  records: ReadonlyMap<string, RecordBinding>
): boolean {
  if (e.role === "dynamic") return true
  const name = e.query.trim().toLowerCase()
  return (
    s.type === "return" &&
    (name === "new" || name === "old") &&
    records.get(name) !== undefined
  )
}

function typeItem(
  v: PlpgsqlVariable,
  ctx: Parameters<typeof rewriteTypeRef>[2]
): Item {
  const text = v.typeText!
  const lexed = lexTypeRef(text, 0)
  const result =
    lexed === undefined
      ? { edits: [], problems: [] }
      : rewriteTypeRef(lexed.tokens, lexed.suffix, ctx, lexed.array)
  return {
    lineno: v.lineno!,
    text,
    pattern: { keyword: "", text, wildcardSpaces: false },
    delta: 0,
    edits: result.edits,
    problems: result.problems,
    changes: [],
    key: { variable: v },
  }
}

/**
 * Вираз у власних координатах. Режим розбору визначає форму: 0 — оператор
 * як є; 2 — синтетичне `SELECT <вираз>`; 3–5 — ціль присвоєння і
 * `SELECT <права частина>`. `PERFORM` Postgres зберігає як `SELECT` на місці
 * ключового слова. Верхній список виводу ігнорується лише для `PERFORM` і
 * синтетичної обгортки (рішення 14).
 */
function expressionItem(
  s: PlpgsqlStatement,
  e: PlpgsqlExpression,
  scope: RewriteScope,
  unknown: ReadonlyMap<string, string>,
  fields: ReadonlySet<string>,
  ctx: PlpgsqlBodyContext
): Item {
  const item: Item = {
    lineno: e.lineno,
    text: e.query,
    pattern: { keyword: "", text: e.query, wildcardSpaces: false },
    delta: 0,
    edits: [],
    problems: [],
    changes: [],
    key: { expression: e },
  }
  const ignore: RewriteScope = { ...scope, topLevelOutput: "ignore" }
  /** Переписує `text`, що лежить у запиті з позиції `at` після `prefix` символів. */
  const part = (
    text: string,
    prefix: number,
    at: number,
    partScope: RewriteScope,
    keepChanges = true
  ) => {
    const shift = (offset: number) => Math.max(offset - prefix, 0) + at
    const r = rewriteStatementText(text, ctx.parse, ctx.map, partScope)
    for (const edit of r.edits) {
      item.edits.push({
        start: shift(edit.start),
        end: shift(edit.end),
        text: edit.text,
      })
    }
    for (const p of r.problems)
      item.problems.push({ ...p, offset: shift(p.offset) })
    if (keepChanges) {
      for (const c of r.contractChanges) {
        item.changes.push({ ...c, offset: shift(c.offset) })
      }
    }
    for (const p of unknownRecordFields(text, ctx.parse, unknown, fields)) {
      item.problems.push({
        code: "rewrite.ambiguous-name",
        offset: shift(p.offset),
        detail: p.detail,
      })
    }
  }

  if (e.perform === true) {
    item.pattern = {
      keyword: "perform",
      text: e.query.slice(6),
      wildcardSpaces: false,
    }
    item.delta = 1
    part(e.query, 0, 0, ignore)
    return item
  }
  if (e.parseMode === 0) {
    item.pattern.wildcardSpaces = e.into === true
    const target = s.target?.variable
    const binding = target === undefined ? undefined : scope.records.get(target)
    const intoRow =
      (e.into === true || s.type === "fors") &&
      binding !== undefined &&
      "table" in binding
        ? binding.table
        : undefined
    part(
      e.query,
      0,
      0,
      intoRow === undefined ? scope : { ...scope, intoRowtypeOf: intoRow }
    )
    const row =
      e.into === true || s.type === "fors"
        ? promotedRow(binding, ctx)
        : undefined
    if (
      row !== undefined &&
      (row === null || !fillsWholeRow(e.query, row, ctx))
    ) {
      item.problems.push(positionalFill(0))
    }
    return item
  }
  if (e.parseMode < 3) {
    const caseWhen = CASE_PREFIX.exec(e.query)
    if (caseWhen !== null && e.query.endsWith(")")) {
      item.pattern.text = e.query.slice(caseWhen[0].length, -1)
      item.delta = -caseWhen[0].length
    }
    part(SELECT + e.query, SELECT.length, 0, ignore)
    return item
  }
  const split = splitAssignment(e.query, e.parseMode - 2)
  if (split === undefined) {
    item.problems.push({
      code: "rewrite.unsupported",
      offset: 0,
      detail: `the assignment target in "${short(e.query)}" is not recognized`,
    })
    return item
  }
  const target = s.target?.variable
  const binding = target === undefined ? undefined : scope.records.get(target)
  if (
    s.type === "assign" &&
    promotedRow(binding, ctx) !== undefined &&
    rowConstructor(e.query.slice(split.valueStart), ctx.parse)
  ) {
    item.problems.push(positionalFill(split.valueStart))
  }
  // Ціль — не значення: її форма ніде не спостерігається, звіт лише про імена.
  part(
    SELECT + e.query.slice(0, split.targetEnd),
    SELECT.length,
    0,
    ignore,
    false
  )
  part(
    SELECT + e.query.slice(split.valueStart),
    SELECT.length,
    split.valueStart,
    ignore
  )
  return item
}

/**
 * Цілі, яких немає в тексті виразу: `INTO`/`FETCH … INTO` (Postgres витирає
 * їх із тексту запиту, тож правку не звірити повторним розбором) і
 * `GET DIAGNOSTICS`. Ціль присвоєння лежить у тексті й переписується з ним,
 * окрім цілі через `ALIAS`: парсер дає її ім'ям справжньої змінної, а текст
 * — псевдонімом. Ціль, яку треба перейменувати чи не доведено, відмовляє.
 */
function targetProblems(
  s: PlpgsqlStatement,
  scope: RewriteScope,
  unknown: ReadonlyMap<string, string>,
  fields: ReadonlySet<string>,
  ctx: PlpgsqlBodyContext,
  offset: number
): BodyFinding[] {
  if (s.target === undefined || s.type === "declare") return []
  const assign = s.type === "assign"
  if (assign && writtenTarget(s) === s.target.variable) return []
  const found: BodyFinding[] = []
  for (const name of s.target.variable.split(", ")) {
    if (!name.includes(".")) continue
    const r = rewriteStatementText(SELECT + name, ctx.parse, ctx.map, {
      ...scope,
      topLevelOutput: "ignore",
    })
    for (const p of r.problems) found.push({ ...p, offset })
    for (const p of unknownRecordFields(
      SELECT + name,
      ctx.parse,
      unknown,
      fields
    )) {
      found.push({ code: "rewrite.ambiguous-name", offset, detail: p.detail })
    }
    if (r.edits.length > 0) {
      found.push({
        code: "rewrite.unsupported",
        offset,
        detail: assign
          ? `the assignment target is written through an ALIAS of ${name}, which names a renamed column`
          : `the target ${name} names a renamed column and is not rewritten in place`,
      })
    }
  }
  return found
}

/** Позиція `ALIAS FOR` у тілі (поза коментарями й рядками). */
function aliasDeclaration(
  text: string,
  body: { start: number; end: number }
): number | undefined {
  let previous: Token | undefined
  for (const word of plainWords(text, body.start, body.end)) {
    if (
      word.value === "for" &&
      !word.separated &&
      previous?.value === "alias"
    ) {
      return previous.start
    }
    previous = word
  }
  return undefined
}

/** Ціль присвоєння, як її написано в тексті: `ім'я.ім'я` у нижньому регістрі. */
function writtenTarget(s: PlpgsqlStatement): string | undefined {
  const e = s.expressions[0]
  if (e === undefined || e.parseMode < 3) return undefined
  return lexChain(e.query, skipTrivia(e.query, 0), e.parseMode - 2)
    ?.map((t) => t.value)
    .join(".")
}

/**
 * Поля записів невідомої форми, імена яких промоція змінює: переписувач
 * оператора їх не бачить (змінна поза `records`), а мовчки лишене ім'я
 * зламало б функцію, якщо запис несе рядок промотованої таблиці.
 */
export function unknownRecordFields(
  text: string,
  parse: SqlParser,
  unknown: ReadonlyMap<string, string>,
  fields: ReadonlySet<string>
): { offset: number; detail: string }[] {
  if (unknown.size === 0) return []
  const parsed = parse(text)
  if (!parsed.ok) return []
  const toIndex = byteOffsets(text)
  const found: { offset: number; detail: string }[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, inner] of Object.entries(value)) {
      if (key === "FuncCall") {
        // `inn(p)` — функціональний запис поля `p.inn` запису невідомої форми.
        const call = inner as {
          funcname?: unknown[]
          args?: unknown[]
          location?: number
        }
        const name = (call.funcname ?? []).map(
          (f) => (f as { String?: { sval?: string } }).String?.sval
        )
        const arg = (call.args?.length === 1 ? call.args[0] : undefined) as
          { ColumnRef?: { fields?: unknown[] } } | undefined
        const ref = (arg?.ColumnRef?.fields ?? []).map(
          (f) => (f as { String?: { sval?: string } }).String?.sval
        )
        const field = name.length === 1 ? name[0] : undefined
        const record = ref.length === 1 ? ref[0] : undefined
        if (
          field !== undefined &&
          record !== undefined &&
          unknown.has(record) &&
          fields.has(field)
        ) {
          found.push({
            offset: call.location === undefined ? 0 : toIndex(call.location),
            detail: `${unknown.get(record)}, and "${field}(${record})" may be functional notation for its field "${field}", a column that the promotion renames or removes`,
          })
        }
      }
      if (key === "ColumnRef") {
        const ref = inner as { fields?: unknown[]; location?: number }
        const names = (ref.fields ?? []).map(
          (f) => (f as { String?: { sval?: string } }).String?.sval
        )
        const [record, field] = names
        if (
          record !== undefined &&
          field !== undefined &&
          unknown.has(record) &&
          fields.has(field)
        ) {
          found.push({
            offset: ref.location === undefined ? 0 : toIndex(ref.location),
            detail: `${unknown.get(record)}, and "${field}" is a column that the promotion renames or removes`,
          })
        }
      }
      visit(inner)
    }
  }
  for (const statement of parsed.statements) visit(statement.stmt)
  return found
}

/**
 * Дерева виразів тіла plpgsql: той самий обхід, що й читання копій обробником
 * (Р2a2-9). Динамічний SQL сюди не доходить: його відкидає закрита оболонка, а
 * нерозбірний вираз — розбір тіла, що вже пройшов.
 */
export function plpgsqlExpressionTrees(
  fn: PlpgsqlFunction,
  parse: SqlParser
): unknown[] {
  const trees: unknown[] = []
  for (const statement of fn.statements) {
    for (const e of statement.expressions) {
      if (e.role === "dynamic") continue
      let text = e.query
      if (e.parseMode >= 3) {
        const split = splitAssignment(e.query, e.parseMode - 2)
        if (split === undefined) continue
        text = `SELECT ${e.query.slice(split.valueStart)}`
      } else if (e.parseMode > 0) {
        text = `SELECT ${e.query}`
      }
      const parsed = parse(text)
      if (parsed.ok) trees.push(parsed.statements.map((s) => s.stmt))
    }
  }
  return trees
}

/**
 * Межа цілі присвоєння `ім'я[.ім'я…][індекси] :=|= значення`; `names` —
 * кількість імен цілі за режимом розбору Postgres.
 */
export function splitAssignment(
  query: string,
  names: number
): { targetEnd: number; valueStart: number } | undefined {
  const chain = lexChain(query, skipTrivia(query, 0), names)
  if (chain === undefined) return undefined
  let i = chain.at(-1)!.end
  for (;;) {
    const j = skipTrivia(query, i)
    if (query[j] !== "[") {
      i = j
      break
    }
    const close = closingBracket(query, j)
    if (close === undefined) return undefined
    i = close + 1
  }
  if (query.startsWith(":=", i)) return { targetEnd: i, valueStart: i + 2 }
  if (query[i] === "=") return { targetEnd: i, valueStart: i + 1 }
  return undefined
}

function closingBracket(text: string, open: number): number | undefined {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "'") {
      const close = text.indexOf("'", i + 1)
      if (close < 0) return undefined
      i = close
    } else if (c === "[") depth++
    else if (c === "]" && --depth === 0) return i
  }
  return undefined
}

/** Перший збіг зразка в `[from, limit)`. */
function find(
  text: string,
  from: number,
  limit: number,
  pattern: Pattern
): number | undefined {
  const { keyword, text: rest, wildcardSpaces } = pattern
  const total = keyword.length + rest.length
  outer: for (let i = from; i + total <= limit; i++) {
    for (let k = 0; k < keyword.length; k++) {
      if (text[i + k]!.toLowerCase() !== keyword[k]) continue outer
    }
    const base = i + keyword.length
    for (let k = 0; k < rest.length; k++) {
      const c = rest[k]!
      if (wildcardSpaces && c === " ") continue
      if (text[base + k] !== c) continue outer
    }
    return i
  }
  return undefined
}

function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat
}
