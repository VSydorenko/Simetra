import { describe, it, expect } from 'vitest'
import { type ProjectModel, projectModelSchema, type FormSchema, formSchema } from '../schemas'
import { generateItemForm, generateListForm, resolveForm } from '../autoform'

// ============================================================
// Helper: мінімальна ProjectModel через schema parsing
// ============================================================

function buildModel(
  partial: Partial<Record<keyof Omit<ProjectModel, 'project'>, unknown[]>>,
): ProjectModel {
  return projectModelSchema.parse({
    project: { name: 'TestProject' },
    ...partial,
  })
}

// ============================================================
// generateItemForm
// ============================================================

describe('generateItemForm', () => {
  it('Catalog без ТЧ, ≤6 user-defined полів → Group (вертикальний список)', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'Products',
      attributes: [
        { name: 'sku', type: 'String', length: 50, required: true },
        { name: 'weight', type: 'Numeric', precision: 10, scale: 2 },
      ],
      tabularSections: [],
    }

    const form = generateItemForm(catalog, 'Catalog')

    expect(form.kind).toBe('ItemForm')
    expect(form.objectRef).toEqual({ kind: 'Catalog', name: 'Products' })
    expect(form.layout).toBeDefined()
    expect(form.layout!.element).toBe('Group')
    if (form.layout!.element === 'Group') {
      expect(form.layout!.children).toHaveLength(2)
      expect(form.layout!.children[0]).toEqual({ element: 'Field', ref: 'sku' })
      expect(form.layout!.children[1]).toEqual({ element: 'Field', ref: 'weight' })
    }
  })

  it('стандартні реквізити НЕ включаються в тіло форми', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'Products',
      attributes: [
        { name: 'sku', type: 'String', length: 50, required: true },
        // Стандартні реквізити Catalog — не повинні потрапити в layout
        { name: 'code', type: 'String', length: 50 },
        { name: 'description', type: 'String', length: 50 },
        { name: 'deletion_mark', type: 'Boolean' },
      ],
      tabularSections: [],
    }

    const form = generateItemForm(catalog, 'Catalog')

    expect(form.layout).toBeDefined()
    if (form.layout!.element === 'Group') {
      // Тільки sku — стандартні виключені
      expect(form.layout!.children).toHaveLength(1)
      expect(form.layout!.children[0]).toEqual({ element: 'Field', ref: 'sku' })
    }
  })

  it('Document з ТЧ → Tabs', () => {
    const doc = {
      kind: 'Document' as const,
      name: 'SalesOrder',
      attributes: [
        { name: 'customer', type: 'Ref', ref: { kind: 'Catalog', name: 'Customers' } },
        { name: 'total', type: 'Numeric', precision: 15, scale: 2 },
      ],
      tabularSections: [
        {
          name: 'items',
          displayName: { uk: 'Товари', en: 'Items' },
          attributes: [
            {
              name: 'product',
              type: 'Ref',
              ref: { kind: 'Catalog', name: 'Products' },
            },
          ],
        },
        {
          name: 'payments',
          displayName: { uk: 'Оплати', en: 'Payments' },
          attributes: [
            { name: 'amount', type: 'Numeric', precision: 15, scale: 2 },
          ],
        },
      ],
    }

    const form = generateItemForm(doc, 'Document')

    expect(form.kind).toBe('ItemForm')
    expect(form.objectRef).toEqual({ kind: 'Document', name: 'SalesOrder' })
    expect(form.layout).toBeDefined()
    expect(form.layout!.element).toBe('Tabs')
    if (form.layout!.element === 'Tabs') {
      expect(form.layout!.tabs).toHaveLength(3)
      // Перша вкладка — "Основні"
      expect(form.layout!.tabs[0].title).toEqual({ uk: 'Основні', en: 'General' })
      expect(form.layout!.tabs[0].children).toHaveLength(2) // customer, total
      // Друга — items ТЧ
      expect(form.layout!.tabs[1].title).toEqual({ uk: 'Товари', en: 'Items' })
      expect(form.layout!.tabs[1].children).toHaveLength(1)
      expect(form.layout!.tabs[1].children[0]).toEqual({
        element: 'TabularSection',
        ref: 'items',
      })
      // Третя — payments ТЧ
      expect(form.layout!.tabs[2].title).toEqual({ uk: 'Оплати', en: 'Payments' })
    }
  })

  it('Catalog з >6 user-defined полів без ТЧ → Columns', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'Products',
      attributes: [
        { name: 'sku', type: 'String', length: 50 },
        { name: 'barcode', type: 'String', length: 50 },
        { name: 'weight', type: 'Numeric', precision: 10, scale: 2 },
        { name: 'height', type: 'Numeric', precision: 10, scale: 2 },
        { name: 'width_val', type: 'Numeric', precision: 10, scale: 2 },
        { name: 'depth', type: 'Numeric', precision: 10, scale: 2 },
        { name: 'color', type: 'String', length: 50 },
      ],
      tabularSections: [],
    }

    const form = generateItemForm(catalog, 'Catalog')

    expect(form.layout).toBeDefined()
    expect(form.layout!.element).toBe('Columns')
    if (form.layout!.element === 'Columns') {
      expect(form.layout!.columns).toHaveLength(2)
      // Перша колонка: ceil(7/2) = 4
      expect(form.layout!.columns[0].children).toHaveLength(4)
      // Друга колонка: 3
      expect(form.layout!.columns[1].children).toHaveLength(3)
    }
  })

  it('об\'єкт без user-defined полів → форма без layout', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'SimpleRef',
      attributes: [],
      tabularSections: [],
    }

    const form = generateItemForm(catalog, 'Catalog')
    expect(form.layout).toBeUndefined()
  })

  it('toolbar для Catalog → Save + DeletionMark', () => {
    const form = generateItemForm(
      { kind: 'Catalog' as const, name: 'X', attributes: [], tabularSections: [] },
      'Catalog',
    )
    expect(form.toolbar).toEqual([{ type: 'SaveButton' }, { type: 'DeletionMarkButton' }])
  })

  it('toolbar для Document → Save + Post + Unpost + DeletionMark', () => {
    const form = generateItemForm(
      { kind: 'Document' as const, name: 'X', attributes: [], tabularSections: [] },
      'Document',
    )
    expect(form.toolbar).toEqual([
      { type: 'SaveButton' },
      { type: 'PostButton' },
      { type: 'UnpostButton' },
      { type: 'DeletionMarkButton' },
    ])
  })

  it('toolbar для CustomTable → Save', () => {
    const form = generateItemForm(
      { kind: 'CustomTable' as const, name: 'X', attributes: [] },
      'CustomTable',
    )
    expect(form.toolbar).toEqual([{ type: 'SaveButton' }])
  })

  it('Catalog з ієрархією — стандартні parent_id/is_folder виключені', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'Categories',
      hierarchyType: 'FoldersAndItems' as const,
      attributes: [
        { name: 'sort_order', type: 'Integer' },
        // parent_id і is_folder — стандартні для ієрархічних каталогів
        { name: 'parent_id', type: 'UUID' },
        { name: 'is_folder', type: 'Boolean' },
      ],
      tabularSections: [],
    }

    const form = generateItemForm(catalog, 'Catalog')
    if (form.layout && form.layout.element === 'Group') {
      const refs = form.layout.children
        .filter((c): c is { element: 'Field'; ref: string } => c.element === 'Field')
        .map((c) => c.ref)
      expect(refs).toEqual(['sort_order'])
      expect(refs).not.toContain('parent_id')
      expect(refs).not.toContain('is_folder')
    }
  })
})

// ============================================================
// generateListForm
// ============================================================

describe('generateListForm', () => {
  it('Catalog → presentation cols (code, description) + user attrs', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'Products',
      attributes: [
        { name: 'sku', type: 'String', length: 50 },
        { name: 'weight', type: 'Numeric', precision: 10, scale: 2 },
      ],
      tabularSections: [],
    }

    const form = generateListForm(catalog, 'Catalog')

    expect(form.kind).toBe('ListForm')
    expect(form.objectRef).toEqual({ kind: 'Catalog', name: 'Products' })
    expect(form.layout).toBeDefined()
    if (form.layout!.element === 'Group') {
      const refs = form.layout!.children
        .filter((c): c is { element: 'Field'; ref: string } => c.element === 'Field')
        .map((c) => c.ref)
      // code, description (presentation) + sku, weight (user)
      expect(refs).toEqual(['code', 'description', 'sku', 'weight'])
    }
  })

  it('Document → presentation cols (number, date) + user attrs', () => {
    const doc = {
      kind: 'Document' as const,
      name: 'Invoice',
      attributes: [
        { name: 'customer', type: 'Ref', ref: { kind: 'Catalog', name: 'Customers' } },
      ],
      tabularSections: [],
    }

    const form = generateListForm(doc, 'Document')

    if (form.layout!.element === 'Group') {
      const refs = form.layout!.children
        .filter((c): c is { element: 'Field'; ref: string } => c.element === 'Field')
        .map((c) => c.ref)
      expect(refs).toEqual(['number', 'date', 'customer'])
    }
  })

  it('об\'єкт з >10 стовпців → обрізано до 8', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'Big',
      attributes: Array.from({ length: 12 }, (_, i) => ({
        name: `field_${i}`,
        type: 'String' as const,
        length: 50,
      })),
      tabularSections: [],
    }

    const form = generateListForm(catalog, 'Catalog')

    if (form.layout!.element === 'Group') {
      // code, description (2 presentation) + field_0..field_5 (6 user) = 8 total (з 14)
      expect(form.layout!.children).toHaveLength(8)
    }
  })

  it('об\'єкт з ≤10 стовпців → всі показуються', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'Medium',
      // 8 user + 2 presentation (code, description) = 10 total → не обрізаємо
      attributes: Array.from({ length: 8 }, (_, i) => ({
        name: `field_${i}`,
        type: 'String' as const,
        length: 50,
      })),
      tabularSections: [],
    }

    const form = generateListForm(catalog, 'Catalog')

    if (form.layout!.element === 'Group') {
      // code, description + 8 user = 10
      expect(form.layout!.children).toHaveLength(10)
    }
  })

  it('рівно 11 стовпців → обрізаємо до 8', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'JustOver',
      // 9 user + 2 presentation = 11
      attributes: Array.from({ length: 9 }, (_, i) => ({
        name: `field_${i}`,
        type: 'String' as const,
        length: 50,
      })),
      tabularSections: [],
    }

    const form = generateListForm(catalog, 'Catalog')

    if (form.layout!.element === 'Group') {
      expect(form.layout!.children).toHaveLength(8)
    }
  })

  it('CustomTable без presentation columns → тільки user attrs', () => {
    const table = {
      kind: 'CustomTable' as const,
      name: 'Logs',
      attributes: [
        { name: 'message', type: 'String', length: 50 },
        { name: 'level', type: 'String', length: 50 },
      ],
    }

    const form = generateListForm(table, 'CustomTable')

    if (form.layout!.element === 'Group') {
      const refs = form.layout!.children
        .filter((c): c is { element: 'Field'; ref: string } => c.element === 'Field')
        .map((c) => c.ref)
      expect(refs).toEqual(['message', 'level'])
    }
  })
})

// ============================================================
// resolveForm
// ============================================================

describe('resolveForm', () => {
  it('explicit form перемагає autogenerated', () => {
    const explicitForm: FormSchema = {
      kind: 'ItemForm',
      objectRef: { kind: 'Catalog', name: 'Products' },
      title: { uk: 'Моя форма', en: 'My form' },
      layout: {
        element: 'Group',
        children: [{ element: 'Field', ref: 'custom_field' }],
      },
    }

    const model = buildModel({
      catalogs: [{ kind: 'Catalog', name: 'Products', attributes: [] }],
      forms: [explicitForm],
    })

    const result = resolveForm({ kind: 'Catalog', name: 'Products' }, 'ItemForm', model)

    // Explicit form повертається як є (з model.forms після parse)
    expect(result.title).toEqual({ uk: 'Моя форма', en: 'My form' })
    expect(result.layout).toBeDefined()
    if (result.layout && result.layout.element === 'Group') {
      expect(result.layout.children[0]).toEqual({ element: 'Field', ref: 'custom_field' })
    }
  })

  it('fallback коли explicit відсутній → autogenerated', () => {
    const model = buildModel({
      catalogs: [
        {
          kind: 'Catalog',
          name: 'Products',
          attributes: [{ name: 'sku', type: 'String', length: 50 }],
        },
      ],
    })

    const result = resolveForm({ kind: 'Catalog', name: 'Products' }, 'ItemForm', model)

    expect(result.kind).toBe('ItemForm')
    expect(result.objectRef).toEqual({ kind: 'Catalog', name: 'Products' })
    // Autogenerated — без title
    expect(result.title).toBeUndefined()
    // Має layout з sku
    expect(result.layout).toBeDefined()
  })

  it('ListForm fallback → autogenerated list form', () => {
    const model = buildModel({
      catalogs: [
        {
          kind: 'Catalog',
          name: 'Products',
          attributes: [{ name: 'sku', type: 'String', length: 50 }],
        },
      ],
    })

    const result = resolveForm({ kind: 'Catalog', name: 'Products' }, 'ListForm', model)

    expect(result.kind).toBe('ListForm')
    expect(result.objectRef).toEqual({ kind: 'Catalog', name: 'Products' })
  })

  it('об\'єкт не знайдено → порожня форма', () => {
    const model = buildModel({ catalogs: [] })

    const result = resolveForm({ kind: 'Catalog', name: 'Missing' }, 'ItemForm', model)

    expect(result.kind).toBe('ItemForm')
    expect(result.objectRef).toEqual({ kind: 'Catalog', name: 'Missing' })
    expect(result.layout).toBeUndefined()
  })

  it('непідтримуваний kind → мінімальна порожня форма', () => {
    const model = buildModel({})

    const result = resolveForm(
      { kind: 'Enumeration', name: 'Colors' },
      'ItemForm',
      model,
    )

    expect(result.kind).toBe('ItemForm')
    expect(result.objectRef).toEqual({ kind: 'Enumeration', name: 'Colors' })
    expect(result.layout).toBeUndefined()
  })
})

// ============================================================
// Determinism — однакові metadata → однакова форма
// ============================================================

describe('autoform determinism', () => {
  it('однакові metadata → однакова ItemForm', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'Products',
      attributes: [
        { name: 'sku', type: 'String', length: 50 },
        { name: 'weight', type: 'Numeric', precision: 10, scale: 2 },
        { name: 'color', type: 'String', length: 50 },
      ],
      tabularSections: [
        {
          name: 'barcodes',
          displayName: { uk: 'Штрихкоди', en: 'Barcodes' },
          attributes: [{ name: 'value', type: 'String', length: 50 }],
        },
      ],
    }

    const form1 = generateItemForm(catalog, 'Catalog')
    const form2 = generateItemForm(catalog, 'Catalog')

    expect(form1).toEqual(form2)
  })

  it('однакові metadata → однакова ListForm', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'Products',
      attributes: [
        { name: 'sku', type: 'String', length: 50 },
        { name: 'weight', type: 'Numeric', precision: 10, scale: 2 },
      ],
      tabularSections: [],
    }

    const form1 = generateListForm(catalog, 'Catalog')
    const form2 = generateListForm(catalog, 'Catalog')

    expect(form1).toEqual(form2)
  })
})

// ============================================================
// Schema validation — autoform result проходить через FormSchema parse
// ============================================================

describe('autoform schema sanity', () => {
  it('ItemForm проходить formSchema.parse', () => {
    const doc = {
      kind: 'Document' as const,
      name: 'SalesOrder',
      attributes: [
        { name: 'customer', type: 'Ref', ref: { kind: 'Catalog', name: 'Customers' } },
        { name: 'total', type: 'Numeric', precision: 15, scale: 2 },
      ],
      tabularSections: [
        {
          name: 'items',
          displayName: { uk: 'Товари', en: 'Items' },
          attributes: [
            {
              name: 'product',
              type: 'Ref',
              ref: { kind: 'Catalog', name: 'Products' },
            },
          ],
        },
      ],
    }

    const form = generateItemForm(doc, 'Document')
    const parsed = formSchema.parse(form)

    expect(parsed.kind).toBe('ItemForm')
    expect(parsed.objectRef).toEqual({ kind: 'Document', name: 'SalesOrder' })
  })

  it('ListForm проходить formSchema.parse', () => {
    const catalog = {
      kind: 'Catalog' as const,
      name: 'Products',
      attributes: [{ name: 'sku', type: 'String', length: 50 }],
      tabularSections: [],
    }

    const form = generateListForm(catalog, 'Catalog')
    const parsed = formSchema.parse(form)

    expect(parsed.kind).toBe('ListForm')
  })
})
