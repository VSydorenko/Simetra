import { isRecordKeyAt } from "simetra/model"
import type { z } from "zod"
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
 * усього, що під ним.
 */
export function renameJsonPlaces(
  root: Json,
  places: readonly Place[],
  newName: string
): void {
  const tokens = new Map<string, { start: number; end: number }[]>()
  const keys: string[] = []
  for (const place of places) {
    switch (place.form) {
      case "value": {
        const { owner, key } = slotOf(root, place.pointer)
        const node = owner[key]
        if (isRecord(node)) node.name = newName
        else owner[key] = newName
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
