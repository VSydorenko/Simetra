import { z } from "zod"
import { catalogSchema } from "./catalog"
import { documentSchema } from "./document"
import { enumerationSchema } from "./enumeration"
import { informationRegisterSchema } from "./information-register"
import { accumulationRegisterSchema } from "./accumulation-register"
import { constantSchema } from "./constant"
import { customTableSchema } from "./custom-table"
import { projectSchema } from "./project"
import { formSchema, formSupportedKinds } from "./form"
import type { MetadataKind } from "./metadata-kind"

export const metadataObjectSchema = z.discriminatedUnion("kind", [
  catalogSchema,
  documentSchema,
  enumerationSchema,
  informationRegisterSchema,
  accumulationRegisterSchema,
  constantSchema,
  customTableSchema,
])

export type MetadataObject = z.infer<typeof metadataObjectSchema>

// MetadataKind → ключ колекції в ProjectModel
const KIND_TO_COLLECTION_KEY: Record<MetadataKind, string> = {
  Catalog: 'catalogs',
  Document: 'documents',
  Enumeration: 'enumerations',
  InformationRegister: 'informationRegisters',
  AccumulationRegister: 'accumulationRegisters',
  Constant: 'constants',
  CustomTable: 'customTables',
}

export const projectModelSchema = z
  .object({
    project: projectSchema,
    catalogs: z.array(catalogSchema).default([]),
    documents: z.array(documentSchema).default([]),
    enumerations: z.array(enumerationSchema).default([]),
    informationRegisters: z.array(informationRegisterSchema).default([]),
    accumulationRegisters: z.array(accumulationRegisterSchema).default([]),
    constants: z.array(constantSchema).default([]),
    customTables: z.array(customTableSchema).default([]),
    forms: z.array(formSchema).optional().default([]),
  })
  .superRefine((data, ctx) => {
    if (!data.forms || data.forms.length === 0) return

    const duplicateCheck = new Set<string>()

    for (let i = 0; i < data.forms.length; i++) {
      const form = data.forms[i]
      const { kind, name } = form.objectRef

      // objectRef.kind має бути з formSupportedKinds
      if (!(formSupportedKinds as readonly string[]).includes(kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['forms', i, 'objectRef', 'kind'],
          message: `Forms не підтримуються для kind "${kind}". Дозволені: ${formSupportedKinds.join(', ')}`,
        })
        continue
      }

      // objectRef має посилатись на існуючий об'єкт
      const collectionKey = KIND_TO_COLLECTION_KEY[kind as MetadataKind]
      const collection = data[collectionKey as keyof typeof data] as
        | { name: string }[]
        | undefined
      const exists = collection?.some((obj) => obj.name === name)
      if (!exists) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['forms', i, 'objectRef'],
          message: `Об'єкт "${kind}.${name}" не знайдено в моделі`,
        })
      }

      // Не більше одної форми кожного виду per object
      const uniqueKey = `${kind}.${name}.${form.kind}`
      if (duplicateCheck.has(uniqueKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['forms', i],
          message: `Дублікат форми ${form.kind} для ${kind}.${name}`,
        })
      }
      duplicateCheck.add(uniqueKey)
    }
  })

export type ProjectModel = z.infer<typeof projectModelSchema>
