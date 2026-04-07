import type { GeneratorOptions } from '@simetra/generator-api'

const VALID_ENUM_STRATEGIES = ['pgEnum', 'lookupTable'] as const
const VALID_CONSTANTS_STRATEGIES = ['singleTable', 'separateTables'] as const

/**
 * Валідує та повертає GeneratorOptions зі значень CLI аргументів.
 * Викидає Error з повідомленням при невалідних значеннях.
 */
export function validateGeneratorOptions(args: {
  'enum-strategy': string
  'constants-strategy': string
  schema: string
  'output-mode'?: string
}): GeneratorOptions {
  const enumStrategy = args['enum-strategy']
  if (
    !VALID_ENUM_STRATEGIES.includes(
      enumStrategy as (typeof VALID_ENUM_STRATEGIES)[number],
    )
  ) {
    throw new Error(
      `Невідома enum-strategy: ${enumStrategy}. Доступні: ${VALID_ENUM_STRATEGIES.join(', ')}`,
    )
  }

  const constantsStrategy = args['constants-strategy']
  if (
    !VALID_CONSTANTS_STRATEGIES.includes(
      constantsStrategy as (typeof VALID_CONSTANTS_STRATEGIES)[number],
    )
  ) {
    throw new Error(
      `Невідома constants-strategy: ${constantsStrategy}. Доступні: ${VALID_CONSTANTS_STRATEGIES.join(', ')}`,
    )
  }

  return {
    enumStrategy: enumStrategy as GeneratorOptions['enumStrategy'],
    constantsStrategy:
      constantsStrategy as GeneratorOptions['constantsStrategy'],
    outputMode: (args['output-mode'] as GeneratorOptions['outputMode']) ?? 'singleFile',
    schema: args.schema,
  }
}
