import { z } from "zod"
import { metadataKindSchema } from "./metadata-kind"

/** BRD §6.2 — Reference to another metadata object (used in recorderTypes, owners, allowedTypes) */
export const metadataRefSchema = z.object({
  kind: metadataKindSchema,
  name: z.string(),
})

export type MetadataRef = z.infer<typeof metadataRefSchema>

/** Kinds, на які може посилатися реквізит (attribute.ref / attribute.allowedTypes) */
export const referenceableKindSchema = z.enum(["Catalog", "Document", "Enumeration"])

export type ReferenceableKind = z.infer<typeof referenceableKindSchema>

/** Обмежений MetadataRef для attribute references — лише referenceable kinds */
export const attributeRefTargetSchema = z.object({
  kind: referenceableKindSchema,
  name: z.string(),
})
