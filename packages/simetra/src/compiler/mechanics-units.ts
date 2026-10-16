import {
  PLATFORM_SCHEMA,
  makeObjectName,
  quoteIdent,
  serviceDateColumns,
  standardLogicalName,
  versionColumn,
  type AttributeCase,
  type DatabaseProvider,
  type PhysicalSnapshot,
} from "simetra/model"
import type { QualifiedName } from "./contracts"
import { compareStrings } from "./diagnostics"
import { dollarTag } from "./movement-functions"
import { executeGrants } from "./sql/execute-grants"
import type { SqlParser } from "./sql/parse"
import { generatedUnit, type SqlUnit } from "./sql/units"

/** Одна функція механіки на всі таблиці: тіло не залежить від таблиці. */
export const MECHANICS_FUNCTION: QualifiedName = {
  schema: PLATFORM_SCHEMA,
  name: "touch",
}

/**
 * Ім'я тригера механіки на таблиці. Алгоритм Postgres тримає мітку цілою, тож
 * зворотна генерація й промоція впізнають тригер за іменем і на довгій таблиці.
 */
export function mechanicsTriggerName(table: string): string {
  return makeObjectName(table, undefined, "simetra_touch")
}

/** Колонки механіки за реєстром — щоб тіло функції не тримало літералів. */
const UPDATED_AT = serviceDateColumns().find(
  (c) => c.logicalName === "updatedAt"
)!
const VERSION = versionColumn()

/**
 * Механіка рядка (спека промоції §9.2): службову дату оновлення й версію
 * рядка тримає база, а не клієнт — `UPDATE`, що пише їх сам, отримує `now()`
 * і `OLD.version + 1`. Таблиці беруться з фізичного знімка за
 * `origin.standard`, а не за видом: механіку має рівно та таблиця, якій
 * реєстр дав обидві колонки. `origin.standard` — логічне ім'я в стилі проєкту
 * (`attributeCase`), тож порівнюється зі стилізованим ім'ям реєстру. Функція
 * й її гранти — лише коли є хоч одна така таблиця; власника-об'єкта в них
 * немає, бо функція спільна.
 */
export function buildMechanicsUnits(
  physical: PhysicalSnapshot,
  attributeCase: AttributeCase,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  const mechanics = new Set(
    [UPDATED_AT, VERSION].map((def) => standardLogicalName(def, attributeCase))
  )
  const tables = physical.tables.filter((table) => {
    const found = table.columns.filter((c) =>
      mechanics.has(c.origin.standard ?? "")
    )
    if (found.length === 0) return false
    // Реєстр дає обидві колонки разом (Catalog, Document); одна без другої чи
    // інше фізичне ім'я зламали б спільне тіло функції — це дефект моделі.
    const names = found.map((c) => c.name).sort(compareStrings)
    const expected = [UPDATED_AT.physicalName, VERSION.physicalName].sort(
      compareStrings
    )
    if (names.join(",") !== expected.join(",")) {
      throw new Error(
        `internal: table ${table.schema}.${table.name} has mechanics columns ${names.join(", ")}, expected ${expected.join(", ")}`
      )
    }
    return true
  })
  if (tables.length === 0) return []
  const fn = `${quoteIdent(MECHANICS_FUNCTION.schema)}.${quoteIdent(MECHANICS_FUNCTION.name)}`
  const shared = (sql: string): SqlUnit => ({
    ...generatedUnit(sql, PLATFORM_SCHEMA, parse),
    module,
    generator: "mechanics",
  })
  // Тригер, що спрацьовує в ролі, яка пише, не потребує `EXECUTE` функції, тож
  // жодна роль API його не має (платформна спека §6.7).
  const units: SqlUnit[] = [
    shared(touchFunction(fn)),
    ...executeGrants(`${fn}()`, [], provider).map(shared),
    ...tables.map((table): SqlUnit => ({
      ...generatedUnit(
        `CREATE TRIGGER ${quoteIdent(mechanicsTriggerName(table.name))} BEFORE UPDATE ON ${quoteIdent(table.schema)}.${quoteIdent(table.name)} FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
        table.schema,
        parse
      ),
      ownerObjectId: table.origin.objectId,
      module,
      generator: "mechanics",
    })),
  ]
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * `SECURITY INVOKER`: присвоєння `NEW` прав на таблицю не потребує, тож
 * підвищувати роль нема чого. Порожній `search_path` — `now()` з
 * `pg_catalog` резолвиться завжди, а підміни імен через шлях немає.
 */
function touchFunction(fn: string): string {
  const text = [
    "BEGIN",
    `  NEW.${quoteIdent(UPDATED_AT.physicalName)} := now();`,
    `  NEW.${quoteIdent(VERSION.physicalName)} := OLD.${quoteIdent(VERSION.physicalName)} + 1;`,
    "  RETURN NEW;",
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
