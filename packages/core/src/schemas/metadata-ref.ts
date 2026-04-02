import { z } from "zod"
import { metadataKindSchema } from "./metadata-kind"

/** BRD §6.2 — Reference to another metadata object (used in recorderTypes, owners, allowedTypes) */
export const metadataRefSchema = z.object({
  kind: metadataKindSchema,
  name: z.string(),
})

export type MetadataRef = z.infer<typeof metadataRefSchema>
