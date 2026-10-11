import type { A_Const, FuncCall, TypeCast } from "libpg-query"
import { relationNameText } from "../parse"
import type { RewriteContext } from "./context"
import { stringLiteral, strings } from "./nodes"
import type { TableRename } from "./renames"

/**
 * Рядкового вмісту переписувач не править: рядок, що може називати мітку чи
 * відношення промотованої таблиці, лише стає відмовою.
 */

/**
 * Рядковий літерал, рівний мітці споживача: дані кодують об'єкт старою
 * міткою. Літерал, що читається як ім'я промотованої таблиці
 * (`to_regclass('app.t')`, неявний `regclass`-аргумент, `TG_TABLE_NAME =
 * 't'`), Postgres резолвить лише під час виконання, а нове ім'я в рядок не
 * підставити, не правлячи його вмісту: мовчки лишений рядок повернув би
 * `NULL` чи хибну гілку вже після промоції.
 */
export function checkLiteral(ctx: RewriteContext, constant: A_Const): void {
  const value = constant.sval?.sval
  if (value === undefined) return
  if (ctx.labels.has(value)) {
    ctx.problem(
      "rewrite.label-literal",
      ctx.at(constant.location),
      `string literal '${value}' equals a consumer label of the promoted object`
    )
  }
  const table = textTable(ctx, value)
  if (table !== undefined) {
    ctx.problem(
      "rewrite.unsupported",
      ctx.at(constant.location),
      `table name in a string literal: '${value}' names promoted table "${table.schema}.${table.from}", which the promotion renames; the rewrite does not edit the contents of a string`
    )
  }
}

/** Промотована таблиця, яку називає текст; кваліфікований — лише в її схемі. */
function textTable(
  ctx: RewriteContext,
  value: string
): TableRename | undefined {
  const names = relationNameText(value)
  if (names === undefined || names.length > 3) return undefined
  const relname = names.at(-1)!
  const schema = names.length >= 2 ? names.at(-2) : undefined
  return ctx.map.tables.find(
    (t) => t.from === relname && (schema === undefined || t.schema === schema)
  )
}

/**
 * Рядок, приведений до `regclass`, називає відношення текстом. Ім'я, якого
 * немає серед таблиць моделі, може бути послідовністю, індексом чи іншим
 * відношенням промотованої таблиці — їх промоція перейменовує окремо, тож
 * таке ім'я не доведене. Промотовану таблицю судить `checkLiteral`.
 */
export function checkRegclassLiteral(
  ctx: RewriteContext,
  cast: TypeCast
): void {
  const type = strings(cast.typeName?.names ?? [])
  if (
    type === undefined ||
    type.at(-1) !== "regclass" ||
    !(type.length === 1 || (type.length === 2 && type[0] === "pg_catalog"))
  ) {
    return
  }
  const value = stringLiteral(cast.arg)
  if (value === undefined || textTable(ctx, value) !== undefined) return
  const names = relationNameText(value)
  if (names !== undefined && knownRelation(ctx, names)) return
  ctx.problem(
    "rewrite.unsupported",
    ctx.at(cast.location),
    `regclass literal '${value}' names no table of the model: it may name a sequence, an index or another relation of a promoted table, which the promotion renames separately`
  )
}

/** Таблиця моделі за іменем з тексту; некваліфіковане — у будь-якій схемі. */
function knownRelation(ctx: RewriteContext, names: readonly string[]): boolean {
  if (names.length === 0 || names.length > 3) return false
  const relname = names.at(-1)!
  if (names.length === 1) {
    return [...ctx.map.knownTables.keys()].some((k) =>
      k.endsWith(`.${relname}`)
    )
  }
  return ctx.map.knownTables.has(`${names.at(-2)}.${relname}`)
}

/**
 * Ім'я послідовності рядком (`nextval('…')`, `setval`, `currval`,
 * `pg_get_serial_sequence`): послідовності промотованої таблиці план
 * перейменовує окремо, а які саме вони, переписувач не знає — рядок не
 * доведено чужим.
 */
export function checkSequenceName(ctx: RewriteContext, call: FuncCall): void {
  const names = strings(call.funcname ?? [])
  const name = names?.at(-1)
  if (
    names === undefined ||
    name === undefined ||
    !SEQUENCE_FUNCTIONS.has(name) ||
    !(names.length === 1 || (names.length === 2 && names[0] === "pg_catalog"))
  ) {
    return
  }
  if (!(call.args ?? []).some((a) => stringLiteral(a) !== undefined)) return
  ctx.problem(
    "rewrite.unsupported",
    ctx.at(call.location),
    `${name}() takes a sequence or table name as a string: the promotion renames the sequences of a promoted table separately, and the rewrite does not prove which sequence the string names; let the column default draw the value or rewrite the call by hand after the promotion`
  )
}

/** Функції каталогу, що беруть ім'я послідовності (чи таблиці) рядком. */
const SEQUENCE_FUNCTIONS: ReadonlySet<string> = new Set([
  "nextval",
  "currval",
  "setval",
  "pg_get_serial_sequence",
])
