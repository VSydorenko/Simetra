import { PLATFORM_ROLES } from "simetra/model"
import type { QualifiedName } from "../contracts"
import { diagnostic, type Diagnostic } from "../diagnostics"
import {
  executableBy,
  isSecurityDefiner,
  isSecurityInvoker,
  isTriggerFunction,
} from "../sql/definer-reads"
import { modelViews } from "../sql/function-body"
import { bodyKindTable, type KindTables } from "../sql/kind-table-verbatim"
import type { SqlParser } from "../sql/parse"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { reachableUnits, relationReads } from "../sql/reads"
import type { VerbatimUnit } from "../sql/units"
import { writeGrantPaths } from "../sql/write-paths"
import type { SnapshotSources } from "./snapshot-sources"

const key = (name: { schema: string; name: string }) =>
  `${name.schema}.${name.name}`

const COMMAND = PLATFORM_ROLES.command

/** Таблиці-винятки як `KindTables` — для обходу записів тіла. */
function exemptKindTables(tables: readonly QualifiedName[]): KindTables {
  const qualified = new Set<string>()
  const byName = new Map<string, string[]>()
  const bySchema = new Map<string, string[]>()
  for (const table of tables) {
    const k = key(table)
    qualified.add(k)
    byName.set(table.name, [...(byName.get(table.name) ?? []), k])
    bySchema.set(table.schema, [...(bySchema.get(table.schema) ?? []), k])
  }
  return { qualified, byName, bySchema }
}

/**
 * Шлях запису в таблицю-виняток знімка, відкритий SQL застосунку ролі команд
 * чи `PUBLIC` (спека прав §7, Р3-13): на винятку тригера знімка немає, тож
 * запис у нього в транзакції команди змінив би факт актора повз знімок.
 * Модель — таблицю ніхто не пише без гранту, тож шлях відкривають: (а) грант
 * запису чи типові привілеї схеми, що його дають; (б) подання з грантом
 * запису над винятком без `security_invoker`; (в) функція чи процедура
 * `SECURITY DEFINER`, замикання якої пише виняток, коли її може виконати
 * роль команд; (г) така ж тригерна функція, яку SQL застосунку чіпляє до
 * будь-якої таблиці, — тригер `EXECUTE` не потребує. Живих ACL цільової бази
 * компілятор не бачить: роль команд створює платформа, тож давніх грантів їй
 * не буває, а новий іде через SQL застосунку.
 */
export function snapshotExemptWriters(
  sources: Pick<SnapshotSources, "exempt">,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Diagnostic[] {
  const tables = sources.exempt
    .filter((e) => e.reason !== "materializedView")
    .map((e) => e.table)
  if (tables.length === 0) return []
  const roles = new Set([COMMAND])
  const found: Diagnostic[] = []
  const report = (
    unit: VerbatimUnit,
    params: { form: string; table: string; object: string; detail?: string }
  ) =>
    found.push(
      diagnostic("rights.snapshot-exempt-writer", unit.file, "", {
        ...params,
        line: unit.line,
      })
    )

  // (а) Гранти запису й типові привілеї схеми.
  for (const { unit, table, detail } of writeGrantPaths(
    units,
    tables,
    roles,
    parse
  ))
    report(unit, {
      form: "grant",
      table: key(table),
      object: unit.identity,
      detail,
    })

  // (б) Подання над винятком з грантом запису ролі команд чи `PUBLIC`.
  const exemptKeys = new Set(tables.map(key))
  const exemptNames = new Set(tables.map((t) => t.name))
  const views = modelViews(units) as VerbatimUnit[]
  const viewTable = (
    view: VerbatimUnit,
    visited: ReadonlySet<string>
  ): string | undefined => {
    for (const ref of relationReads(view, units, parse, plpgsql)) {
      if (ref.schema !== undefined && exemptKeys.has(key(ref as QualifiedName)))
        return key(ref as QualifiedName)
      if (ref.schema === undefined && exemptNames.has(ref.name))
        return [...exemptKeys].find((k) => k.endsWith(`.${ref.name}`))
      for (const inner of views) {
        const id = key(inner)
        if (
          inner.class !== "view" ||
          visited.has(id) ||
          inner.name !== ref.name ||
          (ref.schema !== undefined && inner.schema !== ref.schema)
        )
          continue
        const table = viewTable(inner, new Set([...visited, id]))
        if (table !== undefined) return table
      }
    }
    return undefined
  }
  const writableViews = views.flatMap((view) => {
    if (view.class !== "view" || isSecurityInvoker(view)) return []
    const table = viewTable(view, new Set([key(view)]))
    return table === undefined ? [] : [{ view, table }]
  })
  for (const { unit, table } of writeGrantPaths(
    units,
    writableViews.map(({ view }) => view),
    roles,
    parse
  )) {
    const over = writableViews.find(({ view }) => key(view) === key(table))!
    report(unit, {
      form: "view",
      table: over.table,
      object: key(table),
    })
  }

  // (в), (г) Функції `SECURITY DEFINER`, замикання яких пише виняток.
  const exempt = exemptKindTables(tables)
  const written = (fn: VerbatimUnit): string | undefined => {
    for (const reader of [fn, ...reachableUnits(fn, units, parse, plpgsql)]) {
      const body = bodyKindTable(reader, exempt, parse, plpgsql, views)
      if (body !== undefined) return body.table
    }
    return undefined
  }
  const attached = new Set(
    units.flatMap((unit) => {
      const stmt = (
        unit.tree as {
          CreateTrigStmt?: { funcname?: { String?: { sval?: string } }[] }
        }
      ).CreateTrigStmt
      if (unit.class !== "trigger" || stmt === undefined) return []
      const names = (stmt.funcname ?? []).map((n) => n.String?.sval ?? "")
      return [names.join(".")]
    })
  )
  const isAttached = (fn: VerbatimUnit) =>
    attached.has(key(fn)) || attached.has(fn.name)
  for (const fn of units) {
    if (!isSecurityDefiner(fn, units)) continue
    const trigger = isTriggerFunction(fn)
    if (trigger ? !isAttached(fn) : !executableBy(fn, units, COMMAND, parse))
      continue
    const table = written(fn)
    if (table === undefined) continue
    report(fn, {
      form: trigger ? "trigger" : "definer",
      table,
      object: key(fn),
    })
  }
  return found
}
