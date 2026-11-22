import {
  PLATFORM_SCHEMA,
  STORAGE_TABLES,
  makeObjectName,
  type PhysicalTable,
} from "simetra/model"
import { compareStrings } from "../diagnostics"
import type { ParsedObject } from "../stages/files"

// Листовий модуль (як `outbox.ts` для таблиці): його імпортує `stages/model`,
// а генератор сховища тягне функції прав — разом вони дали б цикл імпортів.

/** Чи має об'єкт `storage` у метаданих: довідник з полем (Р9). */
export function storageOf(
  object: ParsedObject
): { maxBytes: number; mediaTypes: string[] } | undefined {
  if (object.kind !== "Catalog") return undefined
  return (
    object.data as {
      storage?: { maxBytes: number; mediaTypes: string[] }
    }
  ).storage
}

/** Чи є в моделі хоч один об'єкт зі `storage`: від цього залежать таблиці й функції сховища. */
export function hasStorageObjects(objects: readonly ParsedObject[]): boolean {
  return objects.some((object) => storageOf(object) !== undefined)
}

const table = (
  name: string,
  parts: Pick<PhysicalTable, "columns" | "primaryKey" | "checks">
): PhysicalTable => ({
  schema: PLATFORM_SCHEMA,
  name,
  origin: { part: "storage" },
  // Без `FORCE`, як outbox: власник (definer-функції) політик не потребує, а
  // ролям API й команд грантів на таблиці немає зовсім
  rowLevelSecurity: "enabled",
  uniques: [],
  foreignKeys: [],
  indexes: [],
  ...parts,
})

const pkey = (name: string, columns: string[]) => ({
  name: makeObjectName(name, undefined, "pkey"),
  columns,
})
const check = (name: string, label: string, expression: string) => ({
  name: makeObjectName(name, label, "check"),
  expression,
})
const column = (
  name: string,
  type: string,
  extra: { default?: string } = {}
) => ({ name, type, notNull: true, origin: {}, ...extra })

/**
 * Таблиці обліку, межі й запису вкладення (спека профілю postgres §8.1, §8.3) —
 * лише коли є об'єкт зі `storage`. Грантів ролям API й команд немає: їх
 * читають і пишуть definer-функції власника.
 */
export function storageTables(
  objects: readonly ParsedObject[]
): PhysicalTable[] {
  if (!hasStorageObjects(objects)) return []
  const usage = STORAGE_TABLES.usage.name
  const quota = STORAGE_TABLES.quota.name
  const pending = STORAGE_TABLES.pending.name
  return [
    table(usage, {
      columns: [
        column("scope_kind", "uuid"),
        column("scope", "uuid"),
        column("bytes", "bigint"),
      ],
      primaryKey: pkey(usage, ["scope_kind", "scope"]),
      checks: [check(usage, "bytes", "bytes >= 0")],
    }),
    table(quota, {
      columns: [
        column("scope_kind", "uuid"),
        column("scope", "uuid"),
        column("max_bytes", "bigint"),
      ],
      primaryKey: pkey(quota, ["scope_kind", "scope"]),
      checks: [check(quota, "max_bytes", "max_bytes >= 0")],
    }),
    table(pending, {
      columns: [
        column("xact", "xid8"),
        column("object", "uuid"),
        column("id", "uuid"),
        column("size", "bigint"),
        column("content_type", "text"),
      ],
      primaryKey: pkey(pending, ["xact", "object", "id"]),
      checks: [check(pending, "size", "size >= 0")],
    }),
  ].sort((a, b) => compareStrings(a.name, b.name))
}
