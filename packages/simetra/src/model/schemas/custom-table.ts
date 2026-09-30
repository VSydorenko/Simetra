import { z } from "zod"
import {
  elementNameSchema,
  objectNameSchema,
  physicalNameSchema,
} from "./identity"
import { localizedStringSchema } from "./localized-string"
import { metadataRefSchema } from "./metadata-ref"
import { objectHeaderShape } from "./object-header"
import type { SchemaRule } from "./rules"
import { LOGICAL_TYPES, refineValueType, valueTypeShape } from "./value-type"

const IDENTITY_TYPES: readonly string[] = ["SmallInt", "Integer", "BigInt"]

/**
 * Колонка описується рівно однією з трьох форм типу: логічний тип, посилання
 * на `PgEnum` або сирий PG-тип (`Raw` — єдине місце, де допустимий сирий тип).
 * Форму розрізняє `type`; поля всіх форм оголошені разом, щоб невалідна
 * комбінація давала правило `customTable.column-type` зі шляхом до
 * конкретного поля, а не загальну помилку об'єднання.
 */
export const customTableColumnSchema = z
  .object({
    id: objectHeaderShape.id,
    name: elementNameSchema,
    physicalName: physicalNameSchema.optional(),
    title: localizedStringSchema.optional(),
    notNull: z.boolean().default(false),
    /** SQL-вираз значення за замовчуванням. */
    default: z.string().optional(),
    identity: z.enum(["always", "byDefault"]).optional(),
    comment: z.string().optional(),

    type: z.enum([...LOGICAL_TYPES, "PgEnum", "Raw"]),
    ...z.object(valueTypeShape).omit({ type: true }).shape,
    enum: z
      .object({ kind: z.literal("PgEnum"), name: objectNameSchema })
      .optional(),
    pgType: z.string().min(1).optional(),
  })
  .superRefine((column, ctx) => {
    const issue = (rule: SchemaRule, message: string, path: string[]) =>
      ctx.addIssue({ code: "custom", message, path, params: { rule } })

    const logicalFields = [
      "length",
      "precision",
      "scale",
      "ref",
      "allowedTypes",
      "crossScope",
    ] as const

    if (column.type === "PgEnum") {
      if (column.enum === undefined) {
        issue("customTable.column-type", "PgEnum column requires enum", [
          "enum",
        ])
      }
      if (column.pgType !== undefined) {
        issue("customTable.column-type", "PgEnum column cannot have pgType", [
          "pgType",
        ])
      }
      for (const field of logicalFields) {
        if (column[field] !== undefined) {
          issue(
            "customTable.column-type",
            `PgEnum column cannot have ${field}`,
            [field]
          )
        }
      }
    } else if (column.type === "Raw") {
      if (column.pgType === undefined) {
        issue("customTable.column-type", "Raw column requires pgType", [
          "pgType",
        ])
      }
      if (column.enum !== undefined) {
        issue("customTable.column-type", "Raw column cannot have enum", [
          "enum",
        ])
      }
      for (const field of [...logicalFields, "array"] as const) {
        if (column[field] !== undefined) {
          issue("customTable.column-type", `Raw column cannot have ${field}`, [
            field,
          ])
        }
      }
    } else {
      if (column.enum !== undefined) {
        issue(
          "customTable.column-type",
          "enum is only allowed for PgEnum columns",
          ["enum"]
        )
      }
      if (column.pgType !== undefined) {
        issue(
          "customTable.column-type",
          "pgType is only allowed for Raw columns",
          ["pgType"]
        )
      }
      refineValueType({ ...column, type: column.type }, ctx)
    }

    if (
      column.identity !== undefined &&
      !IDENTITY_TYPES.includes(column.type)
    ) {
      issue(
        "customTable.identity-type",
        "identity requires SmallInt, Integer or BigInt type",
        ["identity"]
      )
    }
  })

export type CustomTableColumn = z.infer<typeof customTableColumnSchema>

const constraintName = z.string().min(1).optional()
const columnList = z.array(elementNameSchema).min(1)

export const fkActionSchema = z.enum([
  "noAction",
  "restrict",
  "cascade",
  "setNull",
  "setDefault",
])

export type FkAction = z.infer<typeof fkActionSchema>

const foreignKeySchema = z.object({
  name: constraintName,
  columns: columnList,
  references: z.union([
    z.object({ object: metadataRefSchema, columns: columnList }),
    z.object({
      external: z.object({
        schema: z.string().min(1),
        table: z.string().min(1),
        // Колонки зовнішньої таблиці — фізичні імена, не логічні.
        columns: z.array(z.string().min(1)).min(1),
      }),
    }),
  ]),
  onDelete: fkActionSchema.default("noAction"),
  onUpdate: fkActionSchema.default("noAction"),
  deferrable: z.enum(["no", "deferrable", "initiallyDeferred"]).default("no"),
})

const indexSchema = z.object({
  name: constraintName,
  unique: z.boolean().default(false),
  method: z.string().min(1).default("btree"),
  keys: z
    .array(
      z.union([
        z.object({ column: elementNameSchema }),
        z.object({ expression: z.string().min(1) }),
      ])
    )
    .min(1),
  include: z.array(elementNameSchema).default([]),
  where: z.string().optional(),
  nullsNotDistinct: z.boolean().default(false),
})

/**
 * Довільна таблиця з повним фізичним описом. Колонки в обмеженнях і індексах
 * — логічні імена; ім'я обмеження необов'язкове (відсутнє — ім'я за
 * алгоритмом Postgres), зворотний генератор записує імена явно.
 */
export const customTableSchema = z.object({
  ...objectHeaderShape,
  kind: z.literal("CustomTable"),
  comment: z.string().optional(),
  columns: z.array(customTableColumnSchema).min(1),
  primaryKey: z
    .object({ name: constraintName, columns: columnList })
    .optional(),
  uniques: z
    .array(
      z.object({
        name: constraintName,
        columns: columnList,
        nullsNotDistinct: z.boolean().default(false),
      })
    )
    .default([]),
  checks: z
    .array(z.object({ name: constraintName, expression: z.string().min(1) }))
    .default([]),
  foreignKeys: z.array(foreignKeySchema).default([]),
  indexes: z.array(indexSchema).default([]),
  /** Логічне ім'я власної колонки таблиці, що несе скоуп. */
  scopeColumn: elementNameSchema.optional(),
})

export type CustomTable = z.infer<typeof customTableSchema>
