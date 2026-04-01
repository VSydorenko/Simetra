import { z } from "zod"

/** BRD §6.1 — Primitive types */
export const primitiveFieldType = z.enum([
  "UUID",
  "String",
  "Text",
  "Integer",
  "Numeric",
  "Boolean",
  "Date",
  "DateTime",
  "Binary",
])

/** BRD §6.2 — Reference types */
export const referenceFieldType = z.enum([
  "CatalogRef",
  "DocumentRef",
  "EnumRef",
  "AnyRef",
])

/** Combined field type */
export const fieldTypeSchema = z.union([primitiveFieldType, referenceFieldType])

export type PrimitiveFieldType = z.infer<typeof primitiveFieldType>
export type ReferenceFieldType = z.infer<typeof referenceFieldType>
export type FieldType = z.infer<typeof fieldTypeSchema>
