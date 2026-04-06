import { useCallback } from "react"
import type { Attribute, MetadataKind, MetadataObject } from "@simetra/core"
import { useMetadataStore } from "@/stores/metadata-store"

export type FieldRole =
  | "attributes"
  | "dimensions"
  | "resources"
  | "tabularSection"

export interface FieldTarget {
  kind: MetadataKind
  objectName: string
  fieldName: string
  role: FieldRole
  tabularSectionName?: string
}

/** Визначає field role для правильного dispatch */
export function getFieldRole(
  object: MetadataObject,
  fieldName: string,
  tabularSectionName?: string
): FieldRole {
  if (tabularSectionName) return "tabularSection"

  if ("dimensions" in object) {
    const dims = object.dimensions as Attribute[]
    if (dims.some((a) => a.name === fieldName)) return "dimensions"
  }

  if ("resources" in object) {
    const res = object.resources as Attribute[]
    if (res.some((a) => a.name === fieldName)) return "resources"
  }

  return "attributes"
}

/** Shared hook — розподіляє оновлення атрибутів до відповідних store actions */
export function useFieldUpdate() {
  const {
    updateAttribute,
    updateDimension,
    updateResource,
    updateTabularSectionAttribute,
  } = useMetadataStore()

  return useCallback(
    (target: FieldTarget, updates: Partial<Attribute>) => {
      switch (target.role) {
        case "dimensions":
          updateDimension(
            target.kind,
            target.objectName,
            target.fieldName,
            updates
          )
          break
        case "resources":
          updateResource(
            target.kind,
            target.objectName,
            target.fieldName,
            updates
          )
          break
        case "tabularSection":
          if (target.tabularSectionName) {
            updateTabularSectionAttribute(
              target.kind,
              target.objectName,
              target.tabularSectionName,
              target.fieldName,
              updates
            )
          }
          break
        default:
          updateAttribute(
            target.kind,
            target.objectName,
            target.fieldName,
            updates
          )
      }
    },
    [
      updateAttribute,
      updateDimension,
      updateResource,
      updateTabularSectionAttribute,
    ]
  )
}
