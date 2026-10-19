import { compareStrings } from "../diagnostics"
import type { FileChange } from "./types"

/**
 * Мапа файлів після змін — те, що побачить компілятор і що запише обгортка.
 * Вхід не змінюється: операція й обгортка можуть тримати обидва стани.
 */
export function applyChanges(
  files: ReadonlyMap<string, string>,
  changes: readonly FileChange[]
): Map<string, string> {
  const result = new Map(files)
  for (const change of changes) {
    if (change.content === null) result.delete(change.path)
    else result.set(change.path, change.content)
  }
  return result
}

/**
 * Зміни між двома станами мапи: лише файли, текст яких інший, за шляхом —
 * так повторний прогін без різниці дає порожній перелік.
 */
export function changesBetween(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): FileChange[] {
  const changes: FileChange[] = []
  for (const [path, content] of after) {
    if (before.get(path) !== content) changes.push({ path, content })
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ path, content: null })
  }
  return changes.sort((a, b) => compareStrings(a.path, b.path))
}
