import { describe, it, expect } from 'vitest'
import { validateGeneratorOptions } from '../validate-options'

describe('validateGeneratorOptions', () => {
  it('повертає валідні options', () => {
    const result = validateGeneratorOptions({
      'enum-strategy': 'pgEnum',
      'constants-strategy': 'singleTable',
      schema: 'public',
    })
    expect(result).toEqual({
      enumStrategy: 'pgEnum',
      constantsStrategy: 'singleTable',
      outputMode: 'singleFile',
      schema: 'public',
    })
  })

  it('приймає output-mode', () => {
    const result = validateGeneratorOptions({
      'enum-strategy': 'lookupTable',
      'constants-strategy': 'separateTables',
      'output-mode': 'perObject',
      schema: 'myschema',
    })
    expect(result.enumStrategy).toBe('lookupTable')
    expect(result.constantsStrategy).toBe('separateTables')
    expect(result.outputMode).toBe('perObject')
    expect(result.schema).toBe('myschema')
  })

  it('кидає помилку при невалідній enum-strategy', () => {
    expect(() =>
      validateGeneratorOptions({
        'enum-strategy': 'invalid',
        'constants-strategy': 'singleTable',
        schema: 'public',
      }),
    ).toThrow('Невідома enum-strategy: invalid')
  })

  it('кидає помилку при невалідній constants-strategy', () => {
    expect(() =>
      validateGeneratorOptions({
        'enum-strategy': 'pgEnum',
        'constants-strategy': 'invalid',
        schema: 'public',
      }),
    ).toThrow('Невідома constants-strategy: invalid')
  })
})
