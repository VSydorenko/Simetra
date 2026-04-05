import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { projectModelSchema, type ProjectModel } from '@simetra/core'
import '@/i18n'
import { AdditionalIndexesDialog } from '../components/editor/additional-indexes-dialog'
import { useMetadataStore } from '../stores/metadata-store'

function createModel(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: 'TestProject' },
    documents: [
      {
        kind: 'Document',
        name: 'SalesOrder',
      },
      {
        kind: 'Document',
        name: 'ReturnOrder',
      },
    ],
    informationRegisters: [
      {
        kind: 'InformationRegister',
        name: 'SalesHistory',
        periodicity: 'Month',
        writeMode: 'RecorderSubordinate',
        recorderTypes: [
          { kind: 'Document', name: 'SalesOrder' },
          { kind: 'Document', name: 'ReturnOrder' },
        ],
      },
    ],
  })
}

beforeEach(() => {
  useMetadataStore.getState().loadModel(createModel())
})

describe('AdditionalIndexesDialog', () => {
  it('показує конкретні recorder targets для recorder_id у standard attributes', () => {
    render(
      <AdditionalIndexesDialog
        open={true}
        onOpenChange={vi.fn()}
        kind="InformationRegister"
        objectName="SalesHistory"
      />,
    )

    const recorderRow = screen.getByText('recorder_id').closest('tr')
    expect(recorderRow).not.toBeNull()
    expect(
      within(recorderRow as HTMLTableRowElement).getByText(/SalesOrder/),
    ).toBeInTheDocument()
    expect(
      within(recorderRow as HTMLTableRowElement).getByText(/ReturnOrder/),
    ).toBeInTheDocument()
  })
})