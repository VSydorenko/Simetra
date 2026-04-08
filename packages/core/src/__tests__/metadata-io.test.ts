import { describe, it, expect } from 'vitest'
import {
  parseMetadataFiles,
  buildProjectModelFromParsed,
  serializeToFiles,
  toKebabCase,
  KIND_TO_DIR,
  DIR_TO_KIND,
} from '../metadata-io'
import { projectModelSchema, type ProjectModel } from '../schemas'

// --- Helpers ---

function makeFiles(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries))
}

const MINIMAL_PROJECT = JSON.stringify({ name: 'TestProject', schemaVersion: '1.0' })

const VALID_CATALOG = JSON.stringify({
  kind: 'Catalog',
  name: 'Products',
  codeLength: 9,
  codeType: 'String',
  descriptionLength: 100,
  hierarchyType: 'None',
  attributes: [],
  tabularSections: [],
})

const VALID_DOCUMENT = JSON.stringify({
  kind: 'Document',
  name: 'SalesOrder',
  numberLength: 11,
  numberType: 'String',
  attributes: [],
  tabularSections: [],
})

const VALID_CONSTANT_1 = {
  kind: 'Constant',
  name: 'CompanyName',
  valueType: 'String',
}

const VALID_CONSTANT_2 = {
  kind: 'Constant',
  name: 'MaxRetries',
  valueType: 'Integer',
}

// --- KIND_TO_DIR / DIR_TO_KIND ---

describe('KIND_TO_DIR / DIR_TO_KIND', () => {
  it('has all 7 metadata kinds', () => {
    expect(Object.keys(KIND_TO_DIR)).toHaveLength(7)
    expect(Object.keys(DIR_TO_KIND)).toHaveLength(7)
  })

  it('round-trips kind → dir → kind', () => {
    for (const [kind, dir] of Object.entries(KIND_TO_DIR)) {
      expect(DIR_TO_KIND[dir]).toBe(kind)
    }
  })
})

// --- toKebabCase ---

describe('toKebabCase', () => {
  it('converts PascalCase', () => {
    expect(toKebabCase('SalesOrder')).toBe('sales-order')
  })

  it('handles consecutive uppercase', () => {
    expect(toKebabCase('HTMLParser')).toBe('html-parser')
  })

  it('handles single word', () => {
    expect(toKebabCase('Products')).toBe('products')
  })
})

// --- parseMetadataFiles ---

describe('parseMetadataFiles', () => {
  it('parses project.meta.json', () => {
    const files = makeFiles({ 'project.meta.json': MINIMAL_PROJECT })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(warnings).toHaveLength(0)
    expect(parsed.project).toBeDefined()
    expect((parsed.project as { name: string }).name).toBe('TestProject')
  })

  it('parses catalog from correct directory', () => {
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/products/products.meta.json': VALID_CATALOG,
    })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(warnings).toHaveLength(0)
    expect(parsed.objects).toHaveLength(1)
    expect(parsed.objects[0].kind).toBe('Catalog')
  })

  it('parses document from correct directory', () => {
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'documents/sales-order/sales-order.meta.json': VALID_DOCUMENT,
    })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(warnings).toHaveLength(0)
    expect(parsed.objects).toHaveLength(1)
    expect(parsed.objects[0].kind).toBe('Document')
  })

  it('handles invalid JSON with warning', () => {
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/bad/bad.meta.json': '{ invalid json',
    })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(warnings).toHaveLength(1)
    expect(warnings[0].filePath).toBe('catalogs/bad/bad.meta.json')
    expect(warnings[0].errors[0]).toContain('Invalid JSON')
    expect(parsed.objects).toHaveLength(0)
  })

  it('invalid project.meta.json JSON produces warning', () => {
    const files = makeFiles({ 'project.meta.json': '{ broken' })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(warnings).toHaveLength(1)
    expect(warnings[0].filePath).toBe('project.meta.json')
    expect(parsed.project).toBeUndefined()
  })

  it('warns about unknown directories', () => {
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'unknown/foo/foo.meta.json': '{}',
    })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(warnings).toHaveLength(1)
    expect(warnings[0].errors[0]).toContain('Unknown metadata directory')
    expect(parsed.objects).toHaveLength(0)
  })

  it('ignores files without .meta.json suffix', () => {
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/products/readme.txt': 'some text',
    })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(warnings).toHaveLength(0)
    expect(parsed.objects).toHaveLength(0)
  })

  // Constants wrapper
  it('parses constants wrapper format', () => {
    const wrapper = JSON.stringify({
      constants: [VALID_CONSTANT_1, VALID_CONSTANT_2],
    })
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'constants/constants.meta.json': wrapper,
    })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(warnings).toHaveLength(0)
    expect(parsed.objects.filter((o) => o.kind === 'Constant')).toHaveLength(2)
  })

  it('parses constants legacy array format', () => {
    const legacy = JSON.stringify([VALID_CONSTANT_1, VALID_CONSTANT_2])
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'constants/constants.meta.json': legacy,
    })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(warnings).toHaveLength(0)
    expect(parsed.objects.filter((o) => o.kind === 'Constant')).toHaveLength(2)
  })

  it('graceful degradation for broken constants wrapper', () => {
    const wrapper = JSON.stringify({
      constants: [
        VALID_CONSTANT_1,
        { name: 'Bad', valueType: 'String' }, // відсутнє kind
        VALID_CONSTANT_2,
      ],
    })
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'constants/constants.meta.json': wrapper,
    })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(parsed.objects.filter((o) => o.kind === 'Constant')).toHaveLength(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].errors[0]).toContain('constants[1]')
  })

  // Forms parsing (Phase 3)
  it('parses form files from forms/ directory', () => {
    const formData = JSON.stringify({
      kind: 'ItemForm',
      objectRef: { kind: 'Catalog', name: 'Products' },
      layout: { element: 'Group', children: [] },
    })
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/products/products.meta.json': VALID_CATALOG,
      'catalogs/products/forms/item.form.json': formData,
    })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(warnings).toHaveLength(0)
    expect(parsed.forms).toHaveLength(1)
    expect(parsed.forms[0].objectSlug).toBe('products')
    expect(parsed.forms[0].objectKind).toBe('Catalog')
    expect(parsed.forms[0].formFileName).toBe('item.form.json')
    expect(parsed.forms[0].filePath).toBe('catalogs/products/forms/item.form.json')
  })

  it('handles invalid form JSON with warning', () => {
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/products/forms/item.form.json': '{ broken',
    })
    const { parsed, warnings } = parseMetadataFiles(files)

    expect(warnings).toHaveLength(1)
    expect(warnings[0].filePath).toBe('catalogs/products/forms/item.form.json')
    expect(parsed.forms).toHaveLength(0)
  })

  it('ignores forms without .form.json suffix', () => {
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/products/forms/readme.txt': 'text',
    })
    const { parsed } = parseMetadataFiles(files)

    expect(parsed.forms).toHaveLength(0)
  })
})

// --- buildProjectModelFromParsed ---

describe('buildProjectModelFromParsed', () => {
  it('builds valid ProjectModel from parsed files', () => {
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/products/products.meta.json': VALID_CATALOG,
    })
    const { parsed } = parseMetadataFiles(files)
    const { model, warnings } = buildProjectModelFromParsed(parsed)

    expect(warnings).toHaveLength(0)
    expect(model.project.name).toBe('TestProject')
    expect(model.catalogs).toHaveLength(1)
    expect(model.catalogs[0].name).toBe('Products')
  })

  it('throws on missing project.meta.json', () => {
    const files = makeFiles({
      'catalogs/products/products.meta.json': VALID_CATALOG,
    })
    const { parsed } = parseMetadataFiles(files)

    expect(() => buildProjectModelFromParsed(parsed)).toThrow(
      /project\.meta\.json is missing/,
    )
  })

  it('throws on invalid project.meta.json schema', () => {
    const files = makeFiles({
      'project.meta.json': JSON.stringify({ name: 123 }),
    })
    const { parsed } = parseMetadataFiles(files)

    expect(() => buildProjectModelFromParsed(parsed)).toThrow(
      /project\.meta\.json is invalid/,
    )
  })

  it('collects warnings for invalid objects in lenient mode', () => {
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/bad/bad.meta.json': JSON.stringify({
        kind: 'Catalog',
        name: 'lowercase', // невалідне ім'я (не PascalCase)
      }),
    })
    const { parsed } = parseMetadataFiles(files)
    const { model, warnings } = buildProjectModelFromParsed(parsed)

    expect(warnings).toHaveLength(1)
    expect(model.catalogs).toHaveLength(0)
  })

  it('throws on invalid objects in strict mode', () => {
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/bad/bad.meta.json': JSON.stringify({
        kind: 'Catalog',
        name: 'lowercase',
      }),
    })
    const { parsed } = parseMetadataFiles(files)

    expect(() => buildProjectModelFromParsed(parsed, { strict: true })).toThrow(
      /Помилка валідації/,
    )
  })

  it('returns forms in forms map', () => {
    const formData = { kind: 'ItemForm', layout: { element: 'Group', children: [] } }
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/products/products.meta.json': VALID_CATALOG,
      'catalogs/products/forms/item.form.json': JSON.stringify(formData),
    })
    const { parsed } = parseMetadataFiles(files)
    const { forms } = buildProjectModelFromParsed(parsed)

    expect(forms.size).toBe(1)
    expect(forms.has('catalogs/products/forms/item.form.json')).toBe(true)
  })

  it('builds constants from wrapper through full pipeline', () => {
    const wrapper = JSON.stringify({
      constants: [VALID_CONSTANT_1, VALID_CONSTANT_2],
    })
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'constants/constants.meta.json': wrapper,
    })
    const { parsed } = parseMetadataFiles(files)
    const { model, warnings } = buildProjectModelFromParsed(parsed)

    expect(warnings).toHaveLength(0)
    expect(model.constants).toHaveLength(2)
    expect(model.constants[0].name).toBe('CompanyName')
  })

  // --- Forms в buildProjectModelFromParsed (Phase 3 — Stage 2) ---

  it('includes validated forms in model.forms', () => {
    const formData = { kind: 'ItemForm', layout: { element: 'Group', children: [] } }
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/products/products.meta.json': VALID_CATALOG,
      'catalogs/products/forms/item.form.json': JSON.stringify(formData),
    })
    const { parsed } = parseMetadataFiles(files)
    const { model, warnings } = buildProjectModelFromParsed(parsed)

    expect(warnings).toHaveLength(0)
    expect(model.forms).toHaveLength(1)
    expect(model.forms[0].kind).toBe('ItemForm')
    expect(model.forms[0].objectRef).toEqual({ kind: 'Catalog', name: 'Products' })
  })

  it('resolves form objectSlug to objectName in model.forms', () => {
    // SalesOrder → slug "sales-order"
    const formData = { kind: 'ItemForm', layout: { element: 'Group', children: [] } }
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'documents/sales-order/sales-order.meta.json': VALID_DOCUMENT,
      'documents/sales-order/forms/item.form.json': JSON.stringify(formData),
    })
    const { parsed } = parseMetadataFiles(files)
    const { model, warnings } = buildProjectModelFromParsed(parsed)

    expect(warnings).toHaveLength(0)
    expect(model.forms).toHaveLength(1)
    // slug "sales-order" резолвиться у PascalCase "SalesOrder"
    expect(model.forms[0].objectRef.name).toBe('SalesOrder')
  })

  it('skips form for unknown object slug with warning', () => {
    const formData = { kind: 'ItemForm', layout: { element: 'Group' } }
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/unknown-catalog/forms/item.form.json': JSON.stringify(formData),
    })
    const { parsed } = parseMetadataFiles(files)
    const { model, warnings } = buildProjectModelFromParsed(parsed)

    expect(model.forms).toHaveLength(0)
    expect(warnings.length).toBeGreaterThan(0)
    const formWarnings = warnings.filter((w) => w.filePath.includes('forms/'))
    expect(formWarnings.length).toBeGreaterThan(0)
    expect(formWarnings[0].errors[0]).toContain('unknown-catalog')
  })

  it('skips form with unknown form file name with warning', () => {
    const formData = { kind: 'ItemForm', layout: { element: 'Group' } }
    const files = makeFiles({
      'project.meta.json': MINIMAL_PROJECT,
      'catalogs/products/products.meta.json': VALID_CATALOG,
      'catalogs/products/forms/custom.form.json': JSON.stringify(formData),
    })
    const { parsed } = parseMetadataFiles(files)
    const { model, warnings } = buildProjectModelFromParsed(parsed)

    expect(model.forms).toHaveLength(0)
    expect(warnings.length).toBeGreaterThan(0)
    const formWarnings = warnings.filter((w) => w.filePath.includes('forms/'))
    expect(formWarnings.length).toBeGreaterThan(0)
    expect(formWarnings[0].errors[0]).toContain('custom.form.json')
  })
})

// --- serializeToFiles ---

describe('serializeToFiles', () => {
  function createMinimalModel(): ProjectModel {
    return projectModelSchema.parse({
      project: { name: 'TestProject' },
    })
  }

  function createModelWithObjects(): ProjectModel {
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
          attributes: [],
          tabularSections: [],
        },
      ],
      constants: [VALID_CONSTANT_1, VALID_CONSTANT_2],
    })
  }

  it('creates project.meta.json', () => {
    const files = serializeToFiles(createMinimalModel())
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('project.meta.json')
    expect(files[0].content).toContain('"name": "TestProject"')
  })

  it('creates correct file paths for catalogs', () => {
    const files = serializeToFiles(createModelWithObjects())
    const catalogFiles = files.filter((f) => f.path.startsWith('catalogs/'))

    expect(catalogFiles).toHaveLength(1)
    expect(catalogFiles[0].path).toBe('catalogs/products/products.meta.json')
  })

  it('puts all constants in one wrapper file', () => {
    const files = serializeToFiles(createModelWithObjects())
    const constantFiles = files.filter((f) => f.path.startsWith('constants/'))

    expect(constantFiles).toHaveLength(1)
    expect(constantFiles[0].path).toBe('constants/constants.meta.json')

    const parsed = JSON.parse(constantFiles[0].content)
    expect(parsed).toHaveProperty('$schema')
    expect(parsed).toHaveProperty('constants')
    expect(parsed.constants).toHaveLength(2)
  })

  it('all files end with newline', () => {
    const files = serializeToFiles(createModelWithObjects())
    for (const file of files) {
      expect(file.content.endsWith('\n')).toBe(true)
    }
  })

  it('deterministic output', () => {
    const model = createModelWithObjects()
    expect(serializeToFiles(model)).toEqual(serializeToFiles(model))
  })

  // --- Forms серіалізація (Phase 3 — Stage 2) ---

  it('serializes forms as separate files in forms/ subdirectory', () => {
    const model = projectModelSchema.parse({
      project: { name: 'TestProject' },
      catalogs: [
        {
          kind: 'Catalog',
          name: 'Products',
          codeLength: 9,
          codeType: 'String',
          descriptionLength: 100,
          hierarchyType: 'None',
          attributes: [],
          tabularSections: [],
        },
      ],
      forms: [
        {
          kind: 'ItemForm',
          objectRef: { kind: 'Catalog', name: 'Products' },
        },
        {
          kind: 'ListForm',
          objectRef: { kind: 'Catalog', name: 'Products' },
        },
      ],
    })
    const files = serializeToFiles(model)
    const formFiles = files.filter((f) => f.path.includes('/forms/'))

    expect(formFiles).toHaveLength(2)
    expect(formFiles.map((f) => f.path).sort()).toEqual([
      'catalogs/products/forms/item.form.json',
      'catalogs/products/forms/list.form.json',
    ])
  })

  it('serializes forms with $schema URL', () => {
    const model = projectModelSchema.parse({
      project: { name: 'TestProject' },
      catalogs: [{ kind: 'Catalog', name: 'Products' }],
      forms: [
        {
          kind: 'ItemForm',
          objectRef: { kind: 'Catalog', name: 'Products' },
        },
      ],
    })
    const files = serializeToFiles(model)
    const formFile = files.find((f) => f.path.includes('/forms/'))
    expect(formFile).toBeDefined()

    const parsed = JSON.parse(formFile!.content)
    expect(parsed.$schema).toContain('form.schema.json')
  })

  it('does not write forms if model.forms is empty', () => {
    const model = projectModelSchema.parse({
      project: { name: 'TestProject' },
      catalogs: [{ kind: 'Catalog', name: 'Products' }],
    })
    const files = serializeToFiles(model)
    const formFiles = files.filter((f) => f.path.includes('/forms/'))
    expect(formFiles).toHaveLength(0)
  })
})

// --- Round-trip: serializeToFiles → parseMetadataFiles → buildProjectModelFromParsed ---

describe('round-trip', () => {
  it('empty project survives round-trip', () => {
    const original = projectModelSchema.parse({ project: { name: 'TestProject' } })
    const files = serializeToFiles(original)

    const fileMap = new Map(files.map((f) => [f.path, f.content]))
    const { parsed } = parseMetadataFiles(fileMap)
    const { model } = buildProjectModelFromParsed(parsed)

    const files2 = serializeToFiles(model)
    expect(files2).toEqual(files)
  })

  it('project with objects survives round-trip', () => {
    const original = projectModelSchema.parse({
      project: { name: 'TestProject' },
      catalogs: [
        {
          kind: 'Catalog',
          name: 'Products',
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
          name: 'SalesOrder',
          numberLength: 11,
          numberType: 'String',
          attributes: [],
          tabularSections: [],
        },
      ],
      enumerations: [
        {
          kind: 'Enumeration',
          name: 'OrderStatus',
          values: [{ name: 'New' }, { name: 'Completed' }],
        },
      ],
      constants: [VALID_CONSTANT_1, VALID_CONSTANT_2],
    })
    const files = serializeToFiles(original)

    const fileMap = new Map(files.map((f) => [f.path, f.content]))
    const { parsed } = parseMetadataFiles(fileMap)
    const { model } = buildProjectModelFromParsed(parsed)

    const files2 = serializeToFiles(model)
    expect(files2).toEqual(files)
  })

  it('project with all kind types survives round-trip', () => {
    const original = projectModelSchema.parse({
      project: { name: 'FullProject' },
      catalogs: [
        {
          kind: 'Catalog',
          name: 'Products',
          codeLength: 9,
          codeType: 'String',
          descriptionLength: 100,
          hierarchyType: 'None',
          attributes: [],
          tabularSections: [],
        },
      ],
      informationRegisters: [
        {
          kind: 'InformationRegister',
          name: 'CurrencyRates',
          periodicity: 'Day',
          writeMode: 'Independent',
          dimensions: [{ name: 'currency', type: 'String', length: 50 }],
          resources: [{ name: 'rate', type: 'Numeric', precision: 15, scale: 4 }],
        },
      ],
      accumulationRegisters: [
        {
          kind: 'AccumulationRegister',
          name: 'InventoryBalance',
          registerType: 'Balance',
          dimensions: [{ name: 'product', type: 'Ref', ref: { kind: 'Catalog', name: 'Products' } }],
          resources: [{ name: 'quantity', type: 'Numeric', precision: 15, scale: 3 }],
        },
      ],
      customTables: [
        {
          kind: 'CustomTable',
          name: 'AuditLog',
          attributes: [{ name: 'action', type: 'String', length: 50 }],
        },
      ],
    })
    const files = serializeToFiles(original)

    const fileMap = new Map(files.map((f) => [f.path, f.content]))
    const { parsed } = parseMetadataFiles(fileMap)
    const { model } = buildProjectModelFromParsed(parsed)

    const files2 = serializeToFiles(model)
    expect(files2).toEqual(files)
  })
})

// --- Round-trip з forms (Phase 3 — Stage 2) ---

describe('round-trip with forms', () => {
  it('survives serialize → parse → build cycle', () => {
    const original = projectModelSchema.parse({
      project: { name: 'TestProject' },
      catalogs: [
        {
          kind: 'Catalog',
          name: 'Products',
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
          name: 'SalesOrder',
          numberLength: 11,
          numberType: 'String',
          attributes: [],
          tabularSections: [],
        },
      ],
      forms: [
        {
          kind: 'ItemForm',
          objectRef: { kind: 'Catalog', name: 'Products' },
          title: { uk: 'Картка товару' },
        },
        {
          kind: 'ListForm',
          objectRef: { kind: 'Catalog', name: 'Products' },
        },
        {
          kind: 'ItemForm',
          objectRef: { kind: 'Document', name: 'SalesOrder' },
        },
      ],
    })
    const files = serializeToFiles(original)

    // Перевірка що form-файли були створені
    const formFiles = files.filter((f) => f.path.includes('/forms/'))
    expect(formFiles).toHaveLength(3)

    // Parse назад
    const fileMap = new Map(files.map((f) => [f.path, f.content]))
    const { parsed } = parseMetadataFiles(fileMap)
    const { model, warnings } = buildProjectModelFromParsed(parsed)

    expect(warnings).toHaveLength(0)
    expect(model.forms).toHaveLength(3)

    // Другий серіалізаційний цикл має бути ідентичний
    const files2 = serializeToFiles(model)
    expect(files2).toEqual(files)
  })
})
