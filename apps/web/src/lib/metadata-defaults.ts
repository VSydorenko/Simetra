import type { MetadataKind, MetadataObject, ProjectModel } from '@simetra/core'
import {
  catalogSchema,
  documentSchema,
  enumerationSchema,
  informationRegisterSchema,
  accumulationRegisterSchema,
  constantSchema,
  customTableSchema,
} from '@simetra/core'

// Маппінг MetadataKind → ключ у ProjectModel
const KIND_TO_KEY: Record<MetadataKind, keyof Omit<ProjectModel, 'project'>> = {
  Catalog: 'catalogs',
  Document: 'documents',
  Enumeration: 'enumerations',
  InformationRegister: 'informationRegisters',
  AccumulationRegister: 'accumulationRegisters',
  Constant: 'constants',
  CustomTable: 'customTables',
}

// Маппінг MetadataKind → Zod-схема
const SCHEMA_MAP: Record<MetadataKind, { parse: (input: unknown) => unknown }> = {
  Catalog: catalogSchema,
  Document: documentSchema,
  Enumeration: enumerationSchema,
  InformationRegister: informationRegisterSchema,
  AccumulationRegister: accumulationRegisterSchema,
  Constant: constantSchema,
  CustomTable: customTableSchema,
}

/** Генерує унікальне PascalCase імʼя для нового обʼєкта */
export function generateUniqueName(
  kind: MetadataKind,
  existingNames: string[],
): string {
  const prefix = `New${kind}`
  let i = 1
  while (existingNames.includes(`${prefix}${i}`)) i++
  return `${prefix}${i}`
}

/** Отримує список імен обʼєктів зазначеного типу з моделі */
export function getObjectNames(model: ProjectModel, kind: MetadataKind): string[] {
  const key = KIND_TO_KEY[kind]
  return (model[key] as { name: string }[]).map((o) => o.name)
}

/** Створює мінімально валідний обʼєкт метаданих з Zod-дефолтами */
export function createDefaultObject(kind: MetadataKind, name: string): MetadataObject {
  const minimalInput = kind === 'Constant'
    ? { kind, name, valueType: 'String' }
    : { kind, name }
  return SCHEMA_MAP[kind].parse(minimalInput) as MetadataObject
}

export { KIND_TO_KEY }
