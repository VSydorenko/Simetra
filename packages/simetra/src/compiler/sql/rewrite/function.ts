import type { DefElem, Node, TypeName } from "libpg-query"
import type { RuleCode } from "../../diagnostics"
import { routineLanguage } from "../closed-forms"
import { byteOffsets, type SqlParser } from "../parse"
import type { PlpgsqlParser } from "../plpgsql"
import {
  dollarTag,
  lexChain,
  plainWords,
  readIdent,
  skipTrivia,
  type Token,
} from "./lex"
import {
  isPolymorphic,
  rewritePlpgsqlBody,
  unknownRecordFields,
  type BodyFinding,
} from "./plpgsql-body"
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
import { changedFields, rewriteTypeRef } from "./type-ref"

/**
 * Вхід переписувача функції. `triggerTables` — таблиці, до яких функцію
 * прив'язують тригери й підписки до промоції; `undefined` — не прив'язана.
 * `labels` — мітки споживача, що їх промоція замінює (спека промоції §9.11).
 */
export interface FunctionRewriteContext {
  parse: SqlParser
  plpgsql: PlpgsqlParser
  map: RenameMap
  triggerTables: readonly TableRename[] | undefined
  labels: readonly string[]
}

/** `line`/`column` — 1-базні відносно тексту одиниці. */
export interface FunctionRewriteProblem {
  code: RuleCode
  line: number
  column: number
  detail: string
}

export interface FunctionContractChange {
  line: number
  column: number
  reason: ContractChange["reason"]
  /** Пояснення для повідомлення `rewrite.contract-change` (англійською). */
  detail: string
}

/** Знахідки над текстом одиниці; `verify` звіряє переписаний текст. */
interface UnitRewrite {
  edits: TextEdit[]
  problems: BodyFinding[]
  changes: ContractChange[]
  verify: (rewritten: string) => BodyFinding | undefined
}

const SIGNATURE_DETAIL =
  "the signature names the row type of the promoted table"

/**
 * Переписує одиницю `CREATE FUNCTION` під нові фізичні імена промотованих
 * таблиць (спека промоції §6): сигнатуру, тіло
 * `LANGUAGE sql` (рядкове чи стандарту SQL) і тіло `plpgsql`. Змінюються
 * лише резолвлені токени імен і вставки ` AS <старе>`; переписаний текст
 * перевіряється повторним розбором. Будь-яка проблема — і текст вихідний:
 * частково переписана функція зламалася б уже в базі.
 */
export function rewriteFunction(
  unitSql: string,
  o: FunctionRewriteContext
): {
  sql: string
  problems: FunctionRewriteProblem[]
  contractChanges: FunctionContractChange[]
} {
  const found = rewriteUnit(unitSql, o)
  let sql = unitSql
  if (found.problems.length === 0 && found.edits.length > 0) {
    const rewritten = applyEdits(unitSql, found.edits)
    const failure = found.verify(rewritten)
    if (failure === undefined) sql = rewritten
    else found.problems.push(failure)
  }
  const position = positions(unitSql)
  const byOffset = <T extends { offset: number }>(a: T, b: T) =>
    a.offset - b.offset
  return {
    sql,
    problems: found.problems.sort(byOffset).map((p) => ({
      code: p.code,
      ...position(p.offset),
      detail: p.detail,
    })),
    contractChanges: found.changes.sort(byOffset).map((c) => ({
      ...position(c.offset),
      reason: c.reason,
      detail: c.detail ?? "",
    })),
  }
}

function rewriteUnit(unitSql: string, o: FunctionRewriteContext): UnitRewrite {
  const result: UnitRewrite = {
    edits: [],
    problems: [],
    changes: [],
    verify: (rewritten) => reparse(rewritten, o.parse),
  }
  const refuse = (code: RuleCode, offset: number, detail: string) => {
    result.problems.push({ code, offset, detail })
    return result
  }
  const parsed = o.parse(unitSql)
  if (!parsed.ok) {
    return refuse(
      "rewrite.unsupported",
      parsed.offset,
      `the unit does not parse: ${parsed.message}`
    )
  }
  const stmt =
    parsed.statements.length === 1 ? parsed.statements[0]!.stmt : undefined
  if (stmt === undefined || !("CreateFunctionStmt" in stmt)) {
    return refuse(
      "rewrite.unsupported",
      0,
      "the unit is not a single CREATE FUNCTION"
    )
  }
  const fn = stmt.CreateFunctionStmt
  const toIndex = byteOffsets(unitSql)
  const at = (location: number | undefined) =>
    location === undefined || location < 0 ? 0 : toIndex(location)
  const options = (fn.options ?? []).flatMap((n) =>
    "DefElem" in n ? [n.DefElem] : []
  )
  const option = (name: string) =>
    options.filter((d) => d.defname === name).at(-1)
  const language = routineLanguage(stmt)
  const searchPath = functionSearchPath(options)

  // Імена сигнатури й тіла стандарту SQL Postgres резолвить під час
  // `CREATE FUNCTION` за `search_path` сесії, а не за `SET search_path`
  // функції: некваліфіковане промотоване ім'я там не доводиться.
  const atCreation = (p: BodyFinding): BodyFinding =>
    p.code === "rewrite.unqualified-table"
      ? {
          ...p,
          detail:
            "the name is resolved when the function is created, by the search_path of the session, not by the function's SET search_path",
        }
      : p
  const typeContext = {
    map: o.map,
    searchPath: undefined,
    variables: new Set<string>(),
    records: new Map<string, RecordBinding>(),
  }
  // Сигнатура: тип рядка промотованої таблиці перейменовується, а форма
  // результату чи аргументу змінюється — це зміна контракту, не відмова.
  let signatureTouches = false
  const signatureType = (tn: TypeName): TableRename | undefined => {
    const names = (tn.names ?? []).map((n) =>
      "String" in n ? (n.String.sval ?? "") : ""
    )
    const relation = tn.pct_type === true ? names.slice(0, -1) : names
    if (!o.map.tables.some((t) => t.from === relation.at(-1))) return undefined
    let start = at(tn.location)
    const first = readIdent(unitSql, start)
    if (tn.setof === true && first?.value === "setof") {
      start = skipTrivia(unitSql, first.end)
    }
    const tokens = lexChain(unitSql, start, names.length)
    if (tokens === undefined || tokens.some((t, i) => t.value !== names[i])) {
      refuse(
        "rewrite.unsupported",
        start,
        `the signature type ${names.join(".")} is not written as a plain name`
      )
      return undefined
    }
    const r = rewriteTypeRef(
      tokens,
      tn.pct_type === true ? "type" : undefined,
      typeContext,
      (tn.arrayBounds?.length ?? 0) > 0
    )
    result.edits.push(...r.edits)
    result.problems.push(...r.problems.map(atCreation))
    if (r.edits.length > 0 || r.problems.length > 0) signatureTouches = true
    if (r.rowOf === undefined && r.arrayOf === undefined) return undefined
    signatureTouches = true
    result.changes.push({
      offset: tokens[0]!.start,
      reason: "signature",
      detail: SIGNATURE_DETAIL,
    })
    return r.rowOf
  }
  const params = new Map<string, TableRename>()
  /** Імена вхідних параметрів: лише їх бачить тіло `LANGUAGE sql`. */
  const inputs = new Set<string>()
  /**
   * Вхідні параметри невідомої форми рядка (`record`, поліморфні): тіло
   * `LANGUAGE sql` бачить їх як змінні поза `records`, тож змінене поле через
   * них відмовляє тут, а не мовчки лишається.
   */
  const unprovenParams = new Map<string, string>()
  for (const node of fn.parameters ?? []) {
    if (!("FunctionParameter" in node)) continue
    const param = node.FunctionParameter
    const row =
      param.argType === undefined ? undefined : signatureType(param.argType)
    if (param.name === undefined) continue
    if (row !== undefined) params.set(param.name, row)
    const type = (param.argType?.names ?? [])
      .map((n) => ("String" in n ? (n.String.sval ?? "") : ""))
      .at(-1)
    if (
      type !== undefined &&
      (type === "record" || isPolymorphic(type)) &&
      param.mode !== "FUNC_PARAM_OUT" &&
      param.mode !== "FUNC_PARAM_TABLE"
    ) {
      unprovenParams.set(
        param.name,
        `"${param.name}" has the type ${type}, so the row behind it is not proven`
      )
    }
    if (param.mode !== "FUNC_PARAM_OUT" && param.mode !== "FUNC_PARAM_TABLE") {
      inputs.add(param.name)
    }
  }
  if (fn.returnType !== undefined) signatureType(fn.returnType)

  if (language !== "sql" && language !== "plpgsql") {
    return refuse(
      "rewrite.unsupported",
      0,
      `a LANGUAGE ${language ?? "unknown"} body is not rewritten`
    )
  }
  const scope: RewriteScope = {
    ...(searchPath === undefined ? {} : { searchPath }),
    variables: inputs,
    records: new Map(
      [...params]
        .filter(([name]) => inputs.has(name))
        .map(([name, table]) => [name, { table }])
    ),
    labels: o.labels,
  }
  const fields = changedFields(o.map)
  /** Тіло `LANGUAGE sql`: переписаний текст і поля параметрів невідомої форми. */
  const sqlText = (
    text: string,
    shift: number,
    sqlScope: RewriteScope,
    problem: (p: BodyFinding) => BodyFinding = (p) => p
  ) => {
    merge(rewriteStatementText(text, o.parse, o.map, sqlScope), shift, problem)
    for (const p of unknownRecordFields(
      text,
      o.parse,
      unprovenParams,
      fields
    )) {
      result.problems.push({
        code: "rewrite.ambiguous-name",
        offset: p.offset + shift,
        detail: p.detail,
      })
    }
  }
  const merge = (
    r: ReturnType<typeof rewriteStatementText>,
    shift: number,
    problem: (p: BodyFinding) => BodyFinding = (p) => p
  ) => {
    for (const e of r.edits) {
      result.edits.push({
        start: e.start + shift,
        end: e.end + shift,
        text: e.text,
      })
    }
    for (const p of r.problems) {
      result.problems.push(problem({ ...p, offset: p.offset + shift }))
    }
    for (const c of r.contractChanges) {
      result.changes.push({ ...c, offset: c.offset + shift })
    }
  }

  if (fn.sql_body !== undefined) {
    // Тіло стандарту SQL лежить у самому тексті одиниці: заголовок
    // замінюється пробілами тієї самої довжини, тож позиції правок —
    // позиції в `unitSql`. Завершальне `END` розбирається як `COMMIT`.
    const from = Math.max(
      0,
      ...options.map((d) => at(d.location)),
      at(fn.returnType?.location)
    )
    const body = routineBody(unitSql, from)
    if (body === undefined) {
      return refuse(
        "rewrite.unsupported",
        from,
        "the SQL-standard body is not found after the function options"
      )
    }
    // Тіло стандарту SQL зв'язується під час створення: без `search_path`.
    const standard: RewriteScope = {
      variables: scope.variables,
      records: scope.records,
      labels: scope.labels,
    }
    const blank = (end: number) => unitSql.slice(0, end).replace(/[^\n]/g, " ")
    if (body.kind === "atomic") {
      sqlText(
        blank(body.end) + unitSql.slice(body.end),
        0,
        standard,
        atCreation
      )
    } else {
      // `RETURN <вираз>` — значення без імені колонки: як обгортка виразу.
      const text =
        blank(body.start) +
        "SELECT" +
        unitSql.slice(body.start + "RETURN".length)
      sqlText(text, 0, { ...standard, topLevelOutput: "ignore" }, atCreation)
    }
    return result
  }

  const as = option("as")
  const body = as === undefined ? undefined : dollarBody(unitSql, as, at)
  if (body === undefined || "detail" in body) {
    return refuse(
      "rewrite.body-quoting",
      at(as?.location),
      body?.detail ?? "the function has no body"
    )
  }
  if (language === "sql") {
    sqlText(unitSql.slice(body.start, body.end), body.start, scope)
    // Правка, що зламала б тіло, не видна розбору самої одиниці: тіло для
    // нього — лише рядок. Тож розбирається й переписане тіло.
    result.verify = (rewritten) => {
      const core = reparse(rewritten, o.parse)
      if (core !== undefined) return core
      const after = dollarBodyText(rewritten, o.parse)
      const parsedBody = after === undefined ? undefined : o.parse(after)
      if (parsedBody?.ok === true) return undefined
      return {
        code: "rewrite.verification-failed",
        offset: body.start,
        detail:
          parsedBody === undefined
            ? "the rewritten function has no body"
            : `the rewritten body does not parse: ${parsedBody.message}`,
      }
    }
    return result
  }

  // PL/pgSQL-парсер кличеться лише для `LANGUAGE plpgsql`: на тілі
  // стандарту SQL він аварійно завершується.
  const pl = o.plpgsql(unitSql)
  if (!pl.ok || pl.fn === undefined) {
    return refuse(
      "rewrite.unsupported",
      body.start,
      pl.ok ? "the PL/pgSQL body is empty" : pl.message
    )
  }
  const rewrite = rewritePlpgsqlBody(unitSql, body, pl.fn, {
    parse: o.parse,
    map: o.map,
    labels: o.labels,
    searchPath,
    triggerTables: o.triggerTables,
    params,
    signatureTouches,
  })
  result.edits.push(...rewrite.edits)
  result.problems.push(...rewrite.problems)
  result.changes.push(...rewrite.contractChanges)
  result.verify = (rewritten) => {
    const core = reparse(rewritten, o.parse)
    if (core !== undefined) return core
    const again = o.plpgsql(rewritten)
    if (!again.ok || again.fn === undefined) {
      return {
        code: "rewrite.verification-failed",
        offset: body.start,
        detail: again.ok ? "the rewritten body is empty" : again.message,
      }
    }
    return rewrite.verify(again.fn)
  }
  return result
}

/** Переписаний текст має розбиратися: інакше правка лягла не туди. */
function reparse(rewritten: string, parse: SqlParser): BodyFinding | undefined {
  const parsed = parse(rewritten)
  if (parsed.ok) return undefined
  return {
    code: "rewrite.verification-failed",
    offset: Math.min(parsed.offset, rewritten.length),
    detail: `the rewritten function does not parse: ${parsed.message}`,
  }
}

/** Рядок тіла з опції `AS` переписаної одиниці. */
function dollarBodyText(text: string, parse: SqlParser): string | undefined {
  const parsed = parse(text)
  const stmt = parsed.ok ? parsed.statements[0]?.stmt : undefined
  if (stmt === undefined || !("CreateFunctionStmt" in stmt)) return undefined
  const as = (stmt.CreateFunctionStmt.options ?? [])
    .flatMap((n) => ("DefElem" in n ? [n.DefElem] : []))
    .filter((d) => d.defname === "as")
    .at(-1)
  const item =
    as?.arg !== undefined && "List" in as.arg
      ? as.arg.List.items?.[0]
      : undefined
  return item !== undefined && "String" in item ? item.String.sval : undefined
}

/**
 * `search_path` з `SET search_path` функції (останній перемагає, як у
 * Postgres); `undefined` — функція його не задає, тож ім'я обирає
 * `search_path` викликача. Ім'я налаштування Postgres шукає без огляду на
 * регістр: `SET "SEARCH_PATH"` у лапках — той самий шлях.
 */
function functionSearchPath(options: DefElem[]): string[] | undefined {
  const set = options
    .filter(
      (d) =>
        d.defname === "set" &&
        d.arg !== undefined &&
        "VariableSetStmt" in d.arg &&
        d.arg.VariableSetStmt.name?.toLowerCase() === "search_path"
    )
    .at(-1)?.arg
  if (set === undefined || !("VariableSetStmt" in set)) return undefined
  const stmt = set.VariableSetStmt
  if (stmt.kind !== "VAR_SET_VALUE") return undefined
  const schemas: string[] = []
  for (const arg of stmt.args ?? []) {
    const value = "A_Const" in arg ? arg.A_Const.sval?.sval : undefined
    if (value === undefined) return undefined
    // Рядок `'a, b'` Postgres читає як список ідентифікаторів.
    for (const part of value.split(",")) {
      const name = part.trim()
      if (name === "") continue
      schemas.push(
        name.startsWith('"') && name.endsWith('"')
          ? name.slice(1, -1).replaceAll('""', '"')
          : name.toLowerCase()
      )
    }
  }
  return schemas
}

/**
 * Тіло з опції `AS`: текст між доларовими лапками, звірений із рядком з
 * дерева. Тіло в одинарних лапках подвоює `'`, тож позиції виразів у
 * ньому не відображаються на текст — відмова, а не перерахунок.
 */
function dollarBody(
  text: string,
  as: DefElem,
  at: (location: number | undefined) => number
): { start: number; end: number } | { detail: string } {
  const items: Node[] =
    as.arg !== undefined && "List" in as.arg ? (as.arg.List.items ?? []) : []
  const only = items.length === 1 ? items[0]! : undefined
  const sval =
    only !== undefined && "String" in only ? only.String.sval : undefined
  if (sval === undefined) return { detail: "the body is not a single string" }
  if (as.location === undefined) {
    return { detail: "the body has no position in the parse tree" }
  }
  let i = at(as.location)
  const keyword = readIdent(text, i)
  if (keyword?.value === "as") i = skipTrivia(text, keyword.end)
  const tag = dollarTag(text, i)
  if (tag === undefined) return { detail: "the body is not in dollar quotes" }
  const start = i + tag.length
  const end = text.indexOf(tag, start)
  if (end < 0 || text.slice(start, end) !== sval) {
    return {
      detail: "the text between the dollar quotes is not the parsed body",
    }
  }
  return { start, end }
}

/**
 * Початок тіла стандарту SQL після опцій: `BEGIN ATOMIC` чи `RETURN`.
 * Рядки й лапковані імена опцій (`SET x = 'return'`) пропускаються цілими,
 * щоб слово в них не прийняти за тіло.
 */
function routineBody(
  text: string,
  from: number
):
  | { kind: "atomic"; end: number }
  | { kind: "return"; start: number }
  | undefined {
  let previous: Token | undefined
  for (const word of plainWords(text, from, text.length)) {
    if (word.value === "return") return { kind: "return", start: word.start }
    if (
      word.value === "atomic" &&
      !word.separated &&
      previous?.value === "begin"
    ) {
      return { kind: "atomic", end: word.end }
    }
    previous = word
  }
  return undefined
}

/** Індекс UTF-16 → 1-базні рядок і колонка. */
function positions(
  text: string
): (offset: number) => { line: number; column: number } {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1)
  }
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: offset - starts[lo]! + 1 }
  }
}
