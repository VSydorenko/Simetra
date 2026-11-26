import {
  COMMAND_CORE_ERRORS,
  KIND_REGISTRY,
  deletionMarkColumn,
  isObjectTable,
  makeObjectName,
  quoteIdent,
  type AttributeCase,
  type DatabaseProvider,
  type ObjectTable,
  type PhysicalSnapshot,
  type RoleLanguageState,
} from "simetra/model"
import { platformBeforeTriggerName } from "./before-trigger-names"
import type { QualifiedName } from "./contracts"
import { compareStrings } from "./diagnostics"
import { definerTrigger } from "./rights/definer"
import { executeGrants } from "./sql/execute-grants"
import type { SqlParser } from "./sql/parse"
import { generatedUnit, type SqlUnit } from "./sql/units"
import type { ParsedObject } from "./stages/files"
import { findStandardColumn } from "./standard-column"
import { sqlLiteral } from "./stages/model"

const ROW_LABEL = "simetra_language"
const TRUNCATE_LABEL = "simetra_language_truncate"

/**
 * Імена тригерів стану мови (Р-B2-4). Рядковий — `BEFORE` у групі платформи
 * перед `simetra_touch`: відмовлений запис не бере версії. Запобіжник
 * `TRUNCATE` — операторний, тож у групу не входить і лишається на алгоритмі
 * імен Postgres. Обидва кличуть одну функцію в схемі таблиці з іменем
 * рядкового тригера.
 */
export function languageStateNames(table: QualifiedName): {
  row: string
  truncate: string
  fn: QualifiedName
} {
  const row = platformBeforeTriggerName(table.name, ROW_LABEL)
  return {
    row,
    truncate: makeObjectName(table.name, undefined, TRUNCATE_LABEL),
    fn: { schema: table.schema, name: row },
  }
}

/** Основна таблиця довідника ролі «мови» з фізичними колонками тригера. */
export interface LanguageStateTable {
  table: ObjectTable
  state: RoleLanguageState
  columns: { state: string; primary: string; code: string; mark: string }
}

/**
 * Таблиці з фактом стану мови: довідник знаходить поле реєстру
 * `languagesCatalog`, колонки — визначення стандартних колонок у стилі
 * проєкту, а не літерали. Лише основна таблиця: ТЧ стану мови не мають.
 */
export function languageStateTables(
  physical: Pick<PhysicalSnapshot, "tables">,
  objects: readonly ParsedObject[],
  attributeCase: AttributeCase
): LanguageStateTable[] {
  const byId = new Map(objects.map((o) => [o.id ?? "", o]))
  const result: LanguageStateTable[] = []
  for (const table of physical.tables) {
    if (
      !isObjectTable(table) ||
      table.origin.tabularSectionId !== undefined ||
      table.origin.part !== undefined
    )
      continue
    const object = byId.get(table.origin.objectId)
    if (object === undefined) continue
    const kind = KIND_REGISTRY[object.kind]
    if (kind.languagesCatalog?.(object.data) !== true) continue
    const state = kind.languageState?.(object.data)
    if (state === undefined) continue
    // Довідник без колонки ролі (`codeLength: 0`) уже відмовляє правило
    // `languages.code-form` стадії цілісності; ця функція кличеться раніше
    // (`derivedFunctions`), тож такої таблиці не будує, а не падає.
    const defs = kind.standardColumns(object.data)
    const column = (logicalName: string) => {
      const def = defs.find((d) => d.logicalName === logicalName)
      return def === undefined
        ? undefined
        : findStandardColumn(table, def, attributeCase)?.name
    }
    const columns = {
      state: column(state.stateColumn),
      primary: column(state.primaryColumn),
      code: column(state.codeColumn),
      mark: findStandardColumn(table, deletionMarkColumn(), attributeCase)
        ?.name,
    }
    const { state: s, primary, code, mark } = columns
    if (
      s === undefined ||
      primary === undefined ||
      code === undefined ||
      mark === undefined
    )
      continue
    result.push({ table, state, columns: { state: s, primary, code, mark } })
  }
  return result.sort(
    (a, b) =>
      compareStrings(a.table.schema, b.table.schema) ||
      compareStrings(a.table.name, b.table.name)
  )
}

const q = quoteIdent
const relation = (t: { schema: string; name: string }) =>
  `${q(t.schema)}.${q(t.name)}`

/**
 * Тригер стану мови (Р-B2-4, спека багатомовності §5.2): незмінність основної
 * й коду, переходи стану за матрицею факту ролі, заборона позначки видалення,
 * `DELETE` і `TRUNCATE` — інваріант бази для будь-якого автора, тож тригер є
 * незалежно від функцій прав. Друга лінія за грантами ролі команд (Р-B2-3) і
 * CHECK-ами колонок. Одна функція на рядковий `BEFORE`-тригер і операторний
 * запобіжник `TRUNCATE`; `SECURITY DEFINER` з порожнім `search_path` і
 * `row_security = off`, `EXECUTE` — нікому: тригер спрацьовує без права
 * виконання (платформна спека §6.7).
 */
export function buildLanguageStateUnits(
  physical: PhysicalSnapshot,
  objects: readonly ParsedObject[],
  attributeCase: AttributeCase,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  const units: SqlUnit[] = []
  for (const entry of languageStateTables(physical, objects, attributeCase)) {
    const { table } = entry
    const names = languageStateNames(table)
    const unit = (sql: string): SqlUnit => ({
      ...generatedUnit(sql, table.schema, parse),
      ownerObjectId: table.origin.objectId,
      module,
      generator: "mechanics",
    })
    const execute = `EXECUTE FUNCTION ${relation(names.fn)}();`
    units.push(
      unit(
        definerTrigger(names.fn, languageStateBody(entry), {
          rowSecurity: "off",
        })
      ),
      ...executeGrants(`${relation(names.fn)}()`, [], provider).map((sql) =>
        unit(sql)
      ),
      unit(
        `CREATE TRIGGER ${q(names.row)} BEFORE INSERT OR UPDATE OR DELETE ON ${relation(table)} FOR EACH ROW ${execute}`
      ),
      unit(
        `CREATE TRIGGER ${q(names.truncate)} BEFORE TRUNCATE ON ${relation(table)} FOR EACH STATEMENT ${execute}`
      )
    )
  }
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * Тіло з частин за `TG_OP`. Порівняння — `IS DISTINCT FROM` і `IS NOT TRUE`:
 * `NULL` не проходить гілку мовчки. Гілка `publication_gate` — шов брами
 * публікації B4 (Р-B2-9): у B2 порожня, B4 наповнює її, не створюючи
 * другого тригера.
 */
function languageStateBody({ state, columns }: LanguageStateTable): string {
  const E = COMMAND_CORE_ERRORS.invalid
  const refuse = `RAISE EXCEPTION USING ERRCODE = '${E.errcode}', MESSAGE = '${E.message}', DETAIL = ${sqlLiteral(E.languageState)};`
  const col = (row: "NEW" | "OLD", name: string) => `${row}.${q(name)}`
  const branch = (condition: string, body: string[], indent = "  ") => [
    `${indent}IF ${condition} THEN`,
    ...body.map((line) => `${indent}  ${line}`),
    `${indent}END IF;`,
  ]
  const changed = (name: string) =>
    `${col("NEW", name)} IS DISTINCT FROM ${col("OLD", name)}`
  const transitions = state.transitions
    .map(({ from, to }) => `(${sqlLiteral(from)}, ${sqlLiteral(to)})`)
    .join(", ")
  return [
    "BEGIN",
    // Мови не видаляють (ADR-0115): ні рядком, ні оператором.
    ...branch("TG_OP = 'TRUNCATE'", [refuse]),
    ...branch("TG_OP = 'DELETE'", [refuse]),
    // Не основну мову вставляють лише в стані вставки; основну засіває apply
    // одразу опублікованою.
    ...branch("TG_OP = 'INSERT'", [
      ...branch(
        `${col("NEW", columns.primary)} IS NOT TRUE AND ${col("NEW", columns.state)} IS DISTINCT FROM ${sqlLiteral(state.insertState)}`,
        [refuse],
        ""
      ),
      "RETURN NEW;",
    ]),
    ...branch(changed(columns.primary), [refuse]),
    ...branch(changed(columns.code), [refuse]),
    // Позначки видалення мови не мають; `INSERT` з позначкою тримає CHECK.
    ...branch(
      `${col("NEW", columns.mark)} IS TRUE AND ${col("OLD", columns.mark)} IS NOT TRUE`,
      [refuse]
    ),
    ...branch(changed(columns.state), [
      ...branch(
        `((${col("OLD", columns.state)}, ${col("NEW", columns.state)}) IN (${transitions})) IS NOT TRUE`,
        [refuse],
        ""
      ),
      ...branch(
        `${col("NEW", columns.state)} = ${sqlLiteral(state.publishedState)} AND ${col("NEW", columns.primary)} IS NOT TRUE`,
        ["<<publication_gate>>", "BEGIN", "  NULL;", "END publication_gate;"],
        ""
      ),
    ]),
    "  RETURN NEW;",
    "END",
  ].join("\n")
}
