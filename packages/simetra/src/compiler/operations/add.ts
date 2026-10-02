import { namedCollections } from "simetra/model"
import { diagnostic } from "../diagnostics"
import { completeAndCompile, type CompletionOptions } from "./fix"
import type { AddElementInput } from "./inputs"
import { compileInput, refused } from "./refuse"
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
  const clean = await compileInput(files)
  if (!clean.ok) return clean.result

  const container = locateContainer(clean.model, files, input.target)
  if (!container.ok) return refused([container.diagnostic])

  const collections = [...namedCollections(container.schema).keys()]
  if (!collections.includes(input.collection)) {
    return refused([
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

  const after = new Map(files)
  after.set(container.file, JSON.stringify(raw))
  return completeAndCompile(files, after, o, new Set([container.file]))
}
