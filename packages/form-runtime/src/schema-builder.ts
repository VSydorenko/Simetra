import { z } from 'zod'
import type { Attribute } from '@simetra/core'

// Генерація runtime Zod schema з metadata об'єкта та його атрибутів
export function buildFormSchema(
  attributes: Attribute[],
): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {}

  for (const attr of attributes) {
    const fieldSchema = buildFieldSchema(attr)
    if (fieldSchema) {
      shape[attr.name] = fieldSchema
    }
  }

  return z.object(shape)
}

function buildFieldSchema(attr: Attribute): z.ZodType | null {
  // Boolean має окрему логіку — default(false) зберігається навіть для optional
  if (attr.type === 'Boolean') {
    return z.boolean().default(false)
  }

  let schema: z.ZodType

  switch (attr.type) {
    case 'UUID':
      schema = z.string().uuid()
      break
    case 'String':
      schema = z.string()
      if (attr.length) schema = (schema as z.ZodString).max(attr.length)
      break
    case 'Text':
      schema = z.string()
      break
    case 'Integer': {
      // Попередня обробка порожніх рядків → undefined для коректної required валідації
      const intBase = z.preprocess(
        (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
        z.number().int(),
      )
      schema = attr.required ? intBase : intBase.optional().nullable()
      return schema
    }
    case 'Numeric': {
      // Попередня обробка порожніх рядків → undefined для коректної required валідації
      let numSchema = z.preprocess(
        (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
        z.number(),
      ) as z.ZodType
      // precision/scale обмеження для Numeric полів
      if (attr.precision != null && attr.scale != null) {
        const maxValue = Math.pow(10, attr.precision - attr.scale) - Math.pow(10, -attr.scale)
        numSchema = z.preprocess(
          (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
          z.number().min(-maxValue).max(maxValue),
        )
      }
      schema = attr.required ? numSchema : (numSchema as z.ZodType).optional().nullable()
      return schema
    }
    case 'Date':
      schema = z.string()
      break
    case 'DateTime':
      schema = z.string()
      break
    case 'Binary':
      // Binary не підтримується в MVP — skip
      return null
    case 'Ref':
      // Polymorphic ref — skip (не підтримується в MVP)
      if (attr.allowedTypes && attr.allowedTypes.length > 0) {
        return null
      }
      // Single ref — UUID (id запису)
      schema = z.string().uuid()
      break
    default:
      schema = z.string()
  }

  // required: true → поле обов'язкове (min 1 для рядків)
  if (attr.required) {
    if (schema instanceof z.ZodString) {
      schema = schema.min(1, 'Required')
    }
  } else {
    schema = schema.nullable().optional()
  }

  return schema
}
