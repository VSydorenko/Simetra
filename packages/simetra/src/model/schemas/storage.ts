import { z } from "zod"
import type { SchemaRule } from "./rules"

/**
 * Стеля розміру одного файлу: `put` буферизує тіло для `ContentLength`, тож
 * межа конфігурації не може бути довільно великою (рішення Р7 ПГ-5).
 */
export const STORAGE_MAX_BYTES = 104857600

// `type/subtype` малими літерами без параметрів: тип вмісту порівнюється
// рядком, тож нормальна форма має бути єдиною.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/

/** Сховище файлів довідника: межа розміру й дозволені типи вмісту. */
export const storageSchema = z
  .strictObject({
    maxBytes: z.int().min(1).max(STORAGE_MAX_BYTES).meta({
      description:
        "Largest accepted file size in bytes, 1 to the platform ceiling.",
    }),
    mediaTypes: z.array(z.string()).meta({
      description:
        "Accepted content types: a non-empty list of unique lowercase type/subtype strings without parameters.",
    }),
  })
  .superRefine((storage, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({
        code: "custom",
        message,
        path,
        params: { rule: "storage.media-type" satisfies SchemaRule },
      })
    if (storage.mediaTypes.length === 0) {
      issue("mediaTypes must list at least one media type", ["mediaTypes"])
    }
    const seen = new Set<string>()
    storage.mediaTypes.forEach((type, index) => {
      if (!MEDIA_TYPE.test(type)) {
        issue(`"${type}" is not a lowercase type/subtype without parameters`, [
          "mediaTypes",
          index,
        ])
      } else if (seen.has(type)) {
        issue(`Media type "${type}" is listed twice`, ["mediaTypes", index])
      }
      seen.add(type)
    })
  })
  .meta({
    description:
      "File storage of a catalog: each row is one file, its bytes live outside the database.",
  })

export type Storage = z.infer<typeof storageSchema>
