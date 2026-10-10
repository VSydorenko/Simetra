import type { RuleCode } from "../../diagnostics"
import { byteOffsets, type SqlParser } from "../parse"
import type {
  PlpgsqlExpression,
  PlpgsqlFunction,
  PlpgsqlStatement,
  PlpgsqlVariable,
} from "../plpgsql"
import { lexChain, skipTrivia } from "./lex"
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
    const { rowOf } = rewriteTypeRef(lexed.tokens, lexed.suffix, typeContext())
    if (rowOf !== undefined && lexed.suffix !== "type") {
      records.set(v.name, { table: rowOf })
    }
  }

  const unknown = inferRecords(fn, records, ctx)
  const fields = changedFields(ctx.map)
  const scope: RewriteScope = {
    ...(ctx.searchPath === undefined ? {} : { searchPath: ctx.searchPath }),
    variables,
    records,
    labels: ctx.labels,
  }

  const problems: BodyFinding[] = []
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
  ctx: PlpgsqlBodyContext
): Set<string> {
  const unknown = new Set<string>()
  for (const v of fn.variables) {
    if (records.has(v.name)) continue
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
    } else unknown.add(v.name)
  }
  return unknown
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
      : rewriteTypeRef(lexed.tokens, lexed.suffix, ctx)
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
  unknown: ReadonlySet<string>,
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
 * Цілі `INTO`/`FETCH … INTO`: Postgres витирає їх із тексту запиту, тож
 * правка поля запису тут зламала б вирівнювання з повторним розбором — поле,
 * яке треба перейменувати, відмовляє.
 */
function targetProblems(
  s: PlpgsqlStatement,
  scope: RewriteScope,
  unknown: ReadonlySet<string>,
  fields: ReadonlySet<string>,
  ctx: PlpgsqlBodyContext,
  offset: number
): BodyFinding[] {
  if (s.target === undefined || s.type === "assign" || s.type === "declare") {
    return []
  }
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
        detail: `the INTO target ${name} names a renamed column and is not rewritten in place`,
      })
    }
  }
  return found
}

/**
 * Поля записів невідомої форми, імена яких промоція змінює: переписувач
 * оператора їх не бачить (змінна поза `records`), а мовчки лишене ім'я
 * зламало б функцію, якщо запис несе рядок промотованої таблиці.
 */
function unknownRecordFields(
  text: string,
  parse: SqlParser,
  unknown: ReadonlySet<string>,
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
            detail: `record "${record}" has no proven row shape, and "${field}" is a column that the promotion renames or removes`,
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
 * Межа цілі присвоєння `ім'я[.ім'я…][індекси] :=|= значення`; `names` —
 * кількість імен цілі за режимом розбору Postgres.
 */
function splitAssignment(
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
