import { z } from "zod"

/**
 * Перелік видів метаданих. Сам перелік живе в T0, бо вид — частина форми
 * посилання `MetadataRef`; поведінка видів (реєстр) належить вищому шару.
 */
export const METADATA_KINDS = [
  "Catalog",
  "Document",
  "Enumeration",
  "InformationRegister",
  "AccumulationRegister",
  "Constant",
  "CustomTable",
  "PgEnum",
] as const

export const metadataKindSchema = z.enum(METADATA_KINDS)

export type MetadataKind = z.infer<typeof metadataKindSchema>
