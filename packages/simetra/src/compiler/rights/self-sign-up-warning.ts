import type { Project } from "simetra/model"
import { publicReadRoleOf } from "../access-units"
import type { Contracts } from "../contracts"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import { PROJECT_FILE } from "../stages/files"
import { expandedProjection } from "./functions"

/**
 * Попередження відкритої самореєстрації (Р-D5-9): будь-хто з Інтернету стає
 * «дійсним користувачем», тож усе, що відкрито цій межі, відкрито всім:
 * об'єкти з `publicRead: authenticated` і гранти ролей рівня `everyUser`.
 * Роль `publicRead` читається зі скомпільованого контракту доступу, а не з
 * рядкової форми метаданих: `anon` теж відкриває `user`, але його бачить і
 * гість, тож самореєстрація до нього нічого не додає.
 */
export function selfSignUpWarnings(
  contracts: Pick<
    Contracts,
    "access" | "rights" | "roles" | "rightsProjection"
  >,
  objects: readonly { id?: string; name: string }[],
  project: Pick<Project, "selfSignUp">
): Diagnostic[] {
  if (project.selfSignUp !== true) return []
  const names = new Map(objects.map(({ id, name }) => [id, name]))
  const nameOf = (objectId: string) => names.get(objectId) ?? objectId
  const exposed = [
    ...new Set(
      contracts.access
        .filter((a) => publicReadRoleOf(a.publicRead) === "authenticated")
        .map((a) => nameOf(a.objectId))
    ),
  ].sort(compareStrings)
  const projection = expandedProjection(contracts)
  const roles = contracts.roles
    .filter((role) => role.assignedOn.level === "everyUser")
    .map((role) => {
      const grants = projection
        .filter((row) => row.roleId === role.roleId)
        .map((row) => `${nameOf(row.objectId)}.${row.action}`)
        .sort(compareStrings)
      return `${role.name}: ${grants.join(", ")}`
    })
    .sort(compareStrings)
  return [
    diagnostic("project.self-sign-up", PROJECT_FILE, "/selfSignUp", {
      objects: exposed.join(", "),
      roles: roles.join("; "),
    }),
  ]
}
