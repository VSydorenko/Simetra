import { quoteIdent } from "simetra/model"
import { readIdent, skipTrivia, type Token } from "./lex"
import {
  SYSTEM_COLUMNS,
  survivesPromotion,
  type RecordBinding,
  type RenameMap,
  type RewriteProblem,
  type TableRename,
  type TextEdit,
} from "./renames"
import { resolveTableName } from "./tables"

/** Контекст резолву типу: таблиці — за `search_path`, `запис.поле%TYPE` — за записами. */
export interface TypeRefContext {
  map: RenameMap
  searchPath: readonly string[] | undefined
  variables: ReadonlySet<string>
  records: ReadonlyMap<string, RecordBinding>
}

export interface TypeRefResult {
  edits: TextEdit[]
  problems: TypeRefProblem[]
  /** Тип — рядок цієї промотованої таблиці (`%ROWTYPE` чи ім'я таблиці як тип). */
  rowOf?: TableRename
  /** Тип — масив рядків цієї промотованої таблиці: форма змінюється, запису немає. */
  arrayOf?: TableRename
}

/** Відмова за посиланням на тип; `offset` — індекс першого токена в тексті. */
export interface TypeRefProblem {
  code: RewriteProblem["code"] | "rewrite.unresolved-type"
  offset: number
  detail: string
}

/**
 * Ланцюжок імен типу як у тексті автора (`app.t.col %TYPE`) від `start`:
 * токени імен і суфікс `%TYPE`/`%ROWTYPE`. Модифікатори після імені
 * (`(10)`, `[]`) не читаються: імені таблиці в них немає.
 */
export function lexTypeRef(
  text: string,
  start: number
):
  { tokens: Token[]; suffix?: "type" | "rowtype"; array: boolean } | undefined {
  const first = readIdent(text, skipTrivia(text, start))
  if (first === undefined) return undefined
  const tokens = [first]
  let i = first.end
  for (;;) {
    const dot = skipTrivia(text, i)
    if (text[dot] !== ".") break
    const next = readIdent(text, skipTrivia(text, dot + 1))
    if (next === undefined) return undefined
    tokens.push(next)
    i = next.end
  }
  let suffix: "type" | "rowtype" | undefined
  const percent = skipTrivia(text, i)
  if (text[percent] === "%") {
    const word = readIdent(text, skipTrivia(text, percent + 1))
    if (word?.value === "type" || word?.value === "rowtype") {
      suffix = word.value
      i = word.end
    }
  }
  // `t[]` чи `t ARRAY` — масив рядків, а не запис: полів у нього немає.
  const after = skipTrivia(text, i)
  const array = text[after] === "[" || readIdent(text, after)?.value === "array"
  return suffix === undefined ? { tokens, array } : { tokens, suffix, array }
}

/**
 * Посилання на тип у сигнатурі чи `DECLARE` (рішення 13): ім'я промотованої
 * таблиці перейменовується, колонка `%TYPE` — за мапою колонок, а
 * нерезольвна колонка промотованої таблиці — `rewrite.unresolved-type`.
 * Позиції правок — індекси токенів у тексті, з якого їх лексовано.
 */
export function rewriteTypeRef(
  tokens: readonly Token[],
  suffix: "type" | "rowtype" | undefined,
  ctx: TypeRefContext,
  array = false
): TypeRefResult {
  const result: TypeRefResult = { edits: [], problems: [] }
  const names = tokens.map((t) => t.value)
  const column = suffix === "type" ? names.at(-1) : undefined
  const relation = suffix === "type" ? names.slice(0, -1) : names
  const relname = relation.at(-1)
  // `змінна%TYPE` — тип змінної, а не таблиці.
  if (relname === undefined) return result
  const offset = tokens[0]!.start
  const fail = (code: TypeRefProblem["code"], detail: string) => {
    result.problems.push({ code, offset, detail })
    return result
  }
  if (
    column !== undefined &&
    relation.length === 1 &&
    ctx.variables.has(relname)
  ) {
    return recordFieldType(relname, column, tokens.at(-1)!, ctx, result, fail)
  }
  if (!ctx.map.tables.some((t) => t.from === relname)) return result
  if (relation.length > 3) {
    return fail(
      "rewrite.unsupported",
      `a ${relation.length}-part name of promoted table "${relname}" is not rewritten`
    )
  }
  const resolved = resolveTableName(
    ctx.map,
    ctx.searchPath,
    relation.length === 3 ? relation[0] : undefined,
    relation.length >= 2 ? relation.at(-2) : undefined,
    relname
  )
  if (resolved.failed) return fail(resolved.code, resolved.detail)
  const table = resolved.table
  if (table === undefined) return result
  if (table.from !== table.to) {
    const token = tokens[relation.length - 1]!
    result.edits.push({
      start: token.start,
      end: token.end,
      text: quoteIdent(table.to),
    })
  }
  if (column === undefined) {
    if (array) result.arrayOf = table
    else result.rowOf = table
    return result
  }
  const before = ctx.map.knownTables.get(`${table.schema}.${table.from}`) ?? []
  const renamed = table.columns.get(column)
  if (
    renamed === undefined &&
    !before.includes(column) &&
    !SYSTEM_COLUMNS.has(column)
  ) {
    return fail(
      "rewrite.unresolved-type",
      `"${column}" is not a column of promoted table "${table.from}"`
    )
  }
  if (!survivesPromotion(table, renamed ?? column)) {
    return fail(
      "rewrite.unsupported",
      `column "${column}" of promoted table "${table.from}" is removed by the promotion`
    )
  }
  if (renamed !== undefined) {
    const token = tokens.at(-1)!
    result.edits.push({
      start: token.start,
      end: token.end,
      text: quoteIdent(renamed),
    })
  }
  return result
}

/**
 * `запис.поле%TYPE`: поле запису з відомою формою переписується за мапою;
 * поле запису невідомої форми, що збігається зі зміненою колонкою, —
 * відмова, бо тип міг прийти з промотованої таблиці.
 */
function recordFieldType(
  record: string,
  field: string,
  token: Token,
  ctx: TypeRefContext,
  result: TypeRefResult,
  fail: (code: TypeRefProblem["code"], detail: string) => TypeRefResult
): TypeRefResult {
  const binding = ctx.records.get(record)
  if (binding !== undefined && "table" in binding) {
    const table = binding.table
    const renamed = table.columns.get(field)
    if (!survivesPromotion(table, renamed ?? field)) {
      return fail(
        "rewrite.unsupported",
        `column "${field}" of promoted table "${table.from}" is removed by the promotion`
      )
    }
    if (renamed !== undefined) {
      result.edits.push({
        start: token.start,
        end: token.end,
        text: quoteIdent(renamed),
      })
    }
    return result
  }
  if (changedFields(ctx.map).has(field)) {
    return fail(
      "rewrite.unsupported",
      `the type ${record}.${field}%TYPE comes from a record whose row shape is not proven`
    )
  }
  return result
}

/**
 * Імена полів, які промоція перейменовує чи знімає в будь-якій промотованій
 * таблиці: лише за ними поле запису невідомої форми важить.
 */
export function changedFields(map: RenameMap): Set<string> {
  const names = new Set<string>()
  for (const table of map.tables) {
    for (const old of table.columns.keys()) names.add(old)
    for (const column of map.knownTables.get(`${table.schema}.${table.from}`) ??
      []) {
      if (!survivesPromotion(table, table.columns.get(column) ?? column)) {
        names.add(column)
      }
    }
  }
  return names
}
