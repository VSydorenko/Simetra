import type { CompiledModel, SourceObject } from "simetra/compiler"
import {
  KIND_REGISTRY,
  type Batch,
  type CommandError,
  type MetadataRef,
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
 * Корінь виду скоупу, творець якого отримує роль (`rootCreator`): його
 * `create` змінює права так само, як запис довідника призначень (межа з A6,
 * спека П4 §6.14).
 */
function createsRightsOnCreate(
  model: CompiledModel,
  object: SourceObject
): boolean {
  return model.scopeKinds.some(
    (kind) =>
      "objectId" in kind.root &&
      kind.root.objectId === object.id &&
      model.contracts.roles.some(
        (r) =>
          r.rootCreator &&
          r.assignedOn.level === "scope" &&
          r.assignedOn.scopeKindId === kind.id
      )
  )
}

/**
 * Чиста політика пакета `data-command` до першого з'єднання: база не
 * бачить запиту, якому відмовлено. Перевіряється кожна фаза пакета, бо
 * пакет — одна транзакція: дозволена перша фаза не робить дозволеною решту.
 * Невідомий об'єкт пропускається — його відхилить схема каталогу T3
 * (`command.invalid`), і політика не дублює її текст.
 */
export function dataCommandRefusal(
  model: CompiledModel,
  batch: Batch,
  o: { allowRightsWrite: boolean }
): DataPolicyRefusal | undefined {
  for (const op of batch) {
    const object = model.objects.find(
      (x) => x.kind === op.object.kind && x.name === op.object.name
    )
    if (object === undefined) continue
    // Модуль — першим: designer модулів не завантажує, тож без них хуки
    // об'єкта мовчки не спрацювали б, і прапорець прав цього не змінює
    if (model.moduleFiles.some((m) => m.ownerObjectId === object.id))
      return {
        kind: "command",
        error: {
          code: "command.invalid",
          reason: "object-module",
          object: op.object,
        },
      }
    if (o.allowRightsWrite) continue
    // Гілка за видом — з реєстру видів, не за іменем виду (AGENTS.md)
    if (KIND_REGISTRY[object.kind].rightsSystem?.(object.data) !== undefined)
      return { kind: "rights", object: op.object }
    if (op.action === "create" && createsRightsOnCreate(model, object))
      return { kind: "rights", object: op.object }
  }
  return undefined
}
