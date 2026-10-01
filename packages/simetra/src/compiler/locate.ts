import { parseTree, type Node } from "jsonc-parser"
import type { Diagnostic, Position, Range } from "./diagnostics"

/**
 * Перетворює JSON Pointer діагностики (і `params.line` для `.sql`) на
 * текстовий діапазон LSP (спека П2 §8.4). Діагностика, файлу якої немає в
 * мапі (наприклад, відсутній `project.meta.json`), лишається без діапазону.
 */
export function withRanges(
  diagnostics: readonly Diagnostic[],
  files: ReadonlyMap<string, string>
): Diagnostic[] {
  // Розбір і таблиця рядків — раз на файл, а не на кожну діагностику.
  const cache = new Map<string, FileText>()
  return diagnostics.map((d) => {
    const text = files.get(d.file)
    if (text === undefined) return d
    let file = cache.get(d.file)
    if (file === undefined) {
      file = new FileText(text, d.file.endsWith(".json"))
      cache.set(d.file, file)
    }
    return { ...d, range: file.locate(d) }
  })
}

class FileText {
  private readonly lineStarts: number[] = [0]
  private tree: Node | undefined

  constructor(
    private readonly text: string,
    isJson: boolean
  ) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") this.lineStarts.push(i + 1)
    }
    if (isJson) this.tree = parseTree(text, [], { allowTrailingComma: true })
  }

  locate(d: Diagnostic): Range {
    return this.tree === undefined ? this.byLine(d) : this.byPointer(d)
  }

  /** Колонка — індекс UTF-16, як у LSP; рядок JS уже індексується в тих самих одиницях. */
  private position(offset: number): Position {
    let low = 0
    let high = this.lineStarts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (this.lineStarts[mid]! <= offset) low = mid
      else high = mid - 1
    }
    return { line: low, character: offset - this.lineStarts[low]! }
  }

  private lineEnd(line: number): number {
    const next = this.lineStarts[line + 1]
    // Кінець рядка без `\n` і без попереднього `\r`.
    let end = next === undefined ? this.text.length : next - 1
    if (end > this.lineStarts[line]! && this.text[end - 1] === "\r") end--
    return end
  }

  private byPointer(d: Diagnostic): Range {
    const root = this.tree
    if (root === undefined || d.pointer === "") return fileStart()
    const node = nearestNode(root, d.pointer)
    const offset = d.params?.offset
    if (
      node.type === "string" &&
      typeof offset === "number" &&
      node === nodeAt(root, d.pointer)
    ) {
      const [start, end] = rawSpan(this.text, node, offset)
      return { start: this.position(start), end: this.position(end) }
    }
    return {
      start: this.position(node.offset),
      end: this.position(node.offset + node.length),
    }
  }

  /** `.sql` та інші непарсені файли: рядок (і колонка) з параметрів, інакше початок файлу. */
  private byLine(d: Diagnostic): Range {
    const line = d.params?.line
    if (typeof line !== "number") return fileStart()
    const index = Math.min(Math.max(line - 1, 0), this.lineStarts.length - 1)
    const length = this.lineEnd(index) - this.lineStarts[index]!
    const column = d.params?.column
    if (typeof column === "number") {
      const character = Math.min(Math.max(column - 1, 0), length)
      const at = { line: index, character }
      return { start: at, end: at }
    }
    return {
      start: { line: index, character: 0 },
      end: { line: index, character: length },
    }
  }
}

function fileStart(): Range {
  const start = { line: 0, character: 0 }
  return { start, end: start }
}

function segments(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
}

function child(node: Node, segment: string): Node | undefined {
  if (node.type === "array") {
    return /^(0|[1-9]\d*)$/.test(segment)
      ? node.children?.[Number(segment)]
      : undefined
  }
  if (node.type !== "object") return undefined
  return node.children?.find((p) => p.children?.[0]?.value === segment)
    ?.children?.[1]
}

function nodeAt(root: Node, pointer: string): Node | undefined {
  let node: Node | undefined = root
  for (const segment of segments(pointer)) {
    node = child(node, segment)
    if (node === undefined) return undefined
  }
  return node
}

/** Ключ, якого немає, адресує найближчий наявний предок. */
function nearestNode(root: Node, pointer: string): Node {
  let node = root
  for (const segment of segments(pointer)) {
    const next = child(node, segment)
    if (next === undefined) break
    node = next
  }
  return node
}

/**
 * Зміщення вираження — індекс у декодованому значенні рядка, а позиція в
 * файлі рахується по сирому тексту з екрануванням (`\"`, `\\`, `\uXXXX`):
 * кожна екранована послідовність — одна кодова одиниця декодованого рядка.
 * Повертає `[початок, кінець)` сирого символа в абсолютних індексах файлу.
 */
function rawSpan(text: string, node: Node, offset: number): [number, number] {
  const closing = node.offset + node.length - 1
  let raw = node.offset + 1
  let decoded = 0
  while (raw < closing && decoded < offset) {
    raw += tokenLength(text, raw)
    decoded++
  }
  raw = Math.min(raw, closing)
  return [raw, Math.min(raw + tokenLength(text, raw), closing)]
}

function tokenLength(text: string, at: number): number {
  if (text[at] !== "\\") return 1
  return text[at + 1] === "u" ? 6 : 2
}
