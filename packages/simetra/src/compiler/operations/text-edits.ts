import { isRecordKeyAt } from "simetra/model"
import type { z } from "zod"
import type { TextEdit } from "../sql/rewrite/renames"
import type { ResolvedReference } from "../stages/identity"

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Форма місця посилання — те, як його переписують. Спосіб правки визначає
 * форма, а не роль: одна роль буває в кількох формах (ТЧ руху — і значенням
 * `source/tabularSection`, і токеном у `sum(...)`), тож нова роль у відомій
 * формі не потребує змін тут, а нова форма не скомпілюється без гілки.
 */
export type Place =
  /** Рядок-ім'я чи `MetadataRef` (`{ kind, name }`) за pointer. */
  | { form: "value"; file: string; pointer: string }
  /** Ключ `record` за pointer (поля руху називають поля регістра). */
  | { form: "key"; file: string; pointer: string }
  /** Токен імені у виразі за pointer: пів-інтервал [start, end). */
  | {
      form: "token"
      file: string
      pointer: string
      span: { start: number; end: number }
    }
  /** Маркер `-- @movements [<Kind>.]<Name>` у рядку `.sql`. */
  | { form: "marker"; file: string; line: number }

/**
 * Форма місця запису індексу. Токен і маркер індекс позначає сам (`span`,
 * `line`); ключ від значення відрізняє схема файлу — рядок під ключем
 * `record` є виразом, а не іменем, тож за самим JSON їх не розрізнити.
 */
export function placeOf(
  ref: ResolvedReference,
  raw: unknown,
  schema: z.ZodType | undefined
): Place {
  const { file, pointer } = ref.from
  if (ref.span !== undefined) {
    return { form: "token", file, pointer, span: ref.span }
  }
  if (ref.line !== undefined) return { form: "marker", file, line: ref.line }
  if (schema !== undefined && isRecordKeyAt(schema, raw, pointer)) {
    return { form: "key", file, pointer }
  }
  return { form: "value", file, pointer }
}

function segmentsOf(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
}

/** Контейнер і ключ останнього кроку pointer; індекс масиву — теж ключ. */
function slotOf(root: Json, pointer: string): { owner: Json; key: string } {
  const segments = segmentsOf(pointer)
  let owner: unknown = root
  for (const segment of segments.slice(0, -1)) {
    owner = (owner as Json)[segment]
  }
  return { owner: owner as Json, key: segments.at(-1)! }
}

/**
 * Переписує JSON-місця одного файлу на нове ім'я (мутує `root`). Токени
 * одного виразу — від кінця до початку, щоб зсув попередньої заміни не
 * зсунув межі наступної; ключі — останніми, бо заміна ключа змінює pointer
 * усього, що під ним. `newKind` — ціль змінила й вид (промоція): він пишеться
 * лише в `MetadataRef`, бо голе ім'я виду не несе.
 */
export function renameJsonPlaces(
  root: Json,
  places: readonly Place[],
  newName: string,
  newKind?: string
): void {
  const tokens = new Map<string, { start: number; end: number }[]>()
  const keys: string[] = []
  for (const place of places) {
    switch (place.form) {
      case "value": {
        const { owner, key } = slotOf(root, place.pointer)
        const node = owner[key]
        if (isRecord(node)) {
          node.name = newName
          if (newKind !== undefined) node.kind = newKind
        } else owner[key] = newName
        break
      }
      case "token": {
        const spans = tokens.get(place.pointer) ?? []
        spans.push(place.span)
        tokens.set(place.pointer, spans)
        break
      }
      case "key":
        keys.push(place.pointer)
        break
      case "marker":
        throw new Error(`marker place in JSON file ${place.file}`)
      default: {
        // П'ята форма місця не скомпілюється, доки тут немає її гілки.
        const unhandled: never = place
        throw new Error(`unknown place form ${JSON.stringify(unhandled)}`)
      }
    }
  }
  for (const [pointer, spans] of tokens) {
    const { owner, key } = slotOf(root, pointer)
    let text = owner[key] as string
    for (const span of [...spans].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, span.start) + newName + text.slice(span.end)
    }
    owner[key] = text
  }
  for (const pointer of keys) {
    const { owner, key } = slotOf(root, pointer)
    // Порядок ключів — дані автора: ключ міняється на місці.
    const entries = Object.entries(owner).map(
      ([k, v]) => [k === key ? newName : k, v] as const
    )
    for (const k of Object.keys(owner)) delete owner[k]
    for (const [k, v] of entries) owner[k] = v
  }
}

// Та сама форма, що читає `extractMovementBlocks`: маркер — з початку рядка.
const MARKER = /^(-- @movements\s+)(?:([^\s.]+)\.)?(\S+)/

/**
 * Переписує ім'я в маркерах рядків `lines` (1-базні), зберігаючи
 * кваліфікацію `<Kind>.`; решта тексту `.sql` лишається побайтно та сама.
 */
export function renameMarkers(
  text: string,
  lines: readonly number[],
  newName: string
): string {
  const rows = text.split("\n")
  for (const line of lines) {
    rows[line - 1] = rows[line - 1]!.replace(
      MARKER,
      (_, head: string, kind: string | undefined) =>
        `${head}${kind === undefined ? "" : `${kind}.`}${newName}`
    )
  }
  return rows.join("\n")
}

/**
 * Сусідні чи перекриті вирізи зливаються: виріз першого оператора рядка
 * забирає пробіли до наступного, а виріз останнього — пробіли перед собою,
 * тож двоє класифікованих поруч діляться пробілами. Об'єднання вирізів —
 * той самий виріз; заміни не зливаються ніколи. Злитий виріз, що дійшов до
 * кінця рядка, забирає й пробіли перед собою, а якщо спорожнив рядок — і сам
 * рядок, як виріз одиниці, що займала його сама.
 */
export function mergeDeletions(
  text: string,
  list: readonly TextEdit[]
): TextEdit[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: { edit: TextEdit; joined: boolean }[] = []
  for (const e of sorted) {
    const last = merged.at(-1)
    if (
      last !== undefined &&
      last.edit.text === "" &&
      e.text === "" &&
      e.start <= last.edit.end
    ) {
      last.edit = { ...last.edit, end: Math.max(last.edit.end, e.end) }
      last.joined = true
    } else {
      merged.push({ edit: e, joined: false })
    }
  }
  return merged.map(({ edit, joined }) =>
    joined ? lineAware(text, edit) : edit
  )
}

function lineAware(text: string, edit: TextEdit): TextEdit {
  const blank = (c: string | undefined) => c === " " || c === "\t"
  let end = edit.end
  while (blank(text[end])) end++
  const crlf = text[end] === "\r" && text[end + 1] === "\n"
  if (end < text.length && text[end] !== "\n" && !crlf) return edit
  let start = edit.start
  while (start > 0 && blank(text[start - 1])) start--
  // Перед вирізом лишився інший оператор: кінець рядка лишається.
  if (start > 0 && text[start - 1] !== "\n") return { ...edit, start, end }
  end = Math.min(text.length, end + (crlf ? 2 : 1))
  let next = end
  while (blank(text[next]) || text[next] === "\r") next++
  return { ...edit, start, end: text[next] === "\n" ? next + 1 : end }
}

/**
 * Виріз одиниці `[start, end)` разом із завершальним `;`. Одиниця, що
 * займає рядок сама, забирає й перевід рядка та один порожній рядок після.
 * Поруч з іншим оператором у рядку — лише власний текст: перед наступним
 * оператором вирізаються пробіли після `;`, а за останнім у рядку — пробіли
 * перед одиницею, і перевід рядка лишається.
 */
export function cut(text: string, start: number, end: number): TextEdit {
  const blank = (i: number) => {
    while (text[i] === " " || text[i] === "\t" || text[i] === "\r") i++
    return i
  }
  let i = blank(end)
  if (text[i] === ";") i = blank(i + 1)
  const lineEnds = i >= text.length || text[i] === "\n"
  let lineStart = start
  while (
    lineStart > 0 &&
    (text[lineStart - 1] === " " || text[lineStart - 1] === "\t")
  ) {
    lineStart--
  }
  const ownLine = lineStart === 0 || text[lineStart - 1] === "\n"
  if (!lineEnds) return { start, end: i, text: "" }
  if (!ownLine) {
    // Кінець рядка лишається: інакше наступний рядок піднявся б до попереднього оператора.
    let to = i
    while (to > end && /[ \t\r]/.test(text[to - 1]!)) to--
    return { start: lineStart, end: to, text: "" }
  }
  i = i < text.length ? i + 1 : i
  const next = blank(i)
  return {
    start: lineStart,
    end: text[next] === "\n" ? next + 1 : i,
    text: "",
  }
}
