import type { Batch, MetadataRef, RuntimeCatalog } from "simetra/model"

/** The guard refused a batch that writes rights without permission; carries the object. */
export class AgentWriteRefused extends Error {
  readonly object: MetadataRef

  constructor(object: MetadataRef) {
    super("catalog.rights-write-refused")
    this.name = "AgentWriteRefused"
    this.object = object
  }
}

/**
 * The rights-write guard: a pure function over the runtime catalog and a batch,
 * so an adapter can call it before opening a pool. It refuses when any
 * operation of the batch (not only the first) touches a rights system catalog
 * (its operations have the `administerRights` context) or creates a scope root
 * with a creator. An object outside the catalog is skipped: the runtime schema
 * rejects it. Without `rightsWrite` the refusal comes before the database.
 */
// T1 ставить контекст `administerRights` саме ролям `rightsRoles` і
// `roleAssignments`, тож окремої ознаки в каталозі немає. Корінь із творцем
// пише членство й призначення творця, тож змінює права.
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
