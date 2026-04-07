import type {
  SchemaSnapshot,
  SnapshotColumn,
} from './schema-snapshot'

// ─── Типи diff-у ────────────────────────────────────────────

export interface ColumnChange {
  table: string
  column: string
  old: SnapshotColumn
  new: SnapshotColumn
}

export interface SchemaDiff {
  addedTables: string[]
  droppedTables: string[]
  addedColumns: { table: string; column: string; def: SnapshotColumn }[]
  droppedColumns: { table: string; column: string; def: SnapshotColumn }[]
  modifiedColumns: ColumnChange[]
  addedEnums: string[]
  droppedEnums: string[]
  addedEnumValues: { enumName: string; values: string[] }[]
  droppedEnumValues: { enumName: string; values: string[] }[]
  addedIndexes: string[]
  droppedIndexes: string[]
  hasDestructiveChanges: boolean
}

// ─── Порівняння колонок ──────────────────────────────────────

function columnsEqual(a: SnapshotColumn, b: SnapshotColumn): boolean {
  return (
    a.sqlType === b.sqlType &&
    a.notNull === b.notNull &&
    a.unique === b.unique &&
    a.primaryKey === b.primaryKey &&
    (a.defaultExpr ?? '') === (b.defaultExpr ?? '') &&
    (a.references ?? '') === (b.references ?? '') &&
    (a.check ?? '') === (b.check ?? '')
  )
}

// ─── Обчислення diff ─────────────────────────────────────────

export function computeDiff(
  oldSnapshot: SchemaSnapshot,
  newSnapshot: SchemaSnapshot,
): SchemaDiff {
  const addedTables: string[] = []
  const droppedTables: string[] = []
  const addedColumns: SchemaDiff['addedColumns'] = []
  const droppedColumns: SchemaDiff['droppedColumns'] = []
  const modifiedColumns: ColumnChange[] = []
  const addedEnums: string[] = []
  const droppedEnums: string[] = []
  const addedEnumValues: SchemaDiff['addedEnumValues'] = []
  const droppedEnumValues: SchemaDiff['droppedEnumValues'] = []
  const addedIndexes: string[] = []
  const droppedIndexes: string[] = []

  // Таблиці
  const oldTableKeys = new Set(Object.keys(oldSnapshot.tables))
  const newTableKeys = new Set(Object.keys(newSnapshot.tables))

  for (const key of newTableKeys) {
    if (!oldTableKeys.has(key)) addedTables.push(key)
  }
  for (const key of oldTableKeys) {
    if (!newTableKeys.has(key)) droppedTables.push(key)
  }

  // Колонки в таблицях, що існують в обох снапшотах
  for (const tbl of newTableKeys) {
    if (!oldTableKeys.has(tbl)) continue
    const oldCols = oldSnapshot.tables[tbl].columns
    const newCols = newSnapshot.tables[tbl].columns
    const oldColKeys = new Set(Object.keys(oldCols))
    const newColKeys = new Set(Object.keys(newCols))

    for (const col of newColKeys) {
      if (!oldColKeys.has(col)) {
        addedColumns.push({ table: tbl, column: col, def: newCols[col] })
      }
    }
    for (const col of oldColKeys) {
      if (!newColKeys.has(col)) {
        droppedColumns.push({ table: tbl, column: col, def: oldCols[col] })
      }
    }
    for (const col of newColKeys) {
      if (!oldColKeys.has(col)) continue
      if (!columnsEqual(oldCols[col], newCols[col])) {
        modifiedColumns.push({
          table: tbl,
          column: col,
          old: oldCols[col],
          new: newCols[col],
        })
      }
    }
  }

  // Enums
  const oldEnumKeys = new Set(Object.keys(oldSnapshot.enums))
  const newEnumKeys = new Set(Object.keys(newSnapshot.enums))

  for (const key of newEnumKeys) {
    if (!oldEnumKeys.has(key)) addedEnums.push(key)
  }
  for (const key of oldEnumKeys) {
    if (!newEnumKeys.has(key)) droppedEnums.push(key)
  }

  // Значення enum-ів, що існують в обох
  for (const key of newEnumKeys) {
    if (!oldEnumKeys.has(key)) continue
    const oldVals = new Set(oldSnapshot.enums[key].values)
    const newVals = new Set(newSnapshot.enums[key].values)

    const added = newSnapshot.enums[key].values.filter(
      (v) => !oldVals.has(v),
    )
    const dropped = oldSnapshot.enums[key].values.filter(
      (v) => !newVals.has(v),
    )

    if (added.length > 0) {
      addedEnumValues.push({ enumName: key, values: added })
    }
    if (dropped.length > 0) {
      droppedEnumValues.push({ enumName: key, values: dropped })
    }
  }

  // Індекси
  const oldIdxKeys = new Set(Object.keys(oldSnapshot.indexes))
  const newIdxKeys = new Set(Object.keys(newSnapshot.indexes))

  for (const key of newIdxKeys) {
    if (!oldIdxKeys.has(key)) addedIndexes.push(key)
  }
  for (const key of oldIdxKeys) {
    if (!newIdxKeys.has(key)) droppedIndexes.push(key)
  }

  const hasDestructiveChanges =
    droppedTables.length > 0 ||
    droppedColumns.length > 0 ||
    droppedEnums.length > 0 ||
    droppedEnumValues.length > 0

  return {
    addedTables,
    droppedTables,
    addedColumns,
    droppedColumns,
    modifiedColumns,
    addedEnums,
    droppedEnums,
    addedEnumValues,
    droppedEnumValues,
    addedIndexes,
    droppedIndexes,
    hasDestructiveChanges,
  }
}

// ─── Перевірка деструктивних змін ────────────────────────────

export function isDestructiveChange(diff: SchemaDiff): boolean {
  return diff.hasDestructiveChanges
}

// ─── Форматований підсумок ───────────────────────────────────

export function formatDiffSummary(diff: SchemaDiff): string[] {
  const lines: string[] = []

  for (const t of diff.addedTables) {
    lines.push(`+ Table ${t}`)
  }
  for (const t of diff.droppedTables) {
    lines.push(`[DESTRUCTIVE] - Table ${t}`)
  }
  for (const c of diff.addedColumns) {
    lines.push(`+ Column ${c.table}.${c.column} (${c.def.sqlType})`)
  }
  for (const c of diff.droppedColumns) {
    lines.push(
      `[DESTRUCTIVE] - Column ${c.table}.${c.column} (${c.def.sqlType})`,
    )
  }
  for (const c of diff.modifiedColumns) {
    const changes: string[] = []
    if (c.old.sqlType !== c.new.sqlType) {
      changes.push(`type: ${c.old.sqlType} → ${c.new.sqlType}`)
    }
    if (c.old.notNull !== c.new.notNull) {
      changes.push(c.new.notNull ? 'add NOT NULL' : 'drop NOT NULL')
    }
    if (c.old.unique !== c.new.unique) {
      changes.push(c.new.unique ? 'add UNIQUE' : 'drop UNIQUE')
    }
    if ((c.old.defaultExpr ?? '') !== (c.new.defaultExpr ?? '')) {
      changes.push(
        `default: ${c.old.defaultExpr ?? 'none'} → ${c.new.defaultExpr ?? 'none'}`,
      )
    }
    lines.push(
      `~ Column ${c.table}.${c.column}: ${changes.join(', ')}`,
    )
  }
  for (const e of diff.addedEnums) {
    lines.push(`+ Enum ${e}`)
  }
  for (const e of diff.droppedEnums) {
    lines.push(`[DESTRUCTIVE] - Enum ${e}`)
  }
  for (const e of diff.addedEnumValues) {
    lines.push(
      `+ Enum ${e.enumName}: add values ${e.values.join(', ')}`,
    )
  }
  for (const e of diff.droppedEnumValues) {
    lines.push(
      `[DESTRUCTIVE] - Enum ${e.enumName}: drop values ${e.values.join(', ')}`,
    )
  }
  for (const i of diff.addedIndexes) {
    lines.push(`+ Index ${i}`)
  }
  for (const i of diff.droppedIndexes) {
    lines.push(`- Index ${i}`)
  }

  return lines
}
