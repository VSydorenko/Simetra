import { describe, it, expect, beforeEach } from 'vitest'
import { projectModelSchema, type ProjectModel } from '@simetra/core'
import { useMetadataStore } from '../stores/metadata-store'
import { useDdlStore } from '../stores/ddl-store'

// Мінімальна валідна модель для тестів
function validModel(overrides: Partial<ProjectModel> = {}): ProjectModel {
  return projectModelSchema.parse({
    project: { name: 'Test' },
    catalogs: [
      {
        kind: 'Catalog',
        name: 'Products',
        codeLength: 9,
        attributes: [{ name: 'description', type: 'String', length: 50 }],
      },
    ],
    ...overrides,
  })
}

// Модель з broken ref для тесту валідації
function brokenRefModel(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: 'Test' },
    catalogs: [
      {
        kind: 'Catalog',
        name: 'Orders',
        codeLength: 9,
        attributes: [
          {
            name: 'client',
            type: 'Ref',
            ref: { kind: 'Catalog', name: 'NonExistentCatalog' },
          },
        ],
      },
    ],
  })
}

function setModel(model: ProjectModel) {
  useMetadataStore.setState({
    model,
    version: 1,
    objectVersions: {},
    validationErrors: {},
    modelErrors: {},
  })
}

describe('ddl-store', () => {
  beforeEach(() => {
    useDdlStore.getState().clearOutput()
    useDdlStore.getState().clearValidationErrors()
  })

  it('generateDdl with valid model produces non-empty output', () => {
    setModel(validModel())
    useDdlStore.getState().generateDdl()
    const state = useDdlStore.getState()
    expect(state.output).not.toBeNull()
    expect(state.output!.files.length).toBeGreaterThan(0)
    expect(state.validationErrors).toEqual([])
    expect(state.selectedFilePath).toBe(state.output!.files[0]!.path)
  })

  it('generateDdl with broken ref sets validationErrors and no output', () => {
    setModel(brokenRefModel())
    useDdlStore.getState().generateDdl()
    const state = useDdlStore.getState()
    expect(state.validationErrors.length).toBeGreaterThan(0)
    expect(state.output).toBeNull()
  })

  it('generateDdlForce ignores validation errors and produces output', () => {
    setModel(brokenRefModel())
    useDdlStore.getState().generateDdlForce()
    const state = useDdlStore.getState()
    expect(state.output).not.toBeNull()
    expect(state.output!.files.length).toBeGreaterThan(0)
  })

  it('selectFile updates selectedFilePath', () => {
    useDdlStore.getState().selectFile('test/file.sql')
    expect(useDdlStore.getState().selectedFilePath).toBe('test/file.sql')
  })

  it('selectFile with null clears selection', () => {
    useDdlStore.getState().selectFile('test/file.sql')
    useDdlStore.getState().selectFile(null)
    expect(useDdlStore.getState().selectedFilePath).toBeNull()
  })

  it('clearOutput resets output state', () => {
    setModel(validModel())
    useDdlStore.getState().generateDdl()
    expect(useDdlStore.getState().output).not.toBeNull()

    useDdlStore.getState().clearOutput()
    const state = useDdlStore.getState()
    expect(state.output).toBeNull()
    expect(state.selectedFilePath).toBeNull()
    expect(state.generationError).toBeNull()
  })

  it('clearValidationErrors resets validation errors', () => {
    setModel(brokenRefModel())
    useDdlStore.getState().generateDdl()
    expect(useDdlStore.getState().validationErrors.length).toBeGreaterThan(0)

    useDdlStore.getState().clearValidationErrors()
    expect(useDdlStore.getState().validationErrors).toEqual([])
  })

  it('generateDdl sets selectedFilePath to first file', () => {
    setModel(validModel())
    useDdlStore.getState().generateDdl()
    const state = useDdlStore.getState()
    expect(state.selectedFilePath).toBe(state.output!.files[0]!.path)
  })
})
