import { z } from "zod"

/** BRD §6.1–6.2 — Усі типи полів: примітивні + Ref (посилання) */
export const fieldTypeSchema = z.enum([
  "UUID",
  "String",
  "Text",
  "Integer",
  "Numeric",
  "Boolean",
  "Date",
  "DateTime",
  "Binary",
  "Ref",
])

export type FieldType = z.infer<typeof fieldTypeSchema>
