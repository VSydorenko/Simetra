import { z } from "zod"
import { attributeSchema } from "./attribute"
import { tabularSectionSchema } from "./tabular-section"
import { metadataRefSchema } from "./metadata-ref"
import { parseExpression } from "../posting"
import {
  objectHeaderShape,
  standardAttributeOverridesSchema,
} from "./object-header"

/**
 * Один рух документа в регістр (конструктор рухів, спека П2 §7). `fields` —
 * плаский словник «поле регістра → вираз»: роль поля (вимір, ресурс,
 * реквізит) відома регістру, документу її дублювати не треба.
 */
const movementDeclSchema = z
  .object({
    register: metadataRefSchema,
    source: z.union([
      z.literal("document"),
      z.object({ tabularSection: z.string().min(1) }),
    ]),
    condition: z.string().min(1).optional(),
    // Рівно "Receipt" / "Expense" — літерал, будь-який інший рядок — вираз.
    movementType: z.string().min(1).optional(),
    period: z.string().min(1).optional(),
    fields: z.record(z.string().min(1), z.string().min(1)),
  })
  .superRefine((movement, ctx) => {
    // Розбір тут, а не на стадії 4: синтаксична помилка має вказувати на поле
    // з виразом і зміщення в рядку, а не на весь файл.
    const check = (text: string | undefined, path: (string | number)[]) => {
      if (text === undefined) return
      const result = parseExpression(text)
      if (result.ok) return
      ctx.addIssue({
        code: "custom",
        message: result.message,
        path,
        params: { rule: "posting.parse", offset: result.offset },
      })
    }
    check(movement.condition, ["condition"])
    if (
      movement.movementType !== "Receipt" &&
      movement.movementType !== "Expense"
    ) {
      check(movement.movementType, ["movementType"])
    }
    check(movement.period, ["period"])
    for (const [name, text] of Object.entries(movement.fields)) {
      check(text, ["fields", name])
    }
  })

export type MovementDecl = z.infer<typeof movementDeclSchema>

/** Документ. */
export const documentSchema = z.object({
  ...objectHeaderShape,
  kind: z.literal("Document"),

  numberLength: z.number().int().positive().default(11),
  numberType: z.enum(["String", "Number"]).default("String"),
  autonumber: z.boolean().default(true),
  numberPeriodicity: z
    .enum(["None", "Year", "Quarter", "Month", "Day"])
    .default("Year"),
  posting: z
    .object({ movements: z.array(movementDeclSchema).default([]) })
    .optional(),
  registerMovements: z.array(metadataRefSchema).default([]),

  standardAttributeOverrides: standardAttributeOverridesSchema,

  attributes: z.array(attributeSchema).default([]),
  tabularSections: z.array(tabularSectionSchema).default([]),
})

export type Document = z.infer<typeof documentSchema>
