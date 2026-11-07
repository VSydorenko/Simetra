import { z } from "zod"
import { DATABASE_PROVIDERS } from "../schemas/project"
import { catalogEntrySchema } from "./catalog"

/**
 * The client catalog (`client-catalog.json`): the shared part of each runtime
 * catalog entry, without what only the server core needs (P4-B spec §3).
 */
export const clientCatalogSchema = z
  .strictObject({
    format: z.literal(1),
    snapshotHash: z.string(),
    provider: z.enum(DATABASE_PROVIDERS),
    objects: z.array(catalogEntrySchema),
  })
  .superRefine((catalog, ctx) => {
    // Клієнт мапить `creatorMember` записом довідника членства з цього ж
    // каталогу: без нього мапінг не мав би, за чим іти.
    const ids = new Set(catalog.objects.map((o) => o.id))
    catalog.objects.forEach((object, index) => {
      if (
        object.creatorMembership !== undefined &&
        !ids.has(object.creatorMembership)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["objects", index, "creatorMembership"],
          message: "creatorMembership is not an object of this catalog",
        })
      }
    })
  })

export type ClientCatalog = z.infer<typeof clientCatalogSchema>
