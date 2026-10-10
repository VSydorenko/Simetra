/**
 * Лексика імен для правок на місці. Сканер libpg-query тут не вживається: у
 * збірці PG17 він переповнює буфер на довгому токені, тож межі імені беруться
 * з самого тексту від позиції, яку дало дерево.
 */

export interface Token {
  start: number
  end: number
  /** Ім'я, як його бачить Postgres: без лапок, некваліфіковане — в нижньому регістрі. */
  value: string
}

/**
 * Ланцюжок ідентифікаторів `a . b . c` від `start`. Між частинами дозволені
 * пробіли й коментарі — так їх допускає граматика.
 */
export function lexChain(
  text: string,
  start: number,
  count: number
): Token[] | undefined {
  const tokens: Token[] = []
  let i = start
  for (let k = 0; k < count; k++) {
    if (k > 0) {
      i = skipTrivia(text, i)
      if (text[i] !== ".") return undefined
      i = skipTrivia(text, i + 1)
    }
    const token = readIdent(text, i)
    if (token === undefined) return undefined
    tokens.push(token)
    i = token.end
  }
  return tokens
}

/**
 * Один ідентифікатор: лапкований — до закривальних лапок з урахуванням `""`;
 * звичайний — символи ідентифікатора, значення в нижньому регістрі ASCII (як
 * `downcase_identifier` для багатобайтового кодування). `U&"…"` не
 * розбирається: його значення залежить від екранування.
 */
export function readIdent(text: string, start: number): Token | undefined {
  const first = text[start]
  if (first === undefined) return undefined
  if (first === '"') {
    let value = ""
    let j = start + 1
    for (;;) {
      const close = text.indexOf('"', j)
      if (close < 0) return undefined
      value += text.slice(j, close)
      if (text[close + 1] === '"') {
        value += '"'
        j = close + 2
        continue
      }
      return { start, end: close + 1, value }
    }
  }
  if ((first === "U" || first === "u") && text[start + 1] === "&")
    return undefined
  if (!identStart(first)) return undefined
  let end = start + 1
  while (end < text.length && identCont(text[end]!)) end++
  const raw = text.slice(start, end)
  return { start, end, value: raw.replace(/[A-Z]/g, (c) => c.toLowerCase()) }
}

/** Символ ідентифікатора за `scan.l`: будь-який не-ASCII символ теж його частина. */
function identStart(c: string): boolean {
  return /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80
}

function identCont(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80
}

export function skipTrivia(text: string, start: number): number {
  let i = start
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++
    if (text.startsWith("--", i)) {
      const eol = text.indexOf("\n", i)
      i = eol < 0 ? text.length : eol + 1
      continue
    }
    if (text.startsWith("/*", i)) {
      let depth = 1
      i += 2
      while (i < text.length && depth > 0) {
        if (text.startsWith("/*", i)) {
          depth++
          i += 2
        } else if (text.startsWith("*/", i)) {
          depth--
          i += 2
        } else i++
      }
      continue
    }
    return i
  }
}
