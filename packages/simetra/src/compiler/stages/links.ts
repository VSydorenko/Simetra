import {
  KIND_REGISTRY,
  type MetadataRef,
  type MovementDecl,
} from "simetra/model"
import { diagnostic, toPointer, type Diagnostic } from "../diagnostics"
import { objectKey, type ParsedObject } from "./files"
import type { ResolvedReference } from "./identity"

/**
 * Стадія 5 (спека П2 §8.2): зв'язки між частинами моделі, які не видно в
 * одному файлі. У C2 це повнота джерел рухів; модулі поведінки й функції
 * множини додає наступний план у цей самий вхід.
 */
export function checkLinks(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[]
): Diagnostic[] {
  return checkMovementSources(objects, references)
}

/**
 * Кожен оголошений регістр документа має рівно одне джерело рухів: рухи
 * конструктора або один блок запиту. Два джерела чи блок для неоголошеного
 * регістра — помилка, а не тихий вибір одного: інакше обгортка проведення
 * писала б не те, що прочитає автор.
 */
function checkMovementSources(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[]
): Diagnostic[] {
  const found: Diagnostic[] = []
  const byKey = new Map(objects.map((o) => [objectKey(o.kind, o.name), o]))
  const blocksByDocument = new Map<string, ResolvedReference[]>()
  for (const reference of references) {
    if (reference.role !== "posting.movementsBlock") continue
    const list = blocksByDocument.get(reference.from.objectId) ?? []
    list.push(reference)
    blocksByDocument.set(reference.from.objectId, list)
  }

  for (const object of objects) {
    const data = object.data as {
      registerMovements?: MetadataRef[]
      posting?: { movements: MovementDecl[] }
    }
    const blocks = blocksByDocument.get(object.id ?? "") ?? []
    const declaredIds = new Set<string>()

    ;(data.registerMovements ?? []).forEach((ref, index) => {
      const register = byKey.get(objectKey(ref.kind, ref.name))
      // Не регістр чи неіснуючий — це вже помилка стадій 2 і 4.
      if (register === undefined) return
      if (KIND_REGISTRY[register.kind].registerKeys === undefined) return
      if (register.id !== undefined) declaredIds.add(register.id)

      const constructorCount = (data.posting?.movements ?? []).filter(
        (m) =>
          objectKey(m.register.kind, m.register.name) ===
          objectKey(ref.kind, ref.name)
      ).length
      const blockCount = blocks.filter((b) => b.to.id === register.id).length
      const pointer = toPointer(["registerMovements", index])
      if (constructorCount + blockCount === 0) {
        found.push(
          diagnostic("posting.source-missing", object.file, pointer, {
            name: register.name,
          })
        )
      } else if (blockCount > 1 || (blockCount === 1 && constructorCount > 0)) {
        found.push(
          diagnostic("posting.source-ambiguous", object.file, pointer, {
            name: register.name,
            sources:
              constructorCount > 0
                ? "constructor movements and a query block"
                : "several query blocks",
          })
        )
      }
    })

    for (const block of blocks) {
      if (declaredIds.has(block.to.id)) continue
      const target = objects.find((o) => o.id === block.to.id)
      found.push(
        diagnostic(
          "posting.register-undeclared",
          block.from.file,
          block.from.pointer,
          {
            name: target?.name ?? "",
            line: block.line ?? 0,
          }
        )
      )
    }
  }
  return found
}
