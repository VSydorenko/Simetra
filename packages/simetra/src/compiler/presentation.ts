import {
  KIND_REGISTRY,
  standardLogicalName,
  type AttributeCase,
  type LocalizedString,
  type StandardColumnDef,
} from "simetra/model"
import { compareStrings } from "./diagnostics"
import type { ParsedObject } from "./stages/files"

export interface PresentationBlock {
  objectId: string
  /** Лише довідник. */
  mainPresentation?: "Code" | "Description"
  /** Ключ — канонічне camelCase-ім'я стандартного реквізиту. */
  standardAttributes: Record<
    string,
    { title?: LocalizedString; description?: LocalizedString }
  >
  /**
   * Лише ТЧ з перевизначеннями; у порядку файлу. Ключі — канонічні імена
   * стандартних реквізитів рядка ТЧ.
   */
  sections?: {
    sectionId: string
    standardAttributes: Record<
      string,
      { title?: LocalizedString; description?: LocalizedString }
    >
  }[]
  /** Лише елементи з `description`; у порядку файлу, `id` — як у контракті. */
  predefined?: { id: string; description: LocalizedString }[]
}

interface PresentationFields {
  mainPresentation?: "Code" | "Description"
  standardAttributeOverrides?: Record<
    string,
    { title?: LocalizedString; description?: LocalizedString }
  >
  tabularSections?: {
    id?: string
    standardAttributeOverrides?: PresentationFields["standardAttributeOverrides"]
  }[]
}

type Overrides = NonNullable<PresentationFields["standardAttributeOverrides"]>

/** Перевизначення під канонічними іменами колонок; невідоме ім'я лишається як є. */
function canonicalOverrides(
  overrides: Overrides | undefined,
  columns: readonly StandardColumnDef[],
  style: AttributeCase
): PresentationBlock["standardAttributes"] {
  // Файл може назвати реквізит у стилі проєкту (`deletion_mark`), а
  // читачам потрібне одне канонічне ім'я.
  const canonical = new Map(
    columns.flatMap((column) => [
      [column.logicalName, column.logicalName],
      [standardLogicalName(column, style), column.logicalName],
    ])
  )
  const result: PresentationBlock["standardAttributes"] = {}
  for (const [name, override] of Object.entries(overrides ?? {})) {
    result[canonical.get(name) ?? name] = {
      ...(override.title === undefined ? {} : { title: override.title }),
      ...(override.description === undefined
        ? {}
        : { description: override.description }),
    }
  }
  return result
}

/**
 * Поля подання, які інакше нікому не потрібні в моделі: читачі — `explain` і
 * хости. Об'єкт без жодного з них блоку не має. Вид не перелічується: що в
 * нього є, видно з розібраних даних, а місця елементів з `description` — з
 * реєстру (`namedElementFields`), як у контракті предвизначених.
 */
export function buildPresentation(
  objects: readonly ParsedObject[],
  style: AttributeCase
): PresentationBlock[] {
  return objects
    .flatMap((object): PresentationBlock[] => {
      const data = object.data as PresentationFields
      const def = KIND_REGISTRY[object.kind]
      const standardAttributes = canonicalOverrides(
        data.standardAttributeOverrides,
        def.standardColumns(object.data),
        style
      )
      // Наявність ТЧ у виду — факт реєстру (`tabularSectionColumns`).
      const rowColumns = def.tabularSectionColumns?.(object.data) ?? []
      const sections = (
        def.tabularSectionColumns === undefined
          ? []
          : (data.tabularSections ?? [])
      ).flatMap((section) => {
        const overrides = canonicalOverrides(
          section.standardAttributeOverrides,
          rowColumns,
          style
        )
        return Object.keys(overrides).length === 0
          ? []
          : [{ sectionId: section.id ?? "", standardAttributes: overrides }]
      })

      const predefined = (def.namedElementFields ?? [])
        .flatMap(
          (field) =>
            ((object.data as Record<string, unknown>)[field] ?? []) as {
              id: string
              description?: LocalizedString
            }[]
        )
        .flatMap(({ id, description }) =>
          description === undefined ? [] : [{ id, description }]
        )

      const hasStandard = Object.keys(standardAttributes).length > 0
      if (
        data.mainPresentation === undefined &&
        !hasStandard &&
        sections.length === 0 &&
        predefined.length === 0
      ) {
        return []
      }
      return [
        {
          objectId: object.id ?? "",
          ...(data.mainPresentation === undefined
            ? {}
            : { mainPresentation: data.mainPresentation }),
          standardAttributes,
          ...(sections.length === 0 ? {} : { sections }),
          ...(predefined.length === 0 ? {} : { predefined }),
        },
      ]
    })
    .sort((a, b) => compareStrings(a.objectId, b.objectId))
}
