import type {
  MetadataKind,
  MetadataObject,
  MetadataRef,
  ProjectModel,
  Attribute,
} from "@simetra/core"
import { KIND_TO_KEY } from "./metadata-defaults"

interface Reference {
  /** Обʼєкт, що посилається */
  from: MetadataRef
  /** Тип посилання (owners, recorderTypes, registerMovements, attributeType) */
  via: string
}

/** Пошук обʼєктів, що посилаються на зазначений обʼєкт */
export function findReferences(
  model: ProjectModel,
  targetKind: MetadataKind,
  targetName: string
): Reference[] {
  const refs: Reference[] = []

  const allObjects = getAllObjects(model)

  for (const obj of allObjects) {
    const objRef: MetadataRef = { kind: obj.kind, name: obj.name }

    // Перевірка прямих посилань (owners, recorderTypes, registerMovements)
    if ("owners" in obj && Array.isArray(obj.owners)) {
      for (const owner of obj.owners) {
        if (owner.kind === targetKind && owner.name === targetName) {
          refs.push({ from: objRef, via: "owners" })
        }
      }
    }

    if ("recorderTypes" in obj && Array.isArray(obj.recorderTypes)) {
      for (const recorder of obj.recorderTypes) {
        if (recorder.kind === targetKind && recorder.name === targetName) {
          refs.push({ from: objRef, via: "recorderTypes" })
        }
      }
    }

    if ("registerMovements" in obj && Array.isArray(obj.registerMovements)) {
      for (const movement of obj.registerMovements) {
        if (movement.kind === targetKind && movement.name === targetName) {
          refs.push({ from: objRef, via: "registerMovements" })
        }
      }
    }

    // Перевірка типів атрибутів (ref = MetadataRef, allowedTypes = MetadataRef[])
    const allAttributes = getObjectAttributes(obj)
    for (const attr of allAttributes) {
      if (
        attr.ref &&
        attr.ref.kind === targetKind &&
        attr.ref.name === targetName
      ) {
        refs.push({ from: objRef, via: `attribute "${attr.name}" ref` })
      }
      if (attr.allowedTypes) {
        for (const allowed of attr.allowedTypes) {
          if (allowed.kind === targetKind && allowed.name === targetName) {
            refs.push({
              from: objRef,
              via: `attribute "${attr.name}" allowedTypes`,
            })
          }
        }
      }
    }
  }

  return refs
}

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

function getObjectAttributes(obj: MetadataObject): Attribute[] {
  const attrs: Attribute[] = []

  if ("attributes" in obj && Array.isArray(obj.attributes)) {
    attrs.push(...obj.attributes)
  }
  if ("dimensions" in obj && Array.isArray(obj.dimensions)) {
    attrs.push(...obj.dimensions)
  }
  if ("resources" in obj && Array.isArray(obj.resources)) {
    attrs.push(...obj.resources)
  }
  if ("tabularSections" in obj && Array.isArray(obj.tabularSections)) {
    for (const ts of obj.tabularSections) {
      if (Array.isArray(ts.attributes)) {
        attrs.push(...ts.attributes)
      }
    }
  }

  return attrs
}

export type { Reference }
