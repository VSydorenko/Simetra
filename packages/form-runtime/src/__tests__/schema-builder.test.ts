import { describe, it, expect } from 'vitest'
import { buildFormSchema } from '../schema-builder'
import type { Attribute } from '@simetra/core'

function makeAttr(overrides: Partial<Attribute> & { name: string; type: Attribute['type'] }): Attribute {
  return {
    required: false,
    indexed: false,
    unique: false,
    defaultValue: null,
    ...overrides,
  } as Attribute
}

describe('buildFormSchema', () => {
  it('створює порожню schema для пустого масиву', () => {
    const schema = buildFormSchema([])
    expect(schema).toBeDefined()
    const result = schema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('String поле — required', () => {
    const schema = buildFormSchema([makeAttr({ name: 'title', type: 'String', required: true })])
    const fail = schema.safeParse({ title: '' })
    expect(fail.success).toBe(false)
    const pass = schema.safeParse({ title: 'Hello' })
    expect(pass.success).toBe(true)
  })

  it('String поле — optional', () => {
    const schema = buildFormSchema([makeAttr({ name: 'title', type: 'String' })])
    const pass = schema.safeParse({ title: null })
    expect(pass.success).toBe(true)
    const noField = schema.safeParse({})
    expect(noField.success).toBe(true)
  })

  it('Boolean — default false', () => {
    const schema = buildFormSchema([makeAttr({ name: 'active', type: 'Boolean' })])
    const result = schema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.active).toBe(false)
    }
  })

  it('Integer — порожній рядок не стає 0 для required', () => {
    const schema = buildFormSchema([makeAttr({ name: 'qty', type: 'Integer', required: true })])
    const fail = schema.safeParse({ qty: '' })
    expect(fail.success).toBe(false)
  })

  it('Integer — валідне число проходить', () => {
    const schema = buildFormSchema([makeAttr({ name: 'qty', type: 'Integer', required: true })])
    const pass = schema.safeParse({ qty: 5 })
    expect(pass.success).toBe(true)
  })

  it('Ref single — UUID string', () => {
    const schema = buildFormSchema([makeAttr({
      name: 'customer',
      type: 'Ref',
      required: true,
      ref: { kind: 'Catalog', name: 'Customers' },
    })])
    const fail = schema.safeParse({ customer: 'not-a-uuid' })
    expect(fail.success).toBe(false)
    const pass = schema.safeParse({ customer: '550e8400-e29b-41d4-a716-446655440000' })
    expect(pass.success).toBe(true)
  })

  it('Ref polymorphic — skip (не додається до schema)', () => {
    const schema = buildFormSchema([makeAttr({
      name: 'linked',
      type: 'Ref',
      allowedTypes: [{ kind: 'Catalog', name: 'A' }, { kind: 'Document', name: 'B' }],
    })])
    // Поле не повинно існувати в schema
    const pass = schema.safeParse({})
    expect(pass.success).toBe(true)
  })

  it('Binary — skip', () => {
    const schema = buildFormSchema([makeAttr({ name: 'data', type: 'Binary' })])
    const pass = schema.safeParse({})
    expect(pass.success).toBe(true)
  })

  it('Numeric з precision/scale', () => {
    const schema = buildFormSchema([makeAttr({
      name: 'price',
      type: 'Numeric',
      required: true,
      precision: 10,
      scale: 2,
    })])
    const pass = schema.safeParse({ price: 99.99 })
    expect(pass.success).toBe(true)
  })
})
