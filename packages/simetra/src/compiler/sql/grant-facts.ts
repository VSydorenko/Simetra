import { grantTargetKeys } from "../function-execute"
import type { SqlParser } from "./parse"
import type { VerbatimUnit } from "./units"

export const PUBLIC = "PUBLIC"

/** Дослівний `GRANT`/`REVOKE` на функцію чи відношення. */
export interface GrantFact {
  keys: readonly string[]
  grant: boolean
  /** `REVOKE GRANT OPTION FOR` — сам привілей лишається. */
  optionOnly: boolean
  /** Отримувачі: `PUBLIC` чи ім'я ролі. */
  roles: ReadonlySet<string>
  /** Привілеї; порожньо — `ALL`. `columns` — лише на колонки. */
  privileges: readonly { name: string; columns: boolean }[]
}

interface GrantTree {
  is_grant?: boolean
  grant_option?: boolean
  grantees?: { RoleSpec?: { roletype?: string; rolename?: string } }[]
  privileges?: { AccessPriv?: { priv_name?: string; cols?: unknown[] } }[]
}

export function grantFacts(
  units: readonly VerbatimUnit[],
  parse: SqlParser
): GrantFact[] {
  return units.flatMap((unit) => {
    const stmt = (unit.tree as { GrantStmt?: GrantTree }).GrantStmt
    const keys = grantTargetKeys(unit, parse)
    if (stmt === undefined || keys.length === 0) return []
    const grant = stmt.is_grant === true
    return [
      {
        keys,
        grant,
        optionOnly: !grant && stmt.grant_option === true,
        roles: new Set(
          (stmt.grantees ?? []).flatMap(({ RoleSpec: spec }) =>
            spec?.roletype === "ROLESPEC_PUBLIC"
              ? [PUBLIC]
              : spec?.roletype === "ROLESPEC_CSTRING" &&
                  spec.rolename !== undefined
                ? [spec.rolename]
                : []
          )
        ),
        privileges: (stmt.privileges ?? []).map(({ AccessPriv: priv }) => ({
          name: priv?.priv_name ?? "all",
          columns: (priv?.cols ?? []).length > 0,
        })),
      },
    ]
  })
}

/**
 * Привілеї запису (`ALL` їх містить): грант будь-якого з них відкриває запис.
 * `trigger` — бо його власник створює тригер `BEFORE`, що змінює `NEW` чужого
 * запису (спека прав §6.1).
 */
export const WRITE_PRIVILEGES: ReadonlySet<string> = new Set([
  "insert",
  "update",
  "delete",
  "truncate",
  "trigger",
])

/**
 * Привілеї, відкликання яких прибирає запис крізь подання: Postgres пише
 * крізь автооновлюване подання лише операторами `INSERT`/`UPDATE`/`DELETE`,
 * тож роль без жодного з них шляху не має, а з одним — має.
 */
const VIEW_WRITE_PRIVILEGES = ["insert", "update", "delete"] as const

/** Вид привілею для `privilegedRoles`: `write` — будь-який привілей запису. */
export type GrantedPrivilege = "execute" | "select" | "write"

/**
 * Хто може мати привілей (платформна спека §6.7): `PUBLIC` — без явного відкликання від
 * `PUBLIC` чи з явним грантом йому (Postgres дає `PUBLIC` `EXECUTE` функцій);
 * роль API — так само щодо себе, або через `PUBLIC` (провайдер дає ролям API
 * привілеї типовими привілеями схеми). `grantedRoles` (роль команд) типових
 * привілеїв не мають, тож мають привілей лише через `PUBLIC` чи явний грант.
 * Типові привілеї не моделюються, а
 * порядок операторів — теж (грант перемагає): для попередження надлишок
 * безпечніший за пропуск. Відкликання лише на колонки чи лише права передачі
 * привілею не прибирає.
 *
 * Привілей `write` (спека прав §6.1, Р2): таблиці й подання, на відміну від
 * функцій, `PUBLIC` типових привілеїв не мають — `PUBLIC` пише лише явним
 * грантом; роль API — без відкликання запису (типові привілеї провайдера
 * дають їй запис на таблиці схеми `public`); відкликання запису — коли
 * відкликано кожен із `INSERT`, `UPDATE`, `DELETE` (`ALL` — усі).
 */
export function privilegedRoles(
  target: (key: string) => boolean,
  privilege: GrantedPrivilege,
  grants: readonly GrantFact[],
  apiRoles: readonly string[],
  grantedRoles: readonly string[] = []
): string[] {
  const names = (p: GrantedPrivilege): readonly string[] =>
    p === "write" ? [...WRITE_PRIVILEGES] : [p]
  const covers = (fact: GrantFact, wanted: readonly string[]) =>
    fact.privileges.length === 0 ||
    fact.privileges.some(
      (p) =>
        (wanted.includes(p.name) || p.name === "all") &&
        (fact.grant || !p.columns)
    )
  const facts = grants.filter((f) => f.keys.some(target))
  const granted = (role: string) =>
    facts.some(
      (f) => f.grant && f.roles.has(role) && covers(f, names(privilege))
    )
  const needed = privilege === "write" ? VIEW_WRITE_PRIVILEGES : [privilege]
  const revoked = (role: string) =>
    needed.every((p) =>
      facts.some(
        (f) => !f.grant && !f.optionOnly && f.roles.has(role) && covers(f, [p])
      )
    )
  const publicHas =
    granted(PUBLIC) || (privilege !== "write" && !revoked(PUBLIC))
  return [
    ...(publicHas ? [PUBLIC] : []),
    ...apiRoles.filter((role) => publicHas || granted(role) || !revoked(role)),
    ...grantedRoles.filter((role) => publicHas || granted(role)),
  ]
}
