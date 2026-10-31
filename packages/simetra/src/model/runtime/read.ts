import { z } from "zod"
import { metadataRefSchema } from "../schemas/metadata-ref"

/** Upper bound of one server read page (P4 spec §6.11). */
export const READ_LIMIT_MAX = 200

/** A server read: one row by id or a keyset page by equality filter. */
export const readQuerySchema = z.union([
  z.strictObject({ object: metadataRefSchema, id: z.guid() }),
  z.strictObject({
    object: metadataRefSchema,
    where: z.record(z.string(), z.unknown()),
    after: z.guid().optional(),
    limit: z.int().min(1).max(READ_LIMIT_MAX),
  }),
])

export type ReadQuery = z.infer<typeof readQuerySchema>
