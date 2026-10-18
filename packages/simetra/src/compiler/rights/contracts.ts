import {
  KIND_REGISTRY,
  actionRequires,
  closeRequires,
  type ActionEffects,
  type CustomAction,
  type PhysicalSnapshot,
  type Project,
  type RightsCarrier,
} from "simetra/model"
import {
  mainTableOf,
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
  resolveCarrier,
  type CarrierContext,
} from "./carriers"

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
  const extents: RightsAction["extents"] = [
    { form: "any" },
    ...(ownership.length > 0 ? [{ form: "own" as const }] : []),
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
  }
}

/** Модель без помилок гарантує наявність; відсутність — дефект компілятора. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing rights input")
  return value
}
