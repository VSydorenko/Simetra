import { describe, it, expect } from 'vitest'
import type { ProjectModel, Attribute } from '@simetra/core'
import type { GeneratorOptions } from '@simetra/generator-api'
import { expressionToSql } from '../generate-posting'
import { generateProjectDDL } from '../generate-table'

const defaultOpts: Required<GeneratorOptions> = {
  enumStrategy: 'pgEnum',
  constantsStrategy: 'singleTable',
  outputMode: 'singleFile',
  schema: 'public',
}

// Мінімальний атрибут з усіма обов'язковими полями
function attr(
  name: string,
  type: Attribute['type'],
  overrides?: Partial<Attribute>,
): Attribute {
  return {
    name,
    type,
    required: true,
    indexed: false,
    unique: false,
    defaultValue: null,
    ...overrides,
  } as Attribute
}

function baseProject(
  overrides?: Partial<ProjectModel['project']>,
): ProjectModel['project'] {
  return {
    name: 'test-project',
    schemaVersion: '1.0',
    defaultLocale: 'uk',
    database: {
      target: 'postgresql',
      schema: 'public',
    },
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

function generateSQL(
  project: ProjectModel,
  opts?: Partial<GeneratorOptions>,
): string {
  const result = generateProjectDDL(project, { ...defaultOpts, ...opts })
  return result.files[0].content
}

// ─── expressionToSql ────────────────────────────────────────
describe('expressionToSql', () => {
  it('doc.warehouse → d.warehouse', () => {
    expect(expressionToSql('doc.warehouse', 'd', 'ts', 'GoodsReceipt', '')).toBe(
      'd.warehouse',
    )
  })

  it('row.quantity → ts.quantity', () => {
    expect(expressionToSql('row.quantity', 'd', 'ts', 'GoodsReceipt', '')).toBe(
      'ts.quantity',
    )
  })

  it('row.quantity * row.price → ts.quantity * ts.price', () => {
    expect(
      expressionToSql('row.quantity * row.price', 'd', 'ts', 'GoodsReceipt', ''),
    ).toBe('ts.quantity * ts.price')
  })

  it('sum(items.amount) → subquery', () => {
    const result = expressionToSql('sum(items.amount)', 'd', 'ts', 'GoodsReceipt', '')
    expect(result).toContain('SELECT COALESCE(SUM(amount), 0)')
    expect(result).toContain('goods_receipt_items')
    expect(result).toContain('parent_id = d.id')
  })

  it('count(items) → subquery', () => {
    const result = expressionToSql('count(items)', 'd', 'ts', 'GoodsReceipt', '')
    expect(result).toContain('SELECT COUNT(*)')
    expect(result).toContain('goods_receipt_items')
    expect(result).toContain('parent_id = d.id')
  })

  it('literal:true → escaped string', () => {
    expect(expressionToSql('literal:true', 'd', 'ts', 'X', '')).toBe("'true'")
  })

  it('literal:42 → number', () => {
    expect(expressionToSql('literal:42', 'd', 'ts', 'X', '')).toBe('42')
  })

  it('now() → NOW()', () => {
    expect(expressionToSql('now()', 'd', 'ts', 'X', '')).toBe('NOW()')
  })

  it('doc.operationType → d.operation_type', () => {
    expect(expressionToSql('doc.operationType', 'd', 'ts', 'X', '')).toBe(
      'd.operation_type',
    )
  })
})

// ─── GoodsReceipt → InventoryBalance (tabularSection source) ─
describe('posting: tabularSection source', () => {
  const project: ProjectModel = emptyProject({
    documents: [
      {
        kind: 'Document',
        name: 'GoodsReceipt',
        numberLength: 11,
        numberType: 'String',
        autonumber: true,
        numberPeriodicity: 'Year',
        posting: {
          movements: [
            {
              register: { kind: 'AccumulationRegister', name: 'InventoryBalance' },
              movementType: 'Receipt',
              source: 'tabularSection:items',
              mappings: {
                dimensions: {
                  warehouse: 'doc.warehouse',
                  product: 'row.product',
                },
                resources: { quantity: 'row.quantity' },
                attributes: {},
              },
            },
          ],
          validations: [
            {
              type: 'NonNegativeBalance',
              register: { kind: 'AccumulationRegister', name: 'InventoryBalance' },
              dimensions: ['warehouse', 'product'],
              resource: 'quantity',
              message: { uk: 'Від\'ємний залишок', en: 'Negative balance' },
              applyTo: 'Expense',
            },
          ],
        },
        registerMovements: [],
        attributes: [attr('warehouse', 'String')],
        tabularSections: [
          {
            name: 'items',
            standardAttributeOverrides: {},
            attributes: [
              attr('product', 'String'),
              attr('quantity', 'Numeric'),
              attr('price', 'Numeric'),
            ],
          },
        ],
        standardAttributeOverrides: {},
      },
    ],
    accumulationRegisters: [
      {
        kind: 'AccumulationRegister',
        name: 'InventoryBalance',
        registerType: 'Balance',
        recorderTypes: [{ kind: 'Document', name: 'GoodsReceipt' }],
        dimensions: [
          attr('warehouse', 'String'),
          attr('product', 'String'),
        ],
        resources: [attr('quantity', 'Numeric')],
        attributes: [],
        standardAttributeOverrides: {},
      },
    ],
  })

  it('generates post function with INSERT...SELECT', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('CREATE OR REPLACE FUNCTION post_goods_receipt')
    expect(sql).toContain('INSERT INTO inventory_balance')
    expect(sql).toContain('SELECT')
    expect(sql).toContain('goods_receipt_items ts')
    expect(sql).toContain('ts.product')
    expect(sql).toContain('d.warehouse')
  })

  it('validation uses FOR loop with v_rec over DISTINCT dimensions', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('FOR v_rec IN')
    expect(sql).toContain('SELECT DISTINCT warehouse, product')
    expect(sql).toContain('WHERE recorder_id = p_doc_id')
    expect(sql).toContain('v_rec.warehouse')
    expect(sql).toContain('v_rec.product')
    expect(sql).not.toContain('d.product')
  })

  it('declares v_rec RECORD when validations exist', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('v_rec RECORD')
  })

  it('generates check function with correct dimension types', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('p_warehouse varchar(255)')
    expect(sql).toContain('p_product varchar(255)')
  })

  it('generates unpost function', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('CREATE OR REPLACE FUNCTION unpost_goods_receipt')
    expect(sql).toContain('DELETE FROM inventory_balance WHERE recorder_id')
  })

  it('generates check function for NonNegativeBalance', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('CREATE OR REPLACE FUNCTION check_inventory_balance_quantity')
  })

  it('includes custom hook extension point with schema-qualified lookup', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('goods_receipt_post_custom')
    expect(sql).toContain("n.nspname = 'public'")
    expect(sql).toContain('pg_namespace')
  })

  it('includes POSTING FUNCTIONS section header', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('POSTING FUNCTIONS')
  })
})

// ─── PaymentOrder → SettlementsBalance (document source) ────
describe('posting: document source', () => {
  const project: ProjectModel = emptyProject({
    documents: [
      {
        kind: 'Document',
        name: 'PaymentOrder',
        numberLength: 11,
        numberType: 'String',
        autonumber: true,
        numberPeriodicity: 'Year',
        posting: {
          movements: [
            {
              register: { kind: 'AccumulationRegister', name: 'SettlementsBalance' },
              movementType: 'Expense',
              source: 'document',
              mappings: {
                dimensions: { partner: 'doc.partner' },
                resources: { amount: 'doc.amount' },
                attributes: {},
              },
            },
          ],
          validations: [],
        },
        registerMovements: [],
        attributes: [
          attr('partner', 'String'),
          attr('amount', 'Numeric'),
        ],
        tabularSections: [],
        standardAttributeOverrides: {},
      },
    ],
    accumulationRegisters: [
      {
        kind: 'AccumulationRegister',
        name: 'SettlementsBalance',
        registerType: 'Balance',
        recorderTypes: [{ kind: 'Document', name: 'PaymentOrder' }],
        dimensions: [attr('partner', 'String')],
        resources: [attr('amount', 'Numeric')],
        attributes: [],
        standardAttributeOverrides: {},
      },
    ],
  })

  it('generates post function with VALUES', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('CREATE OR REPLACE FUNCTION post_payment_order')
    expect(sql).toContain('INSERT INTO settlements_balance')
    expect(sql).toContain('VALUES')
    expect(sql).toContain('d.partner')
    expect(sql).toContain('d.amount')
    expect(sql).toContain("'Expense'")
  })
})

// ─── Динамічний movementType ────────────────────────────────
describe('posting: dynamic movementType', () => {
  const project: ProjectModel = emptyProject({
    documents: [
      {
        kind: 'Document',
        name: 'Transfer',
        numberLength: 11,
        numberType: 'String',
        autonumber: true,
        numberPeriodicity: 'Year',
        posting: {
          movements: [
            {
              register: { kind: 'AccumulationRegister', name: 'Stock' },
              movementType: 'doc.operationType',
              source: 'document',
              mappings: {
                dimensions: { warehouse: 'doc.warehouse' },
                resources: { quantity: 'doc.quantity' },
                attributes: {},
              },
            },
          ],
          validations: [],
        },
        registerMovements: [],
        attributes: [
          attr('operation_type', 'String'),
          attr('warehouse', 'String'),
          attr('quantity', 'Numeric'),
        ],
        tabularSections: [],
        standardAttributeOverrides: {},
      },
    ],
    accumulationRegisters: [
      {
        kind: 'AccumulationRegister',
        name: 'Stock',
        registerType: 'Balance',
        recorderTypes: [{ kind: 'Document', name: 'Transfer' }],
        dimensions: [attr('warehouse', 'String')],
        resources: [attr('quantity', 'Numeric')],
        attributes: [],
        standardAttributeOverrides: {},
      },
    ],
  })

  it('uses expressionToSql for dynamic movementType', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('d.operation_type')
  })
})

// ─── Арифметика: row.quantity * row.price ───────────────────
describe('posting: arithmetic in mappings', () => {
  const project: ProjectModel = emptyProject({
    documents: [
      {
        kind: 'Document',
        name: 'Sale',
        numberLength: 11,
        numberType: 'String',
        autonumber: true,
        numberPeriodicity: 'Year',
        posting: {
          movements: [
            {
              register: { kind: 'AccumulationRegister', name: 'Revenue' },
              movementType: 'Receipt',
              source: 'tabularSection:lines',
              mappings: {
                dimensions: {},
                resources: { total: 'row.quantity * row.price' },
                attributes: {},
              },
            },
          ],
          validations: [],
        },
        registerMovements: [],
        attributes: [],
        tabularSections: [
          {
            name: 'lines',
            standardAttributeOverrides: {},
            attributes: [
              attr('quantity', 'Numeric'),
              attr('price', 'Numeric'),
            ],
          },
        ],
        standardAttributeOverrides: {},
      },
    ],
    accumulationRegisters: [
      {
        kind: 'AccumulationRegister',
        name: 'Revenue',
        registerType: 'Turnover',
        recorderTypes: [{ kind: 'Document', name: 'Sale' }],
        dimensions: [],
        resources: [attr('total', 'Numeric')],
        attributes: [],
        standardAttributeOverrides: {},
      },
    ],
  })

  it('generates ts.quantity * ts.price in SQL', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('ts.quantity * ts.price')
  })
})

// ─── Document без posting → без posting functions ───────────
describe('posting: document without posting', () => {
  const project: ProjectModel = emptyProject({
    documents: [
      {
        kind: 'Document',
        name: 'SimpleDoc',
        numberLength: 11,
        numberType: 'String',
        autonumber: true,
        numberPeriodicity: 'Year',
        registerMovements: [],
        attributes: [],
        tabularSections: [],
        standardAttributeOverrides: {},
      },
    ],
  })

  it('does not generate posting functions when posting is absent', () => {
    const sql = generateSQL(project)
    expect(sql).not.toContain('post_simple_doc')
    expect(sql).not.toContain('POSTING FUNCTIONS')
  })
})

// ─── expressionToSql: schema qualification ──────────────────
describe('expressionToSql: schema qualification', () => {
  it('sum() з custom schema → schema-qualified subquery', () => {
    const result = expressionToSql(
      'sum(items.amount)', 'd', 'ts', 'GoodsReceipt', '', 'erp',
    )
    expect(result).toContain('erp.goods_receipt_items')
  })

  it('count() з custom schema → schema-qualified subquery', () => {
    const result = expressionToSql(
      'count(items)', 'd', 'ts', 'GoodsReceipt', '', 'erp',
    )
    expect(result).toContain('erp.goods_receipt_items')
  })
})

// ─── Condition translation ──────────────────────────────────
describe('posting: condition translation', () => {
  const project: ProjectModel = emptyProject({
    documents: [
      {
        kind: 'Document',
        name: 'GoodsReceipt',
        numberLength: 11,
        numberType: 'String',
        autonumber: true,
        numberPeriodicity: 'Year',
        posting: {
          movements: [
            {
              register: { kind: 'AccumulationRegister', name: 'InventoryBalance' },
              movementType: 'Receipt',
              source: 'tabularSection:items',
              condition: 'row.quantity > 0',
              mappings: {
                dimensions: {
                  warehouse: 'doc.warehouse',
                  product: 'row.product',
                },
                resources: { quantity: 'row.quantity' },
                attributes: {},
              },
            },
          ],
          validations: [],
        },
        registerMovements: [],
        attributes: [attr('warehouse', 'String')],
        tabularSections: [
          {
            name: 'items',
            standardAttributeOverrides: {},
            attributes: [
              attr('product', 'String'),
              attr('quantity', 'Numeric'),
            ],
          },
        ],
        standardAttributeOverrides: {},
      },
    ],
    accumulationRegisters: [
      {
        kind: 'AccumulationRegister',
        name: 'InventoryBalance',
        registerType: 'Balance',
        recorderTypes: [{ kind: 'Document', name: 'GoodsReceipt' }],
        dimensions: [
          attr('warehouse', 'String'),
          attr('product', 'String'),
        ],
        resources: [attr('quantity', 'Numeric')],
        attributes: [],
        standardAttributeOverrides: {},
      },
    ],
  })

  it('translates tabularSection condition row.* → ts.*', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('ts.quantity > 0')
    expect(sql).not.toContain('row.quantity > 0')
  })
})

// ─── Condition з document source → IF обгортка ──────────────
describe('posting: condition with document source', () => {
  const project: ProjectModel = emptyProject({
    documents: [
      {
        kind: 'Document',
        name: 'PaymentOrder',
        numberLength: 11,
        numberType: 'String',
        autonumber: true,
        numberPeriodicity: 'Year',
        posting: {
          movements: [
            {
              register: { kind: 'AccumulationRegister', name: 'SettlementsBalance' },
              movementType: 'Expense',
              source: 'document',
              condition: 'doc.isActive',
              mappings: {
                dimensions: { partner: 'doc.partner' },
                resources: { amount: 'doc.amount' },
                attributes: {},
              },
            },
          ],
          validations: [],
        },
        registerMovements: [],
        attributes: [
          attr('partner', 'String'),
          attr('amount', 'Numeric'),
          attr('isActive', 'Boolean'),
        ],
        tabularSections: [],
        standardAttributeOverrides: {},
      },
    ],
    accumulationRegisters: [
      {
        kind: 'AccumulationRegister',
        name: 'SettlementsBalance',
        registerType: 'Balance',
        recorderTypes: [{ kind: 'Document', name: 'PaymentOrder' }],
        dimensions: [attr('partner', 'String')],
        resources: [attr('amount', 'Numeric')],
        attributes: [],
        standardAttributeOverrides: {},
      },
    ],
  })

  it('wraps document source INSERT in IF when condition exists', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('IF (d.is_active) THEN')
    expect(sql).toContain('END IF;')
  })
})

// ─── Custom hook з non-public schema ────────────────────────
describe('posting: custom hook schema qualification', () => {
  const project: ProjectModel = emptyProject({
    project: baseProject({
      database: {
        target: 'postgresql',
        schema: 'erp',
      },
    }),
    documents: [
      {
        kind: 'Document',
        name: 'Invoice',
        numberLength: 11,
        numberType: 'String',
        autonumber: true,
        numberPeriodicity: 'Year',
        posting: {
          movements: [
            {
              register: { kind: 'AccumulationRegister', name: 'Sales' },
              movementType: 'Receipt',
              source: 'document',
              mappings: {
                dimensions: { client: 'doc.client' },
                resources: { amount: 'doc.amount' },
                attributes: {},
              },
            },
          ],
          validations: [],
        },
        registerMovements: [],
        attributes: [
          attr('client', 'String'),
          attr('amount', 'Numeric'),
        ],
        tabularSections: [],
        standardAttributeOverrides: {},
      },
    ],
    accumulationRegisters: [
      {
        kind: 'AccumulationRegister',
        name: 'Sales',
        registerType: 'Turnover',
        recorderTypes: [{ kind: 'Document', name: 'Invoice' }],
        dimensions: [attr('client', 'String')],
        resources: [attr('amount', 'Numeric')],
        attributes: [],
        standardAttributeOverrides: {},
      },
    ],
  })

  it('uses pg_namespace join with schema name for custom hook lookup', () => {
    const sql = generateSQL(project, { schema: 'erp' })
    expect(sql).toContain("n.nspname = 'erp'")
    expect(sql).toContain('pg_namespace')
  })

  it('uses schema-qualified EXECUTE for custom hook', () => {
    const sql = generateSQL(project, { schema: 'erp' })
    expect(sql).toContain("SELECT erp.%I($1)")
  })
})

// ─── InformationRegister movement ───────────────────────────
describe('posting: InformationRegister movement', () => {
  const project: ProjectModel = emptyProject({
    documents: [
      {
        kind: 'Document',
        name: 'PriceChange',
        numberLength: 11,
        numberType: 'String',
        autonumber: true,
        numberPeriodicity: 'Year',
        posting: {
          movements: [
            {
              register: { kind: 'InformationRegister', name: 'ProductPrices' },
              movementType: 'Receipt',
              source: 'tabularSection:prices',
              mappings: {
                dimensions: { product: 'row.product' },
                resources: { price: 'row.price' },
                attributes: {},
              },
            },
          ],
          validations: [],
        },
        registerMovements: [],
        attributes: [],
        tabularSections: [
          {
            name: 'prices',
            standardAttributeOverrides: {},
            attributes: [
              attr('product', 'String'),
              attr('price', 'Numeric'),
            ],
          },
        ],
        standardAttributeOverrides: {},
      },
    ],
    informationRegisters: [
      {
        kind: 'InformationRegister',
        name: 'ProductPrices',
        periodicity: 'Day',
        writeMode: 'RecorderSubordinate',
        recorderTypes: [{ kind: 'Document', name: 'PriceChange' }],
        dimensions: [attr('product', 'String')],
        resources: [attr('price', 'Numeric')],
        attributes: [],
        standardAttributeOverrides: {},
      },
    ],
  })

  it('generates post function for InformationRegister movement', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('CREATE OR REPLACE FUNCTION post_price_change')
    expect(sql).toContain('INSERT INTO product_prices')
    expect(sql).toContain('price_change_prices ts')
  })

  it('generates unpost function for InformationRegister movement', () => {
    const sql = generateSQL(project)
    expect(sql).toContain('DELETE FROM product_prices WHERE recorder_id')
  })
})
