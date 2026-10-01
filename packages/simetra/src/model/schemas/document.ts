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
  .strictObject({
    register: metadataRefSchema.meta({
      description: "Register that receives the movement.",
    }),
    source: z
      .union([
        z.literal("document"),
        z.strictObject({
          tabularSection: z.string().min(1).meta({
            description: "Name of the tabular section that produces the rows.",
          }),
        }),
      ])
      .meta({
        description:
          "Where movement rows come from: the document itself or one of its tabular sections.",
      }),
    condition: z.string().min(1).optional().meta({
      description: "Expression; the movement is written only when it is true.",
    }),
    // Рівно "Receipt" / "Expense" — літерал, будь-який інший рядок — вираз.
    movementType: z.string().min(1).optional().meta({
      description:
        "Receipt or Expense literal for a balance register, otherwise an expression.",
    }),
    period: z.string().min(1).optional().meta({
      description: "Expression for the movement period.",
    }),
    fields: z.record(z.string().min(1), z.string().min(1)).meta({
      description:
        "Register field name to expression; the register defines each field role.",
    }),
  })
  .meta({ description: "One movement of the document into a register." })
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
export const documentSchema = z.strictObject({
  ...objectHeaderShape,
  kind: z
    .literal("Document")
    .meta({ description: "Metadata kind; always Document." }),

  numberLength: z
    .number()
    .int()
    .positive()
    .default(11)
    .meta({ description: "Length of the document number." }),
  numberType: z
    .enum(["String", "Number"])
    .default("String")
    .meta({ description: "Value type of the document number." }),
  autonumber: z
    .boolean()
    .default(true)
    .meta({ description: "Whether the number is generated automatically." }),
  numberPeriodicity: z
    .enum(["None", "Year", "Quarter", "Month", "Day"])
    .default("Year")
    .meta({
      description: "Period after which automatic numbering restarts.",
    }),
  posting: z
    .strictObject({
      movements: z.array(movementDeclSchema).default([]).meta({
        description: "Declared movements written when the document is posted.",
      }),
    })
    .optional()
    .meta({ description: "Posting declaration of the document." }),
  registerMovements: z.array(metadataRefSchema).default([]).meta({
    description: "Registers the document writes movements into.",
  }),

  standardAttributeOverrides: standardAttributeOverridesSchema,

  attributes: z
    .array(attributeSchema)
    .default([])
    .meta({ description: "Custom attributes of the document." }),
  tabularSections: z
    .array(tabularSectionSchema)
    .default([])
    .meta({ description: "Tabular sections of the document." }),
})

export type Document = z.infer<typeof documentSchema>
