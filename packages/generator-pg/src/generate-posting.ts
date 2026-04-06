import type {
  Document,
  PostingMovement,
  PostingValidation,
  ProjectModel,
  AccumulationRegister,
  InformationRegister,
} from "@simetra/core"
import { toSnakeCase, tableName, tabularTableName, qualifiedName, escapeLiteral } from "./naming"
import { mapFieldType } from "./type-mapping"

// Об'єднаний тип регістру для posting
type RegisterDef = AccumulationRegister | InformationRegister

/**
 * Перетворити mapping expression у SQL вираз.
 * MVP — спрощена реалізація без lookup Ref полів.
 */
export function expressionToSql(
  expr: string,
  docAlias: string,
  tsAlias: string,
  docTableName: string,
  prefix: string,
  schema: string = 'public',
): string {
  // literal:value → екранований літерал або число
  if (expr.startsWith('literal:')) {
    const val = expr.slice('literal:'.length)
    if (/^-?\d+(\.\d+)?$/.test(val)) return val
    return `'${escapeLiteral(val)}'`
  }

  // now() → NOW()
  if (expr === 'now()') return 'NOW()'

  // sum(TsName.field) → підзапит
  const sumMatch = expr.match(/^sum\((\w+)\.(\w+)\)$/)
  if (sumMatch) {
    const [, tsName, field] = sumMatch
    const tsTbl = qualifiedName(schema, tabularTableName(prefix, docTableName, tsName))
    return `(SELECT COALESCE(SUM(${toSnakeCase(field)}), 0) FROM ${tsTbl} WHERE parent_id = ${docAlias}.id)`
  }

  // count(TsName) → підзапит
  const countMatch = expr.match(/^count\((\w+)\)$/)
  if (countMatch) {
    const [, tsName] = countMatch
    const tsTbl = qualifiedName(schema, tabularTableName(prefix, docTableName, tsName))
    return `(SELECT COUNT(*) FROM ${tsTbl} WHERE parent_id = ${docAlias}.id)`
  }

  // row.a * row.b → ts.a * ts.b (арифметика з row.*)
  if (expr.includes('row.')) {
    return expr.replace(/row\.(\w+)/g, (_, field) => `${tsAlias}.${toSnakeCase(field)}`)
  }

  // doc.field → d.field_name
  if (expr.startsWith('doc.')) {
    const field = expr.slice(4)
    return `${docAlias}.${toSnakeCase(field)}`
  }

  // fallback — повертаємо як є
  return expr
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

// Транслювати condition вираз у SQL з правильними аліасами
function translateCondition(
  condition: string,
  docAlias: string,
  tsAlias: string,
): string {
  return condition
    .replace(/\bdoc\.(\w+)/g, (_, field) => `${docAlias}.${toSnakeCase(field)}`)
    .replace(/\brow\.(\w+)/g, (_, field) => `${tsAlias}.${toSnakeCase(field)}`)
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

// Генерувати INSERT для одного руху
function generateMovementInsert(
  movement: PostingMovement,
  doc: Document,
  prefix: string,
  schema: string,
  project: ProjectModel,
): string {
  const register = findRegister(project, movement.register)
  if (!register) {
    return `  -- WARNING: register ${movement.register.kind}/${movement.register.name} not found`
  }

  const regTable = qualifiedName(schema, tableName(prefix, register.name))

  // Визначити movementType SQL
  const mvtTypeExpr = movement.movementType === 'Receipt' || movement.movementType === 'Expense'
    ? `'${movement.movementType}'`
    : expressionToSql(movement.movementType, 'd', 'ts', doc.name, prefix, schema)

  // Стовпці dimensions/resources/attributes
  const dimCols = Object.keys(movement.mappings.dimensions).map(toSnakeCase)
  const resCols = Object.keys(movement.mappings.resources).map(toSnakeCase)
  const attrCols = Object.keys(movement.mappings.attributes).map(toSnakeCase)

  const allCols = [
    'period', 'recorder_id', 'line_number', 'active', 'movement_type',
    ...dimCols, ...resCols, ...attrCols,
  ]

  // Expressions для кожного стовпця маппінгу
  const dimExprs = Object.values(movement.mappings.dimensions)
    .map((e) => expressionToSql(e, 'd', 'ts', doc.name, prefix, schema))
  const resExprs = Object.values(movement.mappings.resources)
    .map((e) => expressionToSql(e, 'd', 'ts', doc.name, prefix, schema))
  const attrExprs = Object.values(movement.mappings.attributes)
    .map((e) => expressionToSql(e, 'd', 'ts', doc.name, prefix, schema))

  // Транслювати condition у SQL з правильними аліасами
  const translatedCondition = movement.condition
    ? translateCondition(movement.condition, 'd', 'ts')
    : ''

  // tabularSection source → SELECT ... FROM tabular_table
  if (movement.source.startsWith('tabularSection:')) {
    const tsName = movement.source.slice('tabularSection:'.length)
    const tsTable = qualifiedName(schema, tabularTableName(prefix, doc.name, tsName))

    const condition = translatedCondition
      ? `\n  AND (${translatedCondition})`
      : ''

    const selectExprs = [
      '    d.date',
      '    d.id',
      '    ts.line_number',
      '    TRUE',
      `    ${mvtTypeExpr}`,
      ...dimExprs.map((e) => `    ${e}`),
      ...resExprs.map((e) => `    ${e}`),
      ...attrExprs.map((e) => `    ${e}`),
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

  // document source → VALUES (з optional IF для condition)
  const valueExprs = [
    'd.date',
    'd.id',
    '1',
    'TRUE',
    mvtTypeExpr,
    ...dimExprs,
    ...resExprs,
    ...attrExprs,
  ]

  const insertSql =
    `  INSERT INTO ${regTable} (\n` +
    `    ${allCols.join(', ')}\n` +
    `  )\n` +
    `  VALUES (\n` +
    `    ${valueExprs.join(', ')}\n` +
    `  );`

  // Якщо є condition — обгорнути в IF
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
): string {
  const register = findRegister(project, validation.register)
  if (!register) {
    return `-- WARNING: register ${validation.register.kind}/${validation.register.name} not found`
  }

  const regTable = qualifiedName(schema, tableName(prefix, register.name))
  const regSnake = toSnakeCase(register.name)
  const resource = toSnakeCase(validation.resource)
  const funcName = qualifiedName(schema, `check_${regSnake}_${resource}`)

  // Параметри — dimensions з правильними типами
  const params = validation.dimensions
    .map((d) => `p_${toSnakeCase(d)} ${resolveDimensionType(register, d)}`)
    .join(', ')

  // WHERE conditions для dimensions
  const dimConditions = validation.dimensions
    .map((d) => {
      const col = toSnakeCase(d)
      return `AND ${col} = p_${col}`
    })
    .join('\n    ')

  // Повідомлення помилки
  const msg = validation.message.en ?? validation.message.uk ?? 'Negative balance'

  return (
    `CREATE OR REPLACE FUNCTION ${funcName}(${params})\n` +
    `RETURNS VOID\n` +
    `LANGUAGE plpgsql\n` +
    `AS $$\n` +
    `DECLARE\n` +
    `  v_balance NUMERIC;\n` +
    `BEGIN\n` +
    `  SELECT COALESCE(SUM(\n` +
    `    CASE WHEN movement_type = 'Receipt' THEN ${resource} ELSE -${resource} END\n` +
    `  ), 0)\n` +
    `  INTO v_balance\n` +
    `  FROM ${regTable}\n` +
    `  WHERE active = TRUE\n` +
    `    ${dimConditions};\n` +
    `\n` +
    `  IF v_balance < 0 THEN\n` +
    `    RAISE EXCEPTION '${escapeLiteral(msg)}';\n` +
    `  END IF;\n` +
    `END;\n` +
    `$$;`
  )
}

// Генерувати post function для документа
function generatePostFunction(
  doc: Document,
  prefix: string,
  schema: string,
  project: ProjectModel,
): string {
  const posting = doc.posting as { movements: PostingMovement[]; validations: PostingValidation[] }
  const docSnake = toSnakeCase(doc.name)
  const docTable = qualifiedName(schema, tableName(prefix, doc.name))
  const funcName = qualifiedName(schema, `post_${docSnake}`)

  // Очистка попередніх рухів (дедупліковані за регістром)
  const uniqueDeleteRegs = new Map<string, string>()
  for (const m of posting.movements) {
    const key = `${m.register.kind}.${m.register.name}`
    if (!uniqueDeleteRegs.has(key)) {
      uniqueDeleteRegs.set(key, qualifiedName(schema, tableName(prefix, m.register.name)))
    }
  }
  const deleteStatements = [...uniqueDeleteRegs.values()].map(
    (regTable) => `  DELETE FROM ${regTable} WHERE recorder_id = p_doc_id;`,
  )

  // INSERT рухів
  const insertStatements = posting.movements.map((m) =>
    generateMovementInsert(m, doc, prefix, schema, project),
  )

  // Валідації — FOR loop по DISTINCT dimension combinations з регістру
  const validationStatements = posting.validations.map((v) => {
    const register = findRegister(project, v.register)
    if (!register) {
      return `  -- WARNING: register ${v.register.kind}/${v.register.name} not found for validation`
    }
    const regTable = qualifiedName(schema, tableName(prefix, register.name))
    const regSnake = toSnakeCase(register.name)
    const resource = toSnakeCase(v.resource)
    const checkFunc = qualifiedName(schema, `check_${regSnake}_${resource}`)
    const dimCols = v.dimensions.map((d) => toSnakeCase(d))
    const dimSelect = dimCols.join(', ')
    const dimArgs = dimCols.map((c) => `v_rec.${c}`).join(', ')

    return (
      `  -- Перевірка NonNegativeBalance: ${register.name}.${v.resource}\n` +
      `  FOR v_rec IN (\n` +
      `    SELECT DISTINCT ${dimSelect}\n` +
      `    FROM ${regTable}\n` +
      `    WHERE recorder_id = p_doc_id\n` +
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
): string {
  const posting = doc.posting as { movements: PostingMovement[] }
  const docSnake = toSnakeCase(doc.name)
  const docTable = qualifiedName(schema, tableName(prefix, doc.name))
  const funcName = qualifiedName(schema, `unpost_${docSnake}`)

  // Видалення рухів з кожного регістру
  const uniqueRegisters = new Map<string, string>()
  for (const m of posting.movements) {
    const key = `${m.register.kind}.${m.register.name}`
    if (!uniqueRegisters.has(key)) {
      uniqueRegisters.set(
        key,
        qualifiedName(schema, tableName(prefix, m.register.name)),
      )
    }
  }

  const deleteStatements = [...uniqueRegisters.values()].map(
    (regTable) => `  DELETE FROM ${regTable} WHERE recorder_id = p_doc_id;`,
  )

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

    statements.push(generatePostFunction(doc, prefix, schema, project))
    statements.push(generateUnpostFunction(doc, prefix, schema))

    // Check functions для кожної валідації
    for (const v of posting.validations ?? []) {
      statements.push(generateCheckFunction(v, prefix, schema, project))
    }
  }

  return statements
}
