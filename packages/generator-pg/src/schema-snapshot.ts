import type {
  ProjectModel,
  Attribute,
  StandardAttribute,
  TabularSection,
} from '@simetra/core'
import {
  getStandardAttributes,
  getTabularSectionStandardAttributes,
} from '@simetra/core'
import type { GeneratorOptions } from '@simetra/generator-api'
import {
  tableName,
  tabularTableName,
  qualifiedName,
  escapeLiteral,
} from './naming'
import {
  mapFieldType,
  standardAttrToColumn,
  attributeToColumn,
} from './type-mapping'
import { resolveColumnName, resolveStdColumnName } from './column-naming'

// ─── Типи снапшоту ──────────────────────────────────────────

export interface SnapshotColumn {
  sqlType: string
  notNull: boolean
  unique: boolean
  primaryKey: boolean
  defaultExpr?: string
  references?: string
  check?: string
}

export interface SnapshotTable {
  columns: Record<string, SnapshotColumn>
}

export interface SnapshotEnum {
  strategy: 'pgEnum' | 'lookupTable'
  values: string[]
}

export interface SnapshotIndex {
  table: string
  columns: string[]
  unique: boolean
}

export interface SchemaSnapshot {
  version: 1
  generatedAt: string
  generatorVersion: string
  options: {
    schema: string
    enumStrategy: 'pgEnum' | 'lookupTable'
    constantsStrategy: 'singleTable' | 'separateTables'
    tablePrefix: string
  }
  enums: Record<string, SnapshotEnum>
  tables: Record<string, SnapshotTable>
  indexes: Record<string, SnapshotIndex>
}

// ─── Допоміжні lookup-и ─────────────────────────────────────

function buildRefTableLookup(
  project: ProjectModel,
  prefix: string,
  schema: string,
  enumStrategy: 'pgEnum' | 'lookupTable',
): Map<string, string> {
  const map = new Map<string, string>()
  for (const c of project.catalogs) {
    map.set(`Catalog.${c.name}`, qualifiedName(schema, tableName(prefix, c.name)))
  }
  for (const d of project.documents) {
    map.set(`Document.${d.name}`, qualifiedName(schema, tableName(prefix, d.name)))
  }
  for (const e of project.enumerations) {
    if (enumStrategy === 'lookupTable') {
      map.set(
        `Enumeration.${e.name}`,
        qualifiedName(schema, tableName(prefix, e.name)),
      )
    }
  }
  for (const r of project.informationRegisters) {
    map.set(
      `InformationRegister.${r.name}`,
      qualifiedName(schema, tableName(prefix, r.name)),
    )
  }
  for (const r of project.accumulationRegisters) {
    map.set(
      `AccumulationRegister.${r.name}`,
      qualifiedName(schema, tableName(prefix, r.name)),
    )
  }
  for (const t of project.customTables) {
    map.set(
      `CustomTable.${t.name}`,
      qualifiedName(schema, tableName(prefix, t.name)),
    )
  }
  return map
}

function buildEnumTypeLookup(
  project: ProjectModel,
  prefix: string,
  schema: string,
  enumStrategy: 'pgEnum' | 'lookupTable',
): Map<string, string> {
  if (enumStrategy !== 'pgEnum') return new Map()
  const map = new Map<string, string>()
  for (const e of project.enumerations) {
    map.set(
      `Enumeration.${e.name}`,
      qualifiedName(schema, tableName(prefix, e.name)),
    )
  }
  return map
}

// ─── Парсинг constraints із ColumnDef ────────────────────────

// Розбирає масив constraints на структуровані поля SnapshotColumn
function parseConstraints(
  sqlType: string,
  constraints: string[],
): SnapshotColumn {
  const col: SnapshotColumn = {
    sqlType,
    notNull: false,
    unique: false,
    primaryKey: false,
  }
  const otherChecks: string[] = []

  for (const c of constraints) {
    const trimmed = c.trim()
    if (trimmed === 'NOT NULL') {
      col.notNull = true
    } else if (trimmed === 'UNIQUE') {
      col.unique = true
    } else if (trimmed === 'PRIMARY KEY') {
      col.primaryKey = true
    } else if (trimmed.startsWith('DEFAULT ')) {
      col.defaultExpr = trimmed.slice(8)
    } else if (trimmed.startsWith('REFERENCES ')) {
      col.references = trimmed.slice(11)
    } else if (trimmed.startsWith('CHECK ')) {
      otherChecks.push(trimmed)
    } else {
      otherChecks.push(trimmed)
    }
  }

  if (otherChecks.length > 0) {
    col.check = otherChecks.join(', ')
  }
  return col
}

// ─── Збір колонок ────────────────────────────────────────────

function collectStandardColumns(
  attrs: StandardAttribute[],
  resolve: (ref: { kind: string; name: string }) => string,
  overrides?: Record<string, { type?: string; length?: number }>,
  resolveEnumType?: (ref: { kind: string; name: string }) => string | undefined,
): Record<string, SnapshotColumn> {
  const result: Record<string, SnapshotColumn> = {}

  for (const attr of attrs) {
    // Поліморфні посилання → дві колонки
    if (attr.type === 'Ref' && attr.allowedTypes?.length) {
      const typeValues = attr.allowedTypes
        .map((t) => `'${escapeLiteral(`${t.kind}.${t.name}`)}'`)
        .join(', ')
      result[`${attr.name}_type`] = {
        sqlType: 'varchar(100)',
        notNull: false,
        unique: false,
        primaryKey: false,
        check: `CHECK (${attr.name}_type IN (${typeValues}))`,
      }
      result[`${attr.name}_id`] = {
        sqlType: 'uuid',
        notNull: false,
        unique: false,
        primaryKey: false,
      }
      continue
    }

    const override = overrides?.[attr.name]
    const effective = override ? { ...attr, ...override } : attr
    const col = standardAttrToColumn(effective, resolve, resolveEnumType)
    result[attr.name] = parseConstraints(col.sqlType, col.constraints)
  }

  return result
}

function collectAttributeColumns(
  attrs: Attribute[],
  resolve: (ref: { kind: string; name: string }) => string,
  resolveEnumType?: (ref: { kind: string; name: string }) => string | undefined,
): Record<string, SnapshotColumn> {
  const result: Record<string, SnapshotColumn> = {}

  for (const attr of attrs) {
    // Поліморфний Ref → _type + _id
    if (attr.type === 'Ref' && attr.allowedTypes?.length) {
      const typeValues = attr.allowedTypes
        .map((t) => `'${escapeLiteral(`${t.kind}.${t.name}`)}'`)
        .join(', ')
      const notNull = attr.required ?? false
      result[`${attr.name}_type`] = {
        sqlType: 'varchar(100)',
        notNull,
        unique: false,
        primaryKey: false,
        check: `CHECK (${attr.name}_type IN (${typeValues}))`,
      }
      result[`${attr.name}_id`] = {
        sqlType: 'uuid',
        notNull,
        unique: false,
        primaryKey: false,
      }
      continue
    }

    const col = attributeToColumn(attr, resolve, resolveEnumType)

    // Single Ref → _id суфікс (крім enum refs)
    let colName = attr.name
    if (attr.type === 'Ref' && attr.ref) {
      const isEnumRef = resolveEnumType?.(attr.ref) != null
      if (!isEnumRef) {
        colName = `${attr.name}_id`
      }
    }

    result[colName] = parseConstraints(col.sqlType, col.constraints)
  }

  return result
}

// ─── Збір індексів ───────────────────────────────────────────

function collectTableIndexes(
  objectName: string,
  prefix: string,
  schema: string,
  standardAttrs: StandardAttribute[],
  customAttrs: Attribute[],
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
  tabularSections?: TabularSection[],
): Record<string, SnapshotIndex> {
  const tbl = tableName(prefix, objectName)
  const qName = qualifiedName(schema, tbl)
  const result: Record<string, SnapshotIndex> = {}
  const pkColumns = new Set(['id'])

  for (const attr of standardAttrs) {
    if (!attr.indexed) continue
    const cols = resolveStdColumnName(attr)
    for (const col of cols) {
      if (pkColumns.has(col)) continue
      const idxName = `idx_${tbl}_${col}`
      result[idxName] = { table: qName, columns: [col], unique: false }
    }
  }

  for (const attr of customAttrs) {
    if (attr.indexed && !attr.unique) {
      const cols = resolveColumnName(attr, resolveEnumType)
      for (const col of cols) {
        const idxName = `idx_${tbl}_${col}`
        result[idxName] = { table: qName, columns: [col], unique: false }
      }
      continue
    }
    if (attr.type === 'Ref' && attr.ref) {
      const isEnumRef = resolveEnumType(attr.ref) != null
      if (!isEnumRef) {
        const col = `${attr.name}_id`
        const idxName = `idx_${tbl}_${col}`
        result[idxName] = { table: qName, columns: [col], unique: false }
      }
    }
    if (attr.type === 'Ref' && attr.allowedTypes?.length) {
      const col = `${attr.name}_id`
      const idxName = `idx_${tbl}_${col}`
      result[idxName] = { table: qName, columns: [col], unique: false }
    }
  }

  if (tabularSections) {
    for (const ts of tabularSections) {
      const tsTbl = tabularTableName(prefix, objectName, ts.name)
      const tsQName = qualifiedName(schema, tsTbl)

      const parentIdx = `idx_${tsTbl}_parent_id`
      result[parentIdx] = {
        table: tsQName,
        columns: ['parent_id'],
        unique: false,
      }

      for (const attr of ts.attributes) {
        if (attr.indexed && !attr.unique) {
          const cols = resolveColumnName(attr, resolveEnumType)
          for (const col of cols) {
            const idxName = `idx_${tsTbl}_${col}`
            result[idxName] = {
              table: tsQName,
              columns: [col],
              unique: false,
            }
          }
          continue
        }
        if (attr.type === 'Ref' && attr.ref) {
          const isEnumRef = resolveEnumType(attr.ref) != null
          if (!isEnumRef) {
            const col = `${attr.name}_id`
            const idxName = `idx_${tsTbl}_${col}`
            result[idxName] = {
              table: tsQName,
              columns: [col],
              unique: false,
            }
          }
        }
        if (attr.type === 'Ref' && attr.allowedTypes?.length) {
          const col = `${attr.name}_id`
          const idxName = `idx_${tsTbl}_${col}`
          result[idxName] = {
            table: tsQName,
            columns: [col],
            unique: false,
          }
        }
      }
    }
  }

  return result
}

function collectRegisterSnapshotIndexes(
  objectName: string,
  prefix: string,
  schema: string,
  standardAttrs: StandardAttribute[],
  dimensions: Attribute[],
  resources: Attribute[],
  attributes: Attribute[],
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
): Record<string, SnapshotIndex> {
  const tbl = tableName(prefix, objectName)
  const qName = qualifiedName(schema, tbl)
  const result: Record<string, SnapshotIndex> = {}

  for (const attr of standardAttrs) {
    if (!attr.indexed) continue
    const cols = resolveStdColumnName(attr)
    for (const col of cols) {
      const idxName = `idx_${tbl}_${col}`
      result[idxName] = { table: qName, columns: [col], unique: false }
    }
  }

  const allAttrs = [...dimensions, ...resources, ...attributes]
  for (const attr of allAttrs) {
    if (attr.indexed && !attr.unique) {
      const cols = resolveColumnName(attr, resolveEnumType)
      for (const col of cols) {
        const idxName = `idx_${tbl}_${col}`
        result[idxName] = { table: qName, columns: [col], unique: false }
      }
      continue
    }
    if (attr.type === 'Ref' && attr.ref) {
      const isEnumRef = resolveEnumType(attr.ref) != null
      if (!isEnumRef) {
        const col = `${attr.name}_id`
        const idxName = `idx_${tbl}_${col}`
        result[idxName] = { table: qName, columns: [col], unique: false }
      }
    }
    if (attr.type === 'Ref' && attr.allowedTypes?.length) {
      const col = `${attr.name}_id`
      const idxName = `idx_${tbl}_${col}`
      result[idxName] = { table: qName, columns: [col], unique: false }
    }
  }

  return result
}

// ─── Побудова снапшоту ───────────────────────────────────────

export function buildSnapshot(
  project: ProjectModel,
  options: Required<GeneratorOptions>,
): SchemaSnapshot {
  const prefix = project.project.generation?.tablePrefix ?? ''
  const schema = options.schema

  const refLookup = buildRefTableLookup(
    project, prefix, schema, options.enumStrategy,
  )
  const resolve = (ref: { kind: string; name: string }) => {
    const key = `${ref.kind}.${ref.name}`
    return refLookup.get(key) ?? `/* UNRESOLVED: ${key} */`
  }

  const enumTypeLookup = buildEnumTypeLookup(
    project, prefix, schema, options.enumStrategy,
  )
  const resolveEnumType = (
    ref: { kind: string; name: string },
  ): string | undefined => {
    if (ref.kind !== 'Enumeration') return undefined
    return enumTypeLookup.get(`${ref.kind}.${ref.name}`)
  }

  const tables: Record<string, SnapshotTable> = {}
  const enums: Record<string, SnapshotEnum> = {}
  const indexes: Record<string, SnapshotIndex> = {}

  // ── Enumerations ──────────────────────────────────────────
  for (const en of project.enumerations) {
    const qName = qualifiedName(schema, tableName(prefix, en.name))
    const values = en.values.map((v) => v.name)

    if (options.enumStrategy === 'pgEnum') {
      enums[qName] = { strategy: 'pgEnum', values }
    } else {
      enums[qName] = { strategy: 'lookupTable', values }
      tables[qName] = {
        columns: {
          id: {
            sqlType: 'serial',
            notNull: false,
            unique: false,
            primaryKey: true,
          },
          name: {
            sqlType: 'varchar(100)',
            notNull: true,
            unique: true,
            primaryKey: false,
          },
          display_name_uk: {
            sqlType: 'varchar(255)',
            notNull: false,
            unique: false,
            primaryKey: false,
          },
          display_name_en: {
            sqlType: 'varchar(255)',
            notNull: false,
            unique: false,
            primaryKey: false,
          },
          sort_order: {
            sqlType: 'integer',
            notNull: false,
            unique: false,
            primaryKey: false,
          },
        },
      }
    }
  }

  // ── Catalogs ──────────────────────────────────────────────
  for (const cat of project.catalogs) {
    const tName = qualifiedName(schema, tableName(prefix, cat.name))
    const stdAttrs = getStandardAttributes('Catalog', {
      hierarchyType: cat.hierarchyType,
      owners: cat.owners,
    })

    const overrides: Record<string, { type?: string; length?: number }> = {}
    if (cat.codeType === 'Number') {
      overrides['code'] = { type: 'Integer' }
    } else {
      overrides['code'] = { type: 'String', length: cat.codeLength }
    }
    overrides['description'] = {
      type: 'String',
      length: cat.descriptionLength,
    }

    const columns: Record<string, SnapshotColumn> = {
      ...collectStandardColumns(
        stdAttrs, resolve, overrides, resolveEnumType,
      ),
      ...collectAttributeColumns(
        cat.attributes, resolve, resolveEnumType,
      ),
    }

    // parent_id — self-referencing FK
    if (cat.hierarchyType !== 'None' && columns['parent_id']) {
      columns['parent_id'] = {
        sqlType: 'uuid',
        notNull: false,
        unique: false,
        primaryKey: false,
        references: `${tName}(id)`,
      }
    }

    tables[tName] = { columns }

    // Табличні частини
    for (const ts of cat.tabularSections) {
      buildTabularSnapshot(
        ts, prefix, cat.name, tName, schema,
        resolve, resolveEnumType, tables,
      )
    }

    Object.assign(indexes, collectTableIndexes(
      cat.name, prefix, schema, stdAttrs,
      cat.attributes, resolveEnumType, cat.tabularSections,
    ))
  }

  // ── Documents ─────────────────────────────────────────────
  for (const doc of project.documents) {
    const tName = qualifiedName(schema, tableName(prefix, doc.name))
    const stdAttrs = getStandardAttributes('Document')

    const overrides: Record<string, { type?: string; length?: number }> = {}
    if (doc.numberType === 'Number') {
      overrides['number'] = { type: 'Integer' }
    } else {
      overrides['number'] = { type: 'String', length: doc.numberLength }
    }

    const columns: Record<string, SnapshotColumn> = {
      ...collectStandardColumns(
        stdAttrs, resolve, overrides, resolveEnumType,
      ),
      ...collectAttributeColumns(
        doc.attributes, resolve, resolveEnumType,
      ),
    }

    tables[tName] = { columns }

    for (const ts of doc.tabularSections) {
      buildTabularSnapshot(
        ts, prefix, doc.name, tName, schema,
        resolve, resolveEnumType, tables,
      )
    }

    Object.assign(indexes, collectTableIndexes(
      doc.name, prefix, schema, stdAttrs,
      doc.attributes, resolveEnumType, doc.tabularSections,
    ))
  }

  // ── InformationRegisters ──────────────────────────────────
  for (const reg of project.informationRegisters) {
    const tName = qualifiedName(schema, tableName(prefix, reg.name))
    const stdAttrs = getStandardAttributes('InformationRegister', {
      periodicity: reg.periodicity,
      writeMode: reg.writeMode,
      recorderTypes: reg.recorderTypes,
    })

    const columns: Record<string, SnapshotColumn> = {
      ...collectStandardColumns(
        stdAttrs, resolve, undefined, resolveEnumType,
      ),
      ...collectAttributeColumns(
        reg.dimensions, resolve, resolveEnumType,
      ),
      ...collectAttributeColumns(
        reg.resources, resolve, resolveEnumType,
      ),
      ...collectAttributeColumns(
        reg.attributes, resolve, resolveEnumType,
      ),
    }

    tables[tName] = { columns }

    Object.assign(indexes, collectRegisterSnapshotIndexes(
      reg.name, prefix, schema, stdAttrs,
      reg.dimensions, reg.resources, reg.attributes,
      resolveEnumType,
    ))
  }

  // ── AccumulationRegisters ─────────────────────────────────
  for (const reg of project.accumulationRegisters) {
    const tName = qualifiedName(schema, tableName(prefix, reg.name))
    const stdAttrs = getStandardAttributes('AccumulationRegister', {
      registerType: reg.registerType,
      recorderTypes: reg.recorderTypes,
    })

    const columns: Record<string, SnapshotColumn> = {
      ...collectStandardColumns(
        stdAttrs, resolve, undefined, resolveEnumType,
      ),
      ...collectAttributeColumns(
        reg.dimensions, resolve, resolveEnumType,
      ),
      ...collectAttributeColumns(
        reg.resources, resolve, resolveEnumType,
      ),
      ...collectAttributeColumns(
        reg.attributes, resolve, resolveEnumType,
      ),
    }

    tables[tName] = { columns }

    Object.assign(indexes, collectRegisterSnapshotIndexes(
      reg.name, prefix, schema, stdAttrs,
      reg.dimensions, reg.resources, reg.attributes,
      resolveEnumType,
    ))
  }

  // ── Constants ─────────────────────────────────────────────
  if (options.constantsStrategy === 'singleTable') {
    if (project.constants.length > 0) {
      const tName = qualifiedName(schema, `${prefix}constants`)
      tables[tName] = {
        columns: {
          key: {
            sqlType: 'varchar(100)',
            notNull: false,
            unique: false,
            primaryKey: true,
          },
          value_type: {
            sqlType: 'varchar(50)',
            notNull: true,
            unique: false,
            primaryKey: false,
          },
          value_text: {
            sqlType: 'text',
            notNull: false,
            unique: false,
            primaryKey: false,
          },
          value_numeric: {
            sqlType: 'numeric(15, 2)',
            notNull: false,
            unique: false,
            primaryKey: false,
          },
          value_boolean: {
            sqlType: 'boolean',
            notNull: false,
            unique: false,
            primaryKey: false,
          },
          value_date: {
            sqlType: 'date',
            notNull: false,
            unique: false,
            primaryKey: false,
          },
          value_datetime: {
            sqlType: 'timestamptz',
            notNull: false,
            unique: false,
            primaryKey: false,
          },
          value_uuid: {
            sqlType: 'uuid',
            notNull: false,
            unique: false,
            primaryKey: false,
          },
          value_binary: {
            sqlType: 'bytea',
            notNull: false,
            unique: false,
            primaryKey: false,
          },
        },
      }
    }
  } else {
    for (const c of project.constants) {
      const tName = qualifiedName(
        schema, tableName(prefix, c.name),
      )
      const sqlType = mapFieldType({ type: c.valueType })
      tables[tName] = {
        columns: {
          id: {
            sqlType: 'integer',
            notNull: false,
            unique: false,
            primaryKey: true,
            defaultExpr: '1',
            check: 'CHECK (id = 1)',
          },
          value: {
            sqlType,
            notNull: false,
            unique: false,
            primaryKey: false,
          },
        },
      }
    }
  }

  // ── CustomTables ──────────────────────────────────────────
  for (const ct of project.customTables) {
    const tName = qualifiedName(schema, tableName(prefix, ct.name))
    const stdAttrs = getStandardAttributes('CustomTable', {
      autoAddPrimaryKey: ct.autoAddPrimaryKey,
    })

    const columns: Record<string, SnapshotColumn> = {
      ...collectStandardColumns(
        stdAttrs, resolve, undefined, resolveEnumType,
      ),
      ...collectAttributeColumns(
        ct.attributes, resolve, resolveEnumType,
      ),
    }

    tables[tName] = { columns }

    Object.assign(indexes, collectTableIndexes(
      ct.name, prefix, schema, stdAttrs,
      ct.attributes, resolveEnumType,
    ))
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatorVersion: '0.0.1',
    options: {
      schema,
      enumStrategy: options.enumStrategy,
      constantsStrategy: options.constantsStrategy,
      tablePrefix: prefix,
    },
    enums,
    tables,
    indexes,
  }
}

// ─── Табличні частини ────────────────────────────────────────

function buildTabularSnapshot(
  ts: TabularSection,
  prefix: string,
  parentName: string,
  parentQualified: string,
  schema: string,
  resolve: (ref: { kind: string; name: string }) => string,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
  tables: Record<string, SnapshotTable>,
): void {
  const tName = qualifiedName(
    schema,
    tabularTableName(prefix, parentName, ts.name),
  )
  const stdAttrs = getTabularSectionStandardAttributes()

  const columns: Record<string, SnapshotColumn> = {
    ...collectStandardColumns(
      stdAttrs, resolve, undefined, resolveEnumType,
    ),
    parent_id: {
      sqlType: 'uuid',
      notNull: true,
      unique: false,
      primaryKey: false,
      references: `${parentQualified}(id)`,
    },
    ...collectAttributeColumns(
      ts.attributes, resolve, resolveEnumType,
    ),
  }

  tables[tName] = { columns }
}
