import { z } from "zod"
import { catalogSchema } from "./catalog"
import { documentSchema } from "./document"
import { enumerationSchema } from "./enumeration"
import { informationRegisterSchema } from "./information-register"
import { accumulationRegisterSchema } from "./accumulation-register"
import { constantSchema } from "./constant"
import { customTableSchema } from "./custom-table"
import { projectSchema } from "./project"

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

export const projectModelSchema = z.object({
  project: projectSchema,
  catalogs: z.array(catalogSchema).default([]),
  documents: z.array(documentSchema).default([]),
  enumerations: z.array(enumerationSchema).default([]),
  informationRegisters: z.array(informationRegisterSchema).default([]),
  accumulationRegisters: z.array(accumulationRegisterSchema).default([]),
  constants: z.array(constantSchema).default([]),
  customTables: z.array(customTableSchema).default([]),
})

export type ProjectModel = z.infer<typeof projectModelSchema>
