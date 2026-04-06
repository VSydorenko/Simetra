import type { LocalizedString, ProjectModel } from '@simetra/core'
import type {
  GeneratorOptions,
  GeneratorOutput,
  MetadataGenerator,
} from '@simetra/generator-api'
import { generateProjectDDL } from './generate-table'

export { toSnakeCase, tableName, tabularTableName, qualifiedName, quoteIdentifier, escapeLiteral } from './naming'
export {
  mapFieldType,
  standardAttrToColumn,
  attributeToColumn,
  type ColumnDef,
} from './type-mapping'
export { generateProjectDDL } from './generate-table'

export const DEFAULT_OPTIONS: Required<GeneratorOptions> = {
  enumStrategy: 'pgEnum',
  constantsStrategy: 'singleTable',
  outputMode: 'singleFile',
  schema: 'public',
}

export class PostgresGenerator implements MetadataGenerator {
  readonly name = 'postgresql'
  readonly version = '0.0.1'
  readonly description: LocalizedString = {
    uk: 'Генератор PostgreSQL DDL',
    en: 'PostgreSQL DDL Generator',
  }

  generate(project: ProjectModel, options?: GeneratorOptions): GeneratorOutput {
    // Проєктні налаштування як ефективні defaults (перед explicit options)
    const projectDb = project.project.database
    const projectGen = project.project.generation
    const opts: Required<GeneratorOptions> = {
      schema: options?.schema ?? projectDb?.schema ?? DEFAULT_OPTIONS.schema,
      enumStrategy: options?.enumStrategy ?? projectGen?.enumStrategy ?? DEFAULT_OPTIONS.enumStrategy,
      constantsStrategy: options?.constantsStrategy ?? projectGen?.constantsStrategy ?? DEFAULT_OPTIONS.constantsStrategy,
      outputMode: options?.outputMode ?? DEFAULT_OPTIONS.outputMode,
    }
    return generateProjectDDL(project, opts)
  }
}
