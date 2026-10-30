import type { Project } from "simetra/model"
import type { Contracts } from "../contracts"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { PROJECT_FILE } from "../stages/files"
import { expandedProjection } from "./functions"

/**
 * Попередження на вид скоупу (спека прав §5.2): скоуплені об'єкти
 * з контрактом прав читають лише політики прав, тож вид, на жоден об'єкт
 * якого немає `read` у проєкції з розгорнутим `fullAccess`, — дані, яких не
 * побачить ніхто. Вид без членства потрапляє сюди сам (ролей його рівня не
 * буває), вид лише з прийнятими таблицями — ні (контракту прав у них немає).
 * Системні довідники прав не рахуються: їхнє `read` дає лише явний
 * грант чи `fullAccess` рівня, і воно не відкриває жодного рядка даних виду —
 * зарахувавши їх, попередження замовкло б над непрочитаними даними.
 */
export function scopeKindUnreadWarnings(
  contracts: Pick<Contracts, "rights" | "roles" | "rightsProjection">,
  project: Pick<Project, "scopeKinds">
): Diagnostic[] {
  const read = new Set(
    expandedProjection(contracts)
      .filter((row) => row.action === "read")
      .map((row) => row.objectId)
  )
  return project.scopeKinds.flatMap((kind, index) => {
    const objects = contracts.rights.filter(
      (c) => c.scopeKindId === kind.id && c.system === undefined
    )
    if (objects.length === 0) return []
    if (objects.some((c) => read.has(c.objectId))) return []
    return [
      diagnostic(
        "rights.scope-kind-unread",
        PROJECT_FILE,
        `/scopeKinds/${index}`,
        { scopeKind: kind.name }
      ),
    ]
  })
}
