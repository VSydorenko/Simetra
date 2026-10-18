import {
  KIND_REGISTRY,
  actionRequires,
  closeRequires,
  standardLogicalName,
  type ActionEffects,
  type AttributeCase,
  type CustomAction,
  type PhysicalSnapshot,
  type PhysicalTable,
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
 * Контракти прав (спека прав §3): запис має кожен об'єкт виду з непорожнім
 * `rightsExtents`. Викликається лише на моделі без помилок: цикли вимог і
 * невідомі дії вже відхилила стадія 4, тож замикання не кидає.
 */
export function rightsContracts(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  physical: PhysicalSnapshot,
  style: AttributeCase
): RightsContract[] {
  return objects
    .filter((object) => KIND_REGISTRY[object.kind].rightsExtents.length > 0)
    .map((object) => rightsContract(object, references, physical, style))
    .sort((a, b) => compareStrings(a.objectId, b.objectId))
}

function rightsContract(
  object: ParsedObject,
  references: readonly ResolvedReference[],
  physical: PhysicalSnapshot,
  style: AttributeCase
): RightsContract {
  const def = KIND_REGISTRY[object.kind]
  const objectId = must(object.id)
  const table = must(mainTableOf(physical, objectId))
  const columnsOf = elementColumns(object, objectId, table, style)
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

  const extents: RightsAction["extents"] = [{ form: "any" }]
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
  }
}

/**
 * Фізичні колонки основної таблиці за id елемента: реквізит — за своїм UUID,
 * стандартний реквізит — за синтетичним id з канонічним ім'ям (той самий, що
 * дає індекс посилань), тож ефекти реєстру й посилання файлу читаються
 * однаково. Поліморфна пара дає обидві колонки.
 */
function elementColumns(
  object: ParsedObject,
  objectId: string,
  table: PhysicalTable,
  style: AttributeCase
): Map<string, string[]> {
  const byStandard = new Map(
    KIND_REGISTRY[object.kind]
      .standardColumns(object.data)
      .map((c) => [
        standardLogicalName(c, style),
        standardElementId(objectId, c),
      ])
  )
  const result = new Map<string, string[]>()
  for (const column of table.columns) {
    const id =
      column.origin.elementId ??
      (column.origin.standard === undefined
        ? undefined
        : byStandard.get(column.origin.standard))
    if (id === undefined) continue
    result.set(id, [...(result.get(id) ?? []), column.name])
  }
  return result
}

/** Модель без помилок гарантує наявність; відсутність — дефект компілятора. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing rights input")
  return value
}
