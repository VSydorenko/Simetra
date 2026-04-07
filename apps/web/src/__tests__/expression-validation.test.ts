import { describe, it, expect } from 'vitest'
import type { Attribute } from '@simetra/core'
import { validateExpressionFields } from '@/lib/expression-validation'

function attr(name: string, type = 'Numeric'): Attribute {
  return { name, type, displayName: { uk: '', en: '' } } as Attribute
}

describe('validateExpressionFields', () => {
  it('row.qty * row.price — обидва існують → null', () => {
    const result = validateExpressionFields(
      'row.qty * row.price',
      'tabularSection:Items',
      [],
      [attr('qty'), attr('price')],
    )
    expect(result).toBeNull()
  })

  it('row.qty * row.nonexistent — друге поле не існує → error', () => {
    const result = validateExpressionFields(
      'row.qty * row.nonexistent',
      'tabularSection:Items',
      [],
      [attr('qty'), attr('price')],
    )
    expect(result).toBe('Поле row.nonexistent не існує в ТЧ')
  })

  it('row.a + row.b - row.c — без c → error на row.c', () => {
    const result = validateExpressionFields(
      'row.a + row.b - row.c',
      'tabularSection:Items',
      [],
      [attr('a'), attr('b')],
    )
    expect(result).toBe('Поле row.c не існує в ТЧ')
  })

  it('doc.date — стандартний реквізит → null', () => {
    const result = validateExpressionFields(
      'doc.date',
      'document',
      [],
    )
    expect(result).toBeNull()
  })

  it('doc.nonexistent → error', () => {
    const result = validateExpressionFields(
      'doc.nonexistent',
      'document',
      [],
    )
    expect(result).toBe('Поле doc.nonexistent не існує в документі')
  })

  it('doc.date * doc.nonexistent — composite → error на doc.nonexistent', () => {
    const result = validateExpressionFields(
      'doc.date * doc.nonexistent',
      'document',
      [],
    )
    expect(result).toBe('Поле doc.nonexistent не існує в документі')
  })

  it('sum(Items.amount) — ТЧ і поле існують → null', () => {
    const result = validateExpressionFields(
      'sum(Items.amount)',
      'document',
      [],
      undefined,
      [{ name: 'Items', attributes: [attr('amount')] }],
    )
    expect(result).toBeNull()
  })

  it('literal:100 → null', () => {
    const result = validateExpressionFields(
      'literal:100',
      'document',
      [],
    )
    expect(result).toBeNull()
  })

  it('now() → null', () => {
    const result = validateExpressionFields(
      'now()',
      'document',
      [],
    )
    expect(result).toBeNull()
  })
})
