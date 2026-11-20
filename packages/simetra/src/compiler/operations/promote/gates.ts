import type { Node } from "libpg-query"
import {
  PROVIDER_API_ROLES,
  PROVIDER_IDENTITY_SOURCES,
  type MetadataRef,
} from "simetra/model"
import type { CompiledModel } from "../../compile"
import { diagnostic, type Diagnostic } from "../../diagnostics"
import { PUBLIC } from "../../sql/grant-facts"
import type { SqlParser } from "../../sql/parse"
import type { PlpgsqlParser } from "../../sql/plpgsql"
import type { VerbatimUnit } from "../../sql/units"
import {
  defaultPrivilegeFacts,
  defaultPrivilegeTables,
  grantDetail,
  grantedTables,
  qualifiedKindTables,
  writePaths,
  type QualifiedTable,
  type WritePath,
} from "../../sql/write-paths"
import type { PromotedTable } from "./mapping"

/** Таблиця у фізичних іменах до промоції. */
export type { QualifiedTable }

/** Команди політики, що пропускають запис; `ALL` — кожну з них. */
const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "all",
  "insert",
  "update",
  "delete",
])

const key = (schema: string, name: string) => `${schema}.${name}`

/**
 * Одиниці з файлом і рядком — їх судить перелічувач; згенеровані (рухи,
 * платформний шар) тексту застосунку не мають.
 */
function locatedUnits(model: CompiledModel): VerbatimUnit[] {
  return model.sqlUnits.filter(
    (u): u is typeof u & VerbatimUnit =>
      u.file !== undefined && u.line !== undefined
  )
}

/**
 * Шляхи запису перелічувача над таблицями промоції: таблиці до промоції ще
 * `CustomTable`, тож «таблиці виду» для нього — самі вони.
 */
function promotedPaths(
  model: CompiledModel,
  units: readonly VerbatimUnit[],
  tables: readonly QualifiedTable[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): WritePath[] {
  return writePaths(units, {
    kind: qualifiedKindTables(tables),
    provider: model.project.database.provider,
    parse,
    plpgsql,
  })
}

/**
 * Гейт шляху запису (спека промоції §8, Пр21): прийнята таблиця
 * одиниці, у яку ролі API провайдера пишуть напряму, — відмова, доки шлях
 * запису після промоції не вирішено (спека промоції §16). Запис відкривають: грант запису
 * цим ролям чи `PUBLIC`; типові привілеї схеми таблиці, що дають їм такий
 * грант на таблиці (зворотна генерація не пише явного `GRANT`, коли ACL
 * таблиці дорівнює типовим — саме так виглядає типова схема Supabase);
 * подання без `security_invoker` над таблицею, яке ці ролі пишуть; і
 * політика команди запису. Читається лише дерево одиниць — до будь-яких змін.
 * Грант, політику й подання дає перелічувач шляхів запису; типові привілеї
 * ролям API Правило 1 дозволяє, тож їх гейт читає з фактів ADP сам.
 */
export function writePathProblems(
  model: CompiledModel,
  tables: readonly QualifiedTable[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Diagnostic[] {
  const unit = new Set(tables.map((t) => key(t.schema, t.name)))
  const roles = new Set([
    PUBLIC,
    ...Object.values(
      PROVIDER_API_ROLES[model.project.database.provider]
    ).filter((role): role is string => role !== null),
  ])
  const located = locatedUnits(model)
  const paths = promotedPaths(model, located, tables, parse, plpgsql)
  const adp = defaultPrivilegeTables(
    defaultPrivilegeFacts(located),
    roles,
    tables
  )
  const problems: Diagnostic[] = []
  // Порядок — порядок одиниць: грант і політика однієї одиниці не
  // розходяться в переліку.
  for (const sqlUnit of located) {
    const entries: { table: string; detail: string }[] = []
    for (const path of paths.filter((p) => p.unit === sqlUnit)) {
      const hit = path.roles.filter((r) => roles.has(r))
      if (path.form === "grant" && hit.length > 0)
        entries.push(
          ...grantedTables(path, tables, parse).map((t) => ({
            table: key(t.schema, t.name),
            detail: grantDetail(sqlUnit, hit),
          }))
        )
      else if (path.form === "view" && hit.length > 0 && unit.has(path.target))
        entries.push({
          table: path.target,
          detail: `view ${sqlUnit.schema}.${sqlUnit.name} without security_invoker, writable by ${hit.join(", ")}`,
        })
      else if (path.form === "policy" && unit.has(path.target)) {
        const policy = (
          sqlUnit.tree as Node as { CreatePolicyStmt?: PolicyTree }
        ).CreatePolicyStmt
        const command = policy?.cmd_name ?? "all"
        if (WRITE_COMMANDS.has(command))
          entries.push({
            table: path.target,
            detail: `policy ${policy?.policy_name ?? ""} FOR ${command.toUpperCase()}`,
          })
      }
    }
    // Типові привілеї схеми судить спільний помічник перелічувача.
    for (const { table, detail } of adp.filter((a) => a.unit === sqlUnit))
      entries.push({ table: key(table.schema, table.name), detail })
    for (const { table, detail } of entries)
      problems.push(
        diagnostic("promote.write-path", sqlUnit.file, "", {
          table,
          detail,
          identity: sqlUnit.identity,
          line: sqlUnit.line,
        })
      )
  }
  return problems
}

interface PolicyTree {
  policy_name?: string
  cmd_name?: string
}

/**
 * Правило 4 (спека промоції §9.4): промоція не переносить старий код, що пише
 * промотовану таблицю. Після промоції вона — таблиця виду, і така одиниця
 * дала б `sql.kind-table-verbatim` (Правило 1); гейт називає кожну до змін,
 * тож автор бачить увесь перелік, а не першу відмову компіляції результату.
 * Таблиці виду складаються з промотованих таблиць вручну: `kindTables` їх не
 * дасть, бо до промоції вони ще `CustomTable`.
 */
export function debtWritesProblems(
  model: CompiledModel,
  tables: readonly QualifiedTable[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Diagnostic[] {
  const unit = new Set(tables.map((t) => key(t.schema, t.name)))
  const located = locatedUnits(model)
  return promotedPaths(model, located, tables, parse, plpgsql).flatMap(
    (path) =>
      path.form === "functionBody" && unit.has(path.target)
        ? [
            diagnostic("promote.debt-writes-table", path.unit.file, "", {
              identity: path.unit.identity,
              table: path.target,
              statement: path.statement ?? "",
              line: path.unit.line,
            }),
          ]
        : []
  )
}

/** Таблиця користувачів провайдера бази проєкту (§9.10). */
export function providerUsersTable(model: CompiledModel): QualifiedTable {
  return PROVIDER_IDENTITY_SOURCES[model.project.database.provider].table
}

/**
 * Зовнішній FK колонки на таблицю користувачів провайдера (спека промоції
 * §9.10): промотується лише носій скоупу виду, корінь якого — саме ця
 * таблиця (власник особистих записів). Решта — профіль, членство чи
 * авторство — чекає довідника «Користувачі»: ні мовчазного зняття FK, ні
 * довільного зовнішнього `Ref` у виді.
 */
export function providerUserProblems(
  model: CompiledModel,
  promoted: readonly PromotedTable[]
): Diagnostic[] {
  const users = providerUsersTable(model)
  const problems: Diagnostic[] = []
  for (const { object, table, columns } of promoted) {
    const scopeKind = model.project.scopeKinds.find(
      (kind) => kind.name === table.scope
    )
    const root = scopeKind?.root
    const rootIsUsers =
      root !== undefined &&
      "external" in root &&
      root.external.schema === users.schema &&
      root.external.table === users.name
    for (const { index, column, fate } of columns) {
      const references = (table.foreignKeys ?? []).filter(
        (fk) =>
          fk.columns.includes(column.name) &&
          "external" in fk.references &&
          fk.references.external.schema === users.schema &&
          fk.references.external.table === users.name
      )
      if (references.length === 0) continue
      if (fate.to === "scope" && rootIsUsers) continue
      problems.push(
        diagnostic(
          "promote.provider-user-reference",
          object.file,
          `/columns/${index}`,
          { table: object.name, column: column.name }
        )
      )
    }
  }
  return problems
}

/** FK на таблицю користувачів провайдера: його судить гейт, а не файл виду. */
export function referencesProviderUsers(
  model: CompiledModel,
  references: { external: { schema: string; table: string } } | MetadataRef
): boolean {
  if (!("external" in references)) return false
  const users = providerUsersTable(model)
  return (
    references.external.schema === users.schema &&
    references.external.table === users.name
  )
}
