import { makeObjectName } from "simetra/model"
import type { QualifiedName } from "../contracts"
import { generatedTableFunctionName } from "../rights/generated-names"

// Листовий модуль (як `platform/names.ts`): імена потрібні і генератору
// сховища, і реєстру платформних тригерів, а той не імпортує генератор.

/** Мітки тригерів сховища: вкладення, незмінність розміру й типу, облік. */
const LABELS = {
  attach: "simetra_storage_attach",
  immutable: "simetra_storage_immutable",
  usage: "simetra_storage_usage",
} as const

/**
 * Імена тригерів сховища на таблиці виду зі `storage` (спека профілю postgres
 * §8.1, §8.3): вкладення `BEFORE INSERT`, незмінність `BEFORE UPDATE OF
 * file_*`, облік `AFTER INSERT OR DELETE`. Алгоритм Postgres тримає мітку
 * цілою, тож довга таблиця не дає імені понад 63 байти.
 */
export function storageTriggerNames(table: QualifiedName): {
  attach: string
  immutable: string
  usage: string
} {
  return {
    attach: makeObjectName(table.name, undefined, LABELS.attach),
    immutable: makeObjectName(table.name, undefined, LABELS.immutable),
    usage: makeObjectName(table.name, undefined, LABELS.usage),
  }
}

/** Функції тригерів сховища: по одній на тригер, у схемі таблиці. */
export function storageTriggerFunctions(table: QualifiedName): {
  attach: QualifiedName
  immutable: QualifiedName
  usage: QualifiedName
} {
  const named = (label: string): QualifiedName => ({
    schema: table.schema,
    name: generatedTableFunctionName(table.name, label),
  })
  return {
    attach: named(LABELS.attach),
    immutable: named(LABELS.immutable),
    usage: named(LABELS.usage),
  }
}
