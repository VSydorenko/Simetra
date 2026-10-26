import type { Node } from "libpg-query"
import {
  PROVIDER_IDENTITY_SOURCES,
  type DatabaseProvider,
  type PhysicalTable,
} from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { isDeclaredTable } from "../stages/model"
import { closedModuleOwners } from "./closed-forms"
import { unitRelations } from "./dependencies"
import { modelViews, routineBody, type ModelView } from "./function-body"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import {
  bodyStatementTargets,
  statementTargets,
  type UnitTarget,
} from "./unit-target"
import type { VerbatimUnit } from "./units"

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
  for (const table of tables) {
    if (!kindObjects.has(table.origin.objectId)) continue
    const key = `${table.schema}.${table.name}`
    qualified.add(key)
    byName.set(table.name, [...(byName.get(table.name) ?? []), key])
    bySchema.set(table.schema, [...(bySchema.get(table.schema) ?? []), key])
  }
  return { qualified, byName, bySchema }
}

/**
 * Таблиці, у які SQL застосунку не пише (Правило 1): таблиці виду і таблиця
 * джерела ідентичностей провайдера — тригери платформи переносять запис у неї
 * в «Користувачі» й `simetra.identities` (N7), тож запис туди змінював би
 * таблицю виду повз команду. Лише для DML тіла: дослівні політики й тригери
 * (Р2c1-1) судяться над `kindTables`.
 */
export function ruleOneTables(
  tables: KindTables,
  provider: DatabaseProvider | undefined
): KindTables {
  if (provider === undefined) return tables
  const { schema, name } = PROVIDER_IDENTITY_SOURCES[provider].table
  const key = `${schema}.${name}`
  return {
    qualified: new Set([...tables.qualified, key]),
    byName: new Map([
      ...tables.byName,
      [name, [...(tables.byName.get(name) ?? []), key]],
    ]),
    bySchema: new Map([
      ...tables.bySchema,
      [schema, [...(tables.bySchema.get(schema) ?? []), key]],
    ]),
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
function kindTableNamed(
  target: UnitTarget,
  own: string,
  tables: KindTables
): string | undefined {
  if (target.kind === "schema") return tables.bySchema.get(target.schema)?.[0]
  const name = target.object ?? ""
  if (target.schema !== "") {
    const key = `${target.schema}.${name}`
    return tables.qualified.has(key) ? key : undefined
  }
  const mine = `${own}.${name}`
  if (tables.qualified.has(mine)) return mine
  return tables.byName.get(name)?.[0]
}

/**
 * Таблиця виду, на якій висить дослівна політика чи тригер одиниці;
 * `undefined` — одиниця іншого класу чи ціль поза таблицями видів. Ціль —
 * з дерева розбору (`statementTargets`), а не з тексту; некваліфіковане ім'я
 * — fail-closed (`kindTableNamed`).
 */
export function kindTableOf(
  unit: Pick<VerbatimUnit, "class" | "schema" | "tree">,
  tables: KindTables
): string | undefined {
  if (unit.class !== "policy" && unit.class !== "trigger") return undefined
  for (const target of statementTargets(unit.tree as Node, "")) {
    const table = kindTableNamed(target, unit.schema, tables)
    if (table !== undefined) return table
  }
  return undefined
}

/** Оператор тіла функції, що пише таблицю виду, і ця таблиця. */
export interface BodyKindTable {
  table: string
  /** Вузол оператора в дереві розбору: `InsertStmt`, `UpdateStmt`… */
  statement: string
}

/**
 * Перший DML тіла функції чи процедури, чия ціль (`bodyStatementTargets`) —
 * таблиця з `tables` (Правило 1, Р2c1-16); інший клас чи тіло без такого
 * оператора — `undefined`. Судяться оператори, які тіло виконує
 * (`routineBody`), і вкладені в них. Ціль, що є поданням моделі,
 * розгортається до кожного відношення його визначення, рекурсивно: Postgres
 * переписує запис в автооновлюване подання на базову таблицю, а котре
 * відношення базове, без каталогу не видно (fail-closed).
 */
export function bodyKindTable(
  unit: Pick<VerbatimUnit, "class" | "schema" | "sql" | "tree">,
  tables: KindTables,
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  views: readonly ModelView[]
): BodyKindTable | undefined {
  if (unit.class !== "function" && unit.class !== "procedure") return undefined
  if (tables.qualified.size === 0) return undefined
  const body = routineBody(unit.tree as Node, unit.sql, parse, plpgsql)
  for (const { stmt } of body.statements) {
    for (const target of bodyStatementTargets(stmt, "")) {
      const table = writtenKindTable(
        target,
        unit.schema,
        tables,
        views,
        parse,
        new Set()
      )
      if (table !== undefined)
        return { table, statement: Object.keys(stmt)[0] ?? "" }
    }
  }
  return undefined
}

/** Таблиця виду, у яку потрапляє запис у ціль, зокрема через подання моделі. */
function writtenKindTable(
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

/**
 * Дослівна політика чи тригер на таблиці виду (Р2c1-1, спека прав §6.1) —
 * помилка в будь-якому файлі, зокрема в модулі боргу прийнятої таблиці й
 * навіть перелічена в `sql-debt.json`: ізоляцію таблиці виду розширює лише
 * право (дія, об'єкт), а реакцію на зміну рядка — підписка. Дослівна
 * політика відкрила б рядки повз права, а тригер бачив би запис команди й
 * крок даних копій. Модуль виду ці класи вже відмовляє
 * (`sql.statement-not-allowed`, `kindModule`), тож там друга діагностика —
 * шум.
 *
 * Тіло функції чи процедури в будь-якому файлі, зокрема в модулі виду й у
 * закритій оболонці, у таблицю виду не пише (Правило 1, Р2c1-16, форма
 * `functionBody`): таблицю виду пишуть лише ядро команд, оболонка проведення
 * й тригери платформи, а DML застосунку обійшов би права, рухи й перевірки
 * команди. Що ще тіло може виконувати, судить дозвільний перелік операторів
 * (`sql.function-body-statement`, Р2c1-37). Модуль виду функцію приймає, тож
 * там ця діагностика єдина. `provider` дає таблицю джерела ідентичностей
 * (`ruleOneTables`).
 */
export function checkKindTableVerbatim(
  objects: readonly ParsedObject[],
  tables: readonly PhysicalTable[],
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  provider: DatabaseProvider | undefined
): Diagnostic[] {
  const kind = kindTables(objects, tables)
  const written = ruleOneTables(kind, provider)
  const views = modelViews(units)
  const closed = closedModuleOwners(objects)
  return units.flatMap((unit) => {
    const body = bodyKindTable(unit, written, parse, plpgsql, views)
    if (body !== undefined) {
      return [
        diagnostic("sql.kind-table-verbatim", unit.file, "", {
          identity: unit.identity,
          function: `${unit.schema}.${unit.name}`,
          table: body.table,
          form: "functionBody",
          statement: body.statement,
          line: unit.line,
        }),
      ]
    }
    if (unit.ownerFile !== undefined && closed.has(unit.ownerFile)) return []
    const table = kindTableOf(unit, kind)
    if (table === undefined) return []
    return [
      diagnostic("sql.kind-table-verbatim", unit.file, "", {
        identity: unit.identity,
        table,
        form: unit.class,
        line: unit.line,
      }),
    ]
  })
}
