import { z } from "zod"

/**
 * Localized string: at least one locale required.
 * BRD: {uk, en} — Ukrainian first, English second.
 */
export const localizedStringSchema = z
  .object({
    uk: z.string().optional(),
    en: z.string().optional(),
  })
  .refine((val) => val.uk !== undefined || val.en !== undefined, {
    message: "At least one locale (uk or en) must be provided",
  })

export type LocalizedString = z.infer<typeof localizedStringSchema>
