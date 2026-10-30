import {
  KIND_REGISTRY,
  makeObjectName,
  quoteIdent,
  type AttributeCase,
  type DatabaseProvider,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import type { QualifiedName } from "./contracts"
import { compareStrings } from "./diagnostics"
import { definerTrigger } from "./rights/definer"
import { executeGrants } from "./sql/execute-grants"
import type { SqlParser } from "./sql/parse"
import { generatedUnit, type SqlUnit } from "./sql/units"
import type { ParsedObject } from "./stages/files"
import { findStandardColumn } from "./standard-column"
import { fieldForeignKey, sqlLiteral } from "./stages/model"

/**
 * Простір advisory-замків ієрархії платформи (Р-A2-1, Р-A2-17): `0x53494D48`
 * («SIMH»). Другий ключ — oid таблиці, тож простір має відрізнятися від
 * замка застосування схеми (`0x53494D45`, `1`): інакше таблиця з oid 1
 * чекала б на застосування. Одна стала для тригера й ядра команд.
 */
export const HIERARCHY_LOCK_SPACE = 0x53494d48

const INSERT_LABEL = "simetra_hierarchy"
const UPDATE_LABEL = "simetra_hierarchy_update"

/**
 * Імена тригерів і функції ієрархії таблиці. Тригери — `AFTER`: на `NEW` не
 * впливають і в групу рядкових `BEFORE`-тригерів не входять, тож лишаються на
 * алгоритмі імен Postgres, як тригери поширення носіїв. Функція — у схемі
 * таблиці з іменем тригера вставки.
 */
export function hierarchyNames(table: QualifiedName): {
  insert: string
  update: string
  fn: QualifiedName
} {
  const insert = makeObjectName(table.name, undefined, INSERT_LABEL)
  return {
    insert,
    update: makeObjectName(table.name, undefined, UPDATE_LABEL),
    fn: { schema: table.schema, name: insert },
  }
}

const q = quoteIdent
const relation = (t: { schema: string; name: string }) =>
  `${q(t.schema)}.${q(t.name)}`

/**
 * Виклик advisory-замка ієрархії таблиці — одне джерело ключа для тригера й
 * ядра команд (Р-A2-17): інший вираз ключа в ядрі не серіалізував би його з
 * тригером. oid понад 2³¹ обертається у від'ємне `int` — ключ однаково
 * стабільний.
 */
export function hierarchyLockSql(table: QualifiedName): string {
  return `pg_advisory_xact_lock(${HIERARCHY_LOCK_SPACE}, ${sqlLiteral(relation(table))}::regclass::oid::int)`
}

/** Ієрархічна основна таблиця: колонки батька й ключа. */
export interface HierarchyTable {
  table: PhysicalTable
  parent: string
  key: string
}

/**
 * Ієрархічні основні таблиці знімка: колонка батька — стандартна колонка
 * реєстру виду з ціллю `self`, знайдена спільним помічником за визначенням
 * реєстру в стилі проєкту (не за літералом: snake_case-проєкт), з FK на саму
 * таблицю. Колонка
 * `parent_id` ТЧ — власник рядка, не ієрархія, тож ТЧ сюди не входять.
 * Спільне для генератора й резервування імен функцій (`derivedFunctions`).
 */
export function hierarchyTables(
  physical: Pick<PhysicalSnapshot, "tables">,
  objects: readonly ParsedObject[],
  attributeCase: AttributeCase
): HierarchyTable[] {
  const byId = new Map(objects.map((o) => [o.id ?? "", o]))
  const result: HierarchyTable[] = []
  for (const table of physical.tables) {
    if (
      table.origin.tabularSectionId !== undefined ||
      table.origin.part !== undefined
    )
      continue
    const object = byId.get(table.origin.objectId)
    if (object === undefined) continue
    const parent = KIND_REGISTRY[object.kind]
      .standardColumns(object.data)
      .filter((d) => d.ref === "self")
      .map((d) => findStandardColumn(table, d, attributeCase))
      .find((c) => c !== undefined)
    if (parent === undefined) continue
    const fk = fieldForeignKey(table, parent.name)
    // Ключ — колонка, на яку FK батька вказує в самій таблиці (у скоупленій
    // таблиці FK складений зі скоупом). Колонку батька й FK на себе будує
    // стадія 3 разом: без них обхід предків не мав би сенсу — це дефект
    // компілятора.
    const key = fk?.references.columns[fk.columns.indexOf(parent.name)]
    if (
      key === undefined ||
      fk === undefined ||
      fk.references.schema !== table.schema ||
      fk.references.table !== table.name
    ) {
      throw new Error(
        `internal: hierarchy column ${table.schema}.${table.name}.${parent.name} has no key or self foreign key`
      )
    }
    result.push({ table, parent: parent.name, key })
  }
  return result.sort(
    (a, b) =>
      compareStrings(a.table.schema, b.table.schema) ||
      compareStrings(a.table.name, b.table.name)
  )
}

/**
 * Тригер ієрархії (Р-A2-1): цикл `parent` — інваріант бази для будь-якого
 * автора (команда, імпорт, мігратор), тож тригер є незалежно від функцій
 * прав. `AFTER`, бо `BEFORE … UPDATE OF` не запускається, коли батька
 * присвоїв інший `BEFORE`-тригер (обробник `beforeWrite`), а не `SET`.
 * Функція на таблицю, `SECURITY DEFINER` з `row_security = off`: обхід
 * предків під правами автора не бачив би невидимих рядків і пропустив би
 * цикл через них (залишок оракула — Р-A2-16). `EXECUTE` — нікому: тригер
 * спрацьовує без права виконання (платформна спека §6.7). Тіла plpgsql граф
 * не читає, тож таблиця тіла — явне ребро `requires`.
 */
export function buildHierarchyUnits(
  physical: PhysicalSnapshot,
  objects: readonly ParsedObject[],
  attributeCase: AttributeCase,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  const units: SqlUnit[] = []
  for (const entry of hierarchyTables(physical, objects, attributeCase)) {
    const { table, parent } = entry
    const names = hierarchyNames(table)
    const unit = (sql: string, requires = false): SqlUnit => ({
      ...generatedUnit(sql, table.schema, parse),
      ownerObjectId: table.origin.objectId,
      module,
      generator: "mechanics",
      ...(requires
        ? {
            requires: [
              {
                type: "table" as const,
                schema: table.schema,
                name: table.name,
              },
            ],
          }
        : {}),
    })
    const execute = `EXECUTE FUNCTION ${relation(names.fn)}();`
    units.push(
      unit(
        definerTrigger(names.fn, hierarchyBody(entry), { rowSecurity: "off" }),
        true
      ),
      ...executeGrants(`${relation(names.fn)}()`, [], provider).map((sql) =>
        unit(sql)
      ),
      unit(
        `CREATE TRIGGER ${q(names.insert)} AFTER INSERT ON ${relation(table)} FOR EACH ROW WHEN (NEW.${q(parent)} IS NOT NULL) ${execute}`
      ),
      unit(
        `CREATE TRIGGER ${q(names.update)} AFTER UPDATE ON ${relation(table)} FOR EACH ROW WHEN (NEW.${q(parent)} IS DISTINCT FROM OLD.${q(parent)}) ${execute}`
      )
    )
  }
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * Тіло функції ієрархії. Функція `VOLATILE` (типова), не `STABLE`: у
 * `READ COMMITTED` кожен оператор `VOLATILE`-функції бере новий знімок, тож
 * обхід після очікування на замок бачить переміщення, закомічене тим, хто
 * тримав замок; `STABLE` обходив би знімок до очікування й пропустив би цикл.
 */
function hierarchyBody({ table, parent, key }: HierarchyTable): string {
  const invalid = `RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'command.invalid', DETAIL = ${sqlLiteral(parent)};`
  return [
    "BEGIN",
    // Лише `READ COMMITTED` (Р-A2-13): у `REPEATABLE READ` і `SERIALIZABLE`
    // знімок фіксований, і після замка обхід не бачить закоміченого
    // переміщення; SSI ловить гонку лише між двома `SERIALIZABLE`. Перевірка
    // — до замка: відмова не чекає на чужу транзакцію.
    "  IF current_setting('transaction_isolation') <> 'read committed' THEN",
    "    RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = 'hierarchy.isolation';",
    "  END IF;",
    `  IF NEW.${q(parent)} = NEW.${q(key)} THEN`,
    `    ${invalid}`,
    "  END IF;",
    `  PERFORM ${hierarchyLockSql(table)};`,
    // `AFTER`-тригер бачить таблицю вже з новим зв'язком, тож рядок серед
    // предків нового батька — це цикл. `CYCLE` зупиняє обхід на циклі, що вже
    // є в даних, замість зависання.
    `  IF EXISTS (WITH RECURSIVE up(node) AS (SELECT p.${q(parent)} FROM ${relation(table)} p WHERE p.${q(key)} = NEW.${q(parent)} UNION ALL SELECT p.${q(parent)} FROM ${relation(table)} p JOIN up ON p.${q(key)} = up.node) CYCLE node SET looped USING trail SELECT 1 FROM up WHERE up.node = NEW.${q(key)}) THEN`,
    `    ${invalid}`,
    "  END IF;",
    "  RETURN NULL;",
    "END",
  ].join("\n")
}
