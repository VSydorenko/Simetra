import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '../i18n'
import { FieldTypeSelect } from '../components/editor/field-type-select'

// Radix Select використовує DOM API, відсутнє в jsdom
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
})

describe('FieldTypeSelect', () => {
  it('renders without errors', () => {
    render(
      <FieldTypeSelect
        value="String"
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('excludeTypes filters out specified types from rendered options', async () => {
    const user = userEvent.setup()
    render(
      <FieldTypeSelect
        value="String"
        onChange={vi.fn()}
        excludeTypes={['Ref']}
      />,
    )

    // Відкрити dropdown
    await user.click(screen.getByRole('combobox'))

    // Перевірити що String є серед options
    const options = screen.getAllByRole('option')
    const optionTexts = options.map((o) => o.textContent)
    expect(optionTexts).toContain('String')

    // Ref не повинен бути серед options
    const refOption = options.find(
      (o) => o.textContent === 'Ref' || o.getAttribute('data-value') === 'Ref',
    )
    expect(refOption).toBeUndefined()
  })
})
