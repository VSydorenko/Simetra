import { resolve } from 'node:path'
import {
  parseMetadataFiles,
  buildProjectModelFromParsed,
  type ProjectModel,
} from '@simetra/core'
import { readMetadataFiles } from './read-metadata'

/**
 * Зчитує metadata файли з директорії, валідує через Zod-схеми
 * та повертає ProjectModel.
 */
export function buildProjectModel(inputDir: string): ProjectModel {
  const resolvedDir = resolve(inputDir)
  const metadataFiles = readMetadataFiles(resolvedDir)

  // Перевірка наявності project.meta.json перед парсингом
  if (!metadataFiles.has('project.meta.json')) {
    throw new Error(`Файл project.meta.json не знайдено в ${resolvedDir}`)
  }

  // Делегуємо parsing/validation до shared metadata IO layer
  const { parsed, warnings: parseWarnings } = parseMetadataFiles(metadataFiles)

  // Логуємо parse warnings
  for (const w of parseWarnings) {
    console.warn(`Попередження при парсингу ${w.filePath}: ${w.errors.join('; ')}`)
  }

  // Strict mode — помилки валідації кидають Error
  const { model } = buildProjectModelFromParsed(parsed, { strict: true })
  return model
}
