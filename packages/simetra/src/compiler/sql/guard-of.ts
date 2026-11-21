import type { SqlFunctionDeclaration } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { RightsContract } from "../contracts"
import type { ParsedObject } from "../stages/files"
import { ON_BEHALF_OF_USER, isSecurityDefiner } from "./definer-reads"
import type { DeclaredFunction } from "./declarations"
import type { SqlParser } from "./parse"
import {
  functionBodyText,
  type PlpgsqlParser,
  type PlpgsqlStatement,
} from "./plpgsql"
import { declareSection } from "./rewrite/lex"
import type { VerbatimUnit } from "./units"

/** Причини `sql.declaration-check-not-applied` (спека декларацій функцій §5.2). */
export type GuardReason =
  | "language"
  | "declareSection"
  | "firstStatement"
  | "arguments"
  | "exceptionBlock"

export type GuardProof = { ok: true } | { ok: false; reason: GuardReason }

type Json = Record<string, unknown>

const asRecord = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined

/** Лише перелічені ключі: невідомий (`WINDOW`, `FROM` …) — не та форма. */
const onlyKeys = (node: Json, allowed: readonly string[]) =>
  Object.keys(node).every((key) => allowed.includes(key))

/**
 * Запит `PERFORM`: порт зберігає весь текст запиту (`PERFORM … WHERE false`
 * стає `SELECT … WHERE false`, і Postgres не обчислює ціль), тож форма —
 * голий `SELECT` з рівно однією ціллю, прямим викликом кваліфікованої функції
 * запобіжника без іменованих аргументів. Дозвільний перелік ключів вузлів, а
 * не заборонний: нова гілка граматики не пройде мовчки.
 */
function guardCall(query: string, parse: SqlParser): Json | undefined {
  const parsed = parse(query)
  if (!parsed.ok || parsed.statements.length !== 1) return undefined
  const select = asRecord(asRecord(parsed.statements[0]!.stmt)?.SelectStmt)
  if (
    select === undefined ||
    !onlyKeys(select, ["targetList", "limitOption", "op"]) ||
    !Array.isArray(select.targetList) ||
    select.targetList.length !== 1
  )
    return undefined
  const target = asRecord(asRecord(select.targetList[0])?.ResTarget)
  if (target === undefined || !onlyKeys(target, ["val", "location"]))
    return undefined
  const call = asRecord(asRecord(target.val)?.FuncCall)
  return call !== undefined &&
    onlyKeys(call, ["funcname", "args", "funcformat", "location"])
    ? call
    : undefined
}

const stringConstant = (node: unknown): string | undefined => {
  const constant = asRecord(asRecord(node)?.A_Const)
  const value = asRecord(constant?.sval)
  return constant !== undefined &&
    onlyKeys(constant, ["sval", "location"]) &&
    typeof value?.sval === "string"
    ? value.sval
    : undefined
}

const isNullConstant = (node: unknown): boolean => {
  const constant = asRecord(asRecord(node)?.A_Const)
  return (
    constant !== undefined &&
    onlyKeys(constant, ["isnull", "location"]) &&
    constant.isnull === true
  )
}

/** Голе ім'я з одного поля: `p_row`, не `f.p_row`, не `p_row::uuid`. */
const bareName = (node: unknown): string | undefined => {
  const fields = asRecord(asRecord(node)?.ColumnRef)?.fields
  if (!Array.isArray(fields) || fields.length !== 1) return undefined
  const sval = asRecord(asRecord(fields[0])?.String)?.sval
  return typeof sval === "string" ? sval : undefined
}

/** Функція запобіжника форми цілі декларації (спека §5.2). */
const guardFunctionOf = (
  check: NonNullable<SqlFunctionDeclaration["check"]>
) => (check.scope !== undefined ? "rights_require_scope" : "rights_require")

function firstStatementOk(
  statement: PlpgsqlStatement | undefined,
  check: NonNullable<SqlFunctionDeclaration["check"]>,
  parse: SqlParser
): Json | undefined {
  const [expression, ...rest] = statement?.expressions ?? []
  if (
    statement?.type !== "perform" ||
    expression === undefined ||
    rest.length > 0 ||
    expression.perform !== true
  )
    return undefined
  const call = guardCall(expression.query, parse)
  const name = (call?.funcname as unknown[] | undefined)?.map(
    (part) => asRecord(asRecord(part)?.String)?.sval
  )
  const named = ((call?.args as unknown[] | undefined) ?? []).some(
    (arg) => asRecord(arg)?.NamedArgExpr !== undefined
  )
  return call !== undefined &&
    !named &&
    name?.length === 2 &&
    name[0] === "simetra" &&
    name[1] === guardFunctionOf(check)
    ? call
    : undefined
}

/**
 * Доказ форми запобіжника виклику (спека декларацій функцій §5.2): тіло
 * застосовує перевірку `check` декларації, лише якщо перший оператор блоку
 * автора — `PERFORM` функції запобіжника з аргументами декларації, а до нього
 * блок нічого не виконує (немає `DECLARE`) і виняток нікому перехопити
 * (немає `EXCEPTION`). Перша спрацьована причина — одна; не довели — причина
 * (fail-closed).
 */
export function guardOf(
  unit: VerbatimUnit,
  declaration: SqlFunctionDeclaration,
  contract: RightsContract,
  plpgsql: PlpgsqlParser,
  parse: SqlParser
): GuardProof {
  const check = declaration.check
  const fail = (reason: GuardReason): GuardProof => ({ ok: false, reason })
  if (check === undefined) return fail("firstStatement")
  const body = plpgsql(unit.sql)
  // Тіло, яке не розібрано, довести нічим: тут воно теж не plpgsql.
  if (!body.ok || body.fn === undefined) return fail("language")
  // Текст тіла — вміст `DefElem` `as`, як його бачить Postgres.
  let text: string | undefined
  try {
    text = functionBodyText(unit.sql)
  } catch {
    text = undefined
  }
  if (text === undefined || declareSection(text)) return fail("declareSection")
  const { firstStatement, hasExceptionBlock } = body.fn.author
  const call = firstStatementOk(firstStatement, check, parse)
  if (call === undefined) return fail("firstStatement")
  const action = contract.actions.find((a) => a.name === check.action)
  const target = check.row ?? check.scope
  const args = Array.isArray(call.args) ? (call.args as unknown[]) : []
  if (
    action === undefined ||
    args.length !== 3 ||
    stringConstant(args[0]) !== action.action ||
    stringConstant(args[1]) !== contract.kindLabel ||
    (target === undefined
      ? !isNullConstant(args[2])
      : bareName(args[2]) !== target)
  )
    return fail("arguments")
  return hasExceptionBlock ? fail("exceptionBlock") : { ok: true }
}

/**
 * Суддя запобіжника виклику над задекларованими definer-функціями з
 * викликачами від імені користувача й з `check`: функція, чиє тіло не
 * доводить форму, — `sql.declaration-check-not-applied` (клас ремонту).
 * Судить лише декларації, що пройшли `checkDeclaredChecks`: контракт об'єкта
 * тут існує, а ціль відповідає підпису.
 */
export function checkDeclaredGuards(
  declared: readonly DeclaredFunction[],
  units: readonly VerbatimUnit[],
  objects: readonly ParsedObject[],
  rights: readonly RightsContract[],
  plpgsql: PlpgsqlParser,
  parse: SqlParser
): Diagnostic[] {
  return declared.flatMap(({ declaration, file, pointer, unit, key }) => {
    const check = declaration.check
    if (
      check === undefined ||
      !isSecurityDefiner(unit, units) ||
      !declaration.callers.some((c) => ON_BEHALF_OF_USER.has(c))
    )
      return []
    const object = objects.find(
      (o) => o.kind === check.object.kind && o.name === check.object.name
    )
    const contract = rights.find((r) => r.objectId === object?.id)
    if (contract === undefined) return []
    const proof = guardOf(unit, declaration, contract, plpgsql, parse)
    return proof.ok
      ? []
      : [
          diagnostic("sql.declaration-check-not-applied", file, pointer, {
            schema: key.schema,
            name: key.name,
            function: `${key.schema}.${key.name}`,
            reason: proof.reason,
          }),
        ]
  })
}
