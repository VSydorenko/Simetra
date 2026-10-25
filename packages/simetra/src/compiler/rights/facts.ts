import {
  KIND_REGISTRY,
  UUID_TEXT,
  grantEntryForm,
  isUuidColumn,
  type AccessMapping,
  type ActionEffects,
  type AssignedOn,
  type CustomAction,
  type CustomTable,
  type Extent,
  type GrantEntry,
  type MetadataRef,
  type ObjectSelector,
  type PhysicalSnapshot,
  type Project,
  type RightsCarrier,
  type RoleAssignedOn,
  type SourceCondition,
} from "simetra/model"
import type {
  CompiledAssignedOn,
  CompiledRoleLevel,
  ProjectionExtent,
  RightsExtent,
} from "../contracts"
import type { ParsedObject } from "../stages/files"
import type { ResolvedReference } from "../stages/identity"
import type { CarrierContext } from "./carriers"
import { must, objectTarget, projectTarget } from "./references"

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
export function customActionsOf(
  object: Pick<ParsedObject, "data">
): readonly CustomAction[] {
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
 * Чи пише об'єкт командою: вид із контрактом прав і хоч одна дія з DML — та
 * сама умова, з якою контракт дає політики запису й тригер ефектів, але без
 * контракту: стадія 4 контрактів прав не бачить.
 */
export function writesByCommand(
  object: Pick<ParsedObject, "kind" | "data">
): boolean {
  const def = KIND_REGISTRY[object.kind]
  if (def.rightsExtents.length === 0) return false
  return (
    def.actions(object.data).some((a) => a.effects.dml.length > 0) ||
    customActionsOf(object).some((a) => customActionEffects(a).dml.length > 0)
  )
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

/**
 * Усі носії прав об'єкта — власності, прив'язки й мапінгів `access` — з
 * вказівником, полем для діагностики й роллю першого кроку в індексі
 * посилань: стадія 3 будує за ними копії, стадія 4 — перевіряє їх.
 */
export function carrierDeclarations(object: ParsedObject): {
  carrier: RightsCarrier
  pointer: string
  field: "ownership" | "containerBinding" | "access"
  role: "rights.carrier" | "access.attribute"
}[] {
  const binding = bindingOf(object)
  return [
    ...ownershipOf(object).map((carrier, index) => ({
      carrier,
      pointer: `/ownership/${index}`,
      field: "ownership" as const,
      role: "rights.carrier" as const,
    })),
    ...(binding === undefined
      ? []
      : [
          {
            carrier: binding,
            pointer: "/containerBinding",
            field: "containerBinding" as const,
            role: "rights.carrier" as const,
          },
        ]),
    ...accessOf(object).map((mapping, index) => ({
      ...accessCarrier(mapping, index),
      field: "access" as const,
      role: "access.attribute" as const,
    })),
  ]
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

/** Декларація прав — набір чи роль (факт реєстру `rightsDeclaration`). */
export function isRightsDeclaration(object: ParsedObject): boolean {
  return KIND_REGISTRY[object.kind].rightsDeclaration !== undefined
}

/** Декларації прав одного факту реєстру (`rightsDeclaration`), у порядку файлів. */
export function declarationsOf(
  objects: readonly ParsedObject[],
  which: "set" | "role"
): ParsedObject[] {
  return objects.filter(
    (o) => KIND_REGISTRY[o.kind].rightsDeclaration === which
  )
}

/**
 * Рівень у скомпільованій формі: id виду скоупу чи контейнера дає `target`
 * з індексу посилань. `undefined` — ціль невідома: про неї звітує правило
 * поля чи стадія 2. Одна функція для ролі й джерела, тож рівні порівнюються
 * без перекладу.
 */
export function compileLevel(
  level: AssignedOn,
  target: (field: "scopeKind" | "container") => string | undefined
): CompiledAssignedOn | undefined
export function compileLevel(
  level: RoleAssignedOn,
  target: (field: "scopeKind" | "container") => string | undefined
): CompiledRoleLevel | undefined
export function compileLevel(
  level: RoleAssignedOn,
  target: (field: "scopeKind" | "container") => string | undefined
): CompiledRoleLevel | undefined {
  if (level === "global" || level === "everyUser") return { level }
  if ("scopeKind" in level) {
    const scopeKindId = target("scopeKind")
    return scopeKindId === undefined
      ? undefined
      : { level: "scope", scopeKindId }
  }
  const containerId = target("container")
  return containerId === undefined
    ? undefined
    : { level: "container", containerId }
}

/** Рівень ролі за посиланнями її файлу (`role.scopeKind`, `role.container`). */
export function roleLevel(
  object: ParsedObject,
  references: readonly ResolvedReference[]
): CompiledRoleLevel | undefined {
  const level = (object.data as { assignedOn: RoleAssignedOn }).assignedOn
  return compileLevel(level, (field) =>
    objectTarget(object, `/assignedOn/${field}`, `role.${field}`, references)
  )
}

/** Рівень джерела призначень `index` за посиланнями файлу проєкту. */
export function sourceLevel(
  project: Pick<Project, "assignmentSources">,
  index: number,
  references: readonly ResolvedReference[]
): CompiledAssignedOn | undefined {
  const at = `/assignmentSources/${index}/assignedOn`
  return compileLevel(must(project.assignmentSources[index]).assignedOn, (f) =>
    projectTarget(`${at}/${f}`, `source.${f}`, { references })
  )
}

/**
 * Тип літерала рівності умови `where` за колонкою (Р2d1-15): текст, uuid,
 * логічне чи ціле, у кожному разі не масив; інше — `undefined` (колонку
 * умова рівності не порівнює). Один тлумач для правила стадії 4 і контракту.
 */
export function sourceLiteralType(
  column: CustomTable["columns"][number]
): "text" | "uuid" | "boolean" | "integer" | undefined {
  if (column.array === true) return undefined
  if (isUuidColumn(column)) return "uuid"
  switch (column.type) {
    case "Text":
    case "String":
      return "text"
    case "Boolean":
      return "boolean"
    case "SmallInt":
    case "Integer":
    case "BigInt":
      return "integer"
    default:
      return undefined
  }
}

/**
 * Чи літерал рівності має форму типу колонки: uuid — канонічний текст із
 * дефісами, ціле — точне число JSON.
 */
export function sourceLiteralFits(
  type: NonNullable<ReturnType<typeof sourceLiteralType>>,
  value: Extract<SourceCondition, { equals: unknown }>["equals"]
): boolean {
  switch (type) {
    case "text":
      return typeof value === "string"
    case "uuid":
      return typeof value === "string" && UUID_TEXT.test(value)
    case "boolean":
      return typeof value === "boolean"
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value)
  }
}

/** Ключ рівня для порівняння: однакові рівні мають однаковий ключ. */
export function levelKey(level: CompiledRoleLevel): string {
  if (level.level === "scope") return `scope:${level.scopeKindId}`
  if (level.level === "container") return `container:${level.containerId}`
  return level.level
}

/**
 * Id включених наборів декларації в порядку `include`; `undefined` на
 * позиції — ціль не резолвлено (звітувала стадія 2).
 */
export function includedSets(
  object: ParsedObject,
  references: readonly ResolvedReference[]
): (string | undefined)[] {
  const include = (object.data as { include: MetadataRef[] }).include
  return include.map((_, index) =>
    objectTarget(object, `/include/${index}`, "rights.include", references)
  )
}

/**
 * Обсяги, які об'єкт підтримує (спека прав §3): `any` — завжди, `own` — з
 * власністю, вимір — з мапінгом `access` на нього. Одне читання для
 * контракту й правил гранту, тож «обсяг підтримано» не розійдеться з тим,
 * що бачать Права-2.
 */
export function supportedExtents(
  object: ParsedObject,
  references: readonly ResolvedReference[]
): RightsExtent[] {
  return [
    { form: "any" },
    ...(ownershipOf(object).length > 0 ? [{ form: "own" as const }] : []),
    ...accessOf(object).flatMap((_, index) => {
      const dimensionId = accessDimensionId(object, index, references)
      return dimensionId === undefined
        ? []
        : [{ form: "dimension" as const, dimensionId }]
    }),
  ]
}

/**
 * Обсяг серед підтриманих (`supportedExtents`): одне порівняння для правил
 * гранту й розгортання, тож вони не розійдуться в тому, що «підтримано».
 */
export function supportsExtent(
  extents: readonly RightsExtent[],
  extent: ProjectionExtent
): boolean {
  return extents.some((e) =>
    typeof extent === "string"
      ? e.form === extent
      : e.form === "dimension" && e.dimensionId === extent.dimensionId
  )
}

/** Запис гранту декларації прав з вказівником на тіло запису. */
export interface GrantRecord {
  form: "grantAll" | "grant" | "deny"
  /** Вказівник на тіло запису: `/grants/<i>/<форма>`. */
  pointer: string
  /** Немає — `grantAll`, що бере всі об'єкти рівня. */
  objects?: ObjectSelector
  /** Порожньо в `grantAll`: він бере всі дії, які дозволяє рівень. */
  actions: readonly string[]
  /** Немає — `deny` без обсягу, що знімає всі обсяги дії. */
  extent?: Extent
}

/** Записи `grants` набору чи ролі в порядку файлу. */
export function grantRecords(object: ParsedObject): GrantRecord[] {
  const grants = (object.data as { grants: GrantEntry[] }).grants
  return grants.map((entry, index): GrantRecord => {
    const { form, body } = grantEntryForm(entry)
    const pointer = `/grants/${index}/${form}`
    if (form === "grantAll") {
      return { form, pointer, actions: [], extent: body.extent }
    }
    return {
      form,
      pointer,
      objects: body.objects,
      actions: body.actions,
      ...(body.extent === undefined ? {} : { extent: body.extent }),
    }
  })
}

/**
 * Обсяг запису в скомпільованій формі: вимір — id з індексу посилань
 * (`grant.dimension`). `undefined` — вимір невідомий (звітує стадія 4).
 */
export function recordExtent(
  object: ParsedObject,
  record: GrantRecord,
  references: readonly ResolvedReference[]
): ProjectionExtent | undefined {
  const { extent } = record
  if (extent === undefined || typeof extent === "string") return extent
  const dimensionId = objectTarget(
    object,
    `${record.pointer}/extent/dimension`,
    "grant.dimension",
    references
  )
  return dimensionId === undefined ? undefined : { dimensionId }
}

/** Id об'єктів явного переліку запису; `undefined` — ціль не резолвлено. */
export function recordObjects(
  object: ParsedObject,
  record: GrantRecord,
  references: readonly ResolvedReference[]
): (string | undefined)[] {
  const selector = record.objects
  if (selector === undefined || !Array.isArray(selector)) return []
  return selector.map((_, at) =>
    objectTarget(
      object,
      `${record.pointer}/objects/${at}`,
      "grant.object",
      references
    )
  )
}

/** UUID кастомної дії на позиції `at` в `actions` запису (`grant.customAction`). */
export function recordCustomAction(
  object: ParsedObject,
  record: GrantRecord,
  at: number,
  references: readonly ResolvedReference[]
): string | undefined {
  return objectTarget(
    object,
    `${record.pointer}/actions/${at}`,
    "grant.customAction",
    references
  )
}
