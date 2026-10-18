import type {
  AccessMapping,
  ActionEffects,
  CustomAction,
  PhysicalSnapshot,
  Project,
  RightsCarrier,
} from "simetra/model"
import type { ParsedObject } from "../stages/files"
import type { ResolvedReference } from "../stages/identity"
import type { CarrierContext } from "./carriers"
import { must } from "./references"

// Спільні факти прав для правил стадії 4 і контрактів: обидва читають ті самі
// поля розібраного об'єкта й ті самі рядки індексу посилань, тож і читання
// одне — інакше правило й контракт розійшлися б у тлумаченні поля.

/** Id виду скоупу об'єкта; немає — об'єкт без скоупу. */
export function scopeKindOf(
  object: ParsedObject,
  references: readonly ResolvedReference[]
): string | undefined {
  return references.find(
    (r) => r.role === "object.scope" && r.from.file === object.file
  )?.to.id
}

/** Довідник «Користувачі» (роль `users`). */
export function isUsers(object: ParsedObject): boolean {
  return (object.data as { role?: string }).role === "users"
}

/** Довідник членства виду скоупу (поле `membership`). */
export function isMembershipCatalog(object: ParsedObject): boolean {
  return (object.data as { membership?: unknown }).membership !== undefined
}

/** Об'єкт-контейнер прав (`rightsContainer: true`). */
export function isRightsContainer(object: ParsedObject): boolean {
  return (object.data as { rightsContainer?: boolean }).rightsContainer === true
}

/** Кастомні дії розібраного об'єкта виду з контрактом прав. */
export function customActionsOf(object: ParsedObject): readonly CustomAction[] {
  return (object.data as { customActions?: CustomAction[] }).customActions ?? []
}

/**
 * Ефекти кастомної дії: `dml` не оголошується, а виводиться (Р1a-8) — є що
 * писати, отже це оновлення рядка; інакше дія нічого не пише.
 */
export function customActionEffects(action: CustomAction): ActionEffects {
  const header = action.effects.header ?? []
  const tabularSections = action.effects.tabularSections ?? false
  const writes = header === "all" || header.length > 0 || tabularSections
  return { dml: writes ? ["update"] : [], header, tabularSections }
}

/**
 * Резолвлене посилання імені `effects.header` кастомної дії `index` на
 * позиції `at`; немає — ім'я не є колонкою об'єкта.
 */
export function headerReference(
  object: ParsedObject,
  index: number,
  at: number,
  references: readonly ResolvedReference[]
): ResolvedReference | undefined {
  const pointer = `/customActions/${index}/effects/header/${at}`
  return references.find(
    (r) =>
      r.from.file === object.file &&
      r.from.pointer === pointer &&
      r.role === "customAction.header"
  )
}

/** Носії `ownership` об'єкта виду з обсягом `own`. */
export function ownershipOf(object: ParsedObject): readonly RightsCarrier[] {
  return (object.data as { ownership?: RightsCarrier[] }).ownership ?? []
}

/** Носій `containerBinding` об'єкта виду з фактом `rightsBinding`. */
export function bindingOf(object: ParsedObject): RightsCarrier | undefined {
  return (object.data as { containerBinding?: RightsCarrier }).containerBinding
}

/** Мапінги `access` об'єкта виду з обсягом `dimension`. */
export function accessOf(object: ParsedObject): readonly AccessMapping[] {
  return (object.data as { access?: AccessMapping[] }).access ?? []
}

/** Носій мапінгу й його вказівник: реквізит чи шлях `ref`. */
export function accessCarrier(
  mapping: AccessMapping,
  index: number
): { carrier: RightsCarrier; pointer: string } {
  return "attribute" in mapping
    ? { carrier: mapping.attribute, pointer: `/access/${index}/attribute` }
    : { carrier: mapping.ref, pointer: `/access/${index}/ref` }
}

/** Id виміру, який називає мапінг: його резолвить стадія 2 (`access.dimension`). */
export function accessDimensionId(
  object: ParsedObject,
  index: number,
  references: readonly ResolvedReference[]
): string | undefined {
  const pointer = `/access/${index}/dimension`
  return references.find(
    (r) =>
      r.role === "access.dimension" &&
      r.from.file === object.file &&
      r.from.pointer === pointer
  )?.to.id
}

/**
 * Контекст резолву носіїв. `byId` передає той, хто вже має індекс об'єктів
 * (стадія 4), щоб не будувати його вдруге.
 */
export function carrierContext(input: {
  objects: readonly ParsedObject[]
  references: readonly ResolvedReference[]
  physical: PhysicalSnapshot
  project: Project
  byId?: ReadonlyMap<string, ParsedObject>
}): CarrierContext {
  return {
    references: input.references,
    physical: input.physical,
    project: input.project,
    byId: input.byId ?? new Map(input.objects.map((o) => [must(o.id), o])),
  }
}
