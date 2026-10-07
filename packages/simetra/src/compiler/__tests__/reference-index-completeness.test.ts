import { describe, expect, it } from "vitest"
import { compile, type ResolvedReference } from "simetra/compiler"
import { parseExpression, walkExpr } from "simetra/model"
import { readReferenceDomain } from "./fixtures/reference-domain"
import { kitchenSink } from "./fixtures/kitchen-sink"

/**
 * Охоронець повноти індексу посилань. Каскад перейменування й перевірка
 * залежностей видалення бачать лише те, що є в індексі, тож кожне посилання
 * за логічним іменем у файлах мусить мати запис. Тест навмисно не знає ролей
 * і не читає реєстр видів: кандидатів він знаходить сам, за формою місця, і
 * лише потім звіряє з індексом. Нове поле, що називає елемент за іменем, а в
 * індекс не потрапило, тут червоніє.
 */

/** Місце кандидата; форма — як його переписуватиме каскад. */
interface Candidate {
  file: string
  pointer: string
  name: string
  form: "value" | "key" | "token" | "marker"
  span?: { start: number; end: number }
  line?: number
}

type Path = readonly (string | number)[]

function toPointer(path: Path): string {
  return path
    .map((s) => `/${String(s).replace(/~/g, "~0").replace(/\//g, "~1")}`)
    .join("")
}

/**
 * Місця, чиї рядки можуть збігтися з логічним іменем, але посиланням не є.
 * Кожен запис — з причиною: allowlist не має ставати смітником для пропусків.
 */
const NOT_REFERENCES: { matches: (path: Path) => boolean; reason: string }[] = [
  {
    matches: (path) => path.at(-1) === "physicalName",
    reason:
      "фізичне ім'я призначається раз і не змінюється при перейменуванні (Р5); збіг зі snake_case логічного імені — не посилання",
  },
  {
    matches: (path) => path.at(-1) === "kindLabel",
    reason:
      "мітка виду призначається раз і не змінюється при перейменуванні; збіг зі snake_case логічного імені — не посилання",
  },
  {
    matches: (path) => path.includes("external"),
    reason:
      "`external` (корінь виду скоупу, FK прийнятої таблиці) називає колонки таблиці поза метаданими: модель їх не перейменовує",
  },
  {
    matches: (path) => path.at(-1) === "comment",
    reason:
      "`comment` прийнятої таблиці й колонки — вільний текст `COMMENT ON`, як title/description",
  },
]
/** Поля з виразами конструктора: їх розбирає парсер T0, а не порівняння рядка. */
const EXPRESSION_FIELDS = new Set(["condition", "movementType", "period"])
/** Літерали виду руху — не вираз (схема документа). */
const MOVEMENT_TYPE_LITERALS = new Set(["Receipt", "Expense"])
/** Поля, чиї ключі — імена полів цілі (форма «ключ об'єкта»). */
const KEYED_BY_NAME = new Set(["fields"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isMetadataRef = (value: Record<string, unknown>) =>
  Object.keys(value).length === 2 &&
  typeof value.kind === "string" &&
  typeof value.name === "string"

/** Логічні імена іменованих елементів: усе, що має UUID `id` і `name`. */
function logicalNames(files: ReadonlyMap<string, unknown>): {
  all: Set<string>
  predefined: Set<string>
} {
  const all = new Set<string>()
  const predefined = new Set<string>()
  const walk = (value: unknown, parentKey: string | number | undefined) => {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, parentKey))
      return
    }
    if (!isRecord(value)) return
    if (typeof value.id === "string" && typeof value.name === "string") {
      all.add(value.name)
      if (parentKey === "predefinedItems") predefined.add(value.name)
    }
    for (const [key, child] of Object.entries(value)) walk(child, key)
  }
  for (const data of files.values()) walk(data, undefined)
  return { all, predefined }
}

function expressionCandidates(
  file: string,
  pointer: string,
  text: string
): Candidate[] {
  const parsed = parseExpression(text)
  if (!parsed.ok) throw new Error(`unparsable fixture expression ${text}`)
  const found: Candidate[] = []
  const token = (span: { start: number; end: number }) =>
    found.push({
      file,
      pointer,
      name: text.slice(span.start, span.end),
      form: "token",
      span: { start: span.start, end: span.end },
    })
  walkExpr(parsed.expr, (node) => {
    if (node.type === "field") token(node.fieldSpan)
    if (node.type === "sum") {
      token(node.sectionSpan)
      token(node.fieldSpan)
    }
    if (node.type === "count") token(node.sectionSpan)
  })
  return found
}

/**
 * Кандидати чотирьох форм. Рядкові листи й ключі — лише ті, що дорівнюють
 * логічному імені; токени виразів і маркери — завжди, бо вони посилання за
 * побудовою.
 */
function candidates(files: ReadonlyMap<string, string>): Candidate[] {
  const parsed = new Map(
    [...files]
      .filter(([path]) => path.endsWith(".meta.json"))
      .map(([path, text]) => [path, JSON.parse(text) as unknown])
  )
  const { all } = logicalNames(parsed)
  const found: Candidate[] = []

  for (const [file, data] of parsed) {
    const walk = (value: unknown, path: Path) => {
      const key = path.at(-1)
      if (typeof value === "string") {
        if (typeof key === "string" && EXPRESSION_FIELDS.has(key)) {
          if (key === "movementType" && MOVEMENT_TYPE_LITERALS.has(value))
            return
          found.push(...expressionCandidates(file, toPointer(path), value))
          return
        }
        if (path.at(-2) === "fields" && path.includes("movements")) {
          found.push(...expressionCandidates(file, toPointer(path), value))
          return
        }
        if (!all.has(value)) return
        if (NOT_REFERENCES.some((entry) => entry.matches(path))) return
        found.push({
          file,
          pointer: toPointer(path),
          name: value,
          form: "value",
        })
        return
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, [...path, index]))
        return
      }
      if (!isRecord(value)) return
      // MetadataRef — одне місце (об'єкт `{ kind, name }`), а не два рядки.
      if (isMetadataRef(value)) {
        found.push({
          file,
          pointer: toPointer(path),
          name: value.name as string,
          form: "value",
        })
        return
      }
      for (const [childKey, child] of Object.entries(value)) {
        // Власне ім'я елемента — не посилання; title/description — текст.
        if (childKey === "name" && typeof value.id === "string") continue
        if (childKey === "title" || childKey === "description") continue
        if (
          typeof key === "string" &&
          KEYED_BY_NAME.has(key) &&
          path.includes("movements")
        ) {
          found.push({
            file,
            pointer: toPointer([...path, childKey]),
            name: childKey,
            form: "key",
          })
        }
        walk(child, [...path, childKey])
      }
    }
    walk(data, [])
  }

  const marker = /^--\s*@movements\s+(\S+)\s*$/
  for (const [file, text] of files) {
    if (!file.endsWith(".sql")) continue
    text.split(/\r?\n/).forEach((raw, index) => {
      const match = marker.exec(raw.trimEnd())
      if (match !== null) {
        found.push({
          file,
          pointer: "",
          name: match[1]!,
          form: "marker",
          line: index + 1,
        })
      }
    })
  }
  return found
}

/** Кандидати без запису індексу з тим самим файлом, pointer і формою місця. */
function missing(
  files: ReadonlyMap<string, string>,
  references: readonly ResolvedReference[]
): Candidate[] {
  const placeOf = (r: ResolvedReference) =>
    r.span !== undefined
      ? `token:${r.span.start}:${r.span.end}`
      : r.line !== undefined
        ? `marker:${r.line}`
        : "whole"
  const indexed = new Set(
    references.map((r) => `${r.from.file}\0${r.from.pointer}\0${placeOf(r)}`)
  )
  const placeOfCandidate = (c: Candidate) =>
    c.form === "token"
      ? `token:${c.span!.start}:${c.span!.end}`
      : c.form === "marker"
        ? `marker:${c.line}`
        : "whole"
  return candidates(files).filter(
    (c) => !indexed.has(`${c.file}\0${c.pointer}\0${placeOfCandidate(c)}`)
  )
}

const FIXTURES: [string, () => Map<string, string>][] = [
  ["reference domain", readReferenceDomain],
  ["kitchen sink", kitchenSink],
]

describe("reference index completeness", () => {
  it.each(FIXTURES)("%s: every name reference is indexed", async (_, load) => {
    const files = load()
    const result = await compile(files)
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(candidates(files).length).toBeGreaterThan(0)
    expect(missing(files, result.model!.references)).toEqual([])
  })

  it.each(FIXTURES)(
    "%s: nobody references predefined items by logical name",
    (_, load) => {
      // Ролі для предвизначених немає: якщо хтось почне називати їх у файлах,
      // таке посилання мусить піти в індекс, і цей тест про це нагадає.
      const files = load()
      const parsed = new Map(
        [...files]
          .filter(([path]) => path.endsWith(".meta.json"))
          .map(([path, text]) => [path, JSON.parse(text) as unknown])
      )
      const { predefined } = logicalNames(parsed)
      expect(
        candidates(files).filter(
          (c) => c.form !== "token" && predefined.has(c.name)
        )
      ).toEqual([])
    }
  )

  it("fixtures exercise every place form", () => {
    // Без кандидата якоїсь форми охоронець для неї нічого б не доводив.
    const forms = new Set(
      FIXTURES.flatMap(([, load]) => candidates(load()).map((c) => c.form))
    )
    expect([...forms].sort()).toEqual(["key", "marker", "token", "value"])
  })

  it("the guard sees a dropped enumeration default", async () => {
    const files = readReferenceDomain()
    const result = await compile(files)
    const without = result.model!.references.filter(
      (r) => !r.from.pointer.endsWith("/defaultValue")
    )
    expect(missing(files, without)).toEqual([
      expect.objectContaining({
        pointer: expect.stringMatching(/\/defaultValue$/),
        form: "value",
      }),
    ])
  })

  it("the guard sees a dropped expression token", async () => {
    const files = kitchenSink()
    const result = await compile(files)
    const dropped = result.model!.references.find((r) => r.span !== undefined)!
    const without = result.model!.references.filter((r) => r !== dropped)
    expect(missing(files, without)).toEqual([
      expect.objectContaining({
        file: dropped.from.file,
        pointer: dropped.from.pointer,
        span: dropped.span,
        form: "token",
      }),
    ])
  })
})
