import { z } from 'zod'
import { metadataRefSchema } from './metadata-ref'
import { localizedStringSchema } from './localized-string'

export const formKindSchema = z.enum(['ItemForm', 'ListForm'])
export type FormKind = z.infer<typeof formKindSchema>

// Kinds що підтримують forms
export const formSupportedKinds = ['Catalog', 'Document', 'CustomTable'] as const
export type FormSupportedKind = (typeof formSupportedKinds)[number]

// Мінімальний layout element — Stage 3 розширить повною discriminated union
export const formLayoutElementSchema: z.ZodType<unknown> = z
  .object({
    element: z.string(),
  })
  .passthrough()

export const formSchema = z.object({
  $schema: z.string().optional(),
  kind: formKindSchema,
  objectRef: metadataRefSchema,
  title: localizedStringSchema.optional(),
  // layout: одиночний кореневий елемент або масив — Stage 3 визначить точний тип
  layout: z.unknown().optional(),
})

export type FormSchema = z.infer<typeof formSchema>
