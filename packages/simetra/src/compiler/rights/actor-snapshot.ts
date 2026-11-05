import { CURRENT_USER_FUNCTION_NAME, PLATFORM_SCHEMA } from "simetra/model"
import { qualified, type QualifiedName } from "../contracts"
import { dollarTag } from "../movement-functions"
import { sqlLiteral } from "../stages/model"
import { INPUT_COLUMNS } from "./admin-tables"
import type { MineInputs } from "./functions"

/**
 * Факти актора, які знімок бере до першої зміни їхнього джерела (спека прав
 * §5.1, §7): рядки прав, мої скоупи, мої значення вимірів і вихід дослівних
 * функцій множини видів скоупу.
 */
export type SnapshotFact = "rights" | "scopes" | "values" | "scopeSets"

export const SNAPSHOT_FACTS: readonly SnapshotFact[] = [
  "rights",
  "scopes",
  "values",
  "scopeSets",
]

const platform = (name: string): QualifiedName => ({
  schema: PLATFORM_SCHEMA,
  name,
})

/**
 * Таблиці знімка (спека прав §7): заголовки фактів, входи факту `rights`
 * (Р3-15), кеш прав початку на COMMIT і рядки решти фактів.
 */
export const SNAPSHOT_TABLES = {
  header: platform("rights_tx_header"),
  typed: platform("rights_tx_typed"),
  containers: platform("rights_tx_containers"),
  deltas: platform("rights_tx_deltas"),
  holders: platform("rights_tx_holders"),
  start: platform("rights_tx_start"),
  scopes: platform("rights_tx_scopes"),
  values: platform("rights_tx_values"),
  scopeSets: platform("rights_tx_scope_sets"),
} as const satisfies Record<string, QualifiedName>

/**
 * Таблиці рядків факту. Кеш `start` — не рядки факту: його пише перевірка
 * на COMMIT, а не знімок.
 */
export const FACT_TABLE: Record<SnapshotFact, readonly QualifiedName[]> = {
  rights: [
    SNAPSHOT_TABLES.typed,
    SNAPSHOT_TABLES.containers,
    SNAPSHOT_TABLES.deltas,
    SNAPSHOT_TABLES.holders,
  ],
  scopes: [SNAPSHOT_TABLES.scopes],
  values: [SNAPSHOT_TABLES.values],
  scopeSets: [SNAPSHOT_TABLES.scopeSets],
}

/** Колонки входу з префіксом псевдоніма — для `SELECT` і списку `INSERT`. */
export function inputColumns(input: keyof MineInputs, alias?: string): string {
  return INPUT_COLUMNS[input]
    .map(([name]) => (alias === undefined ? name : `${alias}.${name}`))
    .join(", ")
}

/**
 * Входи `rights_mine` зі знімка транзакції `xid` (Р3-15): та сама форма, що
 * в живих генераторів, тож `mineBody` над ними — те саме тіло.
 */
export function snapshotInputs(xid: string): MineInputs {
  const read = (input: keyof MineInputs) =>
    `SELECT ${inputColumns(input, "i")} FROM ${qualified(SNAPSHOT_TABLES[input])} i WHERE i.xid = ${xid}`
  return {
    typed: read("typed"),
    containers: read("containers"),
    deltas: read("deltas"),
  }
}

const CURRENT_USER = `(SELECT ${qualified(platform(CURRENT_USER_FUNCTION_NAME))}())`

/**
 * Охорона читання: без призначеного xid таблиць знімка не читає ніхто —
 * `txid_current()` видав би xid кожному читанню (`READ ONLY`, PostgREST).
 * `CASE`, а не `AND`: кон'юнкти верхнього рівня планувальник переставляє
 * за ціною, і `EXISTS` виконувався б і без xid.
 */
function guarded(exists: string): string {
  return `CASE WHEN txid_current_if_assigned() IS NULL THEN false ELSE ${exists} END`
}

function header(fact: SnapshotFact, extra = ""): string {
  return `EXISTS (SELECT 1 FROM ${qualified(SNAPSHOT_TABLES.header)} h WHERE h.xid = txid_current_if_assigned() AND h.fact = ${sqlLiteral(fact)}${extra})`
}

/** Чи факт цієї транзакції вже знято (Р3-3). */
export function snapshotPresent(fact: SnapshotFact): string {
  return guarded(header(fact))
}

/** Чи факт цієї транзакції знято для поточного користувача (Р3-3). */
export function snapshotOwned(fact: SnapshotFact): string {
  return guarded(
    header(fact, ` AND h.actor IS NOT DISTINCT FROM ${CURRENT_USER}`)
  )
}

/**
 * Чи транзакцію закріплено за іншим актором (Р3-3): будь-який знятий факт
 * з іншим актором — і живих фактів він не отримує навіть тих, яких ще не
 * знято (fail-closed).
 */
export function snapshotForeign(): string {
  return guarded(
    `EXISTS (SELECT 1 FROM ${qualified(SNAPSHOT_TABLES.header)} h WHERE h.xid = txid_current_if_assigned() AND h.actor IS DISTINCT FROM ${CURRENT_USER})`
  )
}

/**
 * Тіло диспетчера публічної функції факту (Р3-3, Р3-15): гілка знімка — коли
 * факт цієї транзакції знято для поточного користувача; жива гілка — коли
 * факту ще немає й транзакцію не закріплено за іншим актором. Інакше —
 * порожньо (fail-closed). Гілки — згенеровані запити тієї самої форми
 * колонок. План кожного `RETURN QUERY` кешується на сесію, а мертву гілку не
 * планує ніхто — на відміну від SQL-функції з `SET search_path`, яку Postgres
 * планує на кожен виклик цілою разом з охоронами. Колонки результату —
 * змінні plpgsql з тими самими іменами, що колонки гілок, тож
 * неоднозначність вирішено на користь колонки.
 *
 * `scalar` — функція одного значення (`_my_member`): гілка — скалярний
 * підзапит, порожньо — `NULL`. Більше одного рядка гілка не дає: учасник
 * користувача в скоупі один (`UNIQUE (скоуп, користувач)`, спека
 * користувачів §7).
 */
export function snapshotDispatcher(
  fact: SnapshotFact,
  snapshot: string,
  live: string,
  scalar = false
): string {
  const branch = (sql: string) =>
    scalar ? `    RETURN (\n${sql}\n    );` : `    RETURN QUERY\n${sql};`
  return [
    "#variable_conflict use_column",
    "BEGIN",
    // Умови — у дужках: `THEN` усередині `CASE` охорони Р3-3 інакше
    // закінчив би умову `IF` plpgsql.
    `  IF (${snapshotOwned(fact)}) THEN`,
    branch(snapshot),
    `  ELSIF (NOT ${snapshotPresent(fact)} AND NOT ${snapshotForeign()}) THEN`,
    branch(live),
    "  END IF;",
    // Функція одного значення без `RETURN` закінчилась би помилкою.
    ...(scalar ? ["  RETURN NULL;"] : []),
    "END;",
  ].join("\n")
}

/**
 * Оболонка диспетчера: `STABLE SECURITY DEFINER SET search_path = ''`, як у
 * SQL-функцій фактів, і рядкове тіло під `$тег$`.
 */
export function dispatcherFunction(
  signature: string,
  returns: string,
  body: string
): string {
  const tag = dollarTag(body)
  return `CREATE OR REPLACE FUNCTION ${signature} RETURNS ${returns} LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS ${tag}\n${body}\n${tag};`
}
