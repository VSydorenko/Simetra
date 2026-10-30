import type { Node } from "libpg-query"
import type { SqlParser } from "simetra/compiler"
import { quoteIdent } from "simetra/model"
import type { EngineAction, EngineDiagnostic, EngineObjectRef } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import type { ApplyTransaction } from "./port"
import { stringsOf } from "./type-guard"

/**
 * Глобальні типові привілеї ролі (спека промоції
 * §7.2, «Середовище», Пр22). Вони поза межею двигуна й поза відбитком, але
 * Postgres застосовує їх до кожного об'єкта, який створює план. Тож план
 * записує їх рядками `aclexplode`, засіває ними копію доказу, а залишок
 * двигуна на тій копії стає кроками середовища.
 */

/**
 * Види `defaclobjtype`, які глобальний ADP може мати на PG17: таблиці,
 * послідовності, функції, типи, схеми.
 */
export const DEFAULT_PRIVILEGE_OBJTYPES = ["r", "S", "f", "T", "n"] as const

/** Рядок `aclexplode` одного глобального ADP ролі плану. */
export interface GlobalDefaultPrivilege {
  objtype: (typeof DEFAULT_PRIVILEGE_OBJTYPES)[number]
  /** Ім'я ролі або `PUBLIC`. */
  grantee: string
  /** Привілей, як його називає `aclexplode` (`SELECT`, `EXECUTE`, …). */
  privilege: string
  grantable: boolean
}

/** Слово виду в `ALTER DEFAULT PRIVILEGES … ON <вид>`. */
const OBJTYPE_WORDS: Readonly<
  Record<GlobalDefaultPrivilege["objtype"], string>
> = {
  r: "TABLES",
  S: "SEQUENCES",
  f: "FUNCTIONS",
  T: "TYPES",
  n: "SCHEMAS",
}

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/** Порядок за всіма полями, кодовими одиницями: від локалі він не залежить. */
const comparePrivileges = (
  a: GlobalDefaultPrivilege,
  b: GlobalDefaultPrivilege
): number =>
  byCodeUnit(a.objtype, b.objtype) ||
  byCodeUnit(a.grantee, b.grantee) ||
  byCodeUnit(a.privilege, b.privilege) ||
  Number(a.grantable) - Number(b.grantable)

/**
 * Глобальні типові привілеї ролі (`defaclnamespace = 0`) рядками
 * `aclexplode`, а не текстом `aclitem`: рендер засіву тоді не розбирає лапки
 * й `*`. Один запит і для плану, і для звірки засіву копії, і для раннера.
 * Великі об'єкти (`L`, PG18) — поза переліком: план їх не створює.
 */
export async function readGlobalDefaultPrivileges(
  tx: ApplyTransaction,
  role: string
): Promise<GlobalDefaultPrivilege[]> {
  const rows = await tx.query<{
    objtype: string
    grantee: string
    privilege: string
    grantable: boolean
  }>(
    `SELECT d.defaclobjtype::text AS objtype,
       CASE WHEN x.grantee = 0 THEN 'PUBLIC'
         ELSE pg_catalog.pg_get_userbyid(x.grantee) END AS grantee,
       x.privilege_type AS privilege, x.is_grantable AS grantable
     FROM pg_catalog.pg_default_acl d
     CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) x
     WHERE d.defaclnamespace = 0
       AND d.defaclrole = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = $1)
       AND d.defaclobjtype IN (${DEFAULT_PRIVILEGE_OBJTYPES.map((t) => `'${t}'`).join(", ")})`,
    [role]
  )
  return rows
    .map((r) => ({
      objtype: r.objtype as GlobalDefaultPrivilege["objtype"],
      grantee: r.grantee,
      privilege: r.privilege,
      grantable: r.grantable,
    }))
    .sort(comparePrivileges)
}

const granteeSql = (grantee: string): string =>
  grantee === "PUBLIC" ? "PUBLIC" : quoteIdent(grantee)

/**
 * Засів копії: на кожен вид із переліку спершу знімається все, що дають
 * вбудовані права (`PUBLIC` і сама роль), далі видається кожен рядок.
 * Глобальний ADP замінює `acldefault` виду, тож так копія отримує рівно
 * перелік цілі — і перелік із самим лише «роль собі» теж.
 */
export function renderGlobalDefaultPrivileges(
  role: string,
  privileges: readonly GlobalDefaultPrivilege[]
): string[] {
  const prefix = `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(role)}`
  const sorted = [...privileges].sort(comparePrivileges)
  const kinds = [...new Set(sorted.map((p) => p.objtype))]
  return kinds.flatMap((objtype) => {
    const on = OBJTYPE_WORDS[objtype]
    return [
      `${prefix} REVOKE ALL ON ${on} FROM PUBLIC, ${quoteIdent(role)}`,
      ...sorted
        .filter((p) => p.objtype === objtype)
        .map(
          (p) =>
            `${prefix} GRANT ${p.privilege} ON ${on} TO ${granteeSql(p.grantee)}${p.grantable ? " WITH GRANT OPTION" : ""}`
        ),
    ]
  })
}

/** Чи розходяться два переліки як множини рядків. */
export function environmentMismatch(
  expected: readonly GlobalDefaultPrivilege[],
  actual: readonly GlobalDefaultPrivilege[]
): boolean {
  const canonical = (list: readonly GlobalDefaultPrivilege[]) =>
    JSON.stringify(
      [...list]
        .sort(comparePrivileges)
        .map((p) => [p.objtype, p.grantee, p.privilege, p.grantable])
    )
  return canonical(expected) !== canonical(actual)
}

/** Вид у `produced` за `objtype` оператора `GRANT`/`REVOKE`. */
const GRANT_KINDS: Readonly<Record<string, readonly string[]>> = {
  OBJECT_TABLE: ["table", "view", "materializedView", "foreignTable"],
  OBJECT_SEQUENCE: ["sequence"],
  OBJECT_FUNCTION: ["function", "procedure", "aggregate"],
  OBJECT_PROCEDURE: ["function", "procedure", "aggregate"],
  OBJECT_ROUTINE: ["function", "procedure", "aggregate"],
  OBJECT_TYPE: ["type", "domain"],
  OBJECT_DOMAIN: ["type", "domain"],
}

/** Схема й ім'я об'єкта гранту; некваліфіковане ім'я — `undefined`. */
function grantObject(node: Node): { schema: string; name: string } | undefined {
  let parts: string[] = []
  if ("RangeVar" in node) {
    const { schemaname, relname } = node.RangeVar
    parts = [schemaname ?? "", relname ?? ""]
  } else if ("ObjectWithArgs" in node)
    parts = stringsOf(node.ObjectWithArgs.objname ?? [])
  else if ("List" in node) parts = stringsOf(node.List.items ?? [])
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return undefined
  return { schema: parts[0]!, name: parts[1]! }
}

/**
 * Чи дія — рівно один `GRANT`/`REVOKE` на об'єктах, які створює сам план:
 * ні `ON ALL … IN SCHEMA`, ні колонкових прав, ні `CASCADE`. Перевантажена
 * функція зіставляється лише за схемою й іменем — точність тримає прогін
 * доказу. Схем у `produced` немає, тож грант на схему сюди не проходить.
 */
function isEnvironmentGrant(
  action: EngineAction,
  produced: readonly EngineObjectRef[],
  parse: SqlParser
): boolean {
  const result = parse(action.sql)
  if (!result.ok || result.statements.length !== 1) return false
  const stmt = result.statements[0]!.stmt
  if (!("GrantStmt" in stmt)) return false
  const g = stmt.GrantStmt
  if (g.targtype !== "ACL_TARGET_OBJECT" || g.behavior === "DROP_CASCADE")
    return false
  const columns = (g.privileges ?? []).some(
    (p) => "AccessPriv" in p && (p.AccessPriv.cols ?? []).length > 0
  )
  if (columns) return false
  const kinds = GRANT_KINDS[g.objtype ?? ""]
  if (kinds === undefined) return false
  const objects = g.objects ?? []
  return (
    objects.length > 0 &&
    objects.every((node) => {
      const object = grantObject(node)
      return (
        object !== undefined &&
        produced.some(
          (p) =>
            p.table === undefined &&
            kinds.includes(p.kind) &&
            p.schema === object.schema &&
            p.name === object.name
        )
      )
    })
  )
}

/**
 * Залишок плану двигуна на копії з глобальними ADP після всіх кроків плану
 * (спека промоції §7.2): допускається лише як гранти на об'єктах, які створює сам
 * план, — це права, які глобальний ADP дав би їм інакше, ніж бажана тінь.
 * Дії лишаються як є, разом із парою `REVOKE ALL` + `GRANT`. Будь-яка інша
 * дія — та сама відмова, що й непорожній доказ: план не приводить базу до
 * бажаного стану.
 */
export function environmentSteps(
  residual: readonly EngineAction[],
  produced: readonly EngineObjectRef[],
  parse: SqlParser
): { steps: EngineAction[] } | { refusal: EngineDiagnostic } {
  const foreign = residual.find((a) => !isEnvironmentGrant(a, produced, parse))
  return foreign === undefined
    ? { steps: [...residual] }
    : {
        refusal: applyDiagnostic("plan.proof-not-empty", "error", {
          count: residual.length,
          first: foreign.sql,
        }),
      }
}
