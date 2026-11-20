import { PLATFORM_ROLES, type DatabaseProvider } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import {
  executableBy,
  isSecurityDefiner,
  isTriggerFunction,
} from "../sql/definer-reads"
import { modelViews } from "../sql/function-body"
import { PUBLIC } from "../sql/grant-facts"
import type { SqlParser } from "../sql/parse"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { reachableUnits } from "../sql/reads"
import type { VerbatimUnit } from "../sql/units"
import {
  bodyKindTable,
  defaultPrivilegeFacts,
  defaultPrivilegeTables,
  grantDetail,
  grantedTables,
  qualifiedKindTables,
  writePaths,
} from "../sql/write-paths"
import type { SnapshotSources } from "./snapshot-sources"

const key = (name: { schema: string; name: string }) =>
  `${name.schema}.${name.name}`

const COMMAND = PLATFORM_ROLES.command

/**
 * Шлях запису в таблицю-виняток знімка, відкритий SQL застосунку ролі команд
 * чи `PUBLIC` (спека прав §7): на винятку тригера знімка немає, тож
 * запис у нього в транзакції команди змінив би факт актора повз знімок.
 * Модель — таблицю ніхто не пише без гранту, тож шлях відкривають: (а) грант
 * запису чи типові привілеї схеми, що його дають; (б) подання з грантом
 * запису над винятком без `security_invoker`; (в) функція чи процедура
 * `SECURITY DEFINER`, замикання якої пише виняток, коли її може виконати
 * роль команд; (г) така ж тригерна функція, яку SQL застосунку чіпляє до
 * будь-якої таблиці, — тригер `EXECUTE` не потребує. Живих ACL цільової бази
 * компілятор не бачить: роль команд створює платформа, тож давніх грантів їй
 * не буває, а новий іде через SQL застосунку. Гранти й подання дає
 * перелічувач шляхів запису; (в), (г) читають замикання функції самі, бо
 * перелічувач бачить лише тіло функції.
 *
 * Типові привілеї схеми судить уже Правило 1 (`defaultPrivileges`), тож сюди
 * вони доходять лише одним входом: `FOR ROLE` називає саму роль команд, що є
 * отримувачем, — Правило 1 такий ADP дозволяє (власник його об'єктів — вона
 * сама), а виняток знімка його судить, бо таблиці-виняток ця роль не створює,
 * а відкрите їй право було б новим шляхом запису.
 */
export function snapshotExemptWriters(
  sources: Pick<SnapshotSources, "exempt">,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  provider: DatabaseProvider | undefined
): Diagnostic[] {
  const tables = sources.exempt
    .filter((e) => e.reason !== "materializedView")
    .map((e) => e.table)
  if (tables.length === 0) return []
  const roles = new Set([COMMAND, PUBLIC])
  const exempt = qualifiedKindTables(tables)
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

  // (а), (б) Гранти запису, типові привілеї схеми й подання.
  const paths = writePaths(units, { kind: exempt, provider, parse, plpgsql })
  for (const path of paths) {
    const hit = path.roles.filter((r) => roles.has(r))
    if (hit.length === 0) continue
    if (path.form === "grant")
      for (const table of grantedTables(path, tables, parse))
        report(path.unit, {
          form: "grant",
          table: key(table),
          object: path.unit.identity,
          detail: grantDetail(path.unit, hit),
        })
    else if (path.form === "view" && exempt.qualified.has(path.target))
      report(path.unit, {
        form: "view",
        table: path.target,
        object: key(path.unit),
      })
  }
  for (const { unit, table, detail } of defaultPrivilegeTables(
    defaultPrivilegeFacts(units),
    roles,
    tables
  ))
    report(unit, {
      form: "grant",
      table: key(table),
      object: unit.identity,
      detail,
    })

  const views = modelViews(units) as VerbatimUnit[]
  // (в), (г) Функції `SECURITY DEFINER`, замикання яких пише виняток.
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
