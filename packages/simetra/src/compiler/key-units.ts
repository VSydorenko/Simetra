import {
  PLATFORM_SCHEMA,
  keyColumn,
  quoteIdent,
  type AttributeCase,
  type DatabaseProvider,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import { platformBeforeTriggerName } from "./before-trigger-names"
import type { QualifiedName } from "./contracts"
import { compareStrings } from "./diagnostics"
import { dollarTag } from "./movement-functions"
import { generatedTableFunctionName } from "./rights/generated-names"
import { executeGrants } from "./sql/execute-grants"
import type { SqlParser } from "./sql/parse"
import { generatedUnit, type SqlUnit } from "./sql/units"
import { sqlLiteral } from "./stages/model"
import { findStandardColumn } from "./standard-column"

/** Одна функція незмінності ключа на проєкт: тіло не залежить від таблиці. */
export const KEY_FUNCTION: QualifiedName = {
  schema: PLATFORM_SCHEMA,
  name: "key_immutable",
}

/**
 * Імена тригерів незмінності ключа на таблиці. `before` — рядковий
 * `BEFORE`, тож іде спільним префіксом групи (порядок спрацювання за
 * іменем); `after` з рядковими `BEFORE` не перемежовується й має ім'я
 * згенерованої функції таблиці. Генератор, зворотна генерація й промоція
 * впізнають тригери за тими самими іменами.
 */
export function keyTriggerNames(table: string): {
  before: string
  after: string
} {
  return {
    before: platformBeforeTriggerName(table, "simetra_key"),
    after: generatedTableFunctionName(table, "simetra_key_after"),
  }
}

/**
 * Колонка ключа `ref` таблиці за походженням — основні таблиці довідників і
 * документів та рядки ТЧ. Регістри й константи ключа `ref` не мають, а
 * колонки `CustomTable` і службових таблиць `simetra` — не стандартні.
 */
function keyColumnOf(
  table: Pick<PhysicalTable, "columns">,
  attributeCase: AttributeCase
): string | undefined {
  return findStandardColumn(table, keyColumn(false), attributeCase)?.name
}

/**
 * Незмінність ключа таблиці виду (спека прав §7): зміна `id` — інша
 * ідентичність рядка, а законного шляху, що її змінює, немає — рушій і засів
 * ключ лише вставляють, а крок даних промоції, що писав би ключ, відхиляється
 * з причиною `fillTarget`. Тому генератор — для кожного проєкту, незалежно
 * від прав: незмінність ключа не залежить від того, чи є в проєкті команди.
 *
 * Запис даних промоції (`writeData` у `schema/apply/execute.ts`) на час
 * кроків даних вимикає всі невнутрішні ввімкнені тригери таблиці
 * (`readUserTriggers`), ці тригери ключа теж. Ідентичність рядка там тримає
 * не тригер, а план: крок даних, що писав би ключ, відхиляється з причиною
 * `fillTarget`, тож оператор запису ключа не містить.
 *
 * Два тригери на одну функцію. `BEFORE` відмовляє до перевірки унікального
 * індексу: PK не відкладений і перевіряється на кожному рядку, тож обмін
 * ключів двох рядків одним `UPDATE` без нього дав би `23505`, а не названу
 * відмову. `AFTER` бачить рядок після всіх `BEFORE`-тригерів, зокрема
 * обробника `beforeWrite`, що сортується після `simetra_key` і переписує
 * `NEW.id`. Обидва — без `OF`: тригер, що змінює ключ, не згадує його в
 * `SET`. Без винятку режиму обслуговування.
 */
export function buildKeyUnits(
  physical: PhysicalSnapshot,
  attributeCase: AttributeCase,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  const tables = physical.tables.flatMap((table) => {
    const key = keyColumnOf(table, attributeCase)
    return key === undefined ? [] : [{ table, key }]
  })
  if (tables.length === 0) return []
  const fn = `${quoteIdent(KEY_FUNCTION.schema)}.${quoteIdent(KEY_FUNCTION.name)}`
  const shared = (sql: string): SqlUnit => ({
    ...generatedUnit(sql, PLATFORM_SCHEMA, parse),
    module,
    generator: "key",
  })
  const trigger = (
    table: PhysicalTable,
    name: string,
    timing: "BEFORE" | "AFTER",
    key: string
  ): SqlUnit => ({
    ...generatedUnit(
      `CREATE TRIGGER ${quoteIdent(name)} ${timing} UPDATE ON ${quoteIdent(table.schema)}.${quoteIdent(table.name)} FOR EACH ROW WHEN (NEW.${quoteIdent(key)} IS DISTINCT FROM OLD.${quoteIdent(key)}) EXECUTE FUNCTION ${fn}(${sqlLiteral(key)});`,
      table.schema,
      parse
    ),
    ownerObjectId: table.origin.objectId,
    module,
    generator: "key",
  })
  // Тригер, що спрацьовує в ролі, яка пише, не потребує `EXECUTE` функції,
  // тож право не має ніхто (платформна спека §6.7).
  const units: SqlUnit[] = [
    shared(keyFunction(fn)),
    ...executeGrants(`${fn}()`, [], provider).map(shared),
    ...tables.flatMap(({ table, key }) => {
      const names = keyTriggerNames(table.name)
      return [
        trigger(table, names.before, "BEFORE", key),
        trigger(table, names.after, "AFTER", key),
      ]
    }),
  ]
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * Відмова тієї самої форми, що в тригера ефектів (`effect` з колонкою), тож
 * клієнт розбирає її однаково під командою й поза нею. `SECURITY INVOKER`:
 * функція таблиць не читає, підвищувати роль нема чого; порожній
 * `search_path` — підміни імен через шлях немає. Ім'я колонки — аргумент
 * тригера: одна функція на всі таблиці.
 */
function keyFunction(fn: string): string {
  const text = [
    "BEGIN",
    "  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'command.forbidden', DETAIL = 'effect', TABLE = TG_TABLE_NAME, COLUMN = TG_ARGV[0];",
    "  RETURN NULL;",
    "END",
  ].join("\n")
  const tag = dollarTag(text)
  return (
    `CREATE OR REPLACE FUNCTION ${fn}()\n` +
    `RETURNS trigger\n` +
    `LANGUAGE plpgsql SECURITY INVOKER\n` +
    `SET search_path = ''\n` +
    `AS ${tag}\n${text}\n${tag};`
  )
}
