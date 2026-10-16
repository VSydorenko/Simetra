import {
  quoteIdent,
  type ApiRolePurpose,
  type DatabaseProvider,
} from "simetra/model"
import type { QualifiedName } from "./contracts"
import { compareStrings, diagnostic, type Diagnostic } from "./diagnostics"
import { executeGrants } from "./sql/execute-grants"
import type { SqlParser } from "./sql/parse"
import { generatedUnit, grantObjects, type SqlUnit } from "./sql/units"

/**
 * `EXECUTE` функцій, які оголошують метадані (платформна спека §6.7): функцію
 * множини виду скоупу викликає політика від імені запиту, тож її виконують
 * роль користувача й сервісна; обробник підписки викликає тригер без
 * `EXECUTE` у ролі, що пише, тож він не потрібен жодній ролі API. Функцію
 * множини `membership` сюди не передають: її гранти дає генератор членства.
 * Одна функція в кількох видах скоупу чи підписках — одна група грантів.
 */
export function buildFunctionExecuteUnits(
  setFunctions: readonly QualifiedName[],
  handlers: readonly QualifiedName[],
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  const groups = new Map<
    string,
    { fn: QualifiedName; purposes: ApiRolePurpose[] }
  >()
  // Функція множини (`SETOF uuid`) і обробник (`trigger`) — різні функції за
  // правилами стадії 5, тож перша назва не перекриває другу на чистій моделі.
  for (const fn of setFunctions)
    if (!groups.has(key(fn)))
      groups.set(key(fn), { fn, purposes: ["user", "service"] })
  for (const fn of handlers)
    if (!groups.has(key(fn))) groups.set(key(fn), { fn, purposes: [] })
  return [...groups.values()]
    .flatMap(({ fn, purposes }) =>
      executeGrants(
        `${quoteIdent(fn.schema)}.${quoteIdent(fn.name)}()`,
        purposes,
        provider
      ).map((sql): SqlUnit => ({
        ...generatedUnit(sql, fn.schema, parse),
        module,
        generator: "functionExecute",
      }))
    )
    .sort((a, b) => compareStrings(a.identity, b.identity))
}

const key = (fn: QualifiedName) => `${fn.schema}.${fn.name}`

/**
 * Дослівний грант на об'єкт, правами якого володіє платформа (рішення 9 плану
 * П3-3a1): на функцію чи таблицю, що є ціллю згенерованої одиниці `grant`.
 * Функцію звірено повною канонічною сигнатурою: грант на інше перевантаження
 * тієї самої назви — не її. `flagged` — одиниці з цією помилкою: тотожний
 * згенерованому оператор інакше дістав би ще й `sql.unit-duplicate`.
 */
export function generatedGrantConflicts(
  units: readonly SqlUnit[],
  parse: SqlParser
): { diagnostics: Diagnostic[]; flagged: ReadonlySet<SqlUnit> } {
  const owned = platformGrantTargets(units, parse)
  const diagnostics: Diagnostic[] = []
  const flagged = new Set<SqlUnit>()
  for (const unit of units) {
    if (unit.file === undefined || unit.class !== "grant") continue
    const objects = grantTargetKeys(unit, parse)
      .filter((target) => ownsTarget(owned, target))
      .map(targetName)
    if (objects.length === 0) continue
    flagged.add(unit)
    diagnostics.push(
      diagnostic("sql.generated-grant", unit.file, "", {
        identity: unit.identity,
        line: unit.line ?? 0,
        object: objects.join(", "),
      })
    )
  }
  return { diagnostics, flagged }
}

/**
 * Цілі згенерованих грантів — об'єкти, ACL яких належить платформі. Ключ —
 * `function|<сигнатура>` чи `table|<схема.ім'я>`: `grantTargetKeys`.
 */
export function platformGrantTargets(
  units: readonly Pick<SqlUnit, "class" | "name" | "sql" | "file">[],
  parse: SqlParser
): Set<string> {
  return new Set(
    units
      .filter((unit) => unit.file === undefined && unit.class === "grant")
      .flatMap((unit) => grantTargetKeys(unit, parse))
  )
}

/**
 * Чи ціль гранту — об'єкт платформи. `ON FUNCTION f` без списку аргументів
 * Postgres резолвить у єдину функцію з цим ім'ям, тож вона збігається з
 * функцією платформи тієї самої схеми й імені.
 */
export function ownsTarget(
  owned: ReadonlySet<string>,
  target: string
): boolean {
  if (owned.has(target)) return true
  if (!target.startsWith("function|") || target.endsWith(")")) return false
  return [...owned].some((o) => o.startsWith(`${target}(`))
}

const TARGET_KINDS: Readonly<Record<string, "function" | "table">> = {
  OBJECT_FUNCTION: "function",
  OBJECT_PROCEDURE: "function",
  OBJECT_ROUTINE: "function",
  OBJECT_TABLE: "table",
}

/**
 * Цілі гранту-функції чи гранту-таблиці; ціль іншого виду (схема, тип,
 * послідовність) платформі в цьому правилі не належить, тож ключа не має.
 */
export function grantTargetKeys(
  unit: Pick<SqlUnit, "class" | "name" | "sql">,
  parse: SqlParser
): string[] {
  if (unit.class !== "grant") return []
  const parsed = parse(unit.sql)
  const stmt = parsed.ok ? parsed.statements[0]?.stmt : undefined
  if (stmt === undefined || !("GrantStmt" in stmt)) return []
  const kind = TARGET_KINDS[stmt.GrantStmt.objtype ?? ""]
  if (kind === undefined) return []
  return grantObjects(unit.name).map((name) => `${kind}|${name}`)
}

const targetName = (target: string) => target.slice(target.indexOf("|") + 1)
