import { namedCollections } from "simetra/model"
import { diagnostic } from "../diagnostics"
import { completeAndCompile, type CompletionOptions } from "./fix"
import type { AddElementInput } from "./inputs"
import { toPlatformForms } from "./platform-forms"
import { compileInput, refused, refuseSuppliedId } from "./refuse"
import { describeTarget, locateContainer } from "./target"
import type { OperationResult } from "./types"

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Вузол за JSON Pointer, який щойно дала адресація (сегменти без `~`). */
function nodeAt(root: Json, pointer: string): Json | undefined {
  let current: unknown = root
  for (const segment of pointer.split("/").slice(1)) {
    current = Array.isArray(current)
      ? current[Number(segment)]
      : isRecord(current)
        ? current[segment]
        : undefined
  }
  return isRecord(current) ? current : undefined
}

/**
 * Додає іменований елемент у колекцію контейнера (спека П2 §8.6): реквізит
 * об'єкта чи ТЧ, ТЧ, вимір, ресурс, значення, предвизначений елемент,
 * колонку, вид скоупу. Колекції — ключі масивів іменованих елементів у схемі
 * контейнера, тож нова колекція схеми стає доступною без змін тут.
 */
export async function addElement(
  files: ReadonlyMap<string, string>,
  input: AddElementInput,
  o: CompletionOptions
): Promise<OperationResult> {
  const supplied = refuseSuppliedId(files, input.element, "element")
  if (supplied !== undefined) return supplied
  // Режим `repair` (спека декларацій функцій §5.1): тека після зворотної
  // генерації з помилками лише класу ремонту доходить до 0 помилок саме
  // мутаціями, тож вхід з ними приймається, а хвіст не дає додати нову.
  const clean = await compileInput(files, { repair: true })
  if (!clean.ok) return clean.result

  const container = locateContainer(clean.model, files, input.target)
  if (!container.ok) return refused(files, [container.diagnostic])

  // `scopes` пишуть межу тенанта чужих файлів, тож лише для виду скоупу
  // проєкту (Р2) і лише для таблиць без оголошеного скоупу (Р3): зміна
  // наявного скоупу — інша операція, а мовчки переписати межу мутація не може.
  const scopes = Object.entries(input.scopes ?? {})
  // Імена об'єктів унікальні лише в межах виду, тож шукаємо за видом і ім'ям.
  const tables = new Map<string, { file: string }>()
  if (input.scopes !== undefined) {
    // Не `refusal(`: це причина параметра діагностики, а не відмова T3
    // (`core-error-source.test.ts` стереже саме літерали відмов T3).
    const scopesRefused = (scopes: string, table?: string) =>
      refused(files, [
        diagnostic("operation.input-invalid", "", "", {
          scopes,
          at: table === undefined ? "/scopes" : `/scopes/${table}`,
          table: table ?? "",
        }),
      ])
    if (input.target.kind !== "Project" || input.collection !== "scopeKinds") {
      return scopesRefused("target")
    }
    for (const [table] of scopes) {
      const object = clean.model.objects.find(
        (o) => o.kind === "CustomTable" && o.name === table
      )
      if (object === undefined) return scopesRefused("table-unknown", table)
      tables.set(table, object)
      const raw = JSON.parse(files.get(object.file)!) as Json
      if (raw.scope !== undefined) return scopesRefused("table-scoped", table)
    }
  }

  const collections = [...namedCollections(container.schema).keys()]
  if (!collections.includes(input.collection)) {
    return refused(files, [
      diagnostic(
        "operation.collection-unknown",
        container.file,
        container.pointer,
        {
          collection: input.collection,
          target: describeTarget(input.target),
          collections: collections.join(", ") || "none",
        }
      ),
    ])
  }

  // Чиста компіляція гарантує, що файл розбирається, а pointer веде до
  // об'єкта, — адресація щойно пройшла саме цим JSON.
  const raw = JSON.parse(files.get(container.file)!) as Json
  const owner = nodeAt(raw, container.pointer)!
  const items = owner[input.collection]
  const element = structuredClone(input.element)
  if (Array.isArray(items)) items.push(element)
  else owner[input.collection] = [element]

  const changed = new Map(files)
  changed.set(container.file, JSON.stringify(raw))
  // Файли названих таблиць пишуться тим самим канонічним записом, що й
  // проєкт, і входять в `only`: інакше хвіст доповнення їх не бачить.
  const only = new Set([container.file])
  for (const [table, declaration] of scopes) {
    const object = tables.get(table)!
    const tableRaw = JSON.parse(files.get(object.file)!) as Json
    tableRaw.scope = declaration.scope
    if (declaration.scopeColumn !== undefined) {
      tableRaw.scopeColumn = declaration.scopeColumn
    }
    changed.set(object.file, JSON.stringify(tableRaw))
    only.add(object.file)
  }
  // Новий елемент може зробити задекларовану функцію формою платформи
  // (вид скоупу з `setFunction`, вимір з функцією значень): декларація
  // зникає в тій самій зміні (Р12).
  const after = toPlatformForms(changed)
  return completeAndCompile(
    files,
    after.files,
    o,
    only,
    clean.accepted,
    after.diagnostics
  )
}
