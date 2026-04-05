import type { MetadataKind } from "./schemas/metadata-kind"
import type { MetadataRef } from "./schemas/metadata-ref"
import type { Attribute } from "./schemas/attribute"
import type { MetadataObject, ProjectModel } from "./schemas/project-model"

/** Structured reference kind — replaces free-form `via: string` */
export type ReferenceKind =
  | "owners"
  | "recorderTypes"
  | "registerMovements"
  | "attributeRef"
  | "attributeAllowedTypes"

/** A structured reference from one object to another */
export interface Reference {
  /** The object that holds the reference */
  from: MetadataRef
  /** Category of reference */
  referenceKind: ReferenceKind
  /** Attribute/field name (for attributeRef / attributeAllowedTypes) */
  fieldName?: string
  /** Tabular section name if attribute belongs to a tabular section */
  tabularSectionName?: string
}

/** Mapping MetadataKind → ProjectModel collection key */
export const KIND_TO_KEY: Record<
  MetadataKind,
  keyof Omit<ProjectModel, "project">
> = {
  Catalog: "catalogs",
  Document: "documents",
  Enumeration: "enumerations",
  InformationRegister: "informationRegisters",
  AccumulationRegister: "accumulationRegisters",
  Constant: "constants",
  CustomTable: "customTables",
}

/** Структуровані дані посилання для display у UI */
export interface FormattedReference {
  /** Ім'я поля (attribute/dimension/resource) */
  fieldName: string | undefined
  /** Ім'я табличної частини, якщо поле в ТЧ */
  tabularSectionName: string | undefined
  /** Тип посилання */
  referenceKind: ReferenceKind
}

/** Витягує структуровані дані з Reference для display у UI */
export function formatReference(ref: Reference): FormattedReference {
  return {
    fieldName: ref.fieldName,
    tabularSectionName: ref.tabularSectionName,
    referenceKind: ref.referenceKind,
  }
}

interface AttributeWithContext {
  attribute: Attribute
  tabularSectionName?: string
}

/** Collect all attributes from a metadata object, preserving tabular section context */
function getObjectAttributesWithContext(
  obj: MetadataObject,
): AttributeWithContext[] {
  const result: AttributeWithContext[] = []

  if ("attributes" in obj && Array.isArray(obj.attributes)) {
    for (const attr of obj.attributes) {
      result.push({ attribute: attr })
    }
  }
  if ("dimensions" in obj && Array.isArray(obj.dimensions)) {
    for (const attr of obj.dimensions) {
      result.push({ attribute: attr })
    }
  }
  if ("resources" in obj && Array.isArray(obj.resources)) {
    for (const attr of obj.resources) {
      result.push({ attribute: attr })
    }
  }
  if ("tabularSections" in obj && Array.isArray(obj.tabularSections)) {
    for (const ts of obj.tabularSections) {
      if (Array.isArray(ts.attributes)) {
        for (const attr of ts.attributes) {
          result.push({ attribute: attr, tabularSectionName: ts.name })
        }
      }
    }
  }

  return result
}

/** Collect all metadata objects from the project model */
function getAllObjects(model: ProjectModel): MetadataObject[] {
  const kinds: MetadataKind[] = [
    "Catalog",
    "Document",
    "Enumeration",
    "InformationRegister",
    "AccumulationRegister",
    "Constant",
    "CustomTable",
  ]
  const result: MetadataObject[] = []
  for (const kind of kinds) {
    const key = KIND_TO_KEY[kind]
    result.push(...(model[key] as MetadataObject[]))
  }
  return result
}

/** Find all references to a target object across the project model */
export function findReferences(
  model: ProjectModel,
  targetKind: MetadataKind,
  targetName: string,
): Reference[] {
  const refs: Reference[] = []
  const allObjects = getAllObjects(model)

  for (const obj of allObjects) {
    const objRef: MetadataRef = { kind: obj.kind, name: obj.name }

    // Direct references: owners, recorderTypes, registerMovements
    if ("owners" in obj && Array.isArray(obj.owners)) {
      for (const owner of obj.owners) {
        if (owner.kind === targetKind && owner.name === targetName) {
          refs.push({ from: objRef, referenceKind: "owners" })
        }
      }
    }

    if ("recorderTypes" in obj && Array.isArray(obj.recorderTypes)) {
      for (const recorder of obj.recorderTypes) {
        if (recorder.kind === targetKind && recorder.name === targetName) {
          refs.push({ from: objRef, referenceKind: "recorderTypes" })
        }
      }
    }

    if ("registerMovements" in obj && Array.isArray(obj.registerMovements)) {
      for (const movement of obj.registerMovements) {
        if (movement.kind === targetKind && movement.name === targetName) {
          refs.push({ from: objRef, referenceKind: "registerMovements" })
        }
      }
    }

    // Attribute type references — with tabular section context
    const attrsWithContext = getObjectAttributesWithContext(obj)
    for (const { attribute: attr, tabularSectionName } of attrsWithContext) {
      if (
        attr.ref &&
        attr.ref.kind === targetKind &&
        attr.ref.name === targetName
      ) {
        refs.push({
          from: objRef,
          referenceKind: "attributeRef",
          fieldName: attr.name,
          tabularSectionName,
        })
      }
      if (attr.allowedTypes) {
        for (const allowed of attr.allowedTypes) {
          if (allowed.kind === targetKind && allowed.name === targetName) {
            refs.push({
              from: objRef,
              referenceKind: "attributeAllowedTypes",
              fieldName: attr.name,
              tabularSectionName,
            })
          }
        }
      }
    }
  }

  return refs
}
