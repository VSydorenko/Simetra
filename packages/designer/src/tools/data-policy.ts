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
 * `create` пише членство й призначення творця, тож змінює права так само, як
 * запис довідника призначень (спека П4 §6.14). `undefined` — не такий корінь;
 * `membership` — довідник членства виду, як його називає каталог рантайму
 * (`operations.create.root.membership`).
 */
function rootCreation(
  model: CompiledModel,
  object: SourceObject
): { membership: SourceObject | undefined } | undefined {
  const kind = model.scopeKinds.find(
    (k) => "objectId" in k.root && k.root.objectId === object.id
  )
  if (kind === undefined) return undefined
  const creator = model.contracts.roles.some(
    (r) =>
      r.rootCreator &&
      r.assignedOn.level === "scope" &&
      r.assignedOn.scopeKindId === kind.id
  )
  if (!creator) return undefined
  const membership = model.contracts.membership.find(
    (m) => m.scopeKindId === kind.id
  )
  return {
    membership: model.objects.find((o) => o.id === membership?.objectId),
  }
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
    const root =
      op.action === "create" ? rootCreation(model, object) : undefined
    // Ядро кореня вставляє й рядок членства творця: хуки довідника членства
    // без модуля так само не спрацювали б (спека П4 §6.14)
    if (root?.membership !== undefined && hasModule(root.membership))
      return moduleRefusal({
        kind: root.membership.kind,
        name: root.membership.name,
      })
    if (o.allowRightsWrite) continue
    // Гілка за видом — з реєстру видів, не за іменем виду (AGENTS.md)
    if (KIND_REGISTRY[object.kind].rightsSystem?.(object.data) !== undefined)
      return { kind: "rights", object: op.object }
    if (root !== undefined) return { kind: "rights", object: op.object }
  }
  return undefined
}
