import { z } from "zod"
import { localizedStringSchema } from "./localized-string"

/**
 * BRD §5.3.1 — Декларативний маппінг проведення документів.
 *
 * Mapping expression — вираз, що описує, звідки беруться дані для поля регістру:
 * - doc.{field} — реквізит документа
 * - row.{field} — поле рядка табличної частини (тільки source = tabularSection)
 * - row.{a} * row.{b} — арифметика між полями одного рядка (+, -, *, /)
 * - sum({ts}.{field}) — агрегація по полю табличної частини
 * - count({ts}) — кількість рядків табличної частини
 * - literal:{value} — фіксоване значення
 * - now() — поточний timestamp
 */
const MAPPING_EXPR_PATTERN =
  /^(doc\.\w+|row\.\w+(\s*[+\-*/]\s*row\.\w+)*|sum\(\w+\.\w+\)|count\(\w+\)|literal:.+|now\(\))$/

export const mappingExpressionSchema = z
  .string()
  .min(1)
  .regex(
    MAPPING_EXPR_PATTERN,
    "Invalid mapping expression. Allowed: doc.field, row.field, row.a * row.b, sum(ts.field), count(ts), literal:value, now()",
  )

export type MappingExpression = z.infer<typeof mappingExpressionSchema>

/** Kinds, на які може посилатися posting (тільки регістри) */
export const registerKindSchema = z.enum([
  "InformationRegister",
  "AccumulationRegister",
])

export type RegisterKind = z.infer<typeof registerKindSchema>

/** MetadataRef, обмежений тільки регістрами — для posting.register */
export const registerRefSchema = z.object({
  kind: registerKindSchema,
  name: z.string(),
})

export type RegisterRef = z.infer<typeof registerRefSchema>

/** Набір маппінгів полів документа → полів регістру */
export const movementMappingSetSchema = z.object({
  dimensions: z.record(z.string(), mappingExpressionSchema).default({}),
  resources: z.record(z.string(), mappingExpressionSchema).default({}),
  attributes: z.record(z.string(), mappingExpressionSchema).default({}),
})

export type MovementMappingSet = z.infer<typeof movementMappingSetSchema>

/** Тип руху: фіксований або динамічний (з реквізиту документа) */
const MOVEMENT_TYPE_PATTERN = /^(Receipt|Expense|doc\.\w+)$/

export const movementTypeSchema = z
  .string()
  .regex(
    MOVEMENT_TYPE_PATTERN,
    "Must be 'Receipt', 'Expense', or a document field reference (doc.fieldName)",
  )

export type MovementType = z.infer<typeof movementTypeSchema>

/** Джерело рядків: весь документ або рядки табличної частини */
const MOVEMENT_SOURCE_PATTERN = /^(document|tabularSection:\w+)$/

export const movementSourceSchema = z
  .string()
  .regex(
    MOVEMENT_SOURCE_PATTERN,
    "Must be 'document' or 'tabularSection:{name}'",
  )

export type MovementSource = z.infer<typeof movementSourceSchema>

/** Перевірка чи вираз використовує row.* або арифметику row */
function usesRowExpr(expr: string): boolean {
  return /\brow\.\w+/.test(expr)
}

/** Перевірка чи вираз використовує sum() або count() */
function usesAggregation(expr: string): boolean {
  return /^(sum|count)\(/.test(expr)
}

/** Один рух документа → регістр */
export const postingMovementSchema = z
  .object({
    register: registerRefSchema,
    movementType: movementTypeSchema,
    source: movementSourceSchema,
    condition: z.string().nullable().optional(),
    mappings: movementMappingSetSchema,
  })
  .superRefine((movement, ctx) => {
    const isDocumentSource = movement.source === "document"
    const allExprs = [
      ...Object.entries(movement.mappings.dimensions),
      ...Object.entries(movement.mappings.resources),
      ...Object.entries(movement.mappings.attributes),
    ]

    for (const [field, expr] of allExprs) {
      // row.* дозволено тільки для tabularSection source
      if (isDocumentSource && usesRowExpr(expr)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Mapping "${field}": row.* expressions are only allowed when source is tabularSection, not "document"`,
          path: ["mappings"],
        })
      }

      // sum()/count() дозволено тільки для document source
      if (!isDocumentSource && usesAggregation(expr)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Mapping "${field}": sum()/count() aggregations are only allowed when source is "document", not "${movement.source}"`,
          path: ["mappings"],
        })
      }
    }
  })

export type PostingMovement = z.infer<typeof postingMovementSchema>

/** Валідація при проведенні (MVP — тільки NonNegativeBalance) */
export const postingValidationSchema = z.object({
  type: z.literal("NonNegativeBalance"),
  register: registerRefSchema,
  dimensions: z.array(z.string().min(1)),
  resource: z.string().min(1),
  message: localizedStringSchema,
  applyTo: z.enum(["Receipt", "Expense", "Both"]).default("Expense"),
})

export type PostingValidation = z.infer<typeof postingValidationSchema>

/** Секція posting документа — декларативний маппінг проведення */
export const postingSchema = z.object({
  movements: z.array(postingMovementSchema).default([]),
  validations: z.array(postingValidationSchema).default([]),
})

export type Posting = z.infer<typeof postingSchema>
