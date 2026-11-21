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
 * Чи може користувач підписатися на канал: дзеркало режиму підписки
 * `signal_topic_allowed` (`compiler/signal/units.ts`). Канал користувача —
 * лише свій `userId`; канал прав скоупу — пара в `scopeSets` (межа тенанта
 * виду, без умови права), глобальний (обидва нулі) — дійсний користувач;
 * змішані нулі й вид поза видами скоупу в `scopeSets` не трапляються, тож
 * `false`. Канал змін: `publicRead` скоупленого об'єкта скоупу не
 * перевіряє, як і SQL. Інакше — скоуп у межі тенанта й безрядкове право
 * `read`: рядок рівня `scope` свого скоупу (скоуплений) чи будь-який не
 * контейнерний рядок (нескоуплений, `has_right`). Лише контейнерне право
 * канал не відкриває.
 */
export function canSubscribe(
  snapshot: RightsSnapshot,
  channel: string,
  catalog: { readonly objects: readonly CatalogEntry[] }
): boolean {
  if (snapshot.userId === null) return false
  const topic = parseTopic(channel)
  if (topic === undefined) return false
  if (topic.kind === "user") return topic.userId === snapshot.userId
  if (topic.kind === "rights") {
    if (topic.scopeKindId === ZERO_UUID && topic.scope === ZERO_UUID)
      return true
    return snapshot.scopeSets.some(
      (s) => s.scopeKind === topic.scopeKindId && s.scope === topic.scope
    )
  }
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

// Кортеж обсягу рядка `read`: усе, крім об'єкта й дії, які вже відібрано.
const tupleOf = (r: RightsRow): string =>
  JSON.stringify([
    r.level,
    r.levelId,
    r.scope,
    r.container,
    r.extent,
    r.dimensionId,
  ])

/**
 * Чи звузив новий знімок читання об'єкта до B6 (P4-B spec §6.2 правило 4):
 * зник кортеж рядка `read` мітки об'єкта, а його пара лишилась дозволеною; для нескоупленого об'єкта — ще й
 * змінились `scopeSets` (межа читання «Користувачів» залежить від членства).
 * Об'єкт без контракту `rights` знімок не описує — ні.
 */
export function readNarrowed(
  prev: RightsSnapshot,
  next: RightsSnapshot,
  entry: CatalogEntry
): boolean {
  if (entry.rights === undefined) return false
  const kept = new Set(readRows(next, entry).map(tupleOf))
  // Кортеж пари, яку новий знімок забороняє, — не звуження, а втрата пари:
  // її прибирає прохід, а не перечитування.
  const narrowed = (r: RightsRow) =>
    !kept.has(tupleOf(r)) &&
    (entry.scopeKindId === undefined ||
      readAllowed(next, { scope: r.scope }, entry))
  if (readRows(prev, entry).some(narrowed)) return true
  if (entry.scopeKindId !== undefined) return false
  const scopes = (s: RightsSnapshot) =>
    new Set(s.scopeSets.map((x) => `${x.scopeKind}\u0000${x.scope}`))
  const before = scopes(prev)
  const after = scopes(next)
  return before.size !== after.size || [...before].some((x) => !after.has(x))
}

// Скоупи `scopeSets` знімка, що діють для об'єкта: свого виду, а для
// нескоупленого — усі (межа його читання залежить від членства).
const scopesFor = (snapshot: RightsSnapshot, entry: CatalogEntry) =>
  new Set(
    snapshot.scopeSets
      .filter(
        (s) =>
          entry.scopeKindId === undefined || s.scopeKind === entry.scopeKindId
      )
      .map((s) => `${s.scopeKind}\u0000${s.scope}`)
  )

/**
 * Чи втратив об'єкт на заміні знімка хоч щось із читання: кортеж рядка
 * `read`, скоуп зі `scopeSets` чи покриття `publicRead`. Тоді рядки ТЧ
 * власників з невідомим скоупом (шапки в сховищі немає, або вона старша за
 * `ownerVersion` ТЧ чи іншої епохи версій) не судяться за
 * парою — їх прибирає заміна, а повертає наступне читання (P4-B spec §6.2
 * правило 4). Перший знімок (`prev` немає) судиться проти «дозволено
 * все»: втрата — будь-яка пара, яку він забороняє; скоупленому об'єкту, якого
 * не відкриває `publicRead`, знімок забороняє скоупи поза своїми.
 */
export function readLost(
  prev: RightsSnapshot | undefined,
  next: RightsSnapshot,
  entry: CatalogEntry
): boolean {
  if (entry.rights === undefined) return false
  if (prev === undefined)
    return entry.scopeKindId !== undefined
      ? !publicReadCovers(next, entry)
      : !readAllowed(next, { scope: null }, entry)
  if (publicReadCovers(prev, entry) && !publicReadCovers(next, entry))
    return true
  const kept = new Set(readRows(next, entry).map(tupleOf))
  if (readRows(prev, entry).some((r) => !kept.has(tupleOf(r)))) return true
  const after = scopesFor(next, entry)
  return [...scopesFor(prev, entry)].some((s) => !after.has(s))
}

/**
 * Пари об'єкта, які попередній знімок забороняв, а новий дозволяє: читання,
 * що стартувало до застосування попереднього, їх і далі не пише (P4-B spec
 * §6.2 правило 4). `"all"` — новий знімок відкриває кожну пару об'єкта
 * (`publicRead` тепер покриває роль), тож їх не перелічити.
 */
export function reopenedPairs(
  prev: RightsSnapshot,
  next: RightsSnapshot,
  entry: CatalogEntry
): "all" | (string | null)[] {
  if (entry.rights === undefined) return []
  if (!publicReadCovers(prev, entry) && publicReadCovers(next, entry))
    return "all"
  const reopened = (scope: string | null) =>
    !readAllowed(prev, { scope }, entry) && readAllowed(next, { scope }, entry)
  if (entry.scopeKindId === undefined) return reopened(null) ? [null] : []
  // Скоуплену пару новий знімок відкриває лише скоупом зі своїх `scopeSets`.
  const kind = entry.scopeKindId
  const scopes = new Set(
    next.scopeSets.filter((s) => s.scopeKind === kind).map((s) => s.scope)
  )
  return [...scopes].filter(reopened)
}
