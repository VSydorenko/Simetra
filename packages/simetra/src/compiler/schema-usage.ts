import type { Node } from "libpg-query"
import { PLATFORM_SCHEMA, quoteIdent } from "simetra/model"
import { compareStrings } from "./diagnostics"
import type { SqlParser } from "./sql/parse"
import { generatedUnit, type SqlUnit } from "./sql/units"

/** Види об'єктів гранту, яким без `USAGE` на схему грант не діє. */
const SCHEMA_OBJECTS: ReadonlySet<string> = new Set([
  "OBJECT_TABLE",
  "OBJECT_FUNCTION",
  "OBJECT_PROCEDURE",
  "OBJECT_ROUTINE",
])

/** Схеми й отримувачі згенерованого `GRANT` (не `REVOKE`); `PUBLIC` — ні. */
function grantedInSchemas(unit: SqlUnit): {
  schemas: string[]
  roles: string[]
} {
  const tree = unit.tree as Node
  if (!("GrantStmt" in tree)) return { schemas: [], roles: [] }
  const stmt = tree.GrantStmt
  if (stmt.is_grant !== true || !SCHEMA_OBJECTS.has(stmt.objtype ?? ""))
    return { schemas: [], roles: [] }
  const schemas = (stmt.objects ?? []).flatMap((object): string[] => {
    if ("RangeVar" in object)
      return object.RangeVar.schemaname === undefined
        ? []
        : [object.RangeVar.schemaname]
    if ("ObjectWithArgs" in object) {
      const names = (object.ObjectWithArgs.objname ?? []).map((n) =>
        "String" in n ? (n.String.sval ?? "") : ""
      )
      return names.length > 1 ? [names[0]!] : []
    }
    return []
  })
  const roles = (stmt.grantees ?? []).flatMap((grantee): string[] =>
    "RoleSpec" in grantee &&
    grantee.RoleSpec.roletype === "ROLESPEC_CSTRING" &&
    grantee.RoleSpec.rolename !== undefined
      ? [grantee.RoleSpec.rolename]
      : []
  )
  return { schemas, roles }
}

/**
 * `USAGE` на схему застосунку (платформна спека §6.7): грант на таблицю чи
 * функцію ролі не дасть нічого без доступу до її схеми, тож кожному
 * отримувачу згенерованого гранту платформа дає `USAGE` на схему об'єкта.
 * `public` — схема провайдера з вбудованим `USAGE` для `PUBLIC` і грантами
 * пресету, `simetra` — схема платформного шару зі своїми грантами
 * (`platformSchemaGrants`); їх правило не чіпає.
 *
 * Схему ділять об'єкти платформи й власні об'єкти застосунку, тож `USAGE`
 * тій самій ролі буває й законною потребою застосунку. Тотожна дослівна
 * одиниця (та сама ідентичність, у будь-якому варіанті оператора) тому
 * перемагає: згенерована тоді не з'являється, і коли потреба платформи
 * зникає, грант застосунку лишається, а план його не відкликає.
 */
export function buildSchemaUsageUnits(
  units: readonly SqlUnit[],
  module: string,
  parse: SqlParser
): SqlUnit[] {
  const verbatim = new Set(
    units.filter((u) => u.file !== undefined).map((u) => u.identity)
  )
  const grantees = new Map<string, Set<string>>()
  for (const unit of units) {
    if (unit.file !== undefined || unit.class !== "grant") continue
    const { schemas, roles } = grantedInSchemas(unit)
    for (const schema of schemas) {
      if (schema === "public" || schema === PLATFORM_SCHEMA) continue
      const set = grantees.get(schema) ?? new Set<string>()
      for (const role of roles) set.add(role)
      grantees.set(schema, set)
    }
  }
  return [...grantees]
    .flatMap(([schema, roles]) =>
      [...roles].map((role): SqlUnit => ({
        ...generatedUnit(
          `GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)};`,
          schema,
          parse
        ),
        module,
        generator: "schemaUsage",
      }))
    )
    .filter((unit) => !verbatim.has(unit.identity))
    .sort((a, b) => compareStrings(a.identity, b.identity))
}
