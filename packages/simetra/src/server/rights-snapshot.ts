import {
  PLATFORM_SCHEMA,
  RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME,
  rightsSnapshotSchema,
  type RightsDimensionValues,
  type RightsSnapshot,
} from "simetra/model"
import { ident } from "./read"

/**
 * Частина `rights` пакета читання (спека П4-B §9.1; Р3–Р5 плану B5b): знімок
 * прав поточного користувача й його відбиток `rightsVersion`.
 */

/** Оператор знімка: функцію T1 судить роль запиту, як і політики читання. */
export const RIGHTS_SNAPSHOT_STATEMENT = {
  text: `SELECT ${ident(PLATFORM_SCHEMA)}.${ident(RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME)}()::text AS snapshot`,
  params: [] as readonly string[],
}

/** Знімок аноніма й недійсного користувача: без звернення до бази (Р5). */
export const ANONYMOUS_SNAPSHOT: RightsSnapshot = Object.freeze({
  userId: null,
  scopeSets: [],
  rights: [],
  members: [],
  dimensionValues: [],
})

// Ключ повного кортежу рядка: канонічний порядок не залежить від того, у якому
// порядку база віддала рядки (`ORDER BY` функції — лише перший рубіж).
const tupleKey = (...fields: readonly (string | null)[]): string =>
  JSON.stringify(fields)

const byKey = <T>(items: readonly T[], key: (item: T) => string): T[] =>
  items
    .map((item) => ({ item, key: key(item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ item }) => item)

/**
 * Значення виміру в канонічному вигляді. `truncated` і `digest` — лише коли
 * є: `digest` входить у відбиток, тож зміна значення за межею змінює
 * `rightsVersion`.
 */
const canonicalDimension = (
  d: RightsDimensionValues
): RightsDimensionValues => ({
  dimension: d.dimension,
  values: byKey(d.values, (v) => v),
  ...(d.truncated === undefined ? {} : { truncated: d.truncated }),
  ...(d.digest === undefined ? {} : { digest: d.digest }),
})

/**
 * Знімок у канонічному вигляді: масиви впорядковані за повним кортежем, поля
 * — у порядку схеми. Лише з нього рахується відбиток і лише він іде клієнту.
 */
export function canonicalSnapshot(snapshot: RightsSnapshot): RightsSnapshot {
  return {
    userId: snapshot.userId,
    scopeSets: byKey(snapshot.scopeSets, (s) =>
      tupleKey(s.scopeKind, s.scope)
    ).map((s) => ({ scopeKind: s.scopeKind, scope: s.scope })),
    rights: byKey(snapshot.rights, (r) =>
      tupleKey(
        r.level,
        r.levelId,
        r.scope,
        r.container,
        r.object,
        r.action,
        r.extent,
        r.dimensionId
      )
    ).map((r) => ({
      level: r.level,
      levelId: r.levelId,
      scope: r.scope,
      container: r.container,
      object: r.object,
      action: r.action,
      extent: r.extent,
      dimensionId: r.dimensionId,
    })),
    members: byKey(snapshot.members, (m) =>
      tupleKey(m.scopeKind, m.scope, m.member)
    ).map((m) => ({
      scopeKind: m.scopeKind,
      scope: m.scope,
      member: m.member,
    })),
    dimensionValues: byKey(snapshot.dimensionValues, (d) =>
      tupleKey(d.dimension)
    ).map(canonicalDimension),
  }
}

/** `rightsVersion`: sha-256 (WebCrypto) канонічного JSON знімка, hex. */
export async function rightsVersionOf(
  snapshot: RightsSnapshot
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")
}

/**
 * Знімок з рядка відповіді функції: текст JSON, що проходить
 * `rightsSnapshotSchema`. Будь-яка розбіжність кидає — викликач журналить її
 * й віддає `command.internal`.
 */
export function snapshotFromRows(
  rows: readonly Record<string, unknown>[]
): RightsSnapshot {
  const text = rows[0]?.snapshot
  if (rows.length !== 1 || typeof text !== "string") {
    throw new Error("rights_client_snapshot answered no single text row")
  }
  return canonicalSnapshot(rightsSnapshotSchema.parse(JSON.parse(text)))
}

/**
 * Значення частини: `snapshot` не йде, коли `known` — поточний відбиток
 * (Р4); сам знімок розрахований завжди.
 */
export async function rightsValueOf(
  snapshot: RightsSnapshot,
  known: string | undefined
): Promise<{ rightsVersion: string; snapshot?: RightsSnapshot }> {
  const rightsVersion = await rightsVersionOf(snapshot)
  return known === rightsVersion
    ? { rightsVersion }
    : { rightsVersion, snapshot }
}
