import { describe, it, expect } from 'vitest'
import type { ProjectModel, Catalog, Document, CustomTable, Attribute } from '@simetra/core'
import type { GeneratorOptions } from '@simetra/generator-api'
import { buildSnapshot } from '../schema-snapshot'
import { computeDiff, isDestructiveChange, formatDiffSummary } from '../schema-diff'
import { generateMigrationSQL } from '../generate-migration'

// ─── Базові хелпери ──────────────────────────────────────────

function baseProject(
  overrides?: Partial<ProjectModel['project']>,
): ProjectModel['project'] {
  return {
    name: 'test-project',
    schemaVersion: '1.0',
    defaultLocale: 'uk',
    database: { target: 'postgresql', schema: 'public' },
    generation: {
      tablePrefix: '',
      enumStrategy: 'pgEnum',
      constantsStrategy: 'singleTable',
    },
    ...overrides,
  }
}

function emptyProject(overrides?: Partial<ProjectModel>): ProjectModel {
  return {
    project: baseProject(),
    catalogs: [],
    documents: [],
    enumerations: [],
    informationRegisters: [],
    accumulationRegisters: [],
    constants: [],
    customTables: [],
    ...overrides,
  }
}

/** Фабрика атрибутів з дефолтами для обов'язкових полів */
function attr(
  overrides: Pick<Attribute, 'name' | 'type'> & Partial<Omit<Attribute, 'name' | 'type'>>,
): Attribute {
  return {
    required: false,
    indexed: false,
    unique: false,
    defaultValue: null,
    ...overrides,
  } as Attribute
}

/** Фабрика Catalog з дефолтами */
function catalogDef(
  overrides: Pick<Catalog, 'name'> & Partial<Omit<Catalog, 'kind' | 'name'>>,
): Catalog {
  return {
    kind: 'Catalog',
    codeLength: 9,
    codeType: 'String',
    descriptionLength: 150,
    hierarchyType: 'None',
    owners: [],
    autonumber: false,
    codeUnique: false,
    mainPresentation: 'Description',
    predefinedItems: [],
    standardAttributeOverrides: {},
    attributes: [],
    tabularSections: [],
    ...overrides,
  } as Catalog
}

/** Фабрика Document з дефолтами */
function docDef(
  overrides: Pick<Document, 'name'> & Partial<Omit<Document, 'kind' | 'name'>>,
): Document {
  return {
    kind: 'Document',
    numberLength: 11,
    numberType: 'String',
    autonumber: false,
    numberPeriodicity: 'Year',
    registerMovements: [],
    standardAttributeOverrides: {},
    attributes: [],
    tabularSections: [],
    ...overrides,
  } as Document
}

/** Фабрика CustomTable з дефолтами */
function customTableDef(
  overrides: Pick<CustomTable, 'name'> & Partial<Omit<CustomTable, 'kind' | 'name'>>,
): CustomTable {
  return {
    kind: 'CustomTable',
    autoAddPrimaryKey: true,
    attributes: [],
    tabularSections: [],
    ...overrides,
  } as CustomTable
}

const defaultOpts: Required<GeneratorOptions> = {
  schema: 'public',
  enumStrategy: 'pgEnum',
  constantsStrategy: 'singleTable',
  outputMode: 'singleFile',
}

// ─── buildSnapshot ──────────────────────────────────────────

describe('buildSnapshot', () => {
  it('повертає порожній snapshot для порожнього проєкту', () => {
    const snap = buildSnapshot(emptyProject(), defaultOpts)
    expect(snap.version).toBe(1)
    expect(snap.generatorVersion).toBe('0.0.1')
    expect(Object.keys(snap.tables)).toHaveLength(0)
    expect(Object.keys(snap.enums)).toHaveLength(0)
    expect(Object.keys(snap.indexes)).toHaveLength(0)
  })

  it('створює table entry для Catalog', () => {
    const project = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const snap = buildSnapshot(project, defaultOpts)
    expect(snap.tables['cat_items']).toBeDefined()
    expect(snap.tables['cat_items'].columns['id']).toBeDefined()
    expect(snap.tables['cat_items'].columns['id'].primaryKey).toBe(true)
    expect(snap.tables['cat_items'].columns['code']).toBeDefined()
    expect(snap.tables['cat_items'].columns['description']).toBeDefined()
  })

  it('створює enum entry для pgEnum Enumeration', () => {
    const project = emptyProject({
      enumerations: [{
        kind: 'Enumeration',
        name: 'Status',
        values: [
          { name: 'Active', order: 0 },
          { name: 'Inactive', order: 1 },
        ],
      }],
    })
    const snap = buildSnapshot(project, defaultOpts)
    expect(snap.enums['enum_status']).toBeDefined()
    expect(snap.enums['enum_status'].strategy).toBe('pgEnum')
    expect(snap.enums['enum_status'].values).toEqual(['Active', 'Inactive'])
  })

  it('створює таблицю для lookupTable Enumeration', () => {
    const project = emptyProject({
      enumerations: [{
        kind: 'Enumeration',
        name: 'Status',
        values: [
          { name: 'Active', order: 0 },
          { name: 'Inactive', order: 1 },
        ],
      }],
    })
    const opts = { ...defaultOpts, enumStrategy: 'lookupTable' as const }
    const snap = buildSnapshot(project, opts)
    expect(snap.enums['enum_status'].strategy).toBe('lookupTable')
    expect(snap.tables['enum_status']).toBeDefined()
    expect(snap.tables['enum_status'].columns['name']).toBeDefined()
  })

  it('створює таблицю для Document', () => {
    const project = emptyProject({
      documents: [docDef({
        name: 'SalesOrder',
        attributes: [
          attr({ name: 'amount', type: 'Numeric', precision: 15, scale: 2 }),
        ],
      })],
    })
    const snap = buildSnapshot(project, defaultOpts)
    expect(snap.tables['doc_sales_order']).toBeDefined()
    expect(snap.tables['doc_sales_order'].columns['amount']).toBeDefined()
    expect(snap.tables['doc_sales_order'].columns['amount'].sqlType).toBe(
      'numeric(15, 2)',
    )
  })

  it('створює таблицю з табличною частиною', () => {
    const project = emptyProject({
      catalogs: [catalogDef({
        name: 'Products',
        tabularSections: [{
          name: 'prices',
          standardAttributeOverrides: {},
          attributes: [
            attr({ name: 'price', type: 'Numeric', precision: 15, scale: 2 }),
          ],
        }],
      })],
    })
    const snap = buildSnapshot(project, defaultOpts)
    expect(snap.tables['cat_products']).toBeDefined()
    expect(snap.tables['cat_products_prices']).toBeDefined()
    expect(snap.tables['cat_products_prices'].columns['parent_id']).toBeDefined()
    expect(snap.tables['cat_products_prices'].columns['price']).toBeDefined()
  })

  it('створює indeksy для FK ref attributes', () => {
    const project = emptyProject({
      catalogs: [catalogDef({
        name: 'Items',
        attributes: [
          attr({
            name: 'category',
            type: 'Ref',
            ref: { kind: 'Catalog', name: 'Categories' },
          }),
        ],
      })],
    })
    const snap = buildSnapshot(project, defaultOpts)
    expect(snap.indexes['idx_cat_items_category_id']).toBeDefined()
    expect(snap.indexes['idx_cat_items_category_id'].table).toBe('cat_items')
  })

  it('зберігає options у snapshot', () => {
    const opts = { ...defaultOpts, schema: 'custom' }
    const snap = buildSnapshot(emptyProject(), opts)
    expect(snap.options.schema).toBe('custom')
    expect(snap.options.enumStrategy).toBe('pgEnum')
  })

  it('створює таблицю для Constants (singleTable)', () => {
    const project = emptyProject({
      constants: [{
        kind: 'Constant',
        name: 'CompanyName',
        valueType: 'String',
      }],
    })
    const snap = buildSnapshot(project, defaultOpts)
    expect(snap.tables['const_settings']).toBeDefined()
    expect(snap.tables['const_settings'].columns['key']).toBeDefined()
    expect(snap.tables['const_settings'].columns['value_text']).toBeDefined()
  })

  it('створює окремі таблиці для Constants (separateTables)', () => {
    const project = emptyProject({
      constants: [{
        kind: 'Constant',
        name: 'CompanyName',
        valueType: 'String',
      }],
    })
    const opts = {
      ...defaultOpts,
      constantsStrategy: 'separateTables' as const,
    }
    const snap = buildSnapshot(project, opts)
    expect(snap.tables['const_company_name']).toBeDefined()
    expect(snap.tables['const_company_name'].columns['value']).toBeDefined()
  })

  it('створює table для CustomTable', () => {
    const project = emptyProject({
      customTables: [customTableDef({
        name: 'AuditLog',
        attributes: [
          attr({ name: 'message', type: 'Text' }),
        ],
      })],
    })
    const snap = buildSnapshot(project, defaultOpts)
    expect(snap.tables['ct_audit_log']).toBeDefined()
    expect(snap.tables['ct_audit_log'].columns['message']).toBeDefined()
  })
})

// ─── computeDiff ────────────────────────────────────────────

describe('computeDiff', () => {
  it('однакові snapshot-и → порожній diff', () => {
    const project = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const snap = buildSnapshot(project, defaultOpts)
    const diff = computeDiff(snap, snap)
    expect(diff.addedTables).toHaveLength(0)
    expect(diff.droppedTables).toHaveLength(0)
    expect(diff.addedColumns).toHaveLength(0)
    expect(diff.droppedColumns).toHaveLength(0)
    expect(diff.modifiedColumns).toHaveLength(0)
    expect(diff.hasDestructiveChanges).toBe(false)
  })

  it('додавання колонки → ADD COLUMN', () => {
    const oldProject = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const newProject = emptyProject({
      catalogs: [catalogDef({
        name: 'Items',
        attributes: [
          attr({ name: 'weight', type: 'Numeric', precision: 10, scale: 3 }),
        ],
      })],
    })
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)

    expect(diff.addedColumns).toHaveLength(1)
    expect(diff.addedColumns[0].table).toBe('cat_items')
    expect(diff.addedColumns[0].column).toBe('weight')
    expect(diff.addedColumns[0].def.sqlType).toBe('numeric(10, 3)')
    expect(diff.hasDestructiveChanges).toBe(false)
  })

  it('видалення колонки → DROP COLUMN (деструктивно)', () => {
    const oldProject = emptyProject({
      catalogs: [catalogDef({
        name: 'Items',
        attributes: [
          attr({ name: 'weight', type: 'Numeric', precision: 10, scale: 3 }),
        ],
      })],
    })
    const newProject = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)

    expect(diff.droppedColumns).toHaveLength(1)
    expect(diff.droppedColumns[0].table).toBe('cat_items')
    expect(diff.droppedColumns[0].column).toBe('weight')
    expect(diff.hasDestructiveChanges).toBe(true)
  })

  it('зміна типу колонки → ALTER COLUMN TYPE', () => {
    const oldProject = emptyProject({
      catalogs: [catalogDef({
        name: 'Items',
        attributes: [
          attr({ name: 'value', type: 'Integer' }),
        ],
      })],
    })
    const newProject = emptyProject({
      catalogs: [catalogDef({
        name: 'Items',
        attributes: [
          attr({ name: 'value', type: 'Numeric', precision: 15, scale: 2 }),
        ],
      })],
    })
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)

    expect(diff.modifiedColumns).toHaveLength(1)
    expect(diff.modifiedColumns[0].column).toBe('value')
    expect(diff.modifiedColumns[0].old.sqlType).toBe('integer')
    expect(diff.modifiedColumns[0].new.sqlType).toBe('numeric(15, 2)')
  })

  it('додавання таблиці → added table', () => {
    const oldProject = emptyProject()
    const newProject = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)

    expect(diff.addedTables).toContain('cat_items')
    expect(diff.hasDestructiveChanges).toBe(false)
  })

  it('видалення таблиці → dropped table (деструктивно)', () => {
    const oldProject = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const newProject = emptyProject()
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)

    expect(diff.droppedTables).toContain('cat_items')
    expect(diff.hasDestructiveChanges).toBe(true)
  })

  it('додавання enum value → addedEnumValues', () => {
    const oldProject = emptyProject({
      enumerations: [{
        kind: 'Enumeration',
        name: 'Status',
        values: [
          { name: 'Active', order: 0 },
        ],
      }],
    })
    const newProject = emptyProject({
      enumerations: [{
        kind: 'Enumeration',
        name: 'Status',
        values: [
          { name: 'Active', order: 0 },
          { name: 'Inactive', order: 1 },
        ],
      }],
    })
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)

    expect(diff.addedEnumValues).toHaveLength(1)
    expect(diff.addedEnumValues[0].enumName).toBe('enum_status')
    expect(diff.addedEnumValues[0].values).toContain('Inactive')
  })

  it('видалення enum → droppedEnums (деструктивно)', () => {
    const oldProject = emptyProject({
      enumerations: [{
        kind: 'Enumeration',
        name: 'Status',
        values: [{ name: 'Active', order: 0 }],
      }],
    })
    const newProject = emptyProject()
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)

    expect(diff.droppedEnums).toContain('enum_status')
    expect(diff.hasDestructiveChanges).toBe(true)
  })

  it('rename → treat as DROP + ADD (not detected as rename)', () => {
    const oldProject = emptyProject({
      catalogs: [catalogDef({
        name: 'Items',
        attributes: [
          attr({ name: 'old_field', type: 'String', length: 100 }),
        ],
      })],
    })
    const newProject = emptyProject({
      catalogs: [catalogDef({
        name: 'Items',
        attributes: [
          attr({ name: 'new_field', type: 'String', length: 100 }),
        ],
      })],
    })
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)

    // Rename treated як DROP + ADD
    expect(diff.droppedColumns).toHaveLength(1)
    expect(diff.droppedColumns[0].column).toBe('old_field')
    expect(diff.addedColumns).toHaveLength(1)
    expect(diff.addedColumns[0].column).toBe('new_field')
    expect(diff.hasDestructiveChanges).toBe(true)
  })
})

// ─── generateMigrationSQL ───────────────────────────────────

describe('generateMigrationSQL', () => {
  it('генерує порожній рядок для порожнього diff', () => {
    const project = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const snap = buildSnapshot(project, defaultOpts)
    const diff = computeDiff(snap, snap)
    const sql = generateMigrationSQL(diff, snap)
    expect(sql).toBe('')
  })

  it('генерує ALTER TABLE ADD COLUMN', () => {
    const oldProject = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const newProject = emptyProject({
      catalogs: [catalogDef({
        name: 'Items',
        attributes: [
          attr({ name: 'weight', type: 'Numeric', precision: 10, scale: 3 }),
        ],
      })],
    })
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)
    const sql = generateMigrationSQL(diff, newSnap)

    expect(sql).toContain('ALTER TABLE cat_items ADD COLUMN')
    expect(sql).toContain('weight')
    expect(sql).toContain('numeric(10, 3)')
  })

  it('генерує DROP COLUMN для видаленої колонки', () => {
    const oldProject = emptyProject({
      catalogs: [catalogDef({
        name: 'Items',
        attributes: [
          attr({ name: 'weight', type: 'Numeric', precision: 10, scale: 3 }),
        ],
      })],
    })
    const newProject = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)
    const sql = generateMigrationSQL(diff, newSnap)

    expect(sql).toContain('ALTER TABLE cat_items DROP COLUMN weight')
    expect(sql).toContain('DESTRUCTIVE')
  })

  it('генерує ALTER COLUMN TYPE', () => {
    const oldProject = emptyProject({
      catalogs: [catalogDef({
        name: 'Items',
        attributes: [
          attr({ name: 'value', type: 'Integer' }),
        ],
      })],
    })
    const newProject = emptyProject({
      catalogs: [catalogDef({
        name: 'Items',
        attributes: [
          attr({ name: 'value', type: 'Numeric', precision: 15, scale: 2 }),
        ],
      })],
    })
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)
    const sql = generateMigrationSQL(diff, newSnap)

    expect(sql).toContain('ALTER TABLE cat_items ALTER COLUMN value TYPE numeric(15, 2)')
  })

  it('генерує CREATE TABLE для нової таблиці', () => {
    const oldProject = emptyProject()
    const newProject = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)
    const sql = generateMigrationSQL(diff, newSnap)

    expect(sql).toContain('CREATE TABLE cat_items')
    expect(sql).toContain('Added Tables')
  })

  it('генерує DROP TABLE для видаленої таблиці', () => {
    const oldProject = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const newProject = emptyProject()
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)
    const sql = generateMigrationSQL(diff, newSnap)

    expect(sql).toContain('DROP TABLE IF EXISTS cat_items')
    expect(sql).toContain('DESTRUCTIVE')
  })

  it('генерує ALTER TYPE ADD VALUE для нових enum значень', () => {
    const oldProject = emptyProject({
      enumerations: [{
        kind: 'Enumeration',
        name: 'Status',
        values: [{ name: 'Active', order: 0 }],
      }],
    })
    const newProject = emptyProject({
      enumerations: [{
        kind: 'Enumeration',
        name: 'Status',
        values: [
          { name: 'Active', order: 0 },
          { name: 'Closed', order: 1 },
        ],
      }],
    })
    const oldSnap = buildSnapshot(oldProject, defaultOpts)
    const newSnap = buildSnapshot(newProject, defaultOpts)
    const diff = computeDiff(oldSnap, newSnap)
    const sql = generateMigrationSQL(diff, newSnap)

    expect(sql).toContain("ALTER TYPE enum_status ADD VALUE 'Closed'")
  })
})

// ─── isDestructiveChange ────────────────────────────────────

describe('isDestructiveChange', () => {
  it('повертає false для безпечних змін', () => {
    const oldProject = emptyProject()
    const newProject = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const diff = computeDiff(
      buildSnapshot(oldProject, defaultOpts),
      buildSnapshot(newProject, defaultOpts),
    )
    expect(isDestructiveChange(diff)).toBe(false)
  })

  it('повертає true для DROP TABLE', () => {
    const oldProject = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const diff = computeDiff(
      buildSnapshot(oldProject, defaultOpts),
      buildSnapshot(emptyProject(), defaultOpts),
    )
    expect(isDestructiveChange(diff)).toBe(true)
  })
})

// ─── formatDiffSummary ──────────────────────────────────────

describe('formatDiffSummary', () => {
  it('повертає порожній масив для порожнього diff', () => {
    const snap = buildSnapshot(emptyProject(), defaultOpts)
    const diff = computeDiff(snap, snap)
    expect(formatDiffSummary(diff)).toHaveLength(0)
  })

  it('маркує деструктивні зміни [DESTRUCTIVE]', () => {
    const oldProject = emptyProject({
      catalogs: [catalogDef({ name: 'Items' })],
    })
    const diff = computeDiff(
      buildSnapshot(oldProject, defaultOpts),
      buildSnapshot(emptyProject(), defaultOpts),
    )
    const summary = formatDiffSummary(diff)
    expect(summary.some((l) => l.includes('[DESTRUCTIVE]'))).toBe(true)
  })
})

// ─── Snapshot create → modify → diff → correct ALTER TABLE ──

describe('повний цикл: snapshot → modify → diff → migration', () => {
  it('додавання атрибута → ALTER TABLE ADD COLUMN', () => {
    const v1 = emptyProject({
      catalogs: [catalogDef({
        name: 'Products',
        attributes: [
          attr({ name: 'price', type: 'Numeric', precision: 15, scale: 2 }),
        ],
      })],
    })
    const v2 = emptyProject({
      catalogs: [catalogDef({
        name: 'Products',
        attributes: [
          attr({ name: 'price', type: 'Numeric', precision: 15, scale: 2 }),
          attr({ name: 'sku', type: 'String', length: 50 }),
        ],
      })],
    })

    const snap1 = buildSnapshot(v1, defaultOpts)
    const snap2 = buildSnapshot(v2, defaultOpts)
    const diff = computeDiff(snap1, snap2)
    const sql = generateMigrationSQL(diff, snap2)

    expect(diff.addedColumns).toHaveLength(1)
    expect(diff.addedColumns[0].column).toBe('sku')
    expect(sql).toContain('ALTER TABLE cat_products ADD COLUMN sku varchar(50)')
    expect(diff.hasDestructiveChanges).toBe(false)
  })

  it('видалення атрибута → DROP COLUMN з confirmation', () => {
    const v1 = emptyProject({
      catalogs: [catalogDef({
        name: 'Products',
        attributes: [
          attr({ name: 'price', type: 'Numeric', precision: 15, scale: 2 }),
          attr({ name: 'obsolete', type: 'Boolean' }),
        ],
      })],
    })
    const v2 = emptyProject({
      catalogs: [catalogDef({
        name: 'Products',
        attributes: [
          attr({ name: 'price', type: 'Numeric', precision: 15, scale: 2 }),
        ],
      })],
    })

    const snap1 = buildSnapshot(v1, defaultOpts)
    const snap2 = buildSnapshot(v2, defaultOpts)
    const diff = computeDiff(snap1, snap2)
    const sql = generateMigrationSQL(diff, snap2)

    expect(diff.droppedColumns).toHaveLength(1)
    expect(diff.droppedColumns[0].column).toBe('obsolete')
    expect(diff.hasDestructiveChanges).toBe(true)
    expect(sql).toContain('DROP COLUMN obsolete')
  })

  it('зміна типу атрибута → ALTER COLUMN TYPE', () => {
    const v1 = emptyProject({
      documents: [docDef({
        name: 'Invoice',
        attributes: [
          attr({ name: 'total', type: 'Integer' }),
        ],
      })],
    })
    const v2 = emptyProject({
      documents: [docDef({
        name: 'Invoice',
        attributes: [
          attr({ name: 'total', type: 'Numeric', precision: 15, scale: 2 }),
        ],
      })],
    })

    const snap1 = buildSnapshot(v1, defaultOpts)
    const snap2 = buildSnapshot(v2, defaultOpts)
    const diff = computeDiff(snap1, snap2)
    const sql = generateMigrationSQL(diff, snap2)

    expect(diff.modifiedColumns).toHaveLength(1)
    expect(diff.modifiedColumns[0].old.sqlType).toBe('integer')
    expect(diff.modifiedColumns[0].new.sqlType).toBe('numeric(15, 2)')
    expect(sql).toContain('ALTER TABLE doc_invoice ALTER COLUMN total TYPE numeric(15, 2)')
  })
})
