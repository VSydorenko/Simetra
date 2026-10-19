import type { Node } from "libpg-query"
import { PLATFORM_SCHEMA } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { statementTargets } from "./unit-target"
import type { RowRule, SqlSource, VerbatimUnit } from "./units"

/**
 * Резервування схеми платформи для `.sql` метаданих застосунку (спека
 * користувачів §3): одиниця, чий власний об'єкт (функція, в'юха, тригер чи
 * політика на таблиці, `ALTER` таблиці чи функції) або ціль гранту, коментаря,
 * publication, типових привілеїв лежить у `simetra`, і правило рядка на
 * таблиці `simetra` — `schema.reserved`, і далі в модель вони не йдуть.
 *
 * Це правило файлів застосунку, а не мови одиниць: `readSqlUnits` спільний зі
 * зворотним читанням двигуна, яке мусить класифікувати й розгорнутий шар
 * `simetra`, тож резервування стоїть на шляху компілятора після розбору.
 * Виклик функції платформи в тілі — не ціль: тіла тут не читаються.
 */
export function withoutPlatformSchema(
  read: { units: VerbatimUnit[]; rowRules: RowRule[] },
  sources: readonly SqlSource[]
): { units: VerbatimUnit[]; rowRules: RowRule[]; diagnostics: Diagnostic[] } {
  // Некваліфіковані цілі резолвляться у схему файлу, як під час розбору.
  const schemaOf = new Map(sources.map((s) => [s.file, s.schema]))
  const inPlatform = (unit: VerbatimUnit) =>
    unit.schema === PLATFORM_SCHEMA ||
    statementTargets(unit.tree as Node, schemaOf.get(unit.file) ?? "").some(
      (t) => t.schema === PLATFORM_SCHEMA
    )
  const reserved = [
    ...read.units.filter(inPlatform),
    ...read.rowRules.filter((rule) => rule.schema === PLATFORM_SCHEMA),
  ]
  const diagnostics = reserved.map((r) =>
    diagnostic("schema.reserved", r.file, "", { line: r.line })
  )
  const units = read.units.filter((unit) => !inPlatform(unit))
  const rowRules = read.rowRules.filter(
    (rule) => rule.schema !== PLATFORM_SCHEMA
  )
  return { units, rowRules, diagnostics }
}
