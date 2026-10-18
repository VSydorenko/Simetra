import type { PhysicalTable, Project } from "simetra/model"

/**
 * Чи носій прав «в межах скоупу» (Р1a-10): фізичний FK поля є складеним, тобто
 * несе скоуп-колонку першою парою, а в проєкті без видів скоупу межі немає й
 * підходить будь-який одиночний `Ref`.
 *
 * `foreignKey` — FK поля в знімку (`undefined`, коли поле FK не має). Поле виду
 * дає одноколонковий FK лише простим посиланням, тож більше однієї колонки
 * однозначно означає складений.
 */
export function inScopeTarget(
  foreignKey: Pick<PhysicalTable["foreignKeys"][number], "columns"> | undefined,
  project: Pick<Project, "scopeKinds">
): boolean {
  if (project.scopeKinds.length === 0) return true
  return foreignKey !== undefined && foreignKey.columns.length > 1
}
