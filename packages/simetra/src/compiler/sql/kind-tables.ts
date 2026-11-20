import {
  PLATFORM_SCHEMA,
  PLATFORM_STATE_TABLES,
  PROVIDER_IDENTITY_SOURCES,
  isObjectOrigin,
  type DatabaseProvider,
  type PhysicalTable,
} from "simetra/model"
import type { ParsedObject } from "../stages/files"
import { isDeclaredTable } from "../stages/model"
import { unitRelations } from "./dependencies"
import type { ModelView } from "./function-body"
import type { SqlParser } from "./parse"
import type { UnitTarget } from "./unit-target"

/**
 * Таблиці видів знімка — усі, чий об'єкт не є прийнятою таблицею: основна,
 * ТЧ, похідна таблиця регістра, системні довідники прав. `qualified` —
 * `схема.ім'я`, `byName` — ім'я → кваліфіковані імена таблиць з ним,
 * `bySchema` — схема → кваліфіковані імена її таблиць виду.
 */
export interface KindTables {
  qualified: ReadonlySet<string>
  byName: ReadonlyMap<string, readonly string[]>
  bySchema: ReadonlyMap<string, readonly string[]>
  /**
   * Схеми, кожне відношення яких закрите, зокрема те, якого знімок не знає:
   * кваліфікована ціль у такій схемі судиться без переліку імен.
   */
  closedSchemas?: ReadonlySet<string>
  /**
   * Таблиці з грантами генератора `access` (об'єктні таблиці з RLS): дослівний
   * грант на них називає `sql.generated-grant`, тож Правило 1 другої
   * діагностики не дає.
   */
  generatedGrants?: ReadonlySet<string>
  /**
   * Імена таблиць схеми `simetra` знімка, що не є таблицями видів (черга
   * сигналів, ідентичності, версії прав…): їх `ruleOneTables` додає до цілей
   * Правила 1, щоб некваліфіковане ім'я судилося так само, як кваліфіковане.
   */
  platformTables?: readonly string[]
}

export function kindTables(
  objects: readonly ParsedObject[],
  tables: readonly PhysicalTable[]
): KindTables {
  // Прийнятість — факт реєстру (`isDeclaredTable`), не назва виду: таблицю
  // прийнятого об'єкта описує файл, і її борг належить їй самій.
  const kindObjects = new Set(
    objects.filter((o) => !isDeclaredTable(o)).map((o) => o.id ?? "")
  )
  const qualified = new Set<string>()
  const byName = new Map<string, string[]>()
  const bySchema = new Map<string, string[]>()
  const generatedGrants = new Set<string>()
  const platformTables = new Set<string>()
  for (const table of tables) {
    if (table.schema === PLATFORM_SCHEMA) platformTables.add(table.name)
    if (
      !isObjectOrigin(table.origin) ||
      !kindObjects.has(table.origin.objectId)
    )
      continue
    const key = `${table.schema}.${table.name}`
    qualified.add(key)
    if (table.rowLevelSecurity !== "off") generatedGrants.add(key)
    byName.set(table.name, [...(byName.get(table.name) ?? []), key])
    bySchema.set(table.schema, [...(bySchema.get(table.schema) ?? []), key])
  }
  return {
    qualified,
    byName,
    bySchema,
    generatedGrants,
    platformTables: [...platformTables],
  }
}

/**
 * Таблиці, у які SQL застосунку не пише (Правило 1): таблиці виду, таблиця
 * джерела ідентичностей провайдера — тригери платформи переносять запис у неї
 * в «Користувачі» й `simetra.identities` (спека прав §6.1), тож запис туди змінював би
 * таблицю виду повз команду, — і кожне відношення схеми `simetra`. Стан
 * застосування, квитанції й черга сигналів живуть там поза знімком, а
 * функція застосунку з `SECURITY DEFINER` писала б їх від імені власника
 * повз команду. Некваліфіковане ім'я судиться за таблицями схеми, які відомі
 * (знімок і стан застосування, `PLATFORM_STATE_TABLES`), кваліфіковане —
 * будь-яке. Лише для DML тіла: дослівні політики й тригери (спека прав §6.1)
 * судяться над `kindTables`.
 */
export function ruleOneTables(
  tables: KindTables,
  provider: DatabaseProvider | undefined
): KindTables {
  const closed = [
    ...[...PLATFORM_STATE_TABLES, ...(tables.platformTables ?? [])].map(
      (name) => ({ schema: PLATFORM_SCHEMA, name })
    ),
    ...(provider === undefined
      ? []
      : [PROVIDER_IDENTITY_SOURCES[provider].table]),
  ]
  const qualified = new Set(tables.qualified)
  const byName = new Map(tables.byName)
  const bySchema = new Map(tables.bySchema)
  for (const { schema, name } of closed) {
    const key = `${schema}.${name}`
    if (qualified.has(key)) continue
    qualified.add(key)
    byName.set(name, [...(byName.get(name) ?? []), key])
    bySchema.set(schema, [...(bySchema.get(schema) ?? []), key])
  }
  return {
    qualified,
    byName,
    bySchema,
    closedSchemas: new Set([...(tables.closedSchemas ?? []), PLATFORM_SCHEMA]),
    ...(tables.generatedGrants === undefined
      ? {}
      : { generatedGrants: tables.generatedGrants }),
  }
}

/**
 * Таблиця виду, яку називає ціль; `own` — схема одиниці. Некваліфіковане ім'я
 * судиться fail-closed: рендер не задає `search_path`, а функція може
 * виконуватися з будь-яким, тож Postgres розв'яже ім'я за шляхом сесії, а не
 * за схемою файлу, — таблиця виду з тим самим ім'ям у будь-якій схемі
 * підходить. Ціль `kind: "schema"` (оператор над схемою цілком) — кожна
 * таблиця виду схеми.
 */
export function kindTableNamed(
  target: UnitTarget,
  own: string,
  tables: KindTables
): string | undefined {
  const closed = tables.closedSchemas?.has(target.schema) === true
  if (target.kind === "schema")
    return (
      tables.bySchema.get(target.schema)?.[0] ??
      (closed ? `${target.schema}.*` : undefined)
    )
  const name = target.object ?? ""
  if (target.schema !== "") {
    const key = `${target.schema}.${name}`
    return tables.qualified.has(key) || closed ? key : undefined
  }
  const mine = `${own}.${name}`
  if (tables.qualified.has(mine)) return mine
  return tables.byName.get(name)?.[0]
}

/**
 * Таблиця з `tables`, у яку потрапляє запис у подання моделі `view`, — той
 * самий обхід визначень, що й ціль DML тіла (Правило 1): автооновлюване
 * подання Postgres переписує на базову таблицю, рекурсивно. `views` — подання,
 * крізь які обхід іде, серед них і саме `view`.
 */
export function viewWrittenTable(
  view: ModelView,
  tables: KindTables,
  views: readonly ModelView[],
  parse: SqlParser
): string | undefined {
  return writtenKindTable(
    { schema: view.schema, object: view.name, kind: "table" },
    view.schema,
    tables,
    views,
    parse,
    new Set()
  )
}

/** Таблиця виду, у яку потрапляє запис у ціль, зокрема через подання моделі. */
export function writtenKindTable(
  target: UnitTarget,
  own: string,
  tables: KindTables,
  views: readonly ModelView[],
  parse: SqlParser,
  visited: Set<string>
): string | undefined {
  const direct = kindTableNamed(target, own, tables)
  if (direct !== undefined) return direct
  const name = target.object ?? ""
  // Некваліфіковане ім'я — подання з тим самим ім'ям у будь-якій схемі, як і
  // таблиця (`kindTableNamed`).
  for (const view of views) {
    if (view.name !== name) continue
    if (target.schema !== "" && view.schema !== target.schema) continue
    const key = `${view.schema}.${view.name}`
    if (visited.has(key)) continue
    visited.add(key)
    for (const relation of unitRelations({ tree: view.tree }, parse)) {
      const table = writtenKindTable(
        { schema: relation.schema ?? "", object: relation.name, kind: "table" },
        view.schema,
        tables,
        views,
        parse,
        visited
      )
      if (table !== undefined) return table
    }
  }
  return undefined
}
