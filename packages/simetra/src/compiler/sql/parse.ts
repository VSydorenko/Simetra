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
  // Порожній текст libpg-query відхиляє винятком без `sqlDetails`, а порожній
  // файл — не помилка автора: компілятор не кидає на користувацькому вводі.
  if (text.trim() === "") return { ok: true, statements: [] }
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
  const toIndex = byteOffsets(text)
  const statements: ParsedStatement[] = []
  for (const raw of result.stmts ?? []) {
    if (raw.stmt === undefined) continue
    // `stmt_location` і `stmt_len` — байти UTF-8; відсутні означають початок
    // тексту й «до кінця» відповідно.
    const startByte = raw.stmt_location ?? 0
    const start = toIndex(startByte)
    const end =
      raw.stmt_len === undefined || raw.stmt_len === 0
        ? text.length
        : toIndex(startByte + raw.stmt_len)
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

/**
 * Переклад байтових зміщень UTF-8 в індекси UTF-16 за один прохід тексту.
 * libpg-query повертає позиції в байтах, а текст редагують у рядках JS; байт не
 * на межі символу означає, що позиція не з цього тексту, — це помилка, а не
 * округлення.
 */
export function byteOffsets(text: string): (byte: number) => number {
  const indexByByte = new Map<number, number>()
  let byte = 0
  let index = 0
  while (index < text.length) {
    indexByByte.set(byte, index)
    const codePoint = text.codePointAt(index) ?? 0
    byte +=
      codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4
    index += codePoint > 0xffff ? 2 : 1
  }
  indexByByte.set(byte, index)
  return (target) => {
    const found = indexByByte.get(target)
    if (found === undefined) {
      throw new Error(
        `libpg-query offset ${target} is not a character boundary`
      )
    }
    return found
  }
}

/**
 * Частини імені відношення з тексту, як їх читають `regclass`, `to_regclass`
 * і функції з аргументом-іменем (`stringToQualifiedNameList` Postgres):
 * пробіли навколо частин допустимі, без лапок — нижній регістр ASCII, у
 * лапках — як є з `""` → `"`. Одне правило для всіх, хто судить ім'я в
 * рядку, щоб двоє читачів не розходились у тому, що рядок називає.
 * Нерозбірний текст чи порожня частина — `undefined`.
 */
export function relationNameText(text: string): string[] | undefined {
  const names: string[] = []
  const space = (c: string | undefined) =>
    c === " " ||
    c === "\t" ||
    c === "\n" ||
    c === "\r" ||
    c === "\f" ||
    c === "\v"
  let i = 0
  for (;;) {
    while (space(text[i])) i++
    if (text[i] === '"') {
      let name = ""
      i++
      for (;;) {
        if (i >= text.length) return undefined
        if (text[i] === '"') {
          if (text[i + 1] !== '"') break
          i++
        }
        name += text[i++]
      }
      i++
      if (name === "") return undefined
      names.push(name)
    } else {
      const start = i
      while (i < text.length && text[i] !== "." && !space(text[i])) i++
      if (i === start) return undefined
      names.push(text.slice(start, i).replace(/[A-Z]/g, (c) => c.toLowerCase()))
    }
    while (space(text[i])) i++
    if (i >= text.length) return names
    if (text[i] !== ".") return undefined
    i++
  }
}
