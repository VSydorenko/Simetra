import { z } from "zod"

/** BRD §5.1 — Metadata type registry */
export const metadataKindSchema = z.enum([
  "Catalog",
  "Document",
  "Enumeration",
  "InformationRegister",
  "AccumulationRegister",
  "Constant",
  "CustomTable",
])

export type MetadataKind = z.infer<typeof metadataKindSchema>
