import type { SqlFunctionDeclaration } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { RightsContract } from "../contracts"
import type { ParsedObject } from "../stages/files"
import { isSecurityDefiner } from "./definer-reads"
import {
  checkedContract,
  hasUuidInParameter,
  type DeclaredFunction,
} from "./declarations"
import { RIGHTS_FUNCTIONS } from "../rights/functions"
import type { SqlParser } from "./parse"
import {
  functionBodyText,
  type PlpgsqlParser,
  type PlpgsqlStatement,
} from "./plpgsql"
import { declareSection, dollarLiterals, outerBeginEnd } from "./rewrite/lex"
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

/** Функція запобіжника форми цілі декларації: ім'я тримає генератор. */
export const guardFunctionOf = (
  check: NonNullable<SqlFunctionDeclaration["check"]>
) =>
  check.scope !== undefined
    ? RIGHTS_FUNCTIONS.requireScope
    : RIGHTS_FUNCTIONS.require

/**
 * Форма першого оператора без контрактів (спека декларацій функцій §5.2):
 * `PERFORM` єдиного прямого виклику функції запобіжника форми цілі `check`.
 * Правильність аргументів судить `guardOf`; ту саму форму вимагає виняток Р9
 * в `withoutFirstGuard` — одне визначення на обох.
 */
export function firstStatementOk(
  statement: PlpgsqlStatement | undefined,
  check: NonNullable<SqlFunctionDeclaration["check"]>,
  parse: SqlParser
): Json | undefined {
  return firstGuardCall(statement, guardFunctionOf(check), parse)
}

type GuardFunction = (typeof RIGHTS_FUNCTIONS)["require"]

function firstGuardCall(
  statement: PlpgsqlStatement | undefined,
  guard: GuardFunction,
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
    name[0] === guard.schema &&
    name[1] === guard.name
    ? call
    : undefined
}

/**
 * Спільна частина судді й читача: тіло plpgsql без `DECLARE`, першим
 * оператором якого є виклик функції запобіжника `guard`. `EXCEPTION` судить
 * лише `guardOf` (читач бере аргументи тільки з тіла, яке суддя прийняв би).
 */
function guardShape(
  unit: VerbatimUnit,
  guard: GuardFunction,
  plpgsql: PlpgsqlParser,
  parse: SqlParser
):
  | { call: Json; hasExceptionBlock: boolean }
  | { reason: Exclude<GuardReason, "arguments" | "exceptionBlock"> } {
  const body = plpgsql(unit.sql)
  // Тіло, яке не розібрано, довести нічим: тут воно теж не plpgsql.
  if (!body.ok || body.fn === undefined) return { reason: "language" }
  // Текст тіла — вміст `DefElem` `as`, як його бачить Postgres.
  let text: string | undefined
  try {
    text = functionBodyText(unit.sql)
  } catch {
    text = undefined
  }
  if (text === undefined || declareSection(text))
    return { reason: "declareSection" }
  const { firstStatement, hasExceptionBlock } = body.fn.author
  const call = firstGuardCall(firstStatement, guard, parse)
  return call === undefined
    ? { reason: "firstStatement" }
    : { call, hasExceptionBlock }
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
  const shape = guardShape(unit, guardFunctionOf(check), plpgsql, parse)
  if (!("call" in shape)) return fail(shape.reason)
  const { call, hasExceptionBlock } = shape
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
 * Місце вставки запобіжника (спека декларацій функцій §5.6, Р3): зсув у
 * `unit.sql` одразу після слова `BEGIN` зовнішнього блоку — або `undefined`,
 * коли вставка не доводиться безпечною. Умови разом: функція `SECURITY
 * DEFINER` мовою `plpgsql`, тіло в доларових лапках, без `DECLARE`, без
 * секції `EXCEPTION` зовнішнього блоку (вона перехопила б відмову запобіжника
 * власної перевірки блоку), у тексті немає жодного звернення до функцій
 * запобіжника (будь-якої форми: `PERFORM … WHERE false`, динамічний SQL) і
 * `guardOf` дав би причину `firstStatement`. Єдине місце цих умов: `fix`
 * вставляє запобіжник саме тут, а `declare-function` пропускає ціль у цей
 * стан, лише коли `fix` його гарантовано вставить.
 */
export function guardInsertionPoint(
  unit: VerbatimUnit,
  check: NonNullable<SqlFunctionDeclaration["check"]>,
  units: readonly VerbatimUnit[],
  plpgsql: PlpgsqlParser,
  parse: SqlParser
): number | undefined {
  if (!isSecurityDefiner(unit, units)) return undefined
  const shape = guardShape(unit, guardFunctionOf(check), plpgsql, parse)
  if (!("reason" in shape) || shape.reason !== "firstStatement") {
    return undefined
  }
  const parsed = plpgsql(unit.sql)
  if (!parsed.ok || parsed.fn?.author.hasExceptionBlock !== false) {
    return undefined
  }
  const lowered = unit.sql.toLowerCase()
  if (
    [RIGHTS_FUNCTIONS.require, RIGHTS_FUNCTIONS.requireScope].some((guard) =>
      lowered.includes(guard.name)
    )
  ) {
    return undefined
  }
  let text: string | undefined
  try {
    text = functionBodyText(unit.sql)
  } catch {
    return undefined
  }
  if (text === undefined) return undefined
  // Літерал тіла — єдиний доларовий з вмістом, що дорівнює тексту тіла: інший
  // доларовий літерал `CREATE FUNCTION` (значення параметра) не збігається, а
  // неоднозначність — відмова.
  const bodies = [...dollarLiterals(unit.sql)].filter(
    (literal) => unit.sql.slice(literal.start, literal.end) === text
  )
  if (bodies.length !== 1) return undefined
  const begin = outerBeginEnd(text)
  return begin === undefined ? undefined : bodies[0]!.start + begin
}

/**
 * Рядок першого оператора тіла plpgsql (`lineno` рахується від початку тексту
 * тіла, як у `firstDynamicSqlLine`); без оператора чи для іншої мови —
 * рядок `CREATE FUNCTION`.
 */
function bodyStartLine(unit: VerbatimUnit, plpgsql: PlpgsqlParser): number {
  const parsed = plpgsql(unit.sql)
  const first = parsed.ok ? parsed.fn?.author.firstStatement : undefined
  let text: string | undefined
  try {
    text = functionBodyText(unit.sql)
  } catch {
    text = undefined
  }
  const at = text === undefined ? -1 : unit.sql.indexOf(text)
  if (first === undefined || at < 0) return unit.line
  const before = unit.sql.slice(0, at).split("\n").length - 1
  return unit.line + before + first.lineno - 1
}

/**
 * Суддя запобіжника виклику над кожною задекларованою definer-функцією з
 * `check` (хоч би які викликачі, зокрема `[]` і лише `service`): функція, чиє тіло не
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
  return declared.flatMap(({ declaration, unit, key }) => {
    const check = declaration.check
    // Викликачів не питаємо: декларація з `check` на definer-функції без
    // викликачів від імені користувача (`callers: []`, лише `service`) теж
    // мусить довести перевірку — інакше вона мовчки лишається словом без дії,
    // а `withoutFirstGuard` звільняє від `platform-function-call` саме
    // доведений запобіжник.
    if (check === undefined || !isSecurityDefiner(unit, units)) return []
    const contract = checkedContract(check, objects, rights)
    // Сюди доходять лише декларації, що пройшли `check-form` (є контракт);
    // тиха згода тут відкрила б обхід, тож відсутність — внутрішня помилка.
    if (contract === undefined) {
      throw new Error(
        `internal: no rights contract for the check of ${key.schema}.${key.name}`
      )
    }
    const proof = guardOf(unit, declaration, contract, plpgsql, parse)
    return proof.ok
      ? []
      : [
          // Вказуємо на `.sql` функції й рядок першого оператора тіла: саме
          // там автор виправляє тіло (запису декларації виправляти нічого).
          diagnostic("sql.declaration-check-not-applied", unit.file, "", {
            schema: key.schema,
            name: key.name,
            function: `${key.schema}.${key.name}`,
            reason: proof.reason,
            line: bodyStartLine(unit, plpgsql),
          }),
        ]
  })
}

/** Аргументи запобіжника виклику першого оператора тіла (читає зворотна генерація). */
export interface GuardArgs {
  /** Яка функція запобіжника: ціль `row` (`require`) чи `scope` (`requireScope`). */
  form: "require" | "requireScope"
  /** Рядок дії: ім'я стандартної дії або UUID кастомної. */
  action: string
  /** Мітка виду об'єкта. */
  kindLabel: string
  /** Параметр цілі; `null` — `NULL` (дія без цілі). */
  target: string | null
}

/**
 * Читач аргументів запобіжника поруч із `guardOf`: той самий розбір форми
 * (plpgsql, без `DECLARE`, `PERFORM` єдиного прямого виклику першим
 * оператором, без `EXCEPTION`), але без декларації — зворотна генерація з
 * аргументів пише `check`. Нічого не повертає для тіла без запобіжника чи з
 * аргументами іншої форми (дві рядкові константи й голе ім'я чи `NULL`):
 * вигаданого `check` не буде.
 */
export function guardArgsOf(
  unit: VerbatimUnit,
  plpgsql: PlpgsqlParser,
  parse: SqlParser
): GuardArgs | undefined {
  for (const form of ["require", "requireScope"] as const) {
    const shape = guardShape(unit, RIGHTS_FUNCTIONS[form], plpgsql, parse)
    if (!("call" in shape) || shape.hasExceptionBlock) continue
    const args = Array.isArray(shape.call.args)
      ? (shape.call.args as unknown[])
      : []
    if (args.length !== 3) return undefined
    const action = stringConstant(args[0])
    const kindLabel = stringConstant(args[1])
    const target = isNullConstant(args[2]) ? null : bareName(args[2])
    if (action === undefined || kindLabel === undefined || target === undefined)
      return undefined
    // Лише поєднання, які доводить суддя: ціль — IN-параметр uuid функції
    // (`hasUuidInParameter`, той самий, що в `checkFormReason`), а `NULL` —
    // лише для `rights_require` (`check` без цілі); для `scope` ціль завжди
    // параметр. Інакше `check` з цих аргументів `guardOf` відхилив би.
    if (
      target === null
        ? form === "requireScope"
        : !hasUuidInParameter(unit, target)
    )
      return undefined
    return { form, action, kindLabel, target }
  }
  return undefined
}
