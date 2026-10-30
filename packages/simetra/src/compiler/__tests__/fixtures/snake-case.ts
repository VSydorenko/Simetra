import {
  KIND_REGISTRY,
  toSnakeCase,
  type MetadataKind,
  type StandardColumnDef,
} from "simetra/model"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const PROJECT_FILE = "project.meta.json"

/**
 * Близнюк фікстури в стилі `snake_case`: той самий проєкт, лише логічні імена
 * реквізитів, ТЧ, колонок `CustomTable` і стандартних реквізитів — у
 * `snake_case`, і кожне посилання на них теж. Фізичні імена не змінюються
 * (`physicalName` призначається один раз), тож SQL обох стилів має бути
 * однаковим — це й перевіряє тест рівності. Імена об'єктів, дій і ролей
 * лишаються: вони не логічні імена реквізитів. Повноту перейменування судить
 * компілятор: пропущене посилання дає діагностику, тож тест вимагає
 * `diagnostics: []`. Файли не-JSON (`.sql`) — без змін.
 */
export function snakeCaseTwin(
  files: ReadonlyMap<string, string>
): Map<string, string> {
  const parsed = new Map<string, Json>()
  for (const [path, text] of files)
    if (path.endsWith(".json") && path !== "sql-debt.json")
      parsed.set(path, JSON.parse(text) as Json)
  const renames = new Map<string, string>()
  // Імена, які перейменовувати не можна: збіг з реквізитом зробив би
  // перейменування неоднозначним, і близнюк тихо зламав би не те.
  const kept = new Set<string>()
  const rename = (name: unknown) => {
    if (typeof name !== "string") return
    const snake = toSnakeCase(name)
    if (snake !== name) renames.set(name, snake)
  }
  for (const data of parsed.values()) {
    if (!isObject(data)) continue
    const kind = data.kind
    if (typeof kind !== "string" || !(kind in KIND_REGISTRY)) continue
    const def = KIND_REGISTRY[kind as MetadataKind]
    if (typeof data.name === "string") kept.add(data.name)
    for (const action of arrayOf(data.customActions))
      if (isObject(action)) kept.add(String(action.name))
    for (const field of def.columnFields)
      for (const element of arrayOf(data[field]))
        if (isObject(element)) rename(element.name)
    for (const section of arrayOf(data.tabularSections)) {
      if (!isObject(section)) continue
      rename(section.name)
      for (const element of arrayOf(section.attributes))
        if (isObject(element)) rename(element.name)
    }
    // Стандартні реквізити — з реєстру за розібраним файлом, не списком імен.
    const obj = def.schema.safeParse(data)
    if (!obj.success) continue
    const standard: StandardColumnDef[] = [
      ...def.standardColumns(obj.data),
      ...(def.tabularSectionColumns?.(obj.data) ?? []),
      ...(def.standardTabularSections?.(obj.data) ?? []).flatMap((s) =>
        s.columns()
      ),
    ]
    for (const column of standard) rename(column.logicalName)
  }
  for (const name of kept) {
    if (renames.has(name))
      throw new Error(`snakeCaseTwin: ${name} is both an element and a name`)
  }
  const twin = new Map(files)
  for (const [path, data] of parsed) {
    let out = renameValues(data, renames)
    if (path === PROJECT_FILE && isObject(out))
      out = { ...out, naming: { attributeCase: "snake_case" } }
    twin.set(path, JSON.stringify(out))
  }
  return twin
}

/** Кожне рядкове значення (не ключ) з переліку — і сегменти шляху через крапку. */
function renameValues(value: Json, renames: ReadonlyMap<string, string>): Json {
  if (typeof value === "string")
    return value
      .split(".")
      .map((segment) => renames.get(segment) ?? segment)
      .join(".")
  if (Array.isArray(value)) return value.map((v) => renameValues(v, renames))
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renameValues(v, renames)])
    )
  return value
}

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
