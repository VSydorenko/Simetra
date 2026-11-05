import type { CompiledModel, SourceObject } from "simetra/compiler"
import {
  KIND_REGISTRY,
  type Batch,
  type CommandError,
  type MetadataRef,
  type RuntimeCatalog,
} from "simetra/model"

/**
 * Відмова пакета до бази: `command` — помилка T3 у даних результату
 * (об'єкт із модулем), `rights` — запис прав без прапорця; текст підказки
 * будує `invoke`, бо лише він знає argv запуску й канал.
 */
export type DataPolicyRefusal =
  | { kind: "command"; error: CommandError }
  | { kind: "rights"; object: MetadataRef }

/**
 * Чиста політика пакета `data-command` до першого з'єднання: база не
 * бачить запиту, якому відмовлено. Перевіряється кожна фаза пакета, бо
 * пакет — одна транзакція: дозволена перша фаза не робить дозволеною решту.
 * Невідомий об'єкт пропускається — його відхилить схема каталогу T3
 * (`command.invalid`), і політика не дублює її текст.
 */
export function dataCommandRefusal(
  model: CompiledModel,
  catalog: RuntimeCatalog,
  batch: Batch,
  o: { allowRightsWrite: boolean }
): DataPolicyRefusal | undefined {
  const hasModule = (x: SourceObject) =>
    model.moduleFiles.some((m) => m.ownerObjectId === x.id)
  const moduleRefusal = (object: MetadataRef): DataPolicyRefusal => ({
    kind: "command",
    error: { code: "command.invalid", reason: "object-module", object },
  })
  for (const op of batch) {
    const object = model.objects.find(
      (x) => x.kind === op.object.kind && x.name === op.object.name
    )
    if (object === undefined) continue
    // Модуль — першим: designer модулів не завантажує, тож без них хуки
    // об'єкта мовчки не спрацювали б, і прапорець прав цього не змінює
    if (hasModule(object)) return moduleRefusal(op.object)
    // Корінь виду з творцем (`rootCreator`) — той, чий `create` у каталозі
    // рантайму називає довідник членства: ядро кореня пише членство й
    // призначення творця, тож змінює права, як запис довідника призначень
    // (спека П4 §6.14)
    const membershipId =
      op.action === "create"
        ? catalog.objects.find((x) => x.id === object.id)?.operations.create
            ?.root?.membership
        : undefined
    const membership =
      membershipId === undefined
        ? undefined
        : model.objects.find((x) => x.id === membershipId)
    // Ядро кореня вставляє й рядок членства творця: хуки довідника членства
    // без модуля так само не спрацювали б
    if (membership !== undefined && hasModule(membership))
      return moduleRefusal({ kind: membership.kind, name: membership.name })
    if (o.allowRightsWrite) continue
    // Гілка за видом — з реєстру видів, не за іменем виду (AGENTS.md)
    if (KIND_REGISTRY[object.kind].rightsSystem?.(object.data) !== undefined)
      return { kind: "rights", object: op.object }
    if (membershipId !== undefined) return { kind: "rights", object: op.object }
  }
  return undefined
}
