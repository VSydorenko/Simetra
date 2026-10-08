import { kindByDir, type KindDefinition } from "simetra/model"
import { compareStrings } from "./diagnostics"

/**
 * Обхід сирого JSON файлів об'єктів за реєстром видів. Спільний для
 * доповнення (`fix`) і перевірки полів, призначених раз: обидва мають
 * бачити той самий набір іменованих елементів, інакше елемент, якому `fix`
 * дав ім'я, випав би з перевірки.
 */

const META_SUFFIX = ".meta.json"

export type Json = Record<string, unknown>

export const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export interface Located {
  pointer: string
  element: Json
}

export interface ObjectFile {
  path: string
  raw: Json
  def: KindDefinition
  /**
   * Вихід схеми виду, коли файл її проходить: стандартні колонки, ключі
   * регістра й похідні функції реєстр рахує з розібраних даних. Немає —
   * файл зламаний, і доповнення працює без цих знань (запису все одно не
   * буде: компіляція результату дасть помилку).
   */
  data?: unknown
}

/** Елементи масиву-поля, що є об'єктами, з їхніми pointer. */
export function elementsAt(owner: Json, field: string, base = ""): Located[] {
  const value = owner[field]
  if (!Array.isArray(value)) return []
  return value.flatMap((element: unknown, index) =>
    isRecord(element) ? [{ pointer: `${base}/${field}/${index}`, element }] : []
  )
}

/** Табличні частини — лише у виду, якому реєстр їх дозволяє. */
export function sectionsOf(file: ObjectFile): Located[] {
  return file.def.tabularSectionColumns === undefined
    ? []
    : elementsAt(file.raw, "tabularSections")
}

/** Елементи з мітками замість колонок: значення й предвизначені елементи. */
export function labelGroupsOf(file: ObjectFile): Located[][] {
  const fields = [
    ...(file.def.valueElements ? ["values"] : []),
    ...(file.def.namedElementFields ?? []),
  ]
  return fields.map((field) => elementsAt(file.raw, field))
}

/**
 * Кожен іменований елемент файлу (спека П2 §3) — за полями реєстру видів, а
 * не за переліком видів: новий вид приходить зі своїм записом.
 */
export function namedElementsOf(file: ObjectFile): Located[] {
  return [
    { pointer: "", element: file.raw },
    ...file.def.columnFields.flatMap((field) => elementsAt(file.raw, field)),
    ...sectionsOf(file).flatMap((section) => [
      section,
      ...elementsAt(section.element, "attributes", section.pointer),
    ]),
    ...labelGroupsOf(file).flat(),
  ]
}

export function parseJson(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Файли об'єктів, які розуміють читачі сирого JSON: шлях
 * `<тека виду>/<Ім'я>/<Ім'я>.meta.json`, JSON-об'єкт і `kind` виду теки.
 * Решту (зламаний JSON, чужий вид) пропускаємо — причину назве стадія 1
 * компіляції.
 */
export function readObjectFiles(
  files: ReadonlyMap<string, string>
): ObjectFile[] {
  const result: ObjectFile[] = []
  for (const path of [...files.keys()].sort(compareStrings)) {
    const segments = path.split("/")
    if (segments.length !== 3 || !segments[2]!.endsWith(META_SUFFIX)) continue
    const def = kindByDir(segments[0]!)
    const raw = parseJson(files.get(path)!)
    if (def === undefined || raw === undefined || raw.kind !== def.kind) {
      continue
    }
    const parsed = def.schema.safeParse(raw)
    result.push({
      path,
      raw,
      def,
      ...(parsed.success ? { data: parsed.data } : {}),
    })
  }
  return result
}
