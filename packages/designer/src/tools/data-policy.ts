import type { CompiledModel, SourceObject } from "simetra/compiler"
import {
  type Batch,
  type CommandError,
  type MetadataRef,
  type RuntimeCatalog,
} from "simetra/model"

/**
 * Чиста відмова модуля до першого з'єднання: designer модулів не завантажує,
 * тож хуки об'єкта мовчки не спрацювали б. Перевіряється весь пакет (він —
 * одна транзакція: дозволена перша фаза не робить дозволеною решту) і першою,
 * до запобіжника запису прав каталогу T3 (`agentWriteRefusal`), який лишається
 * власністю T3. Невідомий об'єкт пропускається — його відхилить схема
 * каталогу T3 (`command.invalid`), і політика не дублює її текст.
 */
export function dataModuleRefusal(
  model: CompiledModel,
  catalog: RuntimeCatalog,
  batch: Batch
): CommandError | undefined {
  const hasModule = (x: SourceObject) =>
    model.moduleFiles.some((m) => m.ownerObjectId === x.id)
  const moduleRefusal = (object: MetadataRef): CommandError => ({
    code: "command.invalid",
    reason: "object-module",
    object,
  })
  for (const op of batch) {
    const object = model.objects.find(
      (x) => x.kind === op.object.kind && x.name === op.object.name
    )
    if (object === undefined) continue
    if (hasModule(object)) return moduleRefusal(op.object)
    // Ядро кореня з творцем (`rootCreator`) вставляє й рядок членства творця:
    // хуки довідника членства без модуля так само не спрацювали б. Довідник
    // називає `create` об'єкта в каталозі рантайму (спека П4 §6.14)
    const membershipId =
      op.action === "create"
        ? catalog.objects.find((x) => x.id === object.id)?.operations?.create
            ?.root?.membership
        : undefined
    const membership =
      membershipId === undefined
        ? undefined
        : model.objects.find((x) => x.id === membershipId)
    if (membership !== undefined && hasModule(membership))
      return moduleRefusal({ kind: membership.kind, name: membership.name })
  }
  return undefined
}
