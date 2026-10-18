import type { MetadataRef } from "../schemas/metadata-ref"
import { rightsSetSchema, type RightsSet } from "../schemas/rights"
import {
  keyOrderOf,
  type FoundReference,
  type KindDefinition,
} from "./standard"

/**
 * Включені набори — посилання індексу: перейменування набору переписує
 * `include`, а видалення включеного набору бачить індекс.
 */
export function includeReferences(
  include: readonly MetadataRef[]
): FoundReference[] {
  return include.map((ref, index) => ({
    pointer: `/include/${index}`,
    ref,
    role: "rights.include" as const,
    pair: false,
    polymorphic: false,
  }))
}

/**
 * Спільні факти декларацій прав (спека прав §4.1): вид без сховища, як
 * підписка на подію, але й без фізичного імені (Р1b-9) — у базі їх видно лише
 * в згенерованій проєкції, а в даних — за UUID.
 */
export const rightsDeclarationFacts = {
  referenceable: false,
  writePattern: "none",
  actions: () => [],
  rightsExtents: [],
  sqlModule: "closed",
  materializes: "none",
  scope: "absent",
  declared: false,
  physicalName: false,
  columnFields: [],
  valueElements: false,
  standardColumns: () => [],
} as const satisfies Partial<KindDefinition>

/** Набір прав (Рх16): іменована група грантів, яку включають ролі й набори. */
export const rightsSetKind: KindDefinition = {
  ...rightsDeclarationFacts,
  kind: "RightsSet",
  dir: "rights-sets",
  schema: rightsSetSchema,
  keyOrder: keyOrderOf(rightsSetSchema),
  rightsDeclaration: "set",
  references: (obj) => includeReferences((obj as RightsSet).include),
}
