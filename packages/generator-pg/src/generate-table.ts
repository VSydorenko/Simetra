import type {
  ProjectModel,
  Catalog,
  Document,
  Enumeration,
  InformationRegister,
  AccumulationRegister,
  Constant,
  CustomTable,
  Attribute,
  TabularSection,
  StandardAttribute,
  MetadataKind,
} from "@simetra/core"
import {
  getStandardAttributes,
  getTabularSectionStandardAttributes,
} from "@simetra/core"
import type { GeneratorOptions, GeneratorOutput } from "@simetra/generator-api"
import {
  tableName,
  tabularTableName,
  qualifiedName,
  escapeLiteral,
} from "./naming"
import {
  mapFieldType,
  standardAttrToColumn,
  attributeToColumn,
} from "./type-mapping"
import { generatePostingFunctions } from "./generate-posting"
import { resolveColumnName, resolveStdColumnName } from "./column-naming"

// ─── FK Collector ───────────────────────────────────────────

export interface ForeignKeyDef {
  sourceTable: string
  column: string
  targetTable: string
  onDelete?: string
}

// PostgreSQL NAMEDATALEN-1 limit
const PG_IDENTIFIER_LIMIT = 63

// Побудувати lookup: MetadataRef → qualified table name
function buildRefTableLookup(
  project: ProjectModel,
  opts: Required<GeneratorOptions>
): Map<string, string> {
  const prefix = project.project.generation?.tablePrefix ?? ""
  const schema = opts.schema
  const map = new Map<string, string>()

  for (const c of project.catalogs) {
    const key = `Catalog.${c.name}`
    map.set(key, qualifiedName(schema, tableName(prefix, "Catalog", c.name)))
  }
  for (const d of project.documents) {
    const key = `Document.${d.name}`
    map.set(key, qualifiedName(schema, tableName(prefix, "Document", d.name)))
  }
  for (const e of project.enumerations) {
    const key = `Enumeration.${e.name}`
    // Для pgEnum — немає таблиці, але для lookupTable — є
    if (opts.enumStrategy === "lookupTable") {
      map.set(key, qualifiedName(schema, tableName(prefix, "Enumeration", e.name)))
    }
  }
  for (const r of project.informationRegisters) {
    const key = `InformationRegister.${r.name}`
    map.set(key, qualifiedName(schema, tableName(prefix, "InformationRegister", r.name)))
  }
  for (const r of project.accumulationRegisters) {
    const key = `AccumulationRegister.${r.name}`
    map.set(key, qualifiedName(schema, tableName(prefix, "AccumulationRegister", r.name)))
  }
  for (const t of project.customTables) {
    const key = `CustomTable.${t.name}`
    map.set(key, qualifiedName(schema, tableName(prefix, "CustomTable", t.name)))
  }

  return map
}

function resolveRef(
  lookup: Map<string, string>,
  ref: { kind: string; name: string }
): string {
  const key = `${ref.kind}.${ref.name}`
  return lookup.get(key) ?? `/* UNRESOLVED: ${key} */`
}

// Побудувати lookup: Enumeration → qualified CREATE TYPE name (для pgEnum стратегії)
function buildEnumTypeLookup(
  project: ProjectModel,
  opts: Required<GeneratorOptions>
): Map<string, string> {
  if (opts.enumStrategy !== "pgEnum") return new Map()
  const prefix = project.project.generation?.tablePrefix ?? ""
  const schema = opts.schema
  const map = new Map<string, string>()
  for (const e of project.enumerations) {
    const key = `Enumeration.${e.name}`
    map.set(key, qualifiedName(schema, tableName(prefix, "Enumeration", e.name)))
  }
  return map
}

// Форматувати одну колонку як рядок SQL
function formatColumn(
  name: string,
  sqlType: string,
  constraints: string[]
): string {
  const parts = [name, sqlType, ...constraints]
  return `  ${parts.join(" ")}`
}

// Генерувати колонки для стандартних реквізитів
function emitStandardColumns(
  attrs: StandardAttribute[],
  resolve: (ref: { kind: string; name: string }) => string,
  overrides?: Record<string, { type?: string; length?: number }>,
  resolveEnumType?: (ref: { kind: string; name: string }) => string | undefined
): string[] {
  const lines: string[] = []
  for (const attr of attrs) {
    // Пропускаємо polymorphic refs — для них окремі колонки
    if (attr.type === "Ref" && attr.allowedTypes?.length) {
      lines.push(...emitPolymorphicColumns(attr.name, attr.allowedTypes))
      continue
    }

    // Можливі override типу (наприклад code → integer)
    const override = overrides?.[attr.name]
    const effective = override ? { ...attr, ...override } : attr
    const col = standardAttrToColumn(effective, resolve, resolveEnumType)
    lines.push(formatColumn(attr.name, col.sqlType, col.constraints))
  }
  return lines
}

// Генерувати колонки для кастомних реквізитів
function emitAttributeColumns(
  attrs: Attribute[],
  resolve: (ref: { kind: string; name: string }) => string,
  resolveEnumType?: (ref: { kind: string; name: string }) => string | undefined
): string[] {
  const lines: string[] = []
  for (const attr of attrs) {
    if (attr.type === "Ref" && attr.allowedTypes?.length) {
      lines.push(...emitPolymorphicColumns(attr.name, attr.allowedTypes, attr.required))
      continue
    }
    const col = attributeToColumn(attr, resolve, resolveEnumType)
    // Single Ref → додаємо _id суфікс (крім enum refs — вони зберігають значення)
    let colName = attr.name
    if (attr.type === "Ref" && attr.ref) {
      const isEnumRef = resolveEnumType?.(attr.ref) != null
      if (!isEnumRef) {
        colName = `${attr.name}_id`
      }
    }
    lines.push(formatColumn(colName, col.sqlType, col.constraints))
  }
  return lines
}

// Polymorphic ref: дві колонки + CHECK
function emitPolymorphicColumns(
  name: string,
  allowedTypes: { kind: string; name: string }[],
  required: boolean = false
): string[] {
  const typeValues = allowedTypes
    .map((t) => `'${escapeLiteral(`${t.kind}.${t.name}`)}'`)
    .join(", ")
  const notNull = required ? " NOT NULL" : ""
  return [
    `  ${name}_type varchar(100)${notNull}`,
    `  ${name}_id uuid${notNull}`,
    `  CHECK (${name}_type IN (${typeValues}))`,
  ]
}

// Обгортка CREATE TABLE
function createTable(
  qualName: string,
  columns: string[],
  comment?: string
): string {
  const header = comment ? `-- ${comment}\n` : ""
  return `${header}CREATE TABLE ${qualName} (\n` + columns.join(",\n") + "\n);"
}

// Зібрати FK defs для кастомних Ref атрибутів (non-enum, non-polymorphic single refs)
function collectAttributeFKs(
  attrs: Attribute[],
  sourceTable: string,
  resolve: (ref: { kind: string; name: string }) => string,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
  fkCollector: ForeignKeyDef[]
): void {
  for (const attr of attrs) {
    if (attr.type !== "Ref" || !attr.ref) continue
    // Пропускаємо polymorphic refs — Dynamic Link, без FK
    if (attr.allowedTypes?.length) continue
    // Пропускаємо pgEnum refs — це PostgreSQL TYPE, не таблиця
    const enumType = resolveEnumType(attr.ref)
    if (enumType) continue
    // Single ref → FK
    const targetTable = resolve(attr.ref)
    fkCollector.push({
      sourceTable,
      column: `${attr.name}_id`,
      targetTable,
    })
  }
}

// Зібрати FK defs для стандартних Ref атрибутів
function collectStandardAttrFKs(
  attrs: StandardAttribute[],
  sourceTable: string,
  resolve: (ref: { kind: string; name: string }) => string,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
  fkCollector: ForeignKeyDef[]
): void {
  for (const attr of attrs) {
    if (attr.type !== "Ref" || !attr.ref) continue
    // Пропускаємо polymorphic refs
    if (attr.allowedTypes?.length) continue
    // Пропускаємо pgEnum refs
    const enumType = resolveEnumType(attr.ref)
    if (enumType) continue
    // Стандартні реквізити вже мають canonical name (owner_id, recorder_id)
    fkCollector.push({
      sourceTable,
      column: attr.name,
      targetTable: resolve(attr.ref),
    })
  }
}

// Генерувати SQL для late-emitted FK constraints
function emitForeignKeys(
  fkCollector: ForeignKeyDef[],
  warnings: string[]
): string[] {
  if (fkCollector.length === 0) return []
  const statements: string[] = []
  for (const fk of fkCollector) {
    const constraintName = getForeignKeyConstraintName(fk)
    // Identifier length check
    checkIdentifierLength(constraintName, warnings)
    const onDelete = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ""
    statements.push(
      `ALTER TABLE ${fk.sourceTable}\n` +
        `  ADD CONSTRAINT ${constraintName}\n` +
        `  FOREIGN KEY (${fk.column}) REFERENCES ${fk.targetTable}(id)${onDelete};`
    )
  }
  return statements
}

function getForeignKeyConstraintName(fk: ForeignKeyDef): string {
  const sourceUnqualified = fk.sourceTable.includes(".")
    ? fk.sourceTable.split(".").pop()!
    : fk.sourceTable
  return `fk_${sourceUnqualified}_${fk.column}`
}

// Перевірити довжину ідентифікатора та додати warning
function checkIdentifierLength(identifier: string, warnings: string[]): void {
  if (identifier.length > PG_IDENTIFIER_LIMIT) {
    warnings.push(
      `Identifier "${identifier}" exceeds PostgreSQL limit of ${PG_IDENTIFIER_LIMIT} characters and will be silently truncated`
    )
  }
}

// ─── Catalog ────────────────────────────────────────────────
function generateCatalog(
  cat: Catalog,
  prefix: string,
  schema: string,
  resolve: (ref: { kind: string; name: string }) => string,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
  fkCollector: ForeignKeyDef[]
): string[] {
  const tbl = tableName(prefix, "Catalog", cat.name)
  const tName = qualifiedName(schema, tbl)
  const stdAttrs = getStandardAttributes("Catalog", {
    hierarchyType: cat.hierarchyType,
    owners: cat.owners,
  })

  // Override типу code якщо codeType === 'Number'
  const overrides: Record<string, { type?: string; length?: number }> = {}
  if (cat.codeType === "Number") {
    overrides["code"] = { type: "Integer" }
  } else {
    overrides["code"] = { type: "String", length: cat.codeLength }
  }
  overrides["description"] = {
    type: "String",
    length: cat.descriptionLength,
  }

  const columns = [
    ...emitStandardColumns(stdAttrs, resolve, overrides, resolveEnumType),
    ...emitAttributeColumns(cat.attributes, resolve, resolveEnumType),
  ]

  // parent_id — self-referencing FK (через collector)
  if (
    cat.hierarchyType !== "None" &&
    columns.some((c) => c.trimStart().startsWith("parent_id"))
  ) {
    // Прибираємо inline REFERENCES — тепер це просто uuid
    const idx = columns.findIndex((c) => c.trimStart().startsWith("parent_id"))
    columns[idx] = `  parent_id uuid`
    fkCollector.push({
      sourceTable: tName,
      column: "parent_id",
      targetTable: tName,
    })
  }

  // owner_id FK — single ref owners
  for (const stdAttr of stdAttrs) {
    if (stdAttr.name === "owner_id" && stdAttr.type === "Ref" && stdAttr.ref) {
      const targetTable = resolve(stdAttr.ref)
      fkCollector.push({
        sourceTable: tName,
        column: "owner_id",
        targetTable,
      })
    }
  }

  // FK для кастомних single-ref атрибутів (не enum, не polymorphic)
  collectAttributeFKs(cat.attributes, tName, resolve, resolveEnumType, fkCollector)

  // UNIQUE constraint для code якщо codeUnique
  if (cat.codeUnique) {
    columns.push(
      `  CONSTRAINT uq_${tbl}_code UNIQUE (code)`
    )
  }

  const statements: string[] = []
  const label = cat.displayName?.en ?? cat.name
  statements.push(createTable(tName, columns, `Catalog: ${label}`))

  // Табличні частини
  for (const ts of cat.tabularSections) {
    statements.push(
      generateTabularSection(
        ts,
        prefix,
        "Catalog",
        cat.name,
        tName,
        schema,
        resolve,
        resolveEnumType,
        fkCollector
      )
    )
  }

  return statements
}

// ─── Document ───────────────────────────────────────────────
function generateDocument(
  doc: Document,
  prefix: string,
  schema: string,
  resolve: (ref: { kind: string; name: string }) => string,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
  fkCollector: ForeignKeyDef[]
): string[] {
  const tbl = tableName(prefix, "Document", doc.name)
  const tName = qualifiedName(schema, tbl)
  const stdAttrs = getStandardAttributes("Document")

  const overrides: Record<string, { type?: string; length?: number }> = {}
  if (doc.numberType === "Number") {
    overrides["number"] = { type: "Integer" }
  } else {
    overrides["number"] = { type: "String", length: doc.numberLength }
  }

  const columns = [
    ...emitStandardColumns(stdAttrs, resolve, overrides, resolveEnumType),
    ...emitAttributeColumns(doc.attributes, resolve, resolveEnumType),
  ]

  // FK для кастомних атрибутів
  collectAttributeFKs(doc.attributes, tName, resolve, resolveEnumType, fkCollector)

  const statements: string[] = []
  const label = doc.displayName?.en ?? doc.name
  statements.push(createTable(tName, columns, `Document: ${label}`))

  for (const ts of doc.tabularSections) {
    statements.push(
      generateTabularSection(
        ts,
        prefix,
        "Document",
        doc.name,
        tName,
        schema,
        resolve,
        resolveEnumType,
        fkCollector
      )
    )
  }

  return statements
}

// ─── Enumeration ────────────────────────────────────────────
function generateEnumeration(
  en: Enumeration,
  prefix: string,
  schema: string,
  strategy: "pgEnum" | "lookupTable"
): string[] {
  const name = tableName(prefix, "Enumeration", en.name)
  const qName = qualifiedName(schema, name)
  const label = en.displayName?.en ?? en.name

  if (strategy === "pgEnum") {
    const values = en.values
      .map((v) => `  '${escapeLiteral(v.name)}'`)
      .join(",\n")
    return [
      `-- Enumeration: ${label}\n` +
        `CREATE TYPE ${qName} AS ENUM (\n${values}\n);`,
    ]
  }

  // lookupTable
  const columns = [
    "  id serial PRIMARY KEY",
    "  name varchar(100) NOT NULL UNIQUE",
    "  display_name_uk varchar(255)",
    "  display_name_en varchar(255)",
    "  sort_order integer",
  ]
  const statements: string[] = []
  statements.push(createTable(qName, columns, `Enumeration: ${label}`))

  // INSERT початкових значень
  if (en.values.length > 0) {
    const inserts = en.values
      .map((v, i) => {
        const uk = escapeLiteral(v.displayName?.uk ?? v.name)
        const enName = escapeLiteral(v.displayName?.en ?? v.name)
        return (
          `INSERT INTO ${qName} (name, display_name_uk,` +
          ` display_name_en, sort_order)` +
          ` VALUES ('${escapeLiteral(v.name)}', '${uk}', '${enName}', ${v.order ?? i});`
        )
      })
      .join("\n")
    statements.push(inserts)
  }

  return statements
}

// ─── InformationRegister ────────────────────────────────────
function generateInformationRegister(
  reg: InformationRegister,
  prefix: string,
  schema: string,
  resolve: (ref: { kind: string; name: string }) => string,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
  fkCollector: ForeignKeyDef[]
): string[] {
  const tbl = tableName(prefix, "InformationRegister", reg.name)
  const tName = qualifiedName(schema, tbl)
  const stdAttrs = getStandardAttributes("InformationRegister", {
    periodicity: reg.periodicity,
    writeMode: reg.writeMode,
    recorderTypes: reg.recorderTypes,
  })

  const columns = [
    ...emitStandardColumns(stdAttrs, resolve, undefined, resolveEnumType),
    ...emitAttributeColumns(reg.dimensions, resolve, resolveEnumType),
    ...emitAttributeColumns(reg.resources, resolve, resolveEnumType),
    ...emitAttributeColumns(reg.attributes, resolve, resolveEnumType),
  ]

  // Composite unique key: period (якщо є) + dimensions
  const uniqueCols: string[] = []
  if (reg.periodicity !== "NonPeriodic") {
    uniqueCols.push("period")
  }
  if (
    reg.writeMode === "RecorderSubordinate" &&
    stdAttrs.some((a) => a.name === "recorder_id")
  ) {
    // Для polymorphic recorder — використовуємо recorder_id_id
    const recorderAttr = stdAttrs.find((a) => a.name === "recorder_id")
    if (recorderAttr?.allowedTypes?.length) {
      uniqueCols.push("recorder_id_type", "recorder_id_id")
    } else {
      uniqueCols.push("recorder_id")
    }
    uniqueCols.push("line_number")
  }
  for (const d of reg.dimensions) {
    if (d.type === "Ref" && d.allowedTypes?.length) {
      uniqueCols.push(`${d.name}_type`, `${d.name}_id`)
    } else if (d.type === "Ref" && d.ref) {
      // Single Ref: ім'я колонки залежить від стратегії enum
      const isEnumRef = resolveEnumType(d.ref) != null
      uniqueCols.push(isEnumRef ? d.name : `${d.name}_id`)
    } else {
      uniqueCols.push(d.name)
    }
  }

  if (uniqueCols.length > 0) {
    columns.push(`  UNIQUE (${uniqueCols.join(", ")})`)
  }

  // FK для standard attrs (recorder_id single ref)
  collectStandardAttrFKs(stdAttrs, tName, resolve, resolveEnumType, fkCollector)
  // FK для dimensions/resources/attributes
  collectAttributeFKs(reg.dimensions, tName, resolve, resolveEnumType, fkCollector)
  collectAttributeFKs(reg.resources, tName, resolve, resolveEnumType, fkCollector)
  collectAttributeFKs(reg.attributes, tName, resolve, resolveEnumType, fkCollector)

  const label = reg.displayName?.en ?? reg.name
  return [createTable(tName, columns, `InformationRegister: ${label}`)]
}

// ─── AccumulationRegister ───────────────────────────────────
function generateAccumulationRegister(
  reg: AccumulationRegister,
  prefix: string,
  schema: string,
  resolve: (ref: { kind: string; name: string }) => string,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
  fkCollector: ForeignKeyDef[]
): string[] {
  const tbl = tableName(prefix, "AccumulationRegister", reg.name)
  const tName = qualifiedName(schema, tbl)
  const stdAttrs = getStandardAttributes("AccumulationRegister", {
    registerType: reg.registerType,
    recorderTypes: reg.recorderTypes,
  })

  const columns = [
    ...emitStandardColumns(stdAttrs, resolve, undefined, resolveEnumType),
    ...emitAttributeColumns(reg.dimensions, resolve, resolveEnumType),
    ...emitAttributeColumns(reg.resources, resolve, resolveEnumType),
    ...emitAttributeColumns(reg.attributes, resolve, resolveEnumType),
  ]

  // FK для standard attrs (recorder_id single ref)
  collectStandardAttrFKs(stdAttrs, tName, resolve, resolveEnumType, fkCollector)
  // FK для dimensions/resources/attributes
  collectAttributeFKs(reg.dimensions, tName, resolve, resolveEnumType, fkCollector)
  collectAttributeFKs(reg.resources, tName, resolve, resolveEnumType, fkCollector)
  collectAttributeFKs(reg.attributes, tName, resolve, resolveEnumType, fkCollector)

  const label = reg.displayName?.en ?? reg.name
  return [createTable(tName, columns, `AccumulationRegister: ${label}`)]
}

// ─── Constant ───────────────────────────────────────────────
function generateConstantsSingleTable(
  constants: Constant[],
  prefix: string,
  schema: string
): string[] {
  if (constants.length === 0) return []

  const tName = qualifiedName(schema, `${prefix}const_settings`)
  const columns = [
    "  key varchar(100) PRIMARY KEY",
    "  value_type varchar(50) NOT NULL",
    "  value_text text",
    "  value_numeric numeric(15, 2)",
    "  value_boolean boolean",
    "  value_date date",
    "  value_datetime timestamptz",
    "  value_uuid uuid",
    "  value_binary bytea",
  ]
  return [createTable(tName, columns, "Constants")]
}

function generateConstantsSeparateTables(
  constants: Constant[],
  prefix: string,
  schema: string
): string[] {
  const statements: string[] = []
  for (const c of constants) {
    const tName = qualifiedName(schema, tableName(prefix, "Constant", c.name))
    const sqlType = mapFieldType({ type: c.valueType })
    const columns = [
      "  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)",
      `  value ${sqlType}`,
    ]
    const label = c.displayName?.en ?? c.name
    statements.push(createTable(tName, columns, `Constant: ${label}`))
  }
  return statements
}

// ─── CustomTable ────────────────────────────────────────────
function generateCustomTable(
  ct: CustomTable,
  prefix: string,
  schema: string,
  resolve: (ref: { kind: string; name: string }) => string,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
  fkCollector: ForeignKeyDef[]
): string[] {
  const tbl = tableName(prefix, "CustomTable", ct.name)
  const tName = qualifiedName(schema, tbl)
  const stdAttrs = getStandardAttributes("CustomTable", {
    autoAddPrimaryKey: ct.autoAddPrimaryKey,
  })

  const columns = [
    ...emitStandardColumns(stdAttrs, resolve, undefined, resolveEnumType),
    ...emitAttributeColumns(ct.attributes, resolve, resolveEnumType),
  ]

  // FK для кастомних атрибутів
  collectAttributeFKs(ct.attributes, tName, resolve, resolveEnumType, fkCollector)

  const label = ct.displayName?.en ?? ct.name
  return [createTable(tName, columns, `CustomTable: ${label}`)]
}

// ─── Tabular Section ────────────────────────────────────────
function generateTabularSection(
  ts: TabularSection,
  prefix: string,
  kind: MetadataKind,
  parentName: string,
  parentQualified: string,
  schema: string,
  resolve: (ref: { kind: string; name: string }) => string,
  resolveEnumType?: (ref: { kind: string; name: string }) => string | undefined,
  fkCollector?: ForeignKeyDef[]
): string {
  const tbl = tabularTableName(prefix, kind, parentName, ts.name)
  const tName = qualifiedName(schema, tbl)
  const stdAttrs = getTabularSectionStandardAttributes()
  const columns = [
    ...emitStandardColumns(stdAttrs, resolve, undefined, resolveEnumType),
    `  parent_id uuid NOT NULL`,
    ...emitAttributeColumns(ts.attributes, resolve, resolveEnumType),
  ]

  // FK для parent_id → parent table (через collector)
  if (fkCollector) {
    fkCollector.push({
      sourceTable: tName,
      column: "parent_id",
      targetTable: parentQualified,
      onDelete: "CASCADE",
    })
    // FK для кастомних атрибутів ТЧ
    if (resolveEnumType) {
      collectAttributeFKs(ts.attributes, tName, resolve, resolveEnumType, fkCollector)
    }
  }
  return createTable(tName, columns, `Tabular: ${ts.name}`)
}

// ─── Indexes ────────────────────────────────────────────────

// Зібрати індекси для одного об'єкту метаданих
function collectIndexes(
  objectName: string,
  kind: MetadataKind,
  prefix: string,
  schema: string,
  standardAttrs: StandardAttribute[],
  customAttrs: Attribute[],
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
  tabularSections?: TabularSection[]
): string[] {
  const tbl = tableName(prefix, kind, objectName)
  const qName = qualifiedName(schema, tbl)
  const lines: string[] = []

  // PK (id) індексується автоматично через PRIMARY KEY — пропускаємо
  const pkColumns = new Set(["id"])

  // Індекси для стандартних реквізитів (FK та indexed)
  for (const attr of standardAttrs) {
    if (!attr.indexed) continue
    const cols = resolveStdColumnName(attr)
    for (const col of cols) {
      if (pkColumns.has(col)) continue
      lines.push(`CREATE INDEX idx_${tbl}_${col} ON ${qName} (${col});`)
    }
  }

  // Індекси для кастомних атрибутів
  for (const attr of customAttrs) {
    // Indexed custom attribute (пропускаємо якщо unique — UNIQUE вже створює індекс)
    if (attr.indexed && !attr.unique) {
      const cols = resolveColumnName(attr, resolveEnumType)
      for (const col of cols) {
        lines.push(`CREATE INDEX idx_${tbl}_${col} ON ${qName} (${col});`)
      }
      continue
    }
    // FK index для single ref (навіть якщо не indexed)
    if (attr.type === "Ref" && attr.ref) {
      const isEnumRef = resolveEnumType(attr.ref) != null
      if (!isEnumRef) {
        const col = `${attr.name}_id`
        lines.push(`CREATE INDEX idx_${tbl}_${col} ON ${qName} (${col});`)
      }
    }
    // FK index для polymorphic ref
    if (attr.type === "Ref" && attr.allowedTypes?.length) {
      lines.push(
        `CREATE INDEX idx_${tbl}_${attr.name}_id ON ${qName} (${attr.name}_id);`
      )
    }
  }

  // Індекси для табличних частин
  if (tabularSections) {
    for (const ts of tabularSections) {
      const tsTbl = tabularTableName(prefix, kind, objectName, ts.name)
      const tsQName = qualifiedName(schema, tsTbl)
      // parent_id FK
      lines.push(
        `CREATE INDEX idx_${tsTbl}_parent_id ON ${tsQName} (parent_id);`
      )
      // Кастомні ref атрибути
      for (const attr of ts.attributes) {
        if (attr.indexed && !attr.unique) {
          const cols = resolveColumnName(attr, resolveEnumType)
          for (const col of cols) {
            lines.push(
              `CREATE INDEX idx_${tsTbl}_${col} ON ${tsQName} (${col});`
            )
          }
          continue
        }
        if (attr.type === "Ref" && attr.ref) {
          const isEnumRef = resolveEnumType(attr.ref) != null
          if (!isEnumRef) {
            const col = `${attr.name}_id`
            lines.push(
              `CREATE INDEX idx_${tsTbl}_${col} ON ${tsQName} (${col});`
            )
          }
        }
        if (attr.type === "Ref" && attr.allowedTypes?.length) {
          lines.push(
            `CREATE INDEX idx_${tsTbl}_${attr.name}_id ON ${tsQName} (${attr.name}_id);`
          )
        }
      }
    }
  }

  return lines
}

// Індекси для регістрів (dimensions, resources, attributes)
function collectRegisterIndexes(
  objectName: string,
  kind: MetadataKind,
  prefix: string,
  schema: string,
  standardAttrs: StandardAttribute[],
  dimensions: Attribute[],
  resources: Attribute[],
  attributes: Attribute[],
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined
): string[] {
  const tbl = tableName(prefix, kind, objectName)
  const qName = qualifiedName(schema, tbl)
  const lines: string[] = []

  // Стандартні реквізити
  for (const attr of standardAttrs) {
    if (!attr.indexed) continue
    const cols = resolveStdColumnName(attr)
    for (const col of cols) {
      lines.push(`CREATE INDEX idx_${tbl}_${col} ON ${qName} (${col});`)
    }
  }

  // Dimensions, resources, attributes
  const allAttrs = [...dimensions, ...resources, ...attributes]
  for (const attr of allAttrs) {
    if (attr.indexed && !attr.unique) {
      const cols = resolveColumnName(attr, resolveEnumType)
      for (const col of cols) {
        lines.push(`CREATE INDEX idx_${tbl}_${col} ON ${qName} (${col});`)
      }
      continue
    }
    if (attr.type === "Ref" && attr.ref) {
      const isEnumRef = resolveEnumType(attr.ref) != null
      if (!isEnumRef) {
        const col = `${attr.name}_id`
        lines.push(`CREATE INDEX idx_${tbl}_${col} ON ${qName} (${col});`)
      }
    }
    if (attr.type === "Ref" && attr.allowedTypes?.length) {
      lines.push(
        `CREATE INDEX idx_${tbl}_${attr.name}_id ON ${qName} (${attr.name}_id);`
      )
    }
  }

  return lines
}

// ─── Views ──────────────────────────────────────────────────

// Визначити ім'я колонки для dimension у SELECT/GROUP BY
function dimensionColumnName(
  dim: Attribute,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined
): string[] {
  return resolveColumnName(dim, resolveEnumType)
}

// Генерувати views для AccumulationRegister (BRD §5.6)
function generateAccumulationViews(
  reg: AccumulationRegister,
  prefix: string,
  schema: string,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined
): string[] {
  const tbl = tableName(prefix, "AccumulationRegister", reg.name)
  const qName = qualifiedName(schema, tbl)
  const label = reg.displayName?.en ?? reg.name
  const statements: string[] = []

  // Без ресурсів — views не мають сенсу
  if (reg.resources.length === 0) return []

  // Колонки dimensions
  const dimCols = reg.dimensions.flatMap((d) =>
    dimensionColumnName(d, resolveEnumType)
  )

  // Побудувати SELECT/GROUP BY: period + dimensions
  const groupCols = ["period", ...dimCols]
  const selectCols = groupCols.map((c) => `  ${c}`).join(",\n")
  const groupByExpr = groupCols.join(", ")

  if (reg.registerType === "Balance") {
    // Кумулятивні залишки через CTE + window function
    const deltaResources = reg.resources
      .map(
        (r) =>
          `    SUM(CASE WHEN movement_type = 'Receipt' THEN ${r.name}` +
          ` ELSE -${r.name} END) AS ${r.name}_delta`
      )
      .join(",\n")

    const partitionBy = dimCols.length > 0 ? `PARTITION BY ${dimCols.join(", ")} ` : ""
    const windowSpec =
      `${partitionBy}ORDER BY period ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`

    const cumulativeResources = reg.resources
      .map(
        (r) =>
          `  SUM(${r.name}_delta) OVER (${windowSpec}) AS ${r.name}`
      )
      .join(",\n")

    const cteCols = groupCols.map((c) => `    ${c}`).join(",\n")
    const outerCols = groupCols.map((c) => `  ${c}`).join(",\n")

    statements.push(
      `-- Залишки на дату для ${label}\n` +
        `CREATE OR REPLACE VIEW ${qualifiedName(schema, `${tbl}_balance`)} AS\n` +
        `WITH deltas AS (\n` +
        `  SELECT\n` +
        `${cteCols},\n` +
        `${deltaResources}\n` +
        `  FROM ${qName}\n` +
        `  WHERE active = true\n` +
        `  GROUP BY ${groupByExpr}\n` +
        `)\n` +
        `SELECT\n` +
        `${outerCols},\n` +
        `${cumulativeResources}\n` +
        `FROM deltas;`
    )

    // Обороти
    const turnoverResources = reg.resources
      .map(
        (r) =>
          `  SUM(CASE WHEN movement_type = 'Receipt' THEN ${r.name}` +
          ` ELSE 0 END) AS ${r.name}_receipt,\n` +
          `  SUM(CASE WHEN movement_type = 'Expense' THEN ${r.name}` +
          ` ELSE 0 END) AS ${r.name}_expense`
      )
      .join(",\n")
    statements.push(
      `-- Обороти за період для ${label}\n` +
        `CREATE OR REPLACE VIEW ${qualifiedName(schema, `${tbl}_turnovers`)} AS\n` +
        `SELECT\n` +
        `${selectCols},\n` +
        `${turnoverResources}\n` +
        `FROM ${qName}\n` +
        `WHERE active = true\n` +
        `GROUP BY ${groupByExpr};`
    )
  } else {
    // Turnover register — тільки обороти
    const turnoverResources = reg.resources
      .map((r) => `  SUM(${r.name}) AS ${r.name}`)
      .join(",\n")
    statements.push(
      `-- Обороти за період для ${label}\n` +
        `CREATE OR REPLACE VIEW ${qualifiedName(schema, `${tbl}_turnovers`)} AS\n` +
        `SELECT\n` +
        `${selectCols},\n` +
        `${turnoverResources}\n` +
        `FROM ${qName}\n` +
        `WHERE active = true\n` +
        `GROUP BY ${groupByExpr};`
    )
  }

  return statements
}

// Генерувати view для InformationRegister (зріз останніх)
function generateInformationRegisterViews(
  reg: InformationRegister,
  prefix: string,
  schema: string,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined
): string[] {
  // Зріз останніх — тільки для періодичних регістрів
  if (reg.periodicity === "NonPeriodic") return []

  const tbl = tableName(prefix, "InformationRegister", reg.name)
  const qName = qualifiedName(schema, tbl)
  const label = reg.displayName?.en ?? reg.name

  const dimCols = reg.dimensions.flatMap((d) =>
    dimensionColumnName(d, resolveEnumType)
  )

  // Всі колонки: standard + dimensions + resources + attributes
  const stdAttrs = getStandardAttributes("InformationRegister", {
    periodicity: reg.periodicity,
    writeMode: reg.writeMode,
    recorderTypes: reg.recorderTypes,
  })

  const allCols: string[] = []
  for (const attr of stdAttrs) {
    const cols = resolveStdColumnName(attr)
    allCols.push(...cols)
  }
  for (const d of reg.dimensions) {
    allCols.push(...dimensionColumnName(d, resolveEnumType))
  }
  for (const r of reg.resources) {
    allCols.push(...resolveColumnName(r, resolveEnumType))
  }
  for (const a of reg.attributes) {
    allCols.push(...resolveColumnName(a, resolveEnumType))
  }

  const allColsStr = allCols.map((c) => `  ${c}`).join(",\n")

  // Фільтр active для RecorderSubordinate
  const isRecorderSubordinate = reg.writeMode === "RecorderSubordinate"
  const whereClause = isRecorderSubordinate ? `WHERE active = true\n` : ""

  // Додатковий ORDER BY line_number для детермінізму (RecorderSubordinate)
  const lineNumberOrder = isRecorderSubordinate ? ", line_number DESC" : ""

  if (dimCols.length === 0) {
    // Без вимірів — просто останній запис за period
    return [
      `-- Зріз останніх для ${label}\n` +
        `CREATE OR REPLACE VIEW ${qualifiedName(schema, `${tbl}_slice_last`)} AS\n` +
        `SELECT\n` +
        `${allColsStr}\n` +
        `FROM ${qName}\n` +
        `${whereClause}` +
        `ORDER BY period DESC${lineNumberOrder}\n` +
        `LIMIT 1;`,
    ]
  }

  const dimOrder = dimCols.join(", ")

  return [
    `-- Зріз останніх для ${label}\n` +
      `CREATE OR REPLACE VIEW ${qualifiedName(schema, `${tbl}_slice_last`)} AS\n` +
      `SELECT DISTINCT ON (${dimOrder})\n` +
      `${allColsStr}\n` +
      `FROM ${qName}\n` +
      `${whereClause}` +
      `ORDER BY ${dimOrder}, period DESC${lineNumberOrder};`,
  ]
}

// ─── Triggers ───────────────────────────────────────────────

// Тригер автонумерації для Catalog
function generateCatalogAutonumberTrigger(
  cat: Catalog,
  prefix: string,
  schema: string
): string[] {
  const tbl = tableName(prefix, "Catalog", cat.name)
  const qName = qualifiedName(schema, tbl)
  const label = cat.displayName?.en ?? cat.name
  const funcName = qualifiedName(schema, `${tbl}_autonumber`)
  const lockHash = escapeLiteral(`${qName}_autonumber`)

  if (cat.codeType === "Number") {
    // Integer — просто інкремент, без LPAD
    return [
      `-- Тригер автонумерації для ${label}\n` +
        `CREATE OR REPLACE FUNCTION ${funcName}()\n` +
        `RETURNS TRIGGER AS $$\n` +
        `BEGIN\n` +
        `  PERFORM pg_advisory_xact_lock(hashtext('${lockHash}'));\n` +
        `  IF NEW.code IS NULL THEN\n` +
        `    NEW.code := COALESCE(\n` +
        `      (SELECT MAX(code) FROM ${qName}),\n` +
        `      0\n` +
        `    ) + 1;\n` +
        `  END IF;\n` +
        `  RETURN NEW;\n` +
        `END;\n` +
        `$$ LANGUAGE plpgsql;\n` +
        `\n` +
        `CREATE TRIGGER trg_${tbl}_autonumber\n` +
        `  BEFORE INSERT ON ${qName}\n` +
        `  FOR EACH ROW\n` +
        `  EXECUTE FUNCTION ${funcName}();`,
    ]
  }

  // String — LPAD із пошуком максимального числового коду
  const codeLen = cat.codeLength ?? 9
  return [
    `-- Тригер автонумерації для ${label}\n` +
      `CREATE OR REPLACE FUNCTION ${funcName}()\n` +
      `RETURNS TRIGGER AS $$\n` +
      `BEGIN\n` +
      `  PERFORM pg_advisory_xact_lock(hashtext('${lockHash}'));\n` +
      `  IF NEW.code IS NULL OR NEW.code = '' THEN\n` +
      `    NEW.code := LPAD(\n` +
      `      (COALESCE(\n` +
      `        (SELECT MAX(CAST(code AS INTEGER)) FROM ${qName} WHERE code ~ '^\\d+$'),\n` +
      `        0\n` +
      `      ) + 1)::text,\n` +
      `      ${codeLen},\n` +
      `      '0'\n` +
      `    );\n` +
      `  END IF;\n` +
      `  RETURN NEW;\n` +
      `END;\n` +
      `$$ LANGUAGE plpgsql;\n` +
      `\n` +
      `CREATE TRIGGER trg_${tbl}_autonumber\n` +
      `  BEFORE INSERT ON ${qName}\n` +
      `  FOR EACH ROW\n` +
      `  EXECUTE FUNCTION ${funcName}();`,
  ]
}

// Інформація про період: SQL вираз для початку та інтервал
function periodInfo(
  periodicity: string
): { truncExpr: string; interval: string } | null {
  switch (periodicity) {
    case "Year":
      return { truncExpr: "date_trunc('year', NEW.date)", interval: "1 year" }
    case "Quarter":
      return {
        truncExpr: "date_trunc('quarter', NEW.date)",
        interval: "3 months",
      }
    case "Month":
      return { truncExpr: "date_trunc('month', NEW.date)", interval: "1 month" }
    case "Day":
      return { truncExpr: "date_trunc('day', NEW.date)", interval: "1 day" }
    default:
      return null
  }
}

// Тригер автонумерації для Document
function generateDocumentAutonumberTrigger(
  doc: Document,
  prefix: string,
  schema: string
): string[] {
  const tbl = tableName(prefix, "Document", doc.name)
  const qName = qualifiedName(schema, tbl)
  const label = doc.displayName?.en ?? doc.name
  const numLen = doc.numberLength ?? 11
  const funcName = qualifiedName(schema, `${tbl}_autonumber`)
  const lockHash = escapeLiteral(`${qName}_autonumber`)
  const period = periodInfo(doc.numberPeriodicity ?? "None")
  const isNumber = doc.numberType === "Number"

  // DECLARE секція
  const declareParts = ["next_num integer"]
  if (period) {
    declareParts.unshift("period_start timestamptz", "period_end timestamptz")
  }
  const declarePart = `DECLARE\n  ${declareParts.join(";\n  ")};\n`

  // Обчислення періоду
  const periodCalc = period
    ? `    period_start := ${period.truncExpr};\n` +
      `    period_end := period_start + interval '${period.interval}';\n`
    : ""

  // Фільтр за періодом
  const periodFilter = period
    ? `\n      AND date >= period_start\n      AND date < period_end`
    : ""

  // Умова перевірки та SELECT/присвоєння залежать від типу номера
  const condition = isNumber
    ? `  IF NEW.number IS NULL THEN`
    : `  IF NEW.number IS NULL OR NEW.number = '' THEN`

  let selectExpr: string
  let assignExpr: string
  if (isNumber) {
    if (period) {
      selectExpr =
        `    SELECT COALESCE(MAX(number), 0) + 1\n` +
        `      INTO next_num\n` +
        `      FROM ${qName}\n` +
        `      WHERE date >= period_start\n` +
        `        AND date < period_end;`
    } else {
      selectExpr =
        `    SELECT COALESCE(MAX(number), 0) + 1\n` +
        `      INTO next_num\n` +
        `      FROM ${qName};`
    }
    assignExpr = `    NEW.number := next_num;`
  } else {
    selectExpr =
      `    SELECT COALESCE(MAX(CAST(number AS INTEGER)), 0) + 1\n` +
      `      INTO next_num\n` +
      `      FROM ${qName}\n` +
      `      WHERE number ~ '^\\d+$'${periodFilter};`
    assignExpr = `    NEW.number := LPAD(next_num::text, ${numLen}, '0');`
  }

  return [
    `-- Тригер автонумерації для ${label}\n` +
      `CREATE OR REPLACE FUNCTION ${funcName}()\n` +
      `RETURNS TRIGGER AS $$\n` +
      `${declarePart}` +
      `BEGIN\n` +
      `  PERFORM pg_advisory_xact_lock(hashtext('${lockHash}'));\n` +
      `${condition}\n` +
      `${periodCalc}` +
      `${selectExpr}\n` +
      `${assignExpr}\n` +
      `  END IF;\n` +
      `  RETURN NEW;\n` +
      `END;\n` +
      `$$ LANGUAGE plpgsql;\n` +
      `\n` +
      `CREATE TRIGGER trg_${tbl}_autonumber\n` +
      `  BEFORE INSERT ON ${qName}\n` +
      `  FOR EACH ROW\n` +
      `  EXECUTE FUNCTION ${funcName}();`,
  ]
}

// Роздільник секцій SQL
function sectionHeader(title: string): string {
  return (
    `-- ============================================================\n` +
    `-- ${title}\n` +
    `-- ============================================================`
  )
}

// Заголовок файлу
function fileHeader(projectName: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return (
    `-- Generated by Simetra DDL Generator v0.0.1\n` +
    `-- Project: ${projectName}\n` +
    `-- Date: ${date}\n` +
    `-- Target: PostgreSQL\n` +
    `-- ============================================================`
  )
}

// ─── Головна функція ────────────────────────────────────────
export function generateProjectDDL(
  project: ProjectModel,
  options: Required<GeneratorOptions>
): GeneratorOutput {
  const prefix = project.project.generation?.tablePrefix ?? ""
  const schema = options.schema
  const warnings: string[] = []

  const lookup = buildRefTableLookup(project, options)
  const resolve = (ref: { kind: string; name: string }) =>
    resolveRef(lookup, ref)

  // Lookup для enum type names (pgEnum стратегія)
  const enumTypeLookup = buildEnumTypeLookup(project, options)
  const resolveEnumType = (ref: {
    kind: string
    name: string
  }): string | undefined => {
    if (ref.kind !== "Enumeration") return undefined
    return enumTypeLookup.get(`${ref.kind}.${ref.name}`)
  }

  const sections: string[] = []
  const fkCollector: ForeignKeyDef[] = []

  // Заголовок
  sections.push(fileHeader(project.project.name || "schema"))

  // 1. Enumerations (CREATE TYPE має бути до таблиць)
  const enumStatements: string[] = []
  for (const en of project.enumerations) {
    enumStatements.push(
      ...generateEnumeration(en, prefix, schema, options.enumStrategy)
    )
  }
  if (enumStatements.length > 0) {
    sections.push(sectionHeader("ENUM TYPES"))
    sections.push(enumStatements.join("\n\n"))
  }

  // 2–7. Tables
  const tableStatements: string[] = []

  for (const cat of project.catalogs) {
    tableStatements.push(
      ...generateCatalog(
        cat,
        prefix,
        schema,
        resolve,
        resolveEnumType,
        fkCollector,
      )
    )
  }
  for (const doc of project.documents) {
    tableStatements.push(
      ...generateDocument(
        doc,
        prefix,
        schema,
        resolve,
        resolveEnumType,
        fkCollector,
      )
    )
  }
  for (const reg of project.informationRegisters) {
    tableStatements.push(
      ...generateInformationRegister(
        reg,
        prefix,
        schema,
        resolve,
        resolveEnumType,
        fkCollector,
      )
    )
  }
  for (const reg of project.accumulationRegisters) {
    tableStatements.push(
      ...generateAccumulationRegister(
        reg,
        prefix,
        schema,
        resolve,
        resolveEnumType,
        fkCollector,
      )
    )
  }

  if (options.constantsStrategy === "singleTable") {
    tableStatements.push(
      ...generateConstantsSingleTable(project.constants, prefix, schema)
    )
  } else {
    tableStatements.push(
      ...generateConstantsSeparateTables(project.constants, prefix, schema)
    )
  }

  for (const ct of project.customTables) {
    tableStatements.push(
      ...generateCustomTable(
        ct,
        prefix,
        schema,
        resolve,
        resolveEnumType,
        fkCollector,
      )
    )
  }

  if (tableStatements.length > 0) {
    sections.push(sectionHeader("TABLES"))
    sections.push(tableStatements.join("\n\n"))
  }

  // 8. Foreign Keys (late-emitted для уникнення forward-reference проблем)
  const fkStatements = emitForeignKeys(fkCollector, warnings)
  if (fkStatements.length > 0) {
    sections.push(sectionHeader("FOREIGN KEYS"))
    sections.push(fkStatements.join("\n"))
  }

  // 9. Indexes
  const indexStatements: string[] = []

  for (const cat of project.catalogs) {
    const stdAttrs = getStandardAttributes("Catalog", {
      hierarchyType: cat.hierarchyType,
      owners: cat.owners,
    })
    indexStatements.push(
      ...collectIndexes(
        cat.name,
        "Catalog",
        prefix,
        schema,
        stdAttrs,
        cat.attributes,
        resolveEnumType,
        cat.tabularSections,
      )
    )
  }
  for (const doc of project.documents) {
    const stdAttrs = getStandardAttributes("Document")
    indexStatements.push(
      ...collectIndexes(
        doc.name,
        "Document",
        prefix,
        schema,
        stdAttrs,
        doc.attributes,
        resolveEnumType,
        doc.tabularSections,
      )
    )
  }
  for (const reg of project.informationRegisters) {
    const stdAttrs = getStandardAttributes("InformationRegister", {
      periodicity: reg.periodicity,
      writeMode: reg.writeMode,
      recorderTypes: reg.recorderTypes,
    })
    indexStatements.push(
      ...collectRegisterIndexes(
        reg.name,
        "InformationRegister",
        prefix,
        schema,
        stdAttrs,
        reg.dimensions,
        reg.resources,
        reg.attributes,
        resolveEnumType,
      )
    )
  }
  for (const reg of project.accumulationRegisters) {
    const stdAttrs = getStandardAttributes("AccumulationRegister", {
      registerType: reg.registerType,
      recorderTypes: reg.recorderTypes,
    })
    indexStatements.push(
      ...collectRegisterIndexes(
        reg.name,
        "AccumulationRegister",
        prefix,
        schema,
        stdAttrs,
        reg.dimensions,
        reg.resources,
        reg.attributes,
        resolveEnumType,
      )
    )
  }
  for (const ct of project.customTables) {
    const stdAttrs = getStandardAttributes("CustomTable", {
      autoAddPrimaryKey: ct.autoAddPrimaryKey,
    })
    indexStatements.push(
      ...collectIndexes(
        ct.name,
        "CustomTable",
        prefix,
        schema,
        stdAttrs,
        ct.attributes,
        resolveEnumType,
      )
    )
  }

  if (indexStatements.length > 0) {
    sections.push(sectionHeader("INDEXES"))
    sections.push(indexStatements.join("\n\n"))
  }

  // 10. Views
  const viewStatements: string[] = []

  for (const reg of project.accumulationRegisters) {
    viewStatements.push(
      ...generateAccumulationViews(reg, prefix, schema, resolveEnumType)
    )
  }
  for (const reg of project.informationRegisters) {
    viewStatements.push(
      ...generateInformationRegisterViews(reg, prefix, schema, resolveEnumType)
    )
  }

  if (viewStatements.length > 0) {
    sections.push(sectionHeader("VIEWS"))
    sections.push(viewStatements.join("\n\n"))
  }

  // 11. Triggers
  const triggerStatements: string[] = []

  for (const cat of project.catalogs) {
    if (cat.autonumber) {
      triggerStatements.push(
        ...generateCatalogAutonumberTrigger(cat, prefix, schema)
      )
    }
  }
  for (const doc of project.documents) {
    if (doc.autonumber) {
      triggerStatements.push(
        ...generateDocumentAutonumberTrigger(doc, prefix, schema)
      )
    }
  }

  if (triggerStatements.length > 0) {
    sections.push(sectionHeader("TRIGGERS"))
    sections.push(triggerStatements.join("\n\n"))
  }

  // 12. Posting Functions
  const postingStatements = generatePostingFunctions(
    project,
    prefix,
    schema,
    resolveEnumType,
  )
  if (postingStatements.length > 0) {
    sections.push(sectionHeader("POSTING FUNCTIONS"))
    sections.push(postingStatements.join("\n\n"))
  }

  // B.4: Перевірка довжини ідентифікаторів (table names + FK constraint names)
  const identifiersToCheck = new Set<string>()
  // Таблиці всіх об'єктів
  for (const c of project.catalogs) {
    const t = tableName(prefix, "Catalog", c.name)
    identifiersToCheck.add(t)
    for (const ts of c.tabularSections) identifiersToCheck.add(tabularTableName(prefix, "Catalog", c.name, ts.name))
  }
  for (const d of project.documents) {
    const t = tableName(prefix, "Document", d.name)
    identifiersToCheck.add(t)
    for (const ts of d.tabularSections) identifiersToCheck.add(tabularTableName(prefix, "Document", d.name, ts.name))
  }
  for (const e of project.enumerations) identifiersToCheck.add(tableName(prefix, "Enumeration", e.name))
  for (const r of project.informationRegisters) identifiersToCheck.add(tableName(prefix, "InformationRegister", r.name))
  for (const r of project.accumulationRegisters) identifiersToCheck.add(tableName(prefix, "AccumulationRegister", r.name))
  for (const t of project.customTables) identifiersToCheck.add(tableName(prefix, "CustomTable", t.name))
  // FK constraint names
  for (const fk of fkCollector) identifiersToCheck.add(getForeignKeyConstraintName(fk))
  for (const id of identifiersToCheck) {
    checkIdentifierLength(id, warnings)
  }

  const fileName = `${project.project.name || "schema"}.sql`

  return {
    files: [{ path: fileName, content: sections.join("\n\n") }],
    warnings,
  }
}
