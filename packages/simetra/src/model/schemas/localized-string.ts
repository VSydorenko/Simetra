import { z } from "zod"

/**
 * Localized string: at least one locale required.
 * BRD: {uk, en} — Ukrainian first, English second.
 */
export const localizedStringSchema = z
  .object({
    uk: z.string().optional().meta({ description: "Ukrainian text." }),
    en: z.string().optional().meta({ description: "English text." }),
  })
  .refine((val) => val.uk !== undefined || val.en !== undefined, {
    message: "At least one locale (uk or en) must be provided",
  })
  .meta({
    description: "Text per locale; at least one of uk or en is required.",
  })

export type LocalizedString = z.infer<typeof localizedStringSchema>
