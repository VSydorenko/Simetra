import type { MetadataRef } from "../schemas/metadata-ref"
import {
  grantEntryForm,
  rightsSetSchema,
  type GrantEntry,
  type RightsSet,
} from "../schemas/rights"
import {
  keyOrderOf,
  type FoundProjectReference,
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
 * Об'єкти явного переліку гранту — посилання індексу: перейменування об'єкта
 * переписує грант, а видалення об'єкта, на який грант посилається, бачить
 * індекс. Селектор `withAction` об'єктів не називає.
 */
export function grantReferences(
  grants: readonly GrantEntry[]
): FoundReference[] {
  return grants.flatMap((entry, index) => {
    const { form, body } = grantEntryForm(entry)
    if (!("objects" in body) || !Array.isArray(body.objects)) return []
    return body.objects.map((ref, at) => ({
      pointer: `/grants/${index}/${form}/objects/${at}`,
      ref,
      role: "grant.object" as const,
      pair: false,
      polymorphic: false,
    }))
  })
}

/** Вимір обсягу гранту — елемент проєкту: перейменування виміру переписує грант. */
export function grantProjectReferences(
  grants: readonly GrantEntry[]
): FoundProjectReference[] {
  return grants.flatMap((entry, index) => {
    const { form, body } = grantEntryForm(entry)
    const { extent } = body
    if (typeof extent !== "object") return []
    return [
      {
        pointer: `/grants/${index}/${form}/extent/dimension`,
        name: extent.dimension,
        collection: "accessDimensions" as const,
        role: "grant.dimension" as const,
      },
    ]
  })
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
  references: (obj) => {
    const set = obj as RightsSet
    return [...includeReferences(set.include), ...grantReferences(set.grants)]
  },
  projectReferences: (obj) => grantProjectReferences((obj as RightsSet).grants),
}
