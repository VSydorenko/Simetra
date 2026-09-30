import type {
  MetadataKind,
  MetadataObject,
  StandardAttributeSettings,
} from "@simetra/core"

/** Витягує settings з обʼєкта для передачі в getStandardAttributes */
export function extractStandardAttributeSettings(
  _kind: MetadataKind,
  object: MetadataObject
): StandardAttributeSettings {
  switch (object.kind) {
    case "Catalog":
      return {
        hierarchyType: object.hierarchyType ?? "None",
        owners: object.owners,
      }
    case "InformationRegister":
      return {
        periodicity: object.periodicity,
        writeMode: object.writeMode,
        recorderTypes: object.recorderTypes,
      }
    case "AccumulationRegister":
      return {
        registerType: object.registerType,
        recorderTypes: object.recorderTypes,
      }
    case "CustomTable":
      return {
        autoAddPrimaryKey: object.autoAddPrimaryKey,
      }
    default:
      return {}
  }
}
