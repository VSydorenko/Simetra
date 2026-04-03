import type { MetadataKind, MetadataObject, StandardAttributeSettings } from '@simetra/core'

/** Витягує settings з обʼєкта для передачі в getStandardAttributes */
export function extractStandardAttributeSettings(
  kind: MetadataKind,
  object: MetadataObject,
): StandardAttributeSettings {
  switch (kind) {
    case 'Catalog': {
      const o = object as { hierarchyType?: string; owners?: { kind: string; name: string }[] }
      return {
        hierarchyType: (o.hierarchyType as StandardAttributeSettings['hierarchyType']) ?? 'None',
        owners: o.owners,
      }
    }
    case 'InformationRegister': {
      const o = object as { periodicity?: string; writeMode?: string }
      return {
        periodicity: o.periodicity,
        writeMode: o.writeMode,
      }
    }
    case 'AccumulationRegister': {
      const o = object as { registerType?: string }
      return {
        registerType: o.registerType as StandardAttributeSettings['registerType'],
      }
    }
    case 'CustomTable': {
      const o = object as { autoAddPrimaryKey?: boolean }
      return {
        autoAddPrimaryKey: o.autoAddPrimaryKey,
      }
    }
    default:
      return {}
  }
}
