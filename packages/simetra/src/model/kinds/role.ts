import { roleSchema, type Role } from "../schemas/rights"
import {
  grantProjectReferences,
  grantReferences,
  includeReferences,
  rightsDeclarationFacts,
} from "./rights-set"
import {
  keyOrderOf,
  type FoundProjectReference,
  type FoundReference,
  type KindDefinition,
} from "./standard"

/**
 * Роль (спека прав §4.1): рівень призначення, повні права й включені набори.
 * Контейнер рівня — посилання на об'єкт; вид скоупу й джерела ключів —
 * елементи проєкту, тож перейменування будь-якого з них переписує роль.
 */
export const roleKind: KindDefinition = {
  ...rightsDeclarationFacts,
  kind: "Role",
  dir: "roles",
  schema: roleSchema,
  keyOrder: keyOrderOf(roleSchema),
  rightsDeclaration: "role",
  references: (obj) => {
    const role = obj as Role
    const level = role.assignedOn
    const container: FoundReference[] =
      typeof level === "object" && "container" in level
        ? [
            {
              pointer: "/assignedOn/container",
              ref: level.container,
              role: "role.container",
              pair: false,
              polymorphic: false,
            },
          ]
        : []
    return [
      ...includeReferences(role.include),
      ...container,
      ...grantReferences(role.grants),
    ]
  },
  projectReferences: (obj) => {
    const role = obj as Role
    const level = role.assignedOn
    const scopeKind: FoundProjectReference[] =
      typeof level === "object" && "scopeKind" in level
        ? [
            {
              pointer: "/assignedOn/scopeKind",
              name: level.scopeKind,
              collection: "scopeKinds",
              role: "role.scopeKind",
            },
          ]
        : []
    return [
      ...scopeKind,
      ...role.sourceKeys.map((entry, index): FoundProjectReference => ({
        pointer: `/sourceKeys/${index}/source`,
        name: entry.source,
        collection: "assignmentSources",
        role: "role.sourceKey",
      })),
      ...grantProjectReferences(role.grants),
    ]
  },
}
