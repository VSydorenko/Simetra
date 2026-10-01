import { loadModule, parseSync, type Node, type ParseResult } from "libpg-query"

/** Оператор верхнього рівня: вузол розбору і його місце в тексті. */
export interface ParsedStatement {
  stmt: Node
  /** Індекси UTF-16 у розібраному тексті, `[start, end)`; без `;`. */
  start: number
  end: number
}

export type SqlParseResult =
  | { ok: true; statements: ParsedStatement[] }
  /** `offset` — індекс UTF-16 у розібраному тексті. */
  | { ok: false; message: string; offset: number }

export type SqlParser = (text: string) => SqlParseResult

let parser: Promise<SqlParser> | undefined

/**
 * Парсер Postgres (libpg-query, WASM). Модуль вантажиться один раз на процес:
 * ініціалізація WASM дорога, а компілятор викликають багато разів (CLI у
 * режимі спостереження, тести, студія). Після завантаження розбір синхронний,
 * тож стадії компілятора лишаються синхронними функціями над готовим парсером.
 */
export function loadSqlParser(): Promise<SqlParser> {
  parser ??= loadModule().then(
    () => parseText,
    (error: unknown) => {
      // Невдале завантаження не кешуємо: наступний виклик спробує знову.
      parser = undefined
      throw error
    }
  )
  return parser
}

function parseText(text: string): SqlParseResult {
  let result: ParseResult
  try {
    result = parseSync(text) as ParseResult
  } catch (error) {
    const details = sqlDetails(error)
    if (details === undefined) throw error
    return {
      ok: false,
      message: details.message,
      offset: codePointToIndex(text, details.cursorPosition),
    }
  }
  const offsets = new ByteOffsets(text)
  const statements: ParsedStatement[] = []
  for (const raw of result.stmts ?? []) {
    if (raw.stmt === undefined) continue
    // `stmt_location` і `stmt_len` — байти UTF-8; відсутні означають початок
    // тексту й «до кінця» відповідно.
    const startByte = raw.stmt_location ?? 0
    const start = offsets.toIndex(startByte)
    const end =
      raw.stmt_len === undefined || raw.stmt_len === 0
        ? text.length
        : offsets.toIndex(startByte + raw.stmt_len)
    statements.push({ stmt: raw.stmt, start, end })
  }
  return { ok: true, statements }
}

function sqlDetails(
  error: unknown
): { message: string; cursorPosition: number } | undefined {
  if (!(error instanceof Error) || !("sqlDetails" in error)) return undefined
  const details = error.sqlDetails as
    { message?: string; cursorPosition?: number } | undefined
  return {
    message: details?.message ?? error.message,
    cursorPosition: details?.cursorPosition ?? 0,
  }
}

/**
 * `cursorPosition` libpg-query — 0-базне зміщення в кодових точках (Postgres
 * рахує позицію помилки в символах, обгортка віднімає одиницю); рядок JS
 * індексується в UTF-16, тож сурогатна пара — дві одиниці.
 */
function codePointToIndex(text: string, codePoints: number): number {
  let index = 0
  for (let i = 0; i < codePoints && index < text.length; i++) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1
  }
  return index
}

/** Переклад байтових зміщень UTF-8 в індекси UTF-16 за один прохід тексту. */
class ByteOffsets {
  private readonly indexByByte = new Map<number, number>()

  constructor(text: string) {
    let byte = 0
    let index = 0
    while (index < text.length) {
      this.indexByByte.set(byte, index)
      const codePoint = text.codePointAt(index) ?? 0
      byte +=
        codePoint < 0x80
          ? 1
          : codePoint < 0x800
            ? 2
            : codePoint < 0x10000
              ? 3
              : 4
      index += codePoint > 0xffff ? 2 : 1
    }
    this.indexByByte.set(byte, index)
  }

  toIndex(byte: number): number {
    const index = this.indexByByte.get(byte)
    if (index === undefined) {
      throw new Error(`libpg-query offset ${byte} is not a character boundary`)
    }
    return index
  }
}
