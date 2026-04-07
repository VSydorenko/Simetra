import { resolve } from 'node:path'
import {
  projectSchema,
  projectModelSchema,
  catalogSchema,
  documentSchema,
  enumerationSchema,
  informationRegisterSchema,
  accumulationRegisterSchema,
  constantsFileSchema,
  customTableSchema,
  type ProjectModel,
  type Catalog,
  type Document as SimetraDocument,
  type Enumeration,
  type InformationRegister,
  type AccumulationRegister,
  type Constant,
  type CustomTable,
} from '@simetra/core'
import { readMetadataFiles } from './read-metadata'

// Маппінг директорій до kind та відповідних Zod-схем
const DIR_TO_KIND = {
  catalogs: { kind: 'Catalog', schema: catalogSchema },
  documents: { kind: 'Document', schema: documentSchema },
  enumerations: { kind: 'Enumeration', schema: enumerationSchema },
  'information-registers': {
    kind: 'InformationRegister',
    schema: informationRegisterSchema,
  },
  'accumulation-registers': {
    kind: 'AccumulationRegister',
    schema: accumulationRegisterSchema,
  },
  'custom-tables': { kind: 'CustomTable', schema: customTableSchema },
} as const

/**
 * Зчитує metadata файли з директорії, валідує через Zod-схеми
 * та повертає ProjectModel.
 */
export function buildProjectModel(inputDir: string): ProjectModel {
  const resolvedDir = resolve(inputDir)
  const metadataFiles = readMetadataFiles(resolvedDir)

  // Парсинг project.meta.json
  const projectContent = metadataFiles.get('project.meta.json')
  if (!projectContent) {
    throw new Error(
      `Файл project.meta.json не знайдено в ${resolvedDir}`,
    )
  }

  let projectRaw: unknown
  try {
    projectRaw = JSON.parse(projectContent)
  } catch {
    throw new Error(
      'Помилка парсингу project.meta.json: невалідний JSON',
    )
  }

  const projectResult = projectSchema.safeParse(projectRaw)
  if (!projectResult.success) {
    const details = projectResult.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Помилка валідації project.meta.json:\n${details}`)
  }

  // Збираємо об'єкти метаданих за типами
  const catalogs: Catalog[] = []
  const documents: SimetraDocument[] = []
  const enumerations: Enumeration[] = []
  const informationRegisters: InformationRegister[] = []
  const accumulationRegisters: AccumulationRegister[] = []
  const constants: Constant[] = []
  const customTables: CustomTable[] = []

  for (const [filePath, content] of metadataFiles) {
    if (filePath === 'project.meta.json') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error(`Помилка парсингу ${filePath}: невалідний JSON`)
    }

    // Визначаємо тип за директорією
    const dirName = filePath.split('/')[0]

    // Константи — окремий формат (масив у wrapper)
    if (dirName === 'constants') {
      const result = constantsFileSchema.safeParse(parsed)
      if (!result.success) {
        const details = result.error.issues
          .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
          .join('\n')
        throw new Error(`Помилка валідації ${filePath}:\n${details}`)
      }
      constants.push(...result.data.constants)
      continue
    }

    // Типові об'єкти метаданих
    const kindInfo = DIR_TO_KIND[dirName as keyof typeof DIR_TO_KIND]
    if (!kindInfo) {
      // Невідома директорія — пропускаємо з попередженням
      console.warn(
        `Невідома директорія метаданих: ${dirName}, пропускаємо ${filePath}`,
      )
      continue
    }

    const result = kindInfo.schema.safeParse(parsed)
    if (!result.success) {
      const details = result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')
      throw new Error(`Помилка валідації ${filePath}:\n${details}`)
    }

    switch (kindInfo.kind) {
      case 'Catalog':
        catalogs.push(result.data as Catalog)
        break
      case 'Document':
        documents.push(result.data as SimetraDocument)
        break
      case 'Enumeration':
        enumerations.push(result.data as Enumeration)
        break
      case 'InformationRegister':
        informationRegisters.push(result.data as InformationRegister)
        break
      case 'AccumulationRegister':
        accumulationRegisters.push(result.data as AccumulationRegister)
        break
      case 'CustomTable':
        customTables.push(result.data as CustomTable)
        break
    }
  }

  // Побудова ProjectModel
  return projectModelSchema.parse({
    project: projectResult.data,
    catalogs,
    documents,
    enumerations,
    informationRegisters,
    accumulationRegisters,
    constants,
    customTables,
  })
}
