import {
  ZERO_UUID,
  parseTopic,
  type CatalogEntry,
  type RightsRow,
  type RightsSnapshot,
} from "simetra/model"

/**
 * Предикати знімка прав (P4-B spec §8.4, §9.1): чисті, без доступу до бази.
 * Це дзеркала SQL: `readAllowed` — безрядкова частина політики читання,
 * `canSubscribe` — режим підписки `signal_topic_allowed`. Еквівалентність на
 * тих самих фікстурах доводить DB-тест.
 */

/** Пара, яку судить правило втрати: скоуп об'єкта (нескоуплений — `ZERO_UUID` чи `null`). */
export interface ReadPair {
  readonly scope: string | null
}

const readRows = (snapshot: RightsSnapshot, entry: CatalogEntry) =>
  snapshot.rights.filter(
    (r: RightsRow) => r.action === "read" && r.object === entry.kindLabel
  )

/**
 * Рядок діє в скоупі так само, як множини політики (`rights_any/own/dim` і
 * `rights_container`): рядок рівня `scope` чи `container` свого скоупу.
 * Рядки `global` і `everyUser` не мають скоупу й скоупленого об'єкта не
 * відкривають — політика бере лише рівень `scope` і `container`.
 */
const actsInScope = (row: RightsRow, scope: string | null): boolean =>
  (row.level === "scope" || row.level === "container") &&
  row.scope !== null &&
  row.scope === scope

/**
 * `publicRead` відкриває об'єкт лише ролі, яку покриває: гостю (знімок без
 * користувача) — тільки `anon`, користувачу — `anon` і `authenticated`.
 * Політика читання дає `authenticated` лише ролі користувача, не `anon`.
 */
const publicReadCovers = (
  snapshot: RightsSnapshot,
  entry: CatalogEntry
): boolean =>
  entry.publicRead === "anon" ||
  (entry.publicRead === "authenticated" && snapshot.userId !== null)

/**
 * Чи лишається пара (скоуп, об'єкт) читабельною за знімком. Об'єкт без
 * контракту `rights` — так: знімок його читання не описує. `publicRead`, що
 * покриває роль знімка, — так.
 * Скоуплений — скоуп у `scopeSets` свого виду й рядок `read`, що діє в
 * скоупі, будь-якого обсягу, зокрема контейнерний. Нескоуплений — будь-який
 * рядок `read` мітки об'єкта.
 */
export function readAllowed(
  snapshot: RightsSnapshot,
  pair: ReadPair,
  entry: CatalogEntry
): boolean {
  if (entry.rights === undefined) return true
  if (publicReadCovers(snapshot, entry)) return true
  const rows = readRows(snapshot, entry)
  if (entry.scopeKindId === undefined) return rows.length > 0
  const scope = pair.scope
  const kind = entry.scopeKindId
  return (
    scope !== null &&
    snapshot.scopeSets.some((s) => s.scopeKind === kind && s.scope === scope) &&
    rows.some((r) => actsInScope(r, scope))
  )
}

/**
 * Чи може користувач підписатися на канал: дзеркало `subscribeCondition`
 * (`compiler/signal/units.ts`). Лише канал змін; канали прав — `false`
 * (B6). `publicRead` скоупленого об'єкта скоупу не перевіряє, як і SQL.
 * Інакше — скоуп у межі тенанта й безрядкове право `read`: рядок рівня
 * `scope` свого скоупу (скоуплений) чи будь-який не контейнерний рядок
 * (нескоуплений, `has_right`). Лише контейнерне право канал не відкриває.
 */
export function canSubscribe(
  snapshot: RightsSnapshot,
  channel: string,
  catalog: { readonly objects: readonly CatalogEntry[] }
): boolean {
  if (snapshot.userId === null) return false
  const topic = parseTopic(channel)
  if (topic === undefined || topic.kind !== "changes") return false
  const entry = catalog.objects.find((o) => o.id === topic.object)
  if (entry === undefined || !entry.signal) return false
  const kind = entry.scopeKindId ?? ZERO_UUID
  if (topic.scopeKindId !== kind) return false
  const scoped = entry.scopeKindId !== undefined
  if (entry.publicRead !== undefined) {
    return scoped ? true : topic.scope === ZERO_UUID
  }
  const inScope = scoped
    ? snapshot.scopeSets.some(
        (s) => s.scopeKind === kind && s.scope === topic.scope
      )
    : topic.scope === ZERO_UUID
  if (!inScope) return false
  return readRows(snapshot, entry).some((r) =>
    scoped
      ? r.level === "scope" && r.scope === topic.scope
      : r.level !== "container"
  )
}
