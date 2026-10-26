import { makeObjectName } from "simetra/model"
import type { QualifiedName } from "../contracts"
import { generatedTableFunctionName } from "./generated-names"

// Листовий модуль (як `platform/names.ts`): імена потрібні й контрактам, і
// генератору ефектів, і промоції; тип контрактів — лише як тип, тож
// виконуваного циклу `contracts` → генератор немає.

/** Мітки імен тригерів ефектів — алгоритм імен Postgres від таблиці. */
const ALL_LABEL = "simetra_effects"
const UPDATE_LABEL = "simetra_effects_update"

/**
 * Імена тригерів ефектів на таблиці (Р2b1-8): `all` — на всі події (на
 * таблиці з копіями — на вставку й видалення), `update` — оновлення таблиці з
 * копіями. Алгоритм Postgres тримає мітку цілою, тож довга таблиця не дає
 * імені понад 63 байти, яке Postgres мовчки обрізав би.
 */
export function effectsTriggerNames(table: QualifiedName): {
  all: string
  update: string
} {
  return {
    all: makeObjectName(table.name, undefined, ALL_LABEL),
    update: makeObjectName(table.name, undefined, UPDATE_LABEL),
  }
}

/** Функція ефектів у схемі таблиці — одна для обох її тригерів. */
export function effectsFunctionName(table: QualifiedName): QualifiedName {
  return {
    schema: table.schema,
    name: generatedTableFunctionName(table.name, ALL_LABEL),
  }
}
