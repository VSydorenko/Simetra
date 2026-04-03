import { describe, it, expect, beforeEach } from 'vitest'
import { projectModelSchema, type ProjectModel } from '@simetra/core'
import { useMetadataStore } from '../stores/metadata-store'
import { useUiStore } from '../stores/ui-store'
import { findReferences } from '../lib/find-references'

// --- Хелпери ---

function createMinimalModel(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: 'TestProject' },
  })
}

function createModelWithRefTargets(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: 'TestProject' },
    catalogs: [
      {
        kind: 'Catalog',
        name: 'Products',
        codeLength: 9,
        codeType: 'String',
        descriptionLength: 100,
        hierarchyType: 'None',
        attributes: [
          { name: 'category', type: 'CatalogRef', ref: 'Categories' },
        ],
        tabularSections: [],
      },
      {
        kind: 'Catalog',
        name: 'Categories',
        codeLength: 9,
        codeType: 'String',
        descriptionLength: 100,
        hierarchyType: 'None',
        attributes: [],
        tabularSections: [],
      },
    ],
    documents: [
      {
        kind: 'Document',
        name: 'Categories',
        numberLength: 11,
        numberType: 'String',
        attributes: [
          { name: 'ref_doc', type: 'DocumentRef', ref: 'Categories' },
        ],
        tabularSections: [],
      },
    ],
  })
}

// --- deleteObject: version не інкрементується при неіснуючому обʼєкті ---

describe('deleteObject version increment', () => {
  beforeEach(() => {
    useMetadataStore.getState().loadModel(createMinimalModel())
  })

  it('не інкрементує version при видаленні неіснуючого обʼєкта', () => {
    const versionBefore = useMetadataStore.getState().version
    useMetadataStore.getState().deleteObject('Catalog', 'Nonexistent')
    const versionAfter = useMetadataStore.getState().version
    expect(versionAfter).toBe(versionBefore)
  })

  it('інкрементує version при видаленні існуючого обʼєкта', () => {
    useMetadataStore.getState().createObject({
      kind: 'Catalog',
      name: 'TestCatalog',
      codeLength: 9,
      codeType: 'String',
      descriptionLength: 100,
      hierarchyType: 'None',
      attributes: [],
      tabularSections: [],
    } as never)
    const versionBefore = useMetadataStore.getState().version
    useMetadataStore.getState().deleteObject('Catalog', 'TestCatalog')
    const versionAfter = useMetadataStore.getState().version
    expect(versionAfter).toBe(versionBefore + 1)
  })
})

// --- find-references: kind-aware перевірка attr.ref ---

describe('findReferences kind-aware', () => {
  it('знаходить reference лише при відповідності kind через attr.type', () => {
    const model = createModelWithRefTargets()

    // Шукаємо хто посилається на Catalog/Categories
    const catalogRefs = findReferences(model, 'Catalog', 'Categories')
    // Тільки Products.Category (CatalogRef) має посилатись
    expect(catalogRefs).toHaveLength(1)
    expect(catalogRefs[0].from).toEqual({ kind: 'Catalog', name: 'Products' })
  })

  it('не дає false positives для однакових name у різних kinds', () => {
    const model = createModelWithRefTargets()

    // Шукаємо хто посилається на Document/Categories
    const docRefs = findReferences(model, 'Document', 'Categories')
    // Documents.Categories.ref_doc (DocumentRef → Categories) має знайтись
    expect(docRefs).toHaveLength(1)
    expect(docRefs[0].from).toEqual({ kind: 'Document', name: 'Categories' })
  })
})

// --- selectField: tabularSectionName передається ---

describe('selectField tabularSectionName', () => {
  beforeEach(() => {
    useUiStore.setState({ selectedField: null })
  })

  it('зберігає tabularSectionName у selectedField', () => {
    useUiStore.getState().selectField({
      objectRef: { kind: 'Catalog', name: 'Products' },
      fieldName: 'Quantity',
      tabularSectionName: 'Items',
    })

    const { selectedField } = useUiStore.getState()
    expect(selectedField).not.toBeNull()
    expect(selectedField?.tabularSectionName).toBe('Items')
    expect(selectedField?.fieldName).toBe('Quantity')
  })

  it('selectedField без tabularSectionName для top-level реквізитів', () => {
    useUiStore.getState().selectField({
      objectRef: { kind: 'Catalog', name: 'Products' },
      fieldName: 'Category',
    })

    const { selectedField } = useUiStore.getState()
    expect(selectedField).not.toBeNull()
    expect(selectedField?.tabularSectionName).toBeUndefined()
    expect(selectedField?.fieldName).toBe('Category')
  })
})
