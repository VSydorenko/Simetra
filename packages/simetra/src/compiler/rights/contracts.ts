import {
  KIND_REGISTRY,
  actionRequires,
  closeRequires,
  type AccessMapping,
  type ActionEffects,
  type CustomAction,
  type PhysicalSnapshot,
  type Project,
  type RightsCarrier,
} from "simetra/model"
import {
  mainTableOf,
  type AccessDimensionContract,
  type AssignmentSourceContract,
  type CompiledAssignedOn,
  type Contracts,
  type MembershipSourceContract,
  type RightsAction,
  type RightsContract,
} from "../contracts"
import { compareStrings } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { standardElementId, type ResolvedReference } from "../stages/identity"
import { kindLabelOf } from "../stages/model"
import {
  carrierTarget,
  elementColumns,
  elementField,
  resolveCarrier,
  type CarrierContext,
} from "./carriers"
import { must, projectTarget } from "./references"

/** Кастомні дії розібраного об'єкта виду з контрактом прав. */
export function customActionsOf(object: ParsedObject): readonly CustomAction[] {
  return (object.data as { customActions?: CustomAction[] }).customActions ?? []
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
 * Контракти прав (спека прав §3): запис має кожен об'єкт виду з непорожнім
 * `rightsExtents`. Викликається лише на моделі без помилок: цикли вимог і
 * невідомі дії вже відхилила стадія 4, тож замикання не кидає.
 */
export function rightsContracts(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  physical: PhysicalSnapshot,
  project: Project
): RightsContract[] {
  const ctx: CarrierContext = {
    references,
    physical,
    project,
    byId: new Map(objects.map((o) => [must(o.id), o])),
  }
  return objects
    .filter((object) => KIND_REGISTRY[object.kind].rightsExtents.length > 0)
    .map((object) => rightsContract(object, ctx))
    .sort((a, b) => compareStrings(a.objectId, b.objectId))
}

function rightsContract(
  object: ParsedObject,
  ctx: CarrierContext
): RightsContract {
  const { references, physical } = ctx
  const def = KIND_REGISTRY[object.kind]
  const objectId = must(object.id)
  const table = must(mainTableOf(physical, objectId))
  const columnsOf = elementColumns(
    object,
    table,
    ctx.project.naming.attributeCase
  )
  const standard = def.actions(object.data)
  const custom = customActionsOf(object)
    .map((action, index) => ({ action, index }))
    .sort((a, b) => compareStrings(must(a.action.id), must(b.action.id)))

  // Ключ дії в контракті — слово словника чи UUID кастомної (Рх18), тож і
  // вимоги замикаються над ключами: ім'я кастомної дії може змінитися.
  const standardNames = new Set<string>(standard.map((a) => a.name))
  const keyOf = (name: string) =>
    standardNames.has(name)
      ? name
      : must(custom.find((c) => c.action.name === name)?.action.id)
  const customEffects = new Map(
    custom.map(({ action }) => [action, customActionEffects(action)])
  )
  const closed = closeRequires([
    ...standard.map((a) => ({ name: a.name, requires: actionRequires(a) })),
    ...custom.map(({ action }) => ({
      name: must(action.id),
      requires: actionRequires({
        requires: action.requires.map(keyOf),
        effects: must(customEffects.get(action)),
      }),
    })),
  ])

  // Носії вже перевірила стадія 4, тож резолв тут не падає.
  const ownership = ownershipOf(object).map((carrier, index) => {
    const resolved = resolveCarrier(
      object,
      carrier,
      { pointer: `/ownership/${index}`, field: "ownership" },
      ctx
    )
    if (!resolved.ok) throw new Error("internal: unchecked rights carrier")
    return resolved.contract
  })
  const bindingCarrier = bindingOf(object)
  let binding: RightsContract["binding"]
  if (bindingCarrier !== undefined) {
    const resolved = resolveCarrier(
      object,
      bindingCarrier,
      { pointer: "/containerBinding", field: "containerBinding" },
      ctx
    )
    if (!resolved.ok) throw new Error("internal: unchecked rights carrier")
    binding = {
      containerId: must(carrierTarget(resolved.terminal).id),
      carrier: resolved.contract,
    }
  }
  const access = accessOf(object).map((mapping, index) => {
    const { carrier, pointer } = accessCarrier(mapping, index)
    const resolved = resolveCarrier(
      object,
      carrier,
      { pointer, field: "access", role: "access.attribute" },
      ctx
    )
    if (!resolved.ok) throw new Error("internal: unchecked rights carrier")
    return {
      dimensionId: must(accessDimensionId(object, index, references)),
      carrier: resolved.contract,
    }
  })
  const extents: RightsAction["extents"] = [
    { form: "any" },
    ...(ownership.length > 0 ? [{ form: "own" as const }] : []),
    ...access.map(({ dimensionId }) => ({
      form: "dimension" as const,
      dimensionId,
    })),
  ]
  const canonicalHeader = (header: ActionEffects["header"]) =>
    header === "all"
      ? ("all" as const)
      : header.flatMap(
          (name) =>
            columnsOf.get(standardElementId(objectId, { logicalName: name })) ??
            []
        )
  const customHeader = (index: number, header: ActionEffects["header"]) =>
    header === "all"
      ? ("all" as const)
      : header.flatMap((_, at) => {
          const pointer = `/customActions/${index}/effects/header/${at}`
          const target = references.find(
            (r) =>
              r.from.file === object.file &&
              r.from.pointer === pointer &&
              r.role === "customAction.header"
          )
          return columnsOf.get(must(target).to.id) ?? []
        })

  const actions: RightsAction[] = [
    ...standard.map((a) => ({
      action: a.name,
      name: a.name,
      requires: [...must(closed.get(a.name))],
      effects: {
        dml: [...a.effects.dml],
        header: canonicalHeader(a.effects.header),
        tabularSections: a.effects.tabularSections,
      },
      extents,
    })),
    ...custom.map(({ action, index }) => {
      const id = must(action.id)
      const effects = must(customEffects.get(action))
      return {
        action: id,
        name: action.name,
        requires: [...must(closed.get(id))],
        effects: {
          dml: [...effects.dml],
          header: customHeader(index, effects.header),
          tabularSections: effects.tabularSections,
        },
        extents,
      }
    }),
  ]
  const scopeKindId = references.find(
    (r) => r.role === "object.scope" && r.from.file === object.file
  )?.to.id
  return {
    objectId,
    kindLabel: must(kindLabelOf(object)),
    table: { schema: table.schema, name: table.name },
    ...(scopeKindId === undefined ? {} : { scopeKindId }),
    actions,
    ownership,
    ...((object.data as { rightsContainer?: boolean }).rightsContainer === true
      ? { container: true as const }
      : {}),
    ...(binding === undefined ? {} : { binding }),
    access,
  }
}

/**
 * Контракти вимірів доступу проєкту (спека прав §4.4). Викликається лише на
 * моделі без помилок: ціль, об'єкт і поля зв'язку вже перевірила стадія 4.
 */
export function accessDimensionContracts(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  physical: PhysicalSnapshot,
  project: Project
): AccessDimensionContract[] {
  const ctx: CarrierContext = {
    references,
    physical,
    project,
    byId: new Map(objects.map((o) => [must(o.id), o])),
  }
  const toId = (pointer: string, role: ResolvedReference["role"]) =>
    must(projectTarget(pointer, role, { references }))
  return project.accessDimensions
    .map((dimension, index): AccessDimensionContract => {
      const at = `/accessDimensions/${index}`
      const dimensionId = must(dimension.id)
      const targetId = toId(`${at}/target`, "dimension.target")
      if ("function" in dimension.values) {
        const { schema, name } = dimension.values.function
        return {
          dimensionId,
          name: dimension.name,
          targetId,
          values: {
            function: { schema: schema ?? project.defaultSchema, name },
          },
        }
      }
      const { relation } = dimension.values
      const relationAt = `${at}/values/relation`
      const object = must(
        ctx.byId.get(toId(`${relationAt}/object`, "dimension.relationObject"))
      )
      const table = must(mainTableOf(physical, must(object.id)))
      const column = (field: "subject" | "value") =>
        must(
          elementField(
            object,
            toId(`${relationAt}/${field}`, "dimension.relationField"),
            relation[field],
            ctx
          )
        ).column
      return {
        dimensionId,
        name: dimension.name,
        targetId,
        values: {
          relation: {
            objectId: must(object.id),
            table: { schema: table.schema, name: table.name },
            subject: column("subject"),
            value: column("value"),
          },
        },
      }
    })
    .sort((a, b) => compareStrings(a.dimensionId, b.dimensionId))
}

/**
 * Контракти прийнятих джерел (спека прав §4.7): ідентичність, рівень і
 * таблиця з фізичними колонками. Викликається лише на моделі без помилок:
 * таблиці, колонки, види й контейнери вже резолвила стадія 2 і перевірила
 * стадія 4.
 */
export function sourceContracts(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  physical: PhysicalSnapshot,
  project: Project
): Pick<Contracts, "membershipSources" | "assignmentSources"> {
  const byId = new Map(objects.map((o) => [must(o.id), o]))
  const toId = (pointer: string, role: ResolvedReference["role"]) =>
    projectTarget(pointer, role, { references })
  // Таблиця джерела й фізична колонка за логічним полем мапінгу.
  const tableOf = (at: string) => {
    const object = must(byId.get(must(toId(`${at}/table`, "source.table"))))
    const table = must(mainTableOf(physical, must(object.id)))
    const columns = elementColumns(object, table, project.naming.attributeCase)
    const column = (field: string) =>
      must(
        columns.get(must(toId(`${at}/columns/${field}`, "source.column")))?.[0]
      )
    return {
      table: { schema: table.schema, name: table.name },
      column,
    }
  }
  const membershipSources = project.membershipSources
    .map((source, index): MembershipSourceContract => {
      const at = `/membershipSources/${index}`
      const { table, column } = tableOf(at)
      return {
        sourceId: must(source.id),
        name: source.name,
        scopeKindId: must(toId(`${at}/scopeKind`, "source.scopeKind")),
        table,
        scope: column("scope"),
        user: column("user"),
        ...(source.columns.active === undefined
          ? {}
          : { active: column("active") }),
      }
    })
    .sort((a, b) => compareStrings(a.sourceId, b.sourceId))
  const assignmentSources = project.assignmentSources
    .map((source, index): AssignmentSourceContract => {
      const at = `/assignmentSources/${index}`
      const { table, column } = tableOf(at)
      const level = source.assignedOn
      const assignedOn: CompiledAssignedOn =
        level === "global"
          ? { level: "global" }
          : "scopeKind" in level
            ? {
                level: "scope",
                scopeKindId: must(
                  toId(`${at}/assignedOn/scopeKind`, "source.scopeKind")
                ),
              }
            : {
                level: "container",
                containerId: must(
                  toId(`${at}/assignedOn/container`, "source.container")
                ),
              }
      return {
        sourceId: must(source.id),
        name: source.name,
        assignedOn,
        table,
        member: column("member"),
        role: column("role"),
        ...(source.columns.container === undefined
          ? {}
          : { container: column("container") }),
        ...(source.columns.active === undefined
          ? {}
          : { active: column("active") }),
      }
    })
    .sort((a, b) => compareStrings(a.sourceId, b.sourceId))
  return { membershipSources, assignmentSources }
}
