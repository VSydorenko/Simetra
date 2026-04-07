import type { SchemaDiff } from './schema-diff'
import type { SchemaSnapshot, SnapshotColumn } from './schema-snapshot'
import { escapeLiteral } from './naming'

// ─── Форматування колонки з SnapshotColumn ───────────────────

function columnToSql(name: string, col: SnapshotColumn): string {
  const parts = [name, col.sqlType]
  if (col.primaryKey) parts.push('PRIMARY KEY')
  if (col.notNull) parts.push('NOT NULL')
  if (col.defaultExpr) parts.push(`DEFAULT ${col.defaultExpr}`)
  if (col.unique) parts.push('UNIQUE')
  if (col.references) parts.push(`REFERENCES ${col.references}`)
  if (col.check) parts.push(col.check)
  return parts.join(' ')
}

// ─── Генерація міграційного SQL ──────────────────────────────

export function generateMigrationSQL(
  diff: SchemaDiff,
  newSnapshot: SchemaSnapshot,
): string {
  const isEmpty =
    diff.addedTables.length === 0 &&
    diff.droppedTables.length === 0 &&
    diff.addedColumns.length === 0 &&
    diff.droppedColumns.length === 0 &&
    diff.modifiedColumns.length === 0 &&
    diff.addedEnums.length === 0 &&
    diff.droppedEnums.length === 0 &&
    diff.addedEnumValues.length === 0 &&
    diff.droppedEnumValues.length === 0 &&
    diff.addedIndexes.length === 0 &&
    diff.droppedIndexes.length === 0

  if (isEmpty) return ''

  const sections: string[] = []

  // ── Enum Changes ──────────────────────────────────────────
  const enumLines: string[] = []

  for (const name of diff.addedEnums) {
    const entry = newSnapshot.enums[name]
    if (!entry) continue
    if (entry.strategy === 'pgEnum') {
      const values = entry.values
        .map((v) => `  '${escapeLiteral(v)}'`)
        .join(',\n')
      enumLines.push(
        `CREATE TYPE ${name} AS ENUM (\n${values}\n);`,
      )
    } else {
      // lookupTable — таблиця буде створена в секції Added Tables
      // Тут генеруємо тільки INSERT-и
      const tbl = newSnapshot.tables[name]
      if (tbl) {
        const cols = Object.keys(tbl.columns)
        const colDefs = cols.map((c) => columnToSql(c, tbl.columns[c]))
        enumLines.push(
          `CREATE TABLE ${name} (\n` +
            colDefs.map((d) => `  ${d}`).join(',\n') +
            '\n);',
        )
      }
    }
  }

  for (const ev of diff.addedEnumValues) {
    const entry = newSnapshot.enums[ev.enumName]
    if (entry?.strategy === 'pgEnum') {
      for (const val of ev.values) {
        enumLines.push(
          `ALTER TYPE ${ev.enumName} ADD VALUE '${escapeLiteral(val)}';`,
        )
      }
    }
  }

  for (const name of diff.droppedEnums) {
    enumLines.push(`-- DESTRUCTIVE`)
    enumLines.push(`DROP TYPE IF EXISTS ${name};`)
  }

  for (const ev of diff.droppedEnumValues) {
    enumLines.push(
      `-- DESTRUCTIVE: Dropped values from ${ev.enumName}: ` +
        ev.values.join(', '),
    )
    // PG не підтримує DROP VALUE для enum — потрібна пересозда
    enumLines.push(
      `-- NOTE: PostgreSQL does not support DROP VALUE from enum.`,
    )
    enumLines.push(
      `-- Consider recreating the type or using a migration tool.`,
    )
  }

  if (enumLines.length > 0) {
    sections.push(
      '-- Migration: Enum Changes\n' + enumLines.join('\n'),
    )
  }

  // ── Added Tables ──────────────────────────────────────────
  const addedTableLines: string[] = []

  for (const tblName of diff.addedTables) {
    const tbl = newSnapshot.tables[tblName]
    if (!tbl) continue
    // Пропускаємо lookupTable enum — вже додано в enum секції
    if (newSnapshot.enums[tblName]?.strategy === 'lookupTable') continue

    const colDefs = Object.entries(tbl.columns).map(
      ([col, def]) => `  ${columnToSql(col, def)}`,
    )
    addedTableLines.push(
      `CREATE TABLE ${tblName} (\n${colDefs.join(',\n')}\n);`,
    )
  }

  if (addedTableLines.length > 0) {
    sections.push(
      '-- Migration: Added Tables\n' +
        addedTableLines.join('\n\n'),
    )
  }

  // ── Dropped Tables ────────────────────────────────────────
  const droppedTableLines: string[] = []

  for (const tblName of diff.droppedTables) {
    droppedTableLines.push(
      `DROP TABLE IF EXISTS ${tblName};`,
    )
  }

  if (droppedTableLines.length > 0) {
    sections.push(
      '-- Migration: Dropped Tables (DESTRUCTIVE)\n' +
        droppedTableLines.join('\n'),
    )
  }

  // ── Added Columns ─────────────────────────────────────────
  const addedColLines: string[] = []

  for (const c of diff.addedColumns) {
    addedColLines.push(
      `ALTER TABLE ${c.table} ADD COLUMN ` +
        `${columnToSql(c.column, c.def)};`,
    )
  }

  if (addedColLines.length > 0) {
    sections.push(
      '-- Migration: Added Columns\n' +
        addedColLines.join('\n'),
    )
  }

  // ── Dropped Columns ───────────────────────────────────────
  const droppedColLines: string[] = []

  for (const c of diff.droppedColumns) {
    droppedColLines.push(
      `ALTER TABLE ${c.table} DROP COLUMN ${c.column};`,
    )
  }

  if (droppedColLines.length > 0) {
    sections.push(
      '-- Migration: Dropped Columns (DESTRUCTIVE)\n' +
        droppedColLines.join('\n'),
    )
  }

  // ── Modified Columns ──────────────────────────────────────
  const modifiedLines: string[] = []
  const unsupportedWarnings: string[] = []

  for (const c of diff.modifiedColumns) {
    if (c.old.sqlType !== c.new.sqlType) {
      modifiedLines.push(
        `ALTER TABLE ${c.table} ALTER COLUMN ${c.column}` +
          ` TYPE ${c.new.sqlType};`,
      )
    }
    if (c.old.notNull !== c.new.notNull) {
      if (c.new.notNull) {
        modifiedLines.push(
          `ALTER TABLE ${c.table} ALTER COLUMN ${c.column}` +
            ` SET NOT NULL;`,
        )
      } else {
        modifiedLines.push(
          `ALTER TABLE ${c.table} ALTER COLUMN ${c.column}` +
            ` DROP NOT NULL;`,
        )
      }
    }
    if ((c.old.defaultExpr ?? '') !== (c.new.defaultExpr ?? '')) {
      if (c.new.defaultExpr) {
        modifiedLines.push(
          `ALTER TABLE ${c.table} ALTER COLUMN ${c.column}` +
            ` SET DEFAULT ${c.new.defaultExpr};`,
        )
      } else {
        modifiedLines.push(
          `ALTER TABLE ${c.table} ALTER COLUMN ${c.column}` +
            ` DROP DEFAULT;`,
        )
      }
    }
    // Зміни constraints, які ще не підтримуються міграцією
    if (c.old.unique !== c.new.unique) {
      unsupportedWarnings.push(
        `-- WARNING: UNIQUE constraint change on ${c.table}.${c.column} ` +
          `not auto-migrated. Apply manually.`,
      )
    }
    if ((c.old.references ?? '') !== (c.new.references ?? '')) {
      unsupportedWarnings.push(
        `-- WARNING: REFERENCES change on ${c.table}.${c.column} ` +
          `not auto-migrated. Apply manually.`,
      )
    }
    if ((c.old.check ?? '') !== (c.new.check ?? '')) {
      unsupportedWarnings.push(
        `-- WARNING: CHECK constraint change on ${c.table}.${c.column} ` +
          `not auto-migrated. Apply manually.`,
      )
    }
  }

  if (unsupportedWarnings.length > 0) {
    modifiedLines.push(...unsupportedWarnings)
  }

  if (modifiedLines.length > 0) {
    sections.push(
      '-- Migration: Modified Columns\n' +
        modifiedLines.join('\n'),
    )
  }

  // ── Index Changes ─────────────────────────────────────────
  const indexLines: string[] = []

  for (const idxName of diff.addedIndexes) {
    const idx = newSnapshot.indexes[idxName]
    if (!idx) continue
    const prefix = idx.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX'
    const cols = idx.columns.join(', ')
    indexLines.push(
      `${prefix} ${idxName} ON ${idx.table} (${cols});`,
    )
  }

  for (const idxName of diff.droppedIndexes) {
    indexLines.push(`DROP INDEX IF EXISTS ${idxName};`)
  }

  if (indexLines.length > 0) {
    sections.push(
      '-- Migration: Index Changes\n' + indexLines.join('\n'),
    )
  }

  return sections.join('\n\n')
}
