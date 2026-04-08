import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@/i18n'
import { MovementConstructorDialog } from '@/components/editor/movement-constructor-dialog'
import { useMetadataStore } from '@/stores/metadata-store'
import { projectModelSchema } from '@simetra/core'
import type { Document, PostingMovement } from '@simetra/core'

// Мінімальна модель з регістром
const model = projectModelSchema.parse({
  project: { name: 'Test' },
  accumulationRegisters: [
    {
      kind: 'AccumulationRegister',
      name: 'InventoryBalance',
      registerType: 'Balance',
      dimensions: [{ name: 'product', type: 'String', length: 50 }],
      resources: [{ name: 'quantity', type: 'Numeric', precision: 15, scale: 2 }],
    },
  ],
  documents: [
    {
      kind: 'Document',
      name: 'Invoice',
      attributes: [{ name: 'warehouse', type: 'String', length: 50 }],
      tabularSections: [
        {
          name: 'items',
          attributes: [{ name: 'product', type: 'String', length: 50 }],
        },
      ],
      registerMovements: [{ kind: 'AccumulationRegister', name: 'InventoryBalance' }],
    },
  ],
})

// Існуючий movement — щоб діалог відкрився в режимі редагування
const existingMovement: PostingMovement = {
  register: { kind: 'AccumulationRegister', name: 'InventoryBalance' },
  movementType: 'Receipt',
  source: 'document',
  condition: null,
  mappings: {
    dimensions: { product: 'doc.warehouse' },
    resources: { quantity: '' },
    attributes: {},
  },
}

type StoreValidationError = { path: string; message: string }

function seedStore() {
  useMetadataStore.setState({
    model,
    version: 1,
    objectVersions: {},
    validationErrors: {},
    modelErrors: {},
  })
}

describe('MovementConstructorDialog', () => {
  it('store rejection → діалог залишається відкритим', async () => {
    seedStore()

    const onSave = vi.fn().mockReturnValue([
      { path: 'posting', message: 'test error' },
    ] as StoreValidationError[])
    const onOpenChange = vi.fn()

    render(
      <MovementConstructorDialog
        open={true}
        onOpenChange={onOpenChange}
        registerRef={{ kind: 'AccumulationRegister', name: 'InventoryBalance' }}
        document={model.documents[0] as Document}
        existingMovement={existingMovement}
        onSave={onSave}
      />,
    )

    // Змінимо condition щоб зробити форму dirty
    const conditionInput = screen.getByPlaceholderText('Умова')
    fireEvent.change(conditionInput, { target: { value: 'true' } })

    // Клік Save
    const saveBtn = screen.getByRole('button', { name: /зберегти|save/i })
    expect(saveBtn).not.toBeDisabled()
    fireEvent.click(saveBtn)

    // onSave був викликаний
    expect(onSave).toHaveBeenCalled()
    // Діалог НЕ закрився (onOpenChange не викликано з false)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('store success → діалог закривається', async () => {
    seedStore()

    const onSave = vi.fn().mockReturnValue(null)
    const onOpenChange = vi.fn()

    render(
      <MovementConstructorDialog
        open={true}
        onOpenChange={onOpenChange}
        registerRef={{ kind: 'AccumulationRegister', name: 'InventoryBalance' }}
        document={model.documents[0] as Document}
        existingMovement={existingMovement}
        onSave={onSave}
      />,
    )

    // Змінимо condition щоб зробити форму dirty
    const conditionInput = screen.getByPlaceholderText('Умова')
    fireEvent.change(conditionInput, { target: { value: 'true' } })

    const saveBtn = screen.getByRole('button', { name: /зберегти|save/i })
    expect(saveBtn).not.toBeDisabled()
    fireEvent.click(saveBtn)

    expect(onSave).toHaveBeenCalled()
    // Діалог закрився через onOpenChange(false)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
