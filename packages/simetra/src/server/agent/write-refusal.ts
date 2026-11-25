import type { Batch, MetadataRef, RuntimeCatalog } from "simetra/model"

/** Відмова запобіжника: пакет пише права без дозволу; несе об'єкт відмови. */
export class AgentWriteRefused extends Error {
  readonly object: MetadataRef

  constructor(object: MetadataRef) {
    super("catalog.rights-write-refused")
    this.name = "AgentWriteRefused"
    this.object = object
  }
}

/**
 * Запобіжник запису прав: чиста функція над каталогом рантайму й пакетом, щоб
 * адаптер кликав її до відкриття пулу. Відмовляє, коли будь-яка операція
 * пакета (не лише перша: пакет — одна транзакція) стосується
 * - системного довідника прав: його операції мають контекст
 *   `administerRights` (T1 ставить його саме ролям `rightsRoles` і
 *   `roleAssignments`, тож окремої ознаки в каталозі немає), або
 * - `create` кореня з творцем: ядро кореня пише членство й призначення творця.
 * Об'єкт поза каталогом пропускається — його відхилить схема рантайму.
 * Без `rightsWrite` відмова — до бази.
 */
export function agentWriteRefusal(
  catalog: RuntimeCatalog,
  batch: Batch,
  permissions: { rightsWrite: boolean }
): { object: MetadataRef } | undefined {
  if (permissions.rightsWrite) return undefined
  for (const op of batch) {
    const object = catalog.objects.find(
      (o) => o.kind === op.object.kind && o.name === op.object.name
    )
    if (object === undefined) continue
    const operations = Object.values(object.operations ?? {})
    if (operations.some((target) => target.context === "administerRights"))
      return { object: op.object }
    if (
      op.action === "create" &&
      object.operations?.create?.root?.membership !== undefined
    )
      return { object: op.object }
  }
  return undefined
}
