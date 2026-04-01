import { z } from "zod"

/** BRD §6.2 — Reference to another metadata object (used in recorderTypes, owners, allowedTypes) */
export const metadataRefSchema = z.object({
  kind: z.string(),
  name: z.string(),
})

export type MetadataRef = z.infer<typeof metadataRefSchema>
