import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { SchemaSnapshot } from '@simetra/generator-pg'

// Шлях до snapshot файлу відносно metadata директорії
const SNAPSHOT_DIR = '.simetra'
const SNAPSHOT_FILE = 'applied-schema.json'

// Отримати повний шлях до snapshot
export function snapshotPath(metadataDir: string): string {
  return join(metadataDir, SNAPSHOT_DIR, SNAPSHOT_FILE)
}

// Перевірити наявність snapshot
export function snapshotExists(metadataDir: string): boolean {
  return existsSync(snapshotPath(metadataDir))
}

// Прочитати snapshot з файлу. Кидає помилку якщо файл пошкоджений або невідомої версії.
export function readSnapshot(metadataDir: string): SchemaSnapshot | null {
  const filePath = snapshotPath(metadataDir)
  if (!existsSync(filePath)) return null

  const content = readFileSync(filePath, 'utf-8')
  const data = JSON.parse(content) as SchemaSnapshot
  if (data.version !== 1) {
    throw new Error(
      `Невідома версія snapshot (${data.version}). Видаліть ${filePath} або оновіть CLI.`,
    )
  }
  if (!data.tables || !data.enums) {
    throw new Error(`Пошкоджений snapshot: відсутні обов'язкові поля. Видаліть ${filePath}.`)
  }
  return data
}

// Зберегти snapshot у файл
export function writeSnapshot(
  metadataDir: string,
  snapshot: SchemaSnapshot,
): void {
  const filePath = snapshotPath(metadataDir)
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8')
}
