import type {
  MetadataKind,
  MetadataObject,
  StandardAttributeSettings,
} from "@simetra/core"

/** Витягує settings з обʼєкта для передачі в getStandardAttributes */
export function extractStandardAttributeSettings(
  kind: MetadataKind,
  object: MetadataObject
): StandardAttributeSettings {
  switch (kind) {
    case "Catalog": {
      const o = object as {
        hierarchyType?: string
        owners?: { kind: string; name: string }[]
      }
      return {
        hierarchyType:
          (o.hierarchyType as StandardAttributeSettings["hierarchyType"]) ??
          "None",
        owners: o.owners,
      }
    }
    case "InformationRegister": {
      const o = object as {
        periodicity?: string
        writeMode?: string
        recorderTypes?: StandardAttributeSettings["recorderTypes"]
      }
      return {
        periodicity: o.periodicity,
        writeMode: o.writeMode,
        recorderTypes: o.recorderTypes,
      }
    }
    case "AccumulationRegister": {
      const o = object as {
        registerType?: string
        recorderTypes?: StandardAttributeSettings["recorderTypes"]
      }
      return {
        registerType:
          o.registerType as StandardAttributeSettings["registerType"],
        recorderTypes: o.recorderTypes,
      }
    }
    case "CustomTable": {
      const o = object as { autoAddPrimaryKey?: boolean }
      return {
        autoAddPrimaryKey: o.autoAddPrimaryKey,
      }
    }
    default:
      return {}
  }
}
