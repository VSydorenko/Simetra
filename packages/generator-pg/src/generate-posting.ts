import type {
  Document,
  PostingMovement,
  PostingValidation,
  ProjectModel,
  AccumulationRegister,
  InformationRegister,
  Attribute,
  StandardAttribute,
  StandardAttributeSettings,
  MetadataKind,
} from '@simetra/core'
import {
  formatValidationMessage,
  getStandardAttributes,
  getTabularSectionStandardAttributes,
  isPostingCompatible,
} from '@simetra/core'
import { toSnakeCase, tableName, tabularTableName, qualifiedName, escapeLiteral } from './naming'
import { mapFieldType } from './type-mapping'
import { resolveColumnName } from './column-naming'

// Об'єднаний тип регістру для posting
type RegisterDef = AccumulationRegister | InformationRegister

/**
 * Перетворити mapping expression у SQL вираз.
 * resolveField — опціональний callback для резолюції фізичних імен source-полів
 * (з урахуванням _id суфіксу для Ref атрибутів)
 */
export function expressionToSql(
  expr: string,
  docAlias: string,
  tsAlias: string,
  docTableName: string,
  prefix: string,
  schema: string = 'public',
  resolveField?: (source: 'doc' | 'row', fieldName: string) => string,
): string {
  // literal:value → екранований літерал або число
  if (expr.startsWith('literal:')) {
    const val = expr.slice('literal:'.length)
    if (/^-?\d+(\.\d+)?$/.test(val)) return val
    return `'${escapeLiteral(val)}'`
  }

  // now() → NOW()
  if (expr === 'now()') return 'NOW()'

  // sum(TsName.field) → підзапит (поле резолвиться через resolveField якщо доступний)
  const sumMatch = expr.match(/^sum\((\w+)\.(\w+)\)$/)
  if (sumMatch) {
    const [, tsName, field] = sumMatch
    const tsTbl = qualifiedName(schema, tabularTableName(prefix, "Document", docTableName, tsName))
    const physicalField = resolveField ? resolveField('row', field) : toSnakeCase(field)
    return `(SELECT COALESCE(SUM(${physicalField}), 0) FROM ${tsTbl} WHERE parent_id = ${docAlias}.id)`
  }

  // count(TsName) → підзапит
  const countMatch = expr.match(/^count\((\w+)\)$/)
  if (countMatch) {
    const [, tsName] = countMatch
    const tsTbl = qualifiedName(schema, tabularTableName(prefix, "Document", docTableName, tsName))
    return `(SELECT COUNT(*) FROM ${tsTbl} WHERE parent_id = ${docAlias}.id)`
  }

  // row.a * row.b → ts.a * ts.b (арифметика з row.*, поля резолвяться)
  if (expr.includes('row.')) {
    return expr.replace(/row\.(\w+)/g, (_, field) => {
      const physicalField = resolveField ? resolveField('row', field) : toSnakeCase(field)
      return `${tsAlias}.${physicalField}`
    })
  }

  // doc.field → d.field_name (поле резолвиться через resolveField якщо доступний)
  if (expr.startsWith('doc.')) {
    const field = expr.slice(4)
    const physicalField = resolveField ? resolveField('doc', field) : toSnakeCase(field)
    return `${docAlias}.${physicalField}`
  }

  // fallback — невідомий формат
  throw new Error(`Unknown expression format: "${expr}"`)
}

// Знайти регістр за MetadataRef у проєкті
function findRegister(
  project: ProjectModel,
  ref: { kind: string; name: string },
): RegisterDef | undefined {
  if (ref.kind === 'AccumulationRegister') {
    return project.accumulationRegisters.find((r) => r.name === ref.name)
  }
  if (ref.kind === 'InformationRegister') {
    return project.informationRegisters.find((r) => r.name === ref.name)
  }
  return undefined
}

// Дозволені токени condition DSL
const CONDITION_TOKENS = /(?:(?:doc|row)\.(\w+))|(!?=|>=?|<=?)|('[^']*'|-?\d+(?:\.\d+)?|true|false|null)|(\bAND\b|\bOR\b)|([()])/gi

// SQL keywords blocklist — додатковий шар захисту
const SQL_KEYWORDS = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|EXEC|UNION|SELECT)\b/i

// Транслювати condition вираз у SQL з правильними аліасами (token-based parser)
function translateCondition(
  condition: string,
  docAlias: string,
  tsAlias: string,
  resolveField?: (source: 'doc' | 'row', fieldName: string) => string,
): string {
  // Видаляємо string literals перед перевіркою на SQL keywords
  const withoutLiterals = condition.replace(/'[^']*'/g, "''")
  if (SQL_KEYWORDS.test(withoutLiterals)) {
    throw new Error(`Condition contains forbidden SQL keyword: "${condition}"`)
  }
  if (/;|--|\/\*/.test(condition)) {
    throw new Error(`Condition contains forbidden characters: "${condition}"`)
  }

  const parts: string[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset regex state
  CONDITION_TOKENS.lastIndex = 0

  while ((match = CONDITION_TOKENS.exec(condition)) !== null) {
    // Перевіряємо що між токенами тільки пробіли
    const gap = condition.slice(lastIndex, match.index)
    if (gap.trim().length > 0) {
      throw new Error(`Condition contains invalid tokens: "${gap.trim()}"`)
    }
    lastIndex = match.index + match[0].length

    const fullMatch = match[0]

    // doc.field → docAlias.resolved_field
    if (fullMatch.startsWith('doc.')) {
      const field = fullMatch.slice(4)
      const col = resolveField ? resolveField('doc', field) : toSnakeCase(field)
      parts.push(`${docAlias}.${col}`)
      continue
    }
    // row.field → tsAlias.resolved_field
    if (fullMatch.startsWith('row.')) {
      const field = fullMatch.slice(4)
      const col = resolveField ? resolveField('row', field) : toSnakeCase(field)
      parts.push(`${tsAlias}.${col}`)
      continue
    }
    // Все інше (оператори, літерали, зв'язки, дужки) — як є
    parts.push(fullMatch)
  }

  // Перевіряємо хвіст
  const tail = condition.slice(lastIndex)
  if (tail.trim().length > 0) {
    throw new Error(`Condition contains invalid tokens at end: "${tail.trim()}"`)
  }

  return parts.join(' ')
}

// Визначити SQL тип dimension за атрибутом регістру
function resolveDimensionType(
  register: RegisterDef,
  dimName: string,
): string {
  const dim = register.dimensions.find((d) => d.name === dimName)
  if (!dim) return 'uuid'
  if (dim.type === 'Ref') return 'uuid'
  return mapFieldType(dim)
}

/**
 * Створити resolveField callback для резолюції фізичних імен source-полів.
 * Враховує Ref → _id суфікс для документа і табличної частини.
 */
function createFieldResolver(
  doc: Document,
  tsAttrs: Attribute[],
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
): (source: 'doc' | 'row', fieldName: string) => string {
  const docStdAttrs = getStandardAttributes('Document')
  const tsStdAttrs = getTabularSectionStandardAttributes()

  return (source: 'doc' | 'row', fieldName: string): string => {
    if (source === 'doc') {
      // Спочатку шукаємо серед custom attributes документа
      const attr = doc.attributes.find((a) => a.name === fieldName)
      if (attr) {
        const cols = resolveColumnName(attr, resolveEnumType)
        if (cols.length > 1) {
          throw new Error(
            `Polymorphic Ref field "doc.${fieldName}" is not supported in posting expressions`,
          )
        }
        return cols[0]
      }
      // Потім серед standard attributes документа (фізичні імена вже канонічні)
      const stdAttr = docStdAttrs.find((a) => a.name === fieldName)
      if (stdAttr) return stdAttr.name
      // Fallback — toSnakeCase для camelCase полів
      return toSnakeCase(fieldName)
    }
    // source === 'row'
    const attr = tsAttrs.find((a) => a.name === fieldName)
    if (attr) {
      const cols = resolveColumnName(attr, resolveEnumType)
      if (cols.length > 1) {
        throw new Error(
          `Polymorphic Ref field "row.${fieldName}" is not supported in posting expressions`,
        )
      }
      return cols[0]
    }
    // Standard TS attributes
    const stdAttr = tsStdAttrs.find((a) => a.name === fieldName)
    if (stdAttr) return stdAttr.name
    return toSnakeCase(fieldName)
  }
}

// Генерувати INSERT для одного руху
function generateMovementInsert(
  movement: PostingMovement,
  doc: Document,
  prefix: string,
  schema: string,
  project: ProjectModel,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
): string {
  const register = findRegister(project, movement.register)
  if (!register) {
    throw new Error(
      `Register ${movement.register.kind}/${movement.register.name} not found in project`,
    )
  }

  // Fail-fast: posting compatibility
  const compat = isPostingCompatible(register, {
    recorder: { kind: "Document", name: doc.name },
  })
  if (!compat.compatible) {
    throw new Error(
      `Register ${register.kind}/${register.name} is not posting-compatible: ${formatValidationMessage(compat.reason ?? '')}`,
    )
  }

  const regTable = qualifiedName(schema, tableName(prefix, register.kind as MetadataKind, register.name))

  // Побудувати registerSettings для getStandardAttributes
  const registerSettings: StandardAttributeSettings = {
    recorderTypes: register.recorderTypes,
  }
  if (register.kind === 'AccumulationRegister') {
    registerSettings.registerType = register.registerType
  }
  if (register.kind === 'InformationRegister') {
    registerSettings.periodicity = register.periodicity
    registerSettings.writeMode = register.writeMode
  }

  // Динамічні standard columns через getStandardAttributes
  const stdAttrs = getStandardAttributes(register.kind, registerSettings)
  // Фільтруємо id — він не вставляється через INSERT (auto-generated)
  const insertableStdAttrs = stdAttrs.filter((a) => a.name !== 'id')

  // Standard column names (з урахуванням polymorphic)
  const stdCols: string[] = []
  for (const attr of insertableStdAttrs) {
    if (attr.type === 'Ref' && attr.allowedTypes?.length) {
      stdCols.push(`${attr.name}_type`, `${attr.name}_id`)
    } else {
      stdCols.push(attr.name)
    }
  }

  // Визначити чи recorder_id polymorphic
  const recorderAttr = stdAttrs.find((a) => a.name === 'recorder_id')
  const isPolymorphicRecorder = recorderAttr?.allowedTypes && recorderAttr.allowedTypes.length > 0

  // Визначити атрибути source (ТЧ або документ) для резолюції фізичних імен полів
  let sourceAttrs: Attribute[] = []
  if (movement.source.startsWith('tabularSection:')) {
    const tsName = movement.source.slice('tabularSection:'.length)
    const ts = doc.tabularSections.find((t) => t.name === tsName)
    if (ts) sourceAttrs = ts.attributes
  }
  const resolveField = createFieldResolver(doc, sourceAttrs, resolveEnumType)

  // Визначити movementType SQL
  const hasMovementType = stdAttrs.some((a) => a.name === 'movement_type')
  const mvtTypeExpr = hasMovementType
    ? (movement.movementType === 'Receipt' || movement.movementType === 'Expense'
        ? `'${movement.movementType}'`
        : expressionToSql(movement.movementType, 'd', 'ts', doc.name, prefix, schema, resolveField))
    : null

  const dimMappingEntries = Object.entries(movement.mappings.dimensions)
  const resMappingEntries = Object.entries(movement.mappings.resources)
  const attrMappingEntries = Object.entries(movement.mappings.attributes)

  // Резолвити column names для mapping fields через register metadata
  const mappingCols: string[] = []
  const mappingExprs: string[] = []

  for (const [fieldName, expr] of dimMappingEntries) {
    const dim = register.dimensions.find((d) => d.name === fieldName)
    if (dim) {
      const cols = resolveColumnName(dim, resolveEnumType)
      if (cols.length > 1) {
        // Polymorphic Ref dimension — не підтримується в mapping grammar
        throw new Error(
          `Polymorphic Ref dimension "${fieldName}" in register "${register.name}" is not supported in posting mappings`,
        )
      }
      mappingCols.push(cols[0])
    } else {
      mappingCols.push(toSnakeCase(fieldName))
    }
    mappingExprs.push(expressionToSql(expr, 'd', 'ts', doc.name, prefix, schema, resolveField))
  }
  for (const [fieldName, expr] of resMappingEntries) {
    const res = register.resources.find((r) => r.name === fieldName)
    if (res) {
      const cols = resolveColumnName(res, resolveEnumType)
      if (cols.length > 1) {
        throw new Error(
          `Polymorphic Ref resource "${fieldName}" in register "${register.name}" is not supported in posting mappings`,
        )
      }
      mappingCols.push(cols[0])
    } else {
      mappingCols.push(toSnakeCase(fieldName))
    }
    mappingExprs.push(expressionToSql(expr, 'd', 'ts', doc.name, prefix, schema, resolveField))
  }
  for (const [fieldName, expr] of attrMappingEntries) {
    const regAttr = register.attributes.find((a) => a.name === fieldName)
    if (regAttr) {
      const cols = resolveColumnName(regAttr, resolveEnumType)
      if (cols.length > 1) {
        throw new Error(
          `Polymorphic Ref attribute "${fieldName}" in register "${register.name}" is not supported in posting mappings`,
        )
      }
      mappingCols.push(cols[0])
    } else {
      mappingCols.push(toSnakeCase(fieldName))
    }
    mappingExprs.push(expressionToSql(expr, 'd', 'ts', doc.name, prefix, schema, resolveField))
  }

  const allCols = [...stdCols, ...mappingCols]

  // Build SELECT/VALUES expressions for standard columns
  function buildStdExpressions(isSelect: boolean): string[] {
    const exprs: string[] = []
    for (const attr of insertableStdAttrs) {
      switch (attr.name) {
        case 'period':
          exprs.push(isSelect ? '    d.date' : 'd.date')
          break
        case 'recorder_id':
          if (isPolymorphicRecorder) {
            // Polymorphic: recorder_id_type + recorder_id_id
            const docKindName = `${doc.kind}.${doc.name}`
            exprs.push(isSelect ? `    '${docKindName}'` : `'${docKindName}'`)
            exprs.push(isSelect ? '    d.id' : 'd.id')
          } else {
            exprs.push(isSelect ? '    d.id' : 'd.id')
          }
          break
        case 'line_number':
          if (movement.source.startsWith('tabularSection:')) {
            exprs.push(isSelect ? '    ts.line_number' : 'ts.line_number')
          } else {
            exprs.push(isSelect ? '    1' : '1')
          }
          break
        case 'active':
          exprs.push(isSelect ? '    TRUE' : 'TRUE')
          break
        case 'movement_type':
          if (mvtTypeExpr) {
            exprs.push(isSelect ? `    ${mvtTypeExpr}` : mvtTypeExpr)
          }
          break
        default:
          // Інші standard attrs — fallback
          exprs.push(isSelect ? '    NULL' : 'NULL')
          break
      }
    }
    return exprs
  }

  // Транслювати condition у SQL
  const isDocumentSource = movement.source === 'document'
  if (isDocumentSource && movement.condition && /\brow\.\w+/i.test(movement.condition)) {
    throw new Error(
      `Condition references "row.*" but source is "document" (no tabular section alias available)`,
    )
  }
  const translatedCondition = movement.condition
    ? translateCondition(movement.condition, 'd', 'ts', resolveField)
    : ''

  // tabularSection source → SELECT ... FROM tabular_table
  if (movement.source.startsWith('tabularSection:')) {
    const tsName = movement.source.slice('tabularSection:'.length)
    const tsTable = qualifiedName(schema, tabularTableName(prefix, "Document", doc.name, tsName))

    const condition = translatedCondition ? `\n  AND (${translatedCondition})` : ''

    const selectExprs = [
      ...buildStdExpressions(true),
      ...mappingExprs.map((e) => `    ${e}`),
    ]

    return (
      `  INSERT INTO ${regTable} (\n` +
      `    ${allCols.join(', ')}\n` +
      `  )\n` +
      `  SELECT\n` +
      selectExprs.join(',\n') + '\n' +
      `  FROM ${tsTable} ts\n` +
      `  WHERE ts.parent_id = p_doc_id${condition};`
    )
  }

  // document source → VALUES
  const valueExprs = [
    ...buildStdExpressions(false),
    ...mappingExprs,
  ]

  const insertSql =
    `  INSERT INTO ${regTable} (\n` +
    `    ${allCols.join(', ')}\n` +
    `  )\n` +
    `  VALUES (\n` +
    `    ${valueExprs.join(', ')}\n` +
    `  );`

  if (translatedCondition) {
    return (
      `  IF (${translatedCondition}) THEN\n` +
      `  ${insertSql}\n` +
      `  END IF;`
    )
  }

  return insertSql
}

// Генерувати check function для NonNegativeBalance валідації
function generateCheckFunction(
  validation: PostingValidation,
  prefix: string,
  schema: string,
  project: ProjectModel,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
): string {
  const register = findRegister(project, validation.register)
  if (!register) {
    throw new Error(
      `Register ${validation.register.kind}/${validation.register.name} not found for NonNegativeBalance validation`,
    )
  }

  // Перевірка: resource має бути numeric для NonNegativeBalance
  const resourceAttr = register.resources.find((r) => r.name === validation.resource)
  if (resourceAttr && resourceAttr.type !== 'Numeric' && resourceAttr.type !== 'Integer') {
    throw new Error(
      `NonNegativeBalance validation for "${register.name}.${validation.resource}": resource type must be Numeric or Integer, got "${resourceAttr.type}"`,
    )
  }

  const regTable = qualifiedName(schema, tableName(prefix, register.kind as MetadataKind, register.name))
  const regSnake = toSnakeCase(register.name)
  const resource = toSnakeCase(validation.resource)
  const funcName = qualifiedName(schema, `check_${regSnake}_${resource}`)

  // Резолвити фізичні імена dimension колонок через register metadata
  const resolvedDims = validation.dimensions.map((d) => {
    const dim = register.dimensions.find((attr) => attr.name === d)
    if (dim) {
      const cols = resolveColumnName(dim, resolveEnumType)
      if (cols.length > 1) {
        throw new Error(
          `Polymorphic Ref dimension "${d}" in register "${register.name}" is not supported in NonNegativeBalance validation`,
        )
      }
      return { logicalName: d, physicalCol: cols[0] }
    }
    return { logicalName: d, physicalCol: toSnakeCase(d) }
  })

  // Параметри — dimensions з правильними типами і фізичними іменами
  const params = resolvedDims
    .map((d) => `p_${d.physicalCol} ${resolveDimensionType(register, d.logicalName)}`)
    .join(', ')

  // WHERE conditions для dimensions
  const dimConditions = resolvedDims
    .map((d) => `AND ${d.physicalCol} = p_${d.physicalCol}`)
    .join('\n    ')

  // Повідомлення помилки
  const msg = validation.message.en ?? validation.message.uk ?? 'Negative balance'

  // Визначити тип регістра для правильної SQL-структури
  const isBalanceRegister =
    register.kind === 'AccumulationRegister' && register.registerType === 'Balance'

  // applyTo фільтр — тільки для Balance (де є movement_type)
  let applyToFilter = ''
  if (isBalanceRegister && validation.applyTo !== 'Both') {
    applyToFilter = `\n    AND movement_type = '${validation.applyTo}'`
  }

  // Balance: CASE WHEN movement_type = 'Receipt' THEN +res ELSE -res END
  // Turnover/IR: просто SUM(resource)
  const balanceExpr = isBalanceRegister
    ? `CASE WHEN movement_type = 'Receipt' THEN ${resource} ELSE -${resource} END`
    : resource

  return (
    `CREATE OR REPLACE FUNCTION ${funcName}(${params})\n` +
    `RETURNS VOID\n` +
    `LANGUAGE plpgsql\n` +
    `AS $$\n` +
    `DECLARE\n` +
    `  v_balance NUMERIC;\n` +
    `BEGIN\n` +
    `  SELECT COALESCE(SUM(\n` +
    `    ${balanceExpr}\n` +
    `  ), 0)\n` +
    `  INTO v_balance\n` +
    `  FROM ${regTable}\n` +
    `  WHERE active = TRUE\n` +
    `    ${dimConditions}${applyToFilter};\n` +
    `\n` +
    `  IF v_balance < 0 THEN\n` +
    `    RAISE EXCEPTION '${escapeLiteral(msg)}';\n` +
    `  END IF;\n` +
    `END;\n` +
    `$$;`
  )
}

// Побудувати DELETE statement з урахуванням polymorphic recorder
function buildDeleteStatement(
  regTable: string,
  register: RegisterDef,
  doc: Document,
  stdAttrs: StandardAttribute[],
): string {
  const recorderAttr = stdAttrs.find((a) => a.name === 'recorder_id')
  const isPolymorphic = recorderAttr?.allowedTypes && recorderAttr.allowedTypes.length > 0

  if (isPolymorphic) {
    const docKindName = `${doc.kind}.${doc.name}`
    return `  DELETE FROM ${regTable} WHERE recorder_id_type = '${docKindName}' AND recorder_id_id = p_doc_id;`
  }
  return `  DELETE FROM ${regTable} WHERE recorder_id = p_doc_id;`
}

// Побудувати recorder WHERE filter для validation SELECT DISTINCT
function buildRecorderFilter(
  doc: Document,
  stdAttrs: StandardAttribute[],
): string {
  const recorderAttr = stdAttrs.find((a) => a.name === 'recorder_id')
  const isPolymorphic = recorderAttr?.allowedTypes && recorderAttr.allowedTypes.length > 0

  if (isPolymorphic) {
    const docKindName = `${doc.kind}.${doc.name}`
    return `WHERE recorder_id_type = '${docKindName}' AND recorder_id_id = p_doc_id`
  }
  return 'WHERE recorder_id = p_doc_id'
}

// Побудувати StandardAttributeSettings для регістру
function buildRegisterSettings(register: RegisterDef): StandardAttributeSettings {
  const settings: StandardAttributeSettings = {
    recorderTypes: register.recorderTypes,
  }
  if (register.kind === 'AccumulationRegister') {
    settings.registerType = register.registerType
  }
  if (register.kind === 'InformationRegister') {
    settings.periodicity = register.periodicity
    settings.writeMode = register.writeMode
  }
  return settings
}

// Генерувати post function для документа
function generatePostFunction(
  doc: Document,
  prefix: string,
  schema: string,
  project: ProjectModel,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
): string {
  const posting = doc.posting as { movements: PostingMovement[]; validations: PostingValidation[] }
  const docSnake = toSnakeCase(doc.name)
  const docTable = qualifiedName(schema, tableName(prefix, "Document", doc.name))
  const funcName = qualifiedName(schema, `post_${docSnake}`)

  // Очистка попередніх рухів (дедупліковані за регістром)
  const uniqueDeleteRegs = new Map<string, { regTable: string; register: RegisterDef }>()
  for (const m of posting.movements) {
    const key = `${m.register.kind}.${m.register.name}`
    if (!uniqueDeleteRegs.has(key)) {
      const register = findRegister(project, m.register)
      if (register) {
        uniqueDeleteRegs.set(key, {
          regTable: qualifiedName(schema, tableName(prefix, register.kind as MetadataKind, m.register.name)),
          register,
        })
      }
    }
  }
  const deleteStatements = [...uniqueDeleteRegs.values()].map(({ regTable, register }) => {
    const settings = buildRegisterSettings(register)
    const stdAttrs = getStandardAttributes(register.kind, settings)
    return buildDeleteStatement(regTable, register, doc, stdAttrs)
  })

  // INSERT рухів
  const insertStatements = posting.movements.map((m) =>
    generateMovementInsert(m, doc, prefix, schema, project, resolveEnumType),
  )

  // Валідації — FOR loop по DISTINCT dimension combinations з регістру
  const validationStatements = posting.validations.map((v) => {
    const register = findRegister(project, v.register)
    if (!register) {
      throw new Error(
        `Register ${v.register.kind}/${v.register.name} not found for validation`,
      )
    }

    const regTable = qualifiedName(schema, tableName(prefix, register.kind as MetadataKind, register.name))
    const regSnake = toSnakeCase(register.name)
    const resource = toSnakeCase(v.resource)
    const checkFunc = qualifiedName(schema, `check_${regSnake}_${resource}`)

    // Резолвити фізичні імена dimension колонок
    if (v.dimensions.length === 0) {
      throw new Error(
        `Validation for ${register.name}.${v.resource} must have at least one dimension`,
      )
    }
    const resolvedDims = v.dimensions.map((d) => {
      const dim = register.dimensions.find((attr) => attr.name === d)
      if (dim) {
        const cols = resolveColumnName(dim, resolveEnumType)
        if (cols.length > 1) {
          throw new Error(
            `Polymorphic Ref dimension "${d}" in register "${register.name}" is not supported in validation`,
          )
        }
        return cols[0]
      }
      return toSnakeCase(d)
    })
    const dimSelect = resolvedDims.join(', ')
    const dimArgs = resolvedDims.map((c) => `v_rec.${c}`).join(', ')

    const settings = buildRegisterSettings(register)
    const stdAttrs = getStandardAttributes(register.kind, settings)
    const recorderFilter = buildRecorderFilter(doc, stdAttrs)

    // applyTo filter для Balance регістрів
    const isBalanceReg =
      register.kind === 'AccumulationRegister' && register.registerType === 'Balance'
    let applyToValidationFilter = ''
    if (isBalanceReg && v.applyTo !== 'Both') {
      applyToValidationFilter = `\n      AND movement_type = '${v.applyTo}'`
    }

    return (
      `  -- Перевірка NonNegativeBalance: ${register.name}.${v.resource}\n` +
      `  FOR v_rec IN (\n` +
      `    SELECT DISTINCT ${dimSelect}\n` +
      `    FROM ${regTable}\n` +
      `    ${recorderFilter}${applyToValidationFilter}\n` +
      `  )\n` +
      `  LOOP\n` +
      `    PERFORM ${checkFunc}(${dimArgs});\n` +
      `  END LOOP;`
    )
  })
  const hasValidations = validationStatements.length > 0

  return (
    `CREATE OR REPLACE FUNCTION ${funcName}(p_doc_id UUID)\n` +
    `RETURNS VOID\n` +
    `LANGUAGE plpgsql\n` +
    `AS $$\n` +
    `DECLARE\n` +
    `  d ${docTable}%ROWTYPE;\n` +
    (hasValidations ? `  v_rec RECORD;\n` : '') +
    `BEGIN\n` +
    `  -- Отримати документ\n` +
    `  SELECT * INTO STRICT d FROM ${docTable} WHERE id = p_doc_id;\n` +
    `\n` +
    `  -- Перевірка: вже проведений\n` +
    `  IF d.posted THEN\n` +
    `    RAISE EXCEPTION 'Document % is already posted', p_doc_id;\n` +
    `  END IF;\n` +
    `\n` +
    `  -- Очистка попередніх рухів\n` +
    (deleteStatements.length > 0 ? deleteStatements.join('\n') + '\n\n' : '') +
    `  -- Рухи\n` +
    (insertStatements.length > 0 ? insertStatements.join('\n\n') + '\n\n' : '') +
    (validationStatements.length > 0
      ? `  -- Валідації\n` + validationStatements.join('\n') + '\n\n'
      : '') +
    `  -- Оновити статус\n` +
    `  UPDATE ${docTable} SET posted = TRUE, updated_at = NOW() WHERE id = p_doc_id;\n` +
    `\n` +
    `  -- Точка розширення: виклик custom hook\n` +
    `  IF EXISTS (\n` +
    `    SELECT 1 FROM pg_proc p\n` +
    `    JOIN pg_namespace n ON p.pronamespace = n.oid\n` +
    `    WHERE p.proname = '${docSnake}_post_custom'\n` +
    `      AND n.nspname = '${escapeLiteral(schema)}'\n` +
    `  ) THEN\n` +
    `    EXECUTE format('SELECT ${schema}.%I($1)', '${docSnake}_post_custom') USING p_doc_id;\n` +
    `  END IF;\n` +
    `END;\n` +
    `$$;`
  )
}

// Генерувати unpost function для документа
function generateUnpostFunction(
  doc: Document,
  prefix: string,
  schema: string,
  project: ProjectModel,
): string {
  const posting = doc.posting as { movements: PostingMovement[] }
  const docSnake = toSnakeCase(doc.name)
  const docTable = qualifiedName(schema, tableName(prefix, "Document", doc.name))
  const funcName = qualifiedName(schema, `unpost_${docSnake}`)

  // Видалення рухів з кожного регістру
  const uniqueRegisters = new Map<string, { regTable: string; register: RegisterDef }>()
  for (const m of posting.movements) {
    const key = `${m.register.kind}.${m.register.name}`
    if (!uniqueRegisters.has(key)) {
      const register = findRegister(project, m.register)
      if (register) {
        uniqueRegisters.set(key, {
          regTable: qualifiedName(schema, tableName(prefix, register.kind as MetadataKind, m.register.name)),
          register,
        })
      }
    }
  }

  const deleteStatements = [...uniqueRegisters.values()].map(({ regTable, register }) => {
    const settings = buildRegisterSettings(register)
    const stdAttrs = getStandardAttributes(register.kind, settings)
    return buildDeleteStatement(regTable, register, doc, stdAttrs)
  })

  return (
    `CREATE OR REPLACE FUNCTION ${funcName}(p_doc_id UUID)\n` +
    `RETURNS VOID\n` +
    `LANGUAGE plpgsql\n` +
    `AS $$\n` +
    `BEGIN\n` +
    `  -- Видалити рухи\n` +
    (deleteStatements.length > 0 ? deleteStatements.join('\n') + '\n\n' : '') +
    `  -- Зняти позначку проведення\n` +
    `  UPDATE ${docTable} SET posted = FALSE, updated_at = NOW() WHERE id = p_doc_id;\n` +
    `END;\n` +
    `$$;`
  )
}

/**
 * Генерувати posting functions для всього проєкту.
 * Повертає масив SQL statements.
 */
export function generatePostingFunctions(
  project: ProjectModel,
  prefix: string,
  schema: string,
  resolveEnumType: (ref: { kind: string; name: string }) => string | undefined,
): string[] {
  const statements: string[] = []

  for (const doc of project.documents) {
    // Тільки документи з об'єктним posting та непорожніми movements
    if (
      typeof doc.posting !== 'object' ||
      doc.posting === null ||
      !('movements' in doc.posting) ||
      doc.posting.movements.length === 0
    ) {
      continue
    }

    const posting = doc.posting as { movements: PostingMovement[]; validations: PostingValidation[] }

    statements.push(generatePostFunction(doc, prefix, schema, project, resolveEnumType))
    statements.push(generateUnpostFunction(doc, prefix, schema, project))

    // Check functions для кожної валідації
    for (const v of posting.validations ?? []) {
      statements.push(generateCheckFunction(v, prefix, schema, project, resolveEnumType))
    }
  }

  return statements
}
