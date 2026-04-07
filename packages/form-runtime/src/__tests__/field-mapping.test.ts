import { describe, it, expect } from 'vitest'
import { resolveFieldComponent } from '../field-mapping'
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

describe('resolveFieldComponent', () => {
  it('String → input', () => {
    const result = resolveFieldComponent(makeAttr({ name: 'title', type: 'String' }))
    expect(result.component).toBe('input')
  })

  it('String (length > 255) → textarea', () => {
    const result = resolveFieldComponent(makeAttr({ name: 'notes', type: 'String', length: 500 }))
    expect(result.component).toBe('textarea')
  })

  it('Text → textarea', () => {
    const result = resolveFieldComponent(makeAttr({ name: 'body', type: 'Text' }))
    expect(result.component).toBe('textarea')
  })

  it('Integer → number-input', () => {
    const result = resolveFieldComponent(makeAttr({ name: 'qty', type: 'Integer' }))
    expect(result.component).toBe('number-input')
  })

  it('Numeric → number-input', () => {
    const result = resolveFieldComponent(makeAttr({ name: 'price', type: 'Numeric', precision: 10, scale: 2 }))
    expect(result.component).toBe('number-input')
  })

  it('Boolean → switch', () => {
    const result = resolveFieldComponent(makeAttr({ name: 'active', type: 'Boolean' }))
    expect(result.component).toBe('switch')
  })

  it('Date → date-picker', () => {
    const result = resolveFieldComponent(makeAttr({ name: 'birth', type: 'Date' }))
    expect(result.component).toBe('date-picker')
  })

  it('DateTime → datetime-picker', () => {
    const result = resolveFieldComponent(makeAttr({ name: 'created_at', type: 'DateTime' }))
    expect(result.component).toBe('datetime-picker')
  })

  it('Ref (Enumeration) → enum-select', () => {
    const result = resolveFieldComponent(makeAttr({
      name: 'status',
      type: 'Ref',
      ref: { kind: 'Enumeration', name: 'OrderStatus' },
    }))
    expect(result.component).toBe('enum-select')
    expect(result.props).toHaveProperty('enumRef')
  })

  it('Ref (Catalog) → catalog-combobox', () => {
    const result = resolveFieldComponent(makeAttr({
      name: 'customer',
      type: 'Ref',
      ref: { kind: 'Catalog', name: 'Customers' },
    }))
    expect(result.component).toBe('catalog-combobox')
    expect(result.props).toHaveProperty('targetRef')
  })

  it('Ref (Document) → document-combobox', () => {
    const result = resolveFieldComponent(makeAttr({
      name: 'order',
      type: 'Ref',
      ref: { kind: 'Document', name: 'SalesOrder' },
    }))
    expect(result.component).toBe('document-combobox')
    expect(result.props).toHaveProperty('targetRef')
  })

  it('Ref (polymorphic) → placeholder', () => {
    const result = resolveFieldComponent(makeAttr({
      name: 'linked',
      type: 'Ref',
      allowedTypes: [
        { kind: 'Catalog', name: 'A' },
        { kind: 'Document', name: 'B' },
      ],
    }))
    expect(result.component).toBe('polymorphic-ref-placeholder')
  })

  it('UUID → uuid-input', () => {
    const result = resolveFieldComponent(makeAttr({ name: 'pk', type: 'UUID' }))
    expect(result.component).toBe('uuid-input')
  })

  it('Binary → binary-placeholder', () => {
    const result = resolveFieldComponent(makeAttr({ name: 'data', type: 'Binary' }))
    expect(result.component).toBe('binary-placeholder')
  })
})
