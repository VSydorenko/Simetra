import { z } from "zod"

/**
 * Перелік видів метаданих — частина форми посилання `MetadataRef`. Поведінка
 * видів живе поруч у T0, у реєстрі видів (`model/kinds`), а не тут: схема
 * посилання не залежить від знань про види.
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
