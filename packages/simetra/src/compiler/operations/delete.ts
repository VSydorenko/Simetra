import { formatMetaFile, formatProjectFile } from "simetra/model"
import { diagnostic } from "../diagnostics"
import { PROJECT_FILE } from "../stages/files"
import type { DeleteInput } from "./inputs"
import { compileInput, compileResult, refused } from "./refuse"
import { describeTarget, objectFiles, resolveTarget } from "./target"
import type { OperationResult } from "./types"

type Json = Record<string, unknown>

/** Усі `id` піддерева цілі: посилання на вкладений елемент теж блокує видалення. */
function collectIds(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectIds(item, into)
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "id" && typeof value === "string") into.add(value)
      else collectIds(value, into)
    }
  }
  return into
}

/**
 * Чи лежить місце посилання в піддереві елемента-цілі: той самий файл і
 * pointer цілі або під ним. Префікс із кінцевим `/`, щоб `/items/1` не
 * вважав своїм `/items/10`.
 */
export function isInsideElement(
  target: { file: string; pointer: string },
  from: { file: string; pointer: string }
): boolean {
  return (
    from.file === target.file &&
    (from.pointer === target.pointer ||
      from.pointer.startsWith(`${target.pointer}/`))
  )
}

/**
 * Видаляє об'єкт (усі його файли) чи вкладений іменований елемент (спека П2
 * §8.6). Посилання з-поза піддерева цілі блокують видалення: по діагностиці
 * на кожне місце. Посилання зсередини піддерева (конструктор документа на
 * власні секції) не блокують — вони зникають разом із ціллю.
 */
export async function deleteElement(
  files: ReadonlyMap<string, string>,
  input: DeleteInput
): Promise<OperationResult> {
  const clean = await compileInput(files)
  if (!clean.ok) return clean.result
  const { model } = clean

  const target = resolveTarget(model, files, input.target)
  if (!target.ok) return refused([target.diagnostic])

  const object = model.objects.find((o) => o.id === target.id)
  const raw = JSON.parse(files.get(target.file)!) as Json
  let node: unknown = raw
  const segments = target.pointer.split("/").slice(1)
  for (const segment of segments) node = (node as Json)[segment]
  const ids = collectIds(node, new Set())

  // `object !== undefined` — ознака, що ціль є об'єктом (усі його файли —
  // піддерево); інакше ціль — вкладений елемент.
  const isOutside = (from: {
    objectId: string
    file: string
    pointer: string
  }) =>
    object !== undefined
      ? from.objectId !== object.id
      : !isInsideElement(target, from)

  const blockers = model.references.filter(
    (ref) => ids.has(ref.to.id) && isOutside(ref.from)
  )
  if (blockers.length > 0) {
    return refused(
      blockers.map((ref) =>
        diagnostic(
          "operation.delete-referenced",
          ref.from.file,
          ref.from.pointer,
          { target: describeTarget(input.target), role: ref.role }
        )
      )
    )
  }

  const after = new Map(files)
  if (object !== undefined) {
    for (const path of objectFiles(files, object)) after.delete(path)
  } else {
    // Ціль-елемент: pointer завершується `/колекція/індекс`.
    const index = Number(segments.pop())
    let owner: unknown = raw
    for (const segment of segments) owner = (owner as Json)[segment]
    ;(owner as unknown[]).splice(index, 1)
    after.set(
      target.file,
      target.file === PROJECT_FILE
        ? formatProjectFile(raw)
        : formatMetaFile(raw)
    )
  }
  return compileResult(files, after)
}
