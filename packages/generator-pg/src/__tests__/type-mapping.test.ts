import { describe, it, expect } from 'vitest'
import { mapFieldType } from '../type-mapping'

describe('mapFieldType', () => {
  it('maps UUID', () => {
    expect(mapFieldType({ type: 'UUID' })).toBe('uuid')
  })

  it('maps String with default length', () => {
    expect(mapFieldType({ type: 'String' })).toBe('varchar(255)')
  })

  it('maps String with custom length', () => {
    expect(mapFieldType({ type: 'String', length: 50 })).toBe('varchar(50)')
  })

  it('maps Text', () => {
    expect(mapFieldType({ type: 'Text' })).toBe('text')
  })

  it('maps Integer', () => {
    expect(mapFieldType({ type: 'Integer' })).toBe('integer')
  })

  it('maps Numeric with defaults', () => {
    expect(mapFieldType({ type: 'Numeric' })).toBe('numeric(15, 2)')
  })

  it('maps Numeric with custom precision/scale', () => {
    expect(mapFieldType({ type: 'Numeric', precision: 10, scale: 4 })).toBe('numeric(10, 4)')
  })

  it('maps Numeric with scale 0', () => {
    expect(mapFieldType({ type: 'Numeric', precision: 8, scale: 0 })).toBe('numeric(8, 0)')
  })

  it('maps Boolean', () => {
    expect(mapFieldType({ type: 'Boolean' })).toBe('boolean')
  })

  it('maps Date', () => {
    expect(mapFieldType({ type: 'Date' })).toBe('date')
  })

  it('maps DateTime', () => {
    expect(mapFieldType({ type: 'DateTime' })).toBe('timestamptz')
  })

  it('maps Binary', () => {
    expect(mapFieldType({ type: 'Binary' })).toBe('bytea')
  })

  it('falls back to text for unknown type', () => {
    expect(mapFieldType({ type: 'Unknown' })).toBe('text')
  })
})
