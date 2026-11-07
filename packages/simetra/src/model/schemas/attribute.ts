import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import type { SchemaRule } from "./rules"
import {
  elementNameSchema,
  metadataIdSchema,
  physicalNameSchema,
} from "./identity"
import {
  defaultValueSchema,
  refineUnique,
  refineUniqueWithin,
  refineValueChecks,
  refineValueType,
  valueTypeShape,
} from "./value-type"

/**
 * Поле значення: реквізит, вимір чи ресурс регістра. Унікальність імен у
 * масиві й стиль написання імені перевіряють пізніші стадії — схема лише
 * описує форму.
 */
const fieldShape = {
  id: metadataIdSchema.optional(),
  name: elementNameSchema,
  physicalName: physicalNameSchema.optional(),
  title: localizedStringSchema.optional().meta({
    description: "Human-readable title of the attribute.",
  }),
  description: localizedStringSchema.optional().meta({
    description: "Description of the attribute.",
  }),
  ...valueTypeShape,
  required: z
    .boolean()
    .default(false)
    .meta({ description: "Whether a value is mandatory (NOT NULL)." }),
  indexed: z
    .boolean()
    .default(false)
    .meta({ description: "Whether the attribute is indexed." }),
  unique: z
    .union([z.boolean(), z.literal("ignoreCase")])
    .default(false)
    .meta({
      description:
        'Whether values must be unique; "ignoreCase" compares a scalar String or Text value case-insensitively.',
    }),
  defaultValue: defaultValueSchema
    .optional()
    .meta({ description: "Default value of the attribute." }),
  nonNegative: z.literal(true).optional().meta({
    description:
      "Value must be zero or greater (CHECK); scalar Integer, SmallInt, BigInt or Numeric; excludes positive.",
  }),
  positive: z.literal(true).optional().meta({
    description:
      "Value must be greater than zero (CHECK); scalar Integer, SmallInt, BigInt or Numeric; excludes nonNegative.",
  }),
  minValue: z.union([z.number(), z.string()]).optional().meta({
    description:
      "Lower bound of the value (CHECK): a number or a decimal-fraction string within the type's range; numeric types only.",
  }),
  maxValue: z.union([z.number(), z.string()]).optional().meta({
    description:
      "Upper bound of the value (CHECK): a number or a decimal-fraction string within the type's range; must not be below minValue; numeric types only.",
  }),
  pattern: z.string().min(1).optional().meta({
    description:
      "Regular expression the value must match (CHECK); valid for both JavaScript (u flag) and Postgres, so no named groups, \\p{...}, \\k<...>, \\b, \\B, \\x, \\u{...} or (?flags) groups; scalar String or Text only.",
  }),
  minLength: z.number().int().positive().optional().meta({
    description:
      "Minimum number of characters (CHECK); scalar String or Text only.",
  }),
}

/** Реквізит: поле значення, яке може бути персональним. */
const attributeShape = {
  ...fieldShape,
  personalData: z.literal(true).optional().meta({
    description:
      "Marks the attribute as personal data: anonymization sets its columns to NULL, so it cannot be required.",
  }),
  load: z.enum(["eager", "lazy"]).optional().meta({
    description:
      'Whether list reads omit the attribute ("lazy"; a card read returns it); default lazy for Bytes of the header, eager otherwise. Not allowed on a polymorphic Ref, a tabular section attribute, a register attribute or a rights carrier.',
  }),
  maxBytes: z.int().positive().optional().meta({
    description:
      "Most UTF-8 bytes of the JSON wire value a command may write; Text, Json, Bytes or an array only (the whole array counts). Default 1 MiB for Json and Bytes, 64 KiB for Text and arrays. Not allowed on a register attribute.",
  }),
}

/**
 * Типові `maxBytes` (спека П4-B Рд26): `Json` і `Bytes` несуть документи й
 * файли, `Text` і масиви — довгий текст; більше — лише явним `maxBytes`, щоб
 * важке значення не проходило мовчки крізь бюджет відповіді.
 */
const MAX_BYTES_DEFAULTS = {
  Json: 1024 * 1024,
  Bytes: 1024 * 1024,
  Text: 64 * 1024,
} as const
const ARRAY_MAX_BYTES = 64 * 1024

/**
 * The effective `maxBytes` of a value type: the explicit one or the default
 * of its type; `undefined` for a type without a byte limit.
 */
export function effectiveMaxBytes(value: {
  type: string
  array?: boolean
  maxBytes?: number
}): number | undefined {
  if (value.maxBytes !== undefined) return value.maxBytes
  if (value.array === true) return ARRAY_MAX_BYTES
  return Object.hasOwn(MAX_BYTES_DEFAULTS, value.type)
    ? MAX_BYTES_DEFAULTS[value.type as keyof typeof MAX_BYTES_DEFAULTS]
    : undefined
}

/**
 * `maxBytes` — лише там, де значення росте без межі типу: `String` має
 * `length`, решта скалярів — сталий розмір, тож межа в байтах їм нічого б
 * не дала й лише ввела б в оману.
 */
function refineMaxBytes(
  value: { type: string; array?: boolean; maxBytes?: number },
  ctx: z.RefinementCtx
): void {
  if (value.maxBytes === undefined) return
  if (value.array === true || Object.hasOwn(MAX_BYTES_DEFAULTS, value.type)) {
    return
  }
  ctx.addIssue({
    code: "custom",
    message: "maxBytes applies only to Text, Json, Bytes or an array",
    path: ["maxBytes"],
    params: { rule: "type.max-bytes-type" satisfies SchemaRule },
  })
}

/**
 * Знеособлення ставить колонку в `NULL`, тож обов'язковий персональний
 * реквізит зробив би його неможливим — відхиляємо на схемі.
 */
function refinePersonalData(
  value: { personalData?: true; required: boolean },
  ctx: z.RefinementCtx
): void {
  if (value.personalData === true && value.required) {
    ctx.addIssue({
      code: "custom",
      message: "A personalData attribute cannot be required",
      path: ["personalData"],
      params: { rule: "attribute.personal-data-required" satisfies SchemaRule },
    })
  }
}

/**
 * Поліморфна пара лінивою не буває (Рд25): фасад звіряє обидві колонки пари
 * разом, а списочний рядок без однієї з них — напівпосилання.
 */
function refineLoad(
  value: { load?: "eager" | "lazy"; allowedTypes?: unknown },
  ctx: z.RefinementCtx
): void {
  if (value.load === "lazy" && value.allowedTypes !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "A polymorphic Ref cannot be lazy",
      path: ["load"],
      params: { rule: "attribute.lazy-not-allowed" satisfies SchemaRule },
    })
  }
}

export const attributeSchema = z
  .strictObject(attributeShape)
  .superRefine((value, ctx) => {
    refineValueType(value, ctx)
    refineUnique(value, ctx)
    refineValueChecks(value, ctx)
    refinePersonalData(value, ctx)
    refineLoad(value, ctx)
    refineMaxBytes(value, ctx)
  })

/**
 * Власний реквізит довідника: лише тут має сенс `uniqueWithin` (власник і
 * батько — стандартні реквізити довідника). Місце за налаштуваннями довідника
 * (є власники, є ієрархія) перевіряє стадія 4.
 */
export const catalogAttributeSchema = z
  .strictObject({
    ...attributeShape,
    uniqueWithin: z.enum(["owner", "parent"]).optional().meta({
      description:
        "Narrows uniqueness to the owner or the parent of the object (needs unique; own attributes of an object whose kind has that standard attribute).",
    }),
  })
  .superRefine((value, ctx) => {
    refineValueType(value, ctx)
    refineUnique(value, ctx)
    refineValueChecks(value, ctx)
    refinePersonalData(value, ctx)
    refineLoad(value, ctx)
    refineMaxBytes(value, ctx)
    refineUniqueWithin(value, ctx)
  })

/**
 * Вимір регістра чи ресурс регістра відомостей: форма реквізиту без
 * `personalData`. Персональне в розрізі обліку — посилання на довідник, і
 * знеособлюється рядок довідника, а не ключ чи значення запису регістра;
 * строга схема відкидає поле як невідомий ключ.
 */
export const registerFieldSchema = z
  .strictObject(fieldShape)
  .superRefine((value, ctx) => {
    refineValueType(value, ctx)
    refineUnique(value, ctx)
    refineValueChecks(value, ctx)
  })

export type Attribute = z.infer<typeof attributeSchema>
export type CatalogAttribute = z.infer<typeof catalogAttributeSchema>

/**
 * Реквізити регістра: рантайм регістрів ще не читає (Рд1), тож `load` і
 * `maxBytes` на них нічого б не робили — споживач чекав би ефекту, якого
 * немає. Правила знімуть разом із винятками ратчета полів, коли регістри
 * ввійдуть у каталог рантайму.
 */
export const registerAttributesSchema = z
  .array(attributeSchema)
  .superRefine((attributes, ctx) => {
    attributes.forEach((attribute, index) => {
      if (attribute.load !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            "A register attribute cannot set load: the runtime does not read registers yet",
          path: [index, "load"],
          params: { rule: "attribute.load-not-allowed" satisfies SchemaRule },
        })
      }
      if (attribute.maxBytes !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            "A register attribute cannot set maxBytes: the runtime does not read registers yet",
          path: [index, "maxBytes"],
          params: {
            rule: "attribute.max-bytes-not-allowed" satisfies SchemaRule,
          },
        })
      }
    })
  })
