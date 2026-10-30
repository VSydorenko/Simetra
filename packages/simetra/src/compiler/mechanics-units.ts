import {
  PLATFORM_SCHEMA,
  authorColumns,
  quoteIdent,
  serviceDateColumns,
  standardLogicalName,
  versionColumn,
  type AttributeCase,
  type DatabaseProvider,
  type PhysicalColumn,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import { platformBeforeTriggerName } from "./before-trigger-names"
import type { QualifiedName } from "./contracts"
import { compareStrings } from "./diagnostics"
import { dollarTag } from "./movement-functions"
import { carrierCopies } from "./rights/carrier-units"
import { executeGrants } from "./sql/execute-grants"
import type { SqlParser } from "./sql/parse"
import { generatedUnit, type SqlUnit } from "./sql/units"

/** Одна функція механіки на всі таблиці: тіло не залежить від таблиці. */
export const MECHANICS_FUNCTION: QualifiedName = {
  schema: PLATFORM_SCHEMA,
  name: "touch",
}

/**
 * Ім'я тригера механіки на таблиці. Спільний префікс рядкових `BEFORE`-тригерів
 * ставить механіку останньою на будь-якій довжині назви, а зворотна генерація
 * й промоція впізнають тригер за тим самим іменем.
 */
export function mechanicsTriggerName(table: string): string {
  return platformBeforeTriggerName(table, "simetra_touch")
}

/**
 * Ім'я тригера механіки на `UPDATE` таблиці з копіями носіїв: там механіка
 * розділена на вставку й оновлення з умовою `contentChangeCondition`.
 */
export function mechanicsUpdateTriggerName(table: string): string {
  return platformBeforeTriggerName(table, "simetra_touch_update")
}

/** Колонки механіки за реєстром — щоб тіло функції не тримало літералів. */
const UPDATED_AT = serviceDateColumns().find(
  (c) => c.logicalName === "updatedAt"
)!
const VERSION = versionColumn()

/**
 * Логічні імена колонок механіки в стилі проєкту — так їх несе
 * `origin.standard` фізичного знімка.
 */
export function mechanicsStandardNames(
  attributeCase: AttributeCase
): ReadonlySet<string> {
  return new Set(
    [UPDATED_AT, VERSION].map((def) => standardLogicalName(def, attributeCase))
  )
}

/**
 * Логічні імена колонок авторства в стилі проєкту (спека П4 §6.8). Авторство —
 * механіка: під контекстом команди його примушує тригер авторства, тож ні
 * обробник `beforeWrite`, ні шапка дії, ні `whenChanged` його не задають.
 */
export function authorStandardNames(
  attributeCase: AttributeCase
): ReadonlySet<string> {
  return new Set(
    authorColumns().map((def) => standardLogicalName(def, attributeCase))
  )
}

/** Колонки, які пише платформа, а не зміст рядка: механіка й авторство. */
export function nonContentStandardNames(
  attributeCase: AttributeCase
): ReadonlySet<string> {
  return new Set([
    ...mechanicsStandardNames(attributeCase),
    ...authorStandardNames(attributeCase),
  ])
}

/** Колонки авторства таблиці — за `origin.standard`, у порядку таблиці. */
export function authorTableColumns(
  table: Pick<PhysicalTable, "columns">,
  attributeCase: AttributeCase
): PhysicalColumn[] {
  const author = authorStandardNames(attributeCase)
  return table.columns.filter((c) => author.has(c.origin.standard ?? ""))
}

/**
 * Змістові колонки таблиці (спека прав §5.3, спека П4 §6.8): поза механікою, авторством,
 * копіями й генерованими. Механіку й авторство примушує платформа, копії
 * пише лише вона, а генерована колонка випливає зі змістових (і умова
 * `BEFORE`-тригера не може посилатися на її `NEW`). Одне джерело для умови
 * `contentChangeCondition` і порівнянь тригера ефектів.
 */
export function contentColumns(
  table: Pick<PhysicalTable, "columns">,
  attributeCase: AttributeCase
): PhysicalColumn[] {
  const platform = nonContentStandardNames(attributeCase)
  return table.columns.filter(
    (c) =>
      c.origin.copyOf === undefined &&
      c.generated === undefined &&
      !platform.has(c.origin.standard ?? "")
  )
}

/**
 * Умова «змінився зміст рядка» таблиці з копіями носіїв (спека прав §5.2):
 * `(<зміст змінився>) OR NOT (<копії змінилися>)`. Поширення копій
 * платформою — не зміна змісту: воно пише лише копії, тож придушується, а
 * звичайне перезбереження без змін (нічого не змінилося) поводиться, як на
 * будь-якій таблиці. Умова `BEFORE`-тригера рахується з `NEW` після
 * попередніх тригерів, але поширення пише лише копії за будь-якого порядку
 * тригерів, тож результат від порядку імен не залежить. Зміст —
 * `contentColumns`. Таблиця без копій умови не має.
 *
 * `watched` (спека П4 §6.8) — колонки поза змістом, зміна яких теж має спрацювати:
 * авторство для тригерів механіки, авторства й ефектів. Копія носія може
 * виводитися з `createdBy`, тож зміна лише `created_by_id` змінює й копію, і
 * без `watched` умова була б хибною: ефекти не відмовили б незмінному
 * автору, а механіка не підвищила б версію. Підписки `watched` не беруть.
 */
export function contentChangeCondition(
  table: Pick<PhysicalTable, "columns">,
  attributeCase: AttributeCase,
  watched: readonly PhysicalColumn[] = []
): string | undefined {
  const copies = carrierCopies(table)
  if (copies.length === 0) return undefined
  const changed = (columns: readonly { name: string }[]) =>
    columns
      .map(
        (c) =>
          `(OLD.${quoteIdent(c.name)} IS DISTINCT FROM NEW.${quoteIdent(c.name)})`
      )
      .join(" OR ")
  const content = changed(contentColumns(table, attributeCase))
  return watched.length === 0
    ? `(${content}) OR NOT (${changed(copies)})`
    : `((${content}) OR (${changed(watched)})) OR NOT (${changed(copies)})`
}

/**
 * Механіка рядка (спека промоції §9.2): службову дату оновлення й версію
 * рядка тримає база, а не клієнт: вставка дає версію 1, оновлення —
 * `OLD.version + 1`, обидва — `now()`, що б не записав клієнт. Таблиці
 * беруться з фізичного знімка за `origin.standard`, а не за видом: механіку має рівно та таблиця, якій
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
  const mechanics = mechanicsStandardNames(attributeCase)
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
  const trigger = (
    table: PhysicalSnapshot["tables"][number],
    name: string,
    events: string,
    when?: string
  ): SqlUnit => ({
    ...generatedUnit(
      `CREATE TRIGGER ${quoteIdent(name)} BEFORE ${events} ON ${quoteIdent(table.schema)}.${quoteIdent(table.name)} FOR EACH ROW ` +
        (when === undefined ? "" : `WHEN (${when}) `) +
        `EXECUTE FUNCTION ${fn}();`,
      table.schema,
      parse
    ),
    ownerObjectId: table.origin.objectId,
    module,
    generator: "mechanics",
  })
  // Тригер, що спрацьовує в ролі, яка пише, не потребує `EXECUTE` функції, тож
  // жодна роль API його не має (платформна спека §6.7).
  const units: SqlUnit[] = [
    shared(touchFunction(fn)),
    ...executeGrants(`${fn}()`, [], provider).map(shared),
    ...tables.flatMap((table): SqlUnit[] => {
      // Поширення копій носіїв не підвищує версію (спека прав §5.2): оновлення —
      // окремим тригером з умовою, бо на вставці `OLD` немає. Зміна автора —
      // зміна рядка: мігратор поза командою теж підвищує версію (спека П4 §6.8).
      const content = contentChangeCondition(
        table,
        attributeCase,
        authorTableColumns(table, attributeCase)
      )
      return content === undefined
        ? [trigger(table, mechanicsTriggerName(table.name), "INSERT OR UPDATE")]
        : [
            trigger(table, mechanicsTriggerName(table.name), "INSERT"),
            trigger(
              table,
              mechanicsUpdateTriggerName(table.name),
              "UPDATE",
              content
            ),
          ]
    }),
  ]
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * Вставка починає версію з 1, оновлення додає 1; службова дата — `now()` в
 * обох. Значення клієнта не діє ні там, ні там: інакше вставка могла б
 * почати з чужої версії. `created_at` тригер не чіпає. `SECURITY INVOKER`:
 * присвоєння `NEW` прав на таблицю не потребує, тож підвищувати роль нема
 * чого. Порожній `search_path` — `now()` з `pg_catalog` резолвиться завжди,
 * а підміни імен через шлях немає.
 */
function touchFunction(fn: string): string {
  const updatedAt = `NEW.${quoteIdent(UPDATED_AT.physicalName)}`
  const version = quoteIdent(VERSION.physicalName)
  const text = [
    "BEGIN",
    "  IF TG_OP = 'INSERT' THEN",
    `    NEW.${version} := 1;`,
    "  ELSE",
    `    NEW.${version} := OLD.${version} + 1;`,
    "  END IF;",
    `  ${updatedAt} := now();`,
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
