import { z } from "zod"
import type { SchemaRule } from "./rules"

export const LOGICAL_TYPES = [
  "UUID",
  "String",
  "Text",
  "Integer",
  "SmallInt",
  "BigInt",
  "Numeric",
  "Boolean",
  "Date",
  "DateTime",
  "Bytes",
  "Json",
  "Ref",
] as const

export type LogicalType = (typeof LOGICAL_TYPES)[number]

/**
 * Форма посилання {kind, name} без обмеження набору kind-ів: реєстр видів
 * відомий лише вищим шарам, а T0 перевіряє тільки форму.
 */
const typeRefShape = z.object({ kind: z.string(), name: z.string() })

/** Поля типу, спільні для реквізиту, константи й колонки. */
export const valueTypeShape = {
  type: z.enum(LOGICAL_TYPES),
  length: z.number().int().positive().optional(),
  precision: z.number().int().positive().optional(),
  scale: z.number().int().nonnegative().optional(),
  ref: typeRefShape.optional(),
  allowedTypes: z.array(typeRefShape).optional(),
  array: z.boolean().optional(),
}

export type ValueType = z.infer<z.ZodObject<typeof valueTypeShape>>

/** Перевірки сумісності параметрів типу; кожне порушення несе код правила. */
export function refineValueType(value: ValueType, ctx: z.RefinementCtx): void {
  const issue = (rule: SchemaRule, message: string, path: string[]) =>
    ctx.addIssue({ code: "custom", message, path, params: { rule } })

  if (value.type === "String" && value.length === undefined) {
    issue("type.length-required", "String type requires length", ["length"])
  }
  if (value.type !== "String" && value.length !== undefined) {
    issue("type.length-not-allowed", "Only String type accepts length", [
      "length",
    ])
  }
  if (value.type !== "Numeric" && value.precision !== undefined) {
    issue("type.precision-not-allowed", "Only Numeric type accepts precision", [
      "precision",
    ])
  }
  if (value.scale !== undefined && value.precision === undefined) {
    issue("type.scale-requires-precision", "Scale requires precision", [
      "scale",
    ])
  }

  const hasRef = value.ref !== undefined
  const hasAllowed = value.allowedTypes !== undefined
  if (value.type === "Ref") {
    if (!hasRef && !hasAllowed) {
      issue(
        "type.ref-target-required",
        "Ref type requires either ref or allowedTypes",
        ["ref"]
      )
    } else if (hasRef && hasAllowed) {
      issue(
        "type.ref-exclusive",
        "ref and allowedTypes are mutually exclusive",
        ["allowedTypes"]
      )
    }
  } else {
    if (hasRef) {
      issue("type.ref-not-allowed", "Only Ref type accepts ref", ["ref"])
    }
    if (hasAllowed) {
      issue("type.ref-not-allowed", "Only Ref type accepts allowedTypes", [
        "allowedTypes",
      ])
    }
  }
}
