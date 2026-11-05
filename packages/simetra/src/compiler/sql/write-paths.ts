import type { AccessPriv, GrantStmt, Node, RoleSpec } from "libpg-query"
import type { SqlParser } from "./parse"
import { unitTargets } from "./unit-target"
import type { SqlUnit } from "./units"

/** Таблиця у фізичних іменах. */
export interface QualifiedTable {
  schema: string
  name: string
}

/** Шлях запису: одиниця, що відкриває запис у таблицю, і як саме. */
export interface WriteGrantPath<U> {
  unit: U
  table: QualifiedTable
  /** `GRANT …` чи типові привілеї схеми — текст для повідомлення. */
  detail: string
}

/** Привілеї, що відкривають запис у таблицю (`ALL` їх містить). */
const WRITE_PRIVILEGES: ReadonlySet<string> = new Set([
  "insert",
  "update",
  "delete",
  "truncate",
])

/**
 * Гранти запису в таблиці `tables` ролям `roles` чи `PUBLIC` — спільний
 * розбір гейта шляху запису промоції (спека промоції §8) і правила
 * `rights.snapshot-exempt-writer` (спека прав §7). Запис відкривають грант
 * запису (табличний чи поколонковий) і типові привілеї схеми таблиці, що
 * дають такий грант на таблиці: зворотна генерація не пише явного `GRANT`,
 * коли ACL таблиці дорівнює типовим. Глобальні типові привілеї ролі (без
 * `IN SCHEMA`) — поза межею: вони належать ролі, а не схемі (спека промоції
 * §9.9). Читається лише дерево одиниць.
 */
export function writeGrantPaths<
  U extends Pick<SqlUnit, "class" | "schema" | "sql" | "tree">,
>(
  units: readonly U[],
  tables: readonly QualifiedTable[],
  roles: ReadonlySet<string>,
  parse: SqlParser
): WriteGrantPath<U>[] {
  const schemas = new Set(tables.map((t) => t.schema))
  const paths: WriteGrantPath<U>[] = []
  for (const unit of units) {
    const tree = unit.tree as Node
    if ("GrantStmt" in tree && unit.class === "grant") {
      const grant = tree.GrantStmt
      const written = writeGrant(grant, roles)
      if (written === undefined || grant.objtype !== "OBJECT_TABLE") continue
      for (const target of unitTargets(unit, parse)) {
        // `ON ALL TABLES IN SCHEMA s` дає ціль-схему: вона охоплює таблицю.
        const hit =
          target.kind === "schema"
            ? tables.filter((t) => t.schema === target.schema)
            : tables.filter(
                (t) => t.schema === target.schema && t.name === target.object
              )
        for (const table of hit)
          paths.push({ unit, table, detail: `GRANT ${written}` })
      }
      continue
    }
    if ("AlterDefaultPrivilegesStmt" in tree) {
      const action = tree.AlterDefaultPrivilegesStmt.action
      if (action === undefined || action.objtype !== "OBJECT_TABLE") continue
      const written = writeGrant(action, roles)
      if (written === undefined) continue
      for (const target of unitTargets(unit, parse)) {
        if (!schemas.has(target.schema)) continue
        for (const table of tables.filter((t) => t.schema === target.schema))
          paths.push({
            unit,
            table,
            detail: `default privileges of schema ${target.schema} GRANT ${written} ON TABLES`,
          })
      }
    }
  }
  return paths
}

/**
 * Привілеї запису гранту ролям `roles` чи `PUBLIC` у тексті для повідомлення;
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
