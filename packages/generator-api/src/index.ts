import type { LocalizedString, ProjectModel } from '@simetra/core'

// Опції генерації
export interface GeneratorOptions {
  // Стратегія enum: CREATE TYPE або lookup table
  enumStrategy?: 'pgEnum' | 'lookupTable'
  // Стратегія констант: одна таблиця або окрема на кожну константу
  constantsStrategy?: 'singleTable' | 'separateTables'
  // Один SQL файл або по-файлово
  outputMode?: 'singleFile' | 'perObject'
  // SQL schema (default: public)
  schema?: string
}

// Результат генерації
export interface GeneratorOutput {
  files: GeneratedFile[]
  warnings: string[]
}

// Один згенерований файл
export interface GeneratedFile {
  path: string
  content: string
}

// Інтерфейс генератора метаданих (BRD section 10.4)
export interface MetadataGenerator {
  name: string
  version: string
  description: LocalizedString
  generate(project: ProjectModel, options?: GeneratorOptions): GeneratorOutput
}
