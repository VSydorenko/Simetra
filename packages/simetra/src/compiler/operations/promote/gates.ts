import type { AccessPriv, GrantStmt, Node, RoleSpec } from "libpg-query"
import {
  PROVIDER_API_ROLES,
  PROVIDER_IDENTITY_SOURCES,
  type MetadataRef,
} from "simetra/model"
import type { CompiledModel } from "../../compile"
import { diagnostic, type Diagnostic } from "../../diagnostics"
import { modelViews } from "../../sql/function-body"
import { bodyKindTable, type KindTables } from "../../sql/kind-table-verbatim"
import type { SqlParser } from "../../sql/parse"
import type { PlpgsqlParser } from "../../sql/plpgsql"
import { unitTargets } from "../../sql/unit-target"
import type { PromotedTable } from "./mapping"

/** Таблиця у фізичних іменах до промоції. */
export interface QualifiedTable {
  schema: string
  name: string
}

/** Привілеї, що відкривають запис у таблицю (`ALL` їх містить). */
const WRITE_PRIVILEGES: ReadonlySet<string> = new Set([
  "insert",
  "update",
  "delete",
  "truncate",
])

/** Команди політики, що пропускають запис; `ALL` — кожну з них. */
const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "all",
  "insert",
  "update",
  "delete",
])

const key = (schema: string, name: string) => `${schema}.${name}`

/**
 * Гейт шляху запису (спека промоції §8, Пр21): прийнята таблиця
 * одиниці, у яку ролі API провайдера пишуть напряму, — відмова, доки шлях
 * запису після промоції не вирішено (спека промоції §16). Запис відкривають: грант запису
 * цим ролям чи `PUBLIC`; типові привілеї схеми таблиці, що дають їм такий
 * грант на таблиці (зворотна генерація не пише явного `GRANT`, коли ACL
 * таблиці дорівнює типовим — саме так виглядає типова схема Supabase); і
 * політика команди запису. Читається лише дерево одиниць — до будь-яких змін.
 */
export function writePathProblems(
  model: CompiledModel,
  tables: readonly QualifiedTable[],
  parse: SqlParser
): Diagnostic[] {
  const unit = new Set(tables.map((t) => key(t.schema, t.name)))
  const schemas = new Set(tables.map((t) => t.schema))
  const roles = new Set(
    Object.values(PROVIDER_API_ROLES[model.project.database.provider])
  )
  const problems: Diagnostic[] = []
  for (const sqlUnit of model.sqlUnits) {
    if (sqlUnit.file === undefined || sqlUnit.line === undefined) continue
    const { file, line } = sqlUnit
    const refuse = (table: string, detail: string) =>
      problems.push(
        diagnostic("promote.write-path", file, "", {
          table,
          detail,
          identity: sqlUnit.identity,
          line,
        })
      )
    const tree = sqlUnit.tree as Node
    if ("GrantStmt" in tree && sqlUnit.class === "grant") {
      const grant = tree.GrantStmt
      const written = writeGrant(grant, roles)
      if (written === undefined || grant.objtype !== "OBJECT_TABLE") continue
      for (const target of unitTargets(sqlUnit, parse)) {
        // `ON ALL TABLES IN SCHEMA s` дає ціль-схему: вона охоплює таблицю.
        const hit =
          target.kind === "schema"
            ? tables.filter((t) => t.schema === target.schema)
            : tables.filter(
                (t) => t.schema === target.schema && t.name === target.object
              )
        for (const t of hit) {
          refuse(key(t.schema, t.name), `GRANT ${written}`)
        }
      }
      continue
    }
    if ("AlterDefaultPrivilegesStmt" in tree) {
      const stmt = tree.AlterDefaultPrivilegesStmt
      const action = stmt.action
      if (action === undefined || action.objtype !== "OBJECT_TABLE") continue
      const written = writeGrant(action, roles)
      if (written === undefined) continue
      // Глобальні типові привілеї ролі (без `IN SCHEMA`) — поза межею гейта
      // (спека промоції §9.9): вони належать ролі, а не схемі.
      for (const target of unitTargets(sqlUnit, parse)) {
        if (!schemas.has(target.schema)) continue
        for (const t of tables.filter((t) => t.schema === target.schema)) {
          refuse(
            key(t.schema, t.name),
            `default privileges of schema ${target.schema} GRANT ${written} ON TABLES`
          )
        }
      }
      continue
    }
    if ("CreatePolicyStmt" in tree) {
      const policy = tree.CreatePolicyStmt
      const command = policy.cmd_name ?? "all"
      if (!WRITE_COMMANDS.has(command)) continue
      const schema = policy.table?.schemaname ?? sqlUnit.schema
      const table = policy.table?.relname ?? ""
      if (!unit.has(key(schema, table))) continue
      refuse(
        key(schema, table),
        `policy ${policy.policy_name ?? ""} FOR ${command.toUpperCase()}`
      )
    }
  }
  return problems
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
  const qualified = new Set<string>()
  const byName = new Map<string, string[]>()
  const bySchema = new Map<string, string[]>()
  for (const t of tables) {
    const k = key(t.schema, t.name)
    qualified.add(k)
    byName.set(t.name, [...(byName.get(t.name) ?? []), k])
    bySchema.set(t.schema, [...(bySchema.get(t.schema) ?? []), k])
  }
  const promoted: KindTables = { qualified, byName, bySchema }
  const views = modelViews(model.sqlUnits)
  return model.sqlUnits.flatMap((unit) => {
    if (unit.file === undefined || unit.line === undefined) return []
    const body = bodyKindTable(unit, promoted, parse, plpgsql, views)
    if (body === undefined) return []
    return [
      diagnostic("promote.debt-writes-table", unit.file, "", {
        identity: unit.identity,
        table: body.table,
        statement: body.statement,
        line: unit.line,
      }),
    ]
  })
}

/**
 * Привілеї запису гранту ролям API чи `PUBLIC` у тексті для повідомлення;
 * `undefined` — грант не відкриває запису цим ролям. `REVOKE` запису не дає.
 */
function writeGrant(
  grant: GrantStmt,
  roles: ReadonlySet<string>
): string | undefined {
  if (grant.is_grant !== true) return undefined
  const grantees = (grant.grantees ?? []).flatMap((n) =>
    "RoleSpec" in n ? [n.RoleSpec as RoleSpec] : []
  )
  const named = grantees.flatMap((r) =>
    r.roletype === "ROLESPEC_PUBLIC"
      ? ["PUBLIC"]
      : r.rolename !== undefined && roles.has(r.rolename)
        ? [r.rolename]
        : []
  )
  if (named.length === 0) return undefined
  const privileges = (grant.privileges ?? []).flatMap((n) =>
    "AccessPriv" in n ? [n.AccessPriv as AccessPriv] : []
  )
  // Порожній перелік привілеїв — `ALL [PRIVILEGES]`.
  const writes =
    privileges.length === 0
      ? ["ALL"]
      : privileges
          // `ALL (колонки)` — привілей без імені з переліком колонок.
          .map((p) => p.priv_name ?? "all")
          .filter((p) => p === "all" || WRITE_PRIVILEGES.has(p))
          .map((p) => p.toUpperCase())
  if (writes.length === 0) return undefined
  return `${writes.join(", ")} TO ${named.join(", ")}`
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
