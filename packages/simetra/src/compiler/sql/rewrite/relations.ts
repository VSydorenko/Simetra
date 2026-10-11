import type { RangeVar, TypeName } from "libpg-query"
import { quoteIdent } from "simetra/model"
import type { RewriteContext } from "./context"
import { strings } from "./nodes"
import { survivesPromotion, type TableRename } from "./renames"
import { findByRefname, postRefname, type Item, type Level } from "./sources"
import { resolveTableName, type TableResolution } from "./tables"

/**
 * Імена відношень у тексті оператора: резолв імені таблиці, правка її
 * токена й захоплення видимого імені елемента `FROM` новим ім'ям таблиці.
 */

/**
 * Перейменована таблиця без аліасу змінює видиме ім'я свого елемента
 * `FROM`; ім'я, яке вже займає інший елемент того самого рівня, — помилка
 * Postgres після промоції.
 */
export function checkNames(ctx: RewriteContext, items: readonly Item[]): void {
  for (const item of items) {
    if (!("leaf" in item)) continue
    const { leaf } = item
    const table = leaf.table
    if (table === undefined || leaf.aliased || table.from === table.to) continue
    if (items.some((o) => o !== item && postRefname(o) === table.to)) {
      ctx.problem("rewrite.ambiguous-name", leaf.location ?? 0, "capture")
    }
  }
}

/** Ім'я таблиці за правилом `resolveTableName`; відмову записано як проблему. */
export function resolveTable(
  ctx: RewriteContext,
  catalog: string | undefined,
  schema: string | undefined,
  relname: string,
  location: number | undefined
): TableResolution {
  const resolved = resolveTableName(
    ctx.map,
    ctx.scope.searchPath,
    catalog,
    schema,
    relname
  )
  if (resolved.failed) {
    ctx.problem(resolved.code, ctx.at(location), resolved.detail)
  }
  return resolved
}

export function renameRelation(
  ctx: RewriteContext,
  rv: RangeVar,
  table: TableRename
): void {
  if (table.from === table.to) return
  const names = [rv.catalogname, rv.schemaname, rv.relname].filter(
    (n) => n !== undefined
  )
  const tokens = ctx.tokens(rv.location, names)
  const last = tokens?.at(-1)
  if (last !== undefined) ctx.edit(last.start, last.end, quoteIdent(table.to))
}

/** `FOR UPDATE OF <ім'я>`: ім'я таблиці без псевдоніма слідує за її перейменуванням. */
export function lockedRel(
  ctx: RewriteContext,
  rv: RangeVar,
  level: Level
): void {
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
  const tokens = ctx.tokens(rv.location, [rv.relname ?? ""])
  if (tokens !== undefined)
    ctx.edit(tokens[0]!.start, tokens[0]!.end, quoteIdent(table.to))
}

/** Відношення поза `FROM` (`TRUNCATE`, `LOCK`): лише ім'я таблиці. */
export function looseRangeVar(ctx: RewriteContext, rv: RangeVar): void {
  const resolved = resolveTable(
    ctx,
    rv.catalogname,
    rv.schemaname,
    rv.relname ?? "",
    rv.location
  )
  if (!resolved.failed && resolved.table !== undefined) {
    renameRelation(ctx, rv, resolved.table)
  }
}

/**
 * Тип рядка промотованої таблиці (`::app.t`, `app.t.col%TYPE`) — те саме ім'я
 * відношення. Вирази `typmods`/`arrayBounds` обходить викликач — до цього
 * виклику, бо обхід належить обходу дерева.
 */
export function typeName(ctx: RewriteContext, tn: TypeName): void {
  const names = strings(tn.names ?? [])
  if (names === undefined) return
  const relation = tn.pct_type === true ? names.slice(0, -1) : names
  const relname = relation.at(-1)
  if (relname === undefined || !ctx.promotedNames.has(relname)) return
  if (relation.length > 3) {
    ctx.problem(
      "rewrite.unsupported",
      ctx.at(tn.location),
      `a ${relation.length}-part name of promoted table "${relname}" is not rewritten`
    )
    return
  }
  const catalog = relation.length === 3 ? relation[0] : undefined
  const schema = relation.length >= 2 ? relation.at(-2) : undefined
  const resolved = resolveTable(ctx, catalog, schema, relname, tn.location)
  if (resolved.failed || resolved.table === undefined) return
  const table = resolved.table
  const column = tn.pct_type === true ? names.at(-1)! : undefined
  const renamed = column === undefined ? undefined : table.columns.get(column)
  if (column !== undefined && !survivesPromotion(table, renamed ?? column)) {
    ctx.removed(column, table, tn.location)
    return
  }
  const tokens = ctx.tokens(tn.location, names)
  if (tokens === undefined) return
  const relToken = tokens[relation.length - 1]!
  if (table.from !== table.to) {
    ctx.edit(relToken.start, relToken.end, quoteIdent(table.to))
  }
  const colToken = tokens.at(-1)!
  if (renamed !== undefined) {
    ctx.edit(colToken.start, colToken.end, quoteIdent(renamed))
  }
  // Значення типу рядка промотованої таблиці отримує поля виду.
  if (column === undefined) ctx.change("wholeRow", ctx.at(tn.location))
}
