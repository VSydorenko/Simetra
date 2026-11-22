import {
  ZERO_UUID,
  parseTopic,
  type CatalogAdoptedFacts,
  type CatalogEntry,
  type CatalogRightsCarrier,
  type CatalogRightsSubject,
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

/**
 * Чи забороняє знімок хоч одну пару об'єкта: тоді рядки ТЧ власників з
 * невідомим скоупом (шапки в сховищі немає, або вона іншої версії чи епохи
 * версій, ніж `ownerVersion` ТЧ) прибирає кожна заміна знімка — їх не
 * судити за парою, а повертає наступне читання (P4-B spec §6.2 правило 4),
 * як прохід прибирає рядки шапки кожної забороненої пари. Скоупленому
 * об'єкту, якого не відкриває `publicRead`, знімок забороняє скоупи поза
 * своїми; нескоупленому — його єдину пару, коли читання не дозволено.
 */
export function deniesSomePair(
  snapshot: RightsSnapshot,
  entry: CatalogEntry
): boolean {
  if (entry.rights === undefined) return false
  return entry.scopeKindId !== undefined
    ? !publicReadCovers(snapshot, entry)
    : !readAllowed(snapshot, { scope: null }, entry)
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

/** Тризначна відповідь обчислювача: `unknown` хост показує доступною (§9.2). */
export type CanResult = boolean | "unknown"

export interface CanOptions {
  /** Скоуп дії; скоупленому об'єкту без нього — `unknown`. */
  readonly scope?: string | null
  /** Значення рядка за логічними іменами; без нього — право «хоч на щось у скоупі». */
  readonly row?: Readonly<Record<string, unknown>>
}

// Кліні: `false` гасить `and`, `true` гасить `or`, інакше `unknown` заразний.
const and = (...v: CanResult[]): CanResult =>
  v.includes(false) ? false : v.includes("unknown") ? "unknown" : true
const or = (...v: CanResult[]): CanResult =>
  v.includes(true) ? true : v.includes("unknown") ? "unknown" : false

/**
 * Чи має користувач право дії над об'єктом (P4-B spec §9.2): дзеркало
 * `rightsPredicates` (`compiler/rights/predicates.ts`), результат = межі ∧
 * (∨ гілок) за Кліні. Не захист: помилка дає зайву чи приховану кнопку, а база
 * лишається бар'єром. Знімок і факти прийнятих джерел приходять від виклику —
 * власного стану й другого кешу немає. Об'єкт без контракту — `unknown`.
 */
export function can(
  snapshot: RightsSnapshot,
  entry: CatalogEntry,
  action: string,
  options: CanOptions = {},
  adoptedFacts?: CatalogAdoptedFacts
): CanResult {
  const contract = entry.rights
  if (contract === undefined) return "unknown"
  const extents = contract.actions.find((a) => a.action === action)?.extents
  if (extents === undefined) return false

  const { row } = options
  const scopeKind = entry.scopeKindId
  const scoped = scopeKind !== undefined
  const root = action === "create" && contract.root !== undefined
  const verbatim = contract.scopeSet === "verbatim"
  // Факти прийнятих джерел сигналу не шлють: усе, що від них залежить, — `unknown`.
  const assignmentsAdopted = adoptedFacts?.assignments === true
  const kindAdopted =
    scoped && (adoptedFacts?.membershipKinds.includes(scopeKind) ?? false)
  const scope = options.scope ?? null
  // Скоуп кореня, що створюється, ще не існує: межа тенанта його не судить.
  if (scoped && !root && scope === null) return "unknown"

  const rows = snapshot.rights.filter(
    (r) => r.action === action && r.object === entry.kindLabel
  )
  const mine = (subject: CatalogRightsSubject): ReadonlySet<string> =>
    new Set(
      "users" in subject
        ? snapshot.userId === null
          ? []
          : [snapshot.userId]
        : snapshot.members
            .filter((m) => m.scopeKind === subject.scopeKind)
            .map((m) => m.member)
    )
  const carrierOf = (carrier: CatalogRightsCarrier): unknown =>
    row === undefined
      ? undefined
      : row["key" in carrier ? entry.keyName : carrier.attribute]
  // Носій рядка проти множини: відсутній — `unknown`, `null` ніколи не збігається.
  const within = (
    carrier: CatalogRightsCarrier,
    set: ReadonlySet<string>
  ): CanResult => {
    const value = carrierOf(carrier)
    if (value === undefined) return "unknown"
    return typeof value === "string" && set.has(value)
  }

  type Inner = {
    extent: "any" | "own" | "dimension"
    dimensionId?: string
    carrier: CanResult
    /** Гілка залежить від факту без сигналу: `unknown` завжди. */
    always?: true
  }
  const inners: Inner[] = []
  const hasExtent = (form: string) => extents.some((e) => e.form === form)
  if (hasExtent("any")) inners.push({ extent: "any", carrier: true })
  if (hasExtent("own")) {
    const owners = root
      ? contract.ownership.filter(
          (o) =>
            contract.root?.author !== undefined &&
            JSON.stringify(o.carrier) === JSON.stringify(contract.root.author)
        )
      : contract.ownership
    for (const o of owners) {
      const stale =
        "scopeKind" in o.owner &&
        (adoptedFacts?.membershipKinds.includes(o.owner.scopeKind) ?? false)
      inners.push({
        extent: "own",
        carrier: row === undefined ? true : within(o.carrier, mine(o.owner)),
        ...(stale ? { always: true as const } : {}),
      })
    }
  }
  if (!root) {
    for (const e of extents) {
      if (e.form !== "dimension") continue
      for (const a of contract.access.filter(
        (x) => x.dimensionId === e.dimensionId
      )) {
        const values = snapshot.dimensionValues.find(
          (d) => d.dimension === a.dimensionId
        )
        const unsure = values === undefined || values.truncated === true
        inners.push({
          extent: "dimension",
          dimensionId: a.dimensionId,
          carrier:
            row === undefined
              ? true
              : unsure
                ? "unknown"
                : within(a.carrier, new Set(values.values)),
          ...(a.fresh ? {} : { always: true as const }),
        })
      }
    }
  }

  const grant = (inner: Inner, level: (r: RightsRow) => boolean): CanResult => {
    if (assignmentsAdopted) return "unknown"
    return rows.some(
      (r) =>
        level(r) &&
        r.extent === inner.extent &&
        (inner.extent !== "dimension" || r.dimensionId === inner.dimensionId)
    )
  }

  const branches: CanResult[] = []
  for (const inner of inners) {
    if (inner.always || (scoped && !root && (kindAdopted || verbatim))) {
      branches.push("unknown")
      continue
    }
    // Корінь: `has_right` будь-якого рівня, крім контейнера, без скоупу.
    const base = root
      ? grant(inner, (r) => r.level !== "container")
      : scoped
        ? grant(inner, (r) => actsInScope(r, scope) && r.level === "scope")
        : grant(inner, (r) => r.level !== "container")
    branches.push(and(base, inner.carrier))
    if (!root && row !== undefined && contract.binding !== undefined) {
      const container = carrierOf(contract.binding.carrier)
      branches.push(
        and(
          // Без контейнерного рядка носій нічого не міняє: гілка хибна.
          grant(
            inner,
            (r) =>
              r.level === "container" &&
              (container === undefined || r.container === container)
          ),
          container === undefined ? "unknown" : true,
          inner.extent === "any" ? true : inner.carrier
        )
      )
    }
  }

  // Читання судить межа з контракту (`publicRead`-об'єкт її не має), запис —
  // скоуп об'єкта: його політики межу тенанта несуть завжди.
  const tenantBound =
    scoped &&
    !root &&
    (action !== "read" || contract.readBoundary.includes("tenant"))
  const tenant: CanResult = tenantBound
    ? kindAdopted || verbatim
      ? "unknown"
      : snapshot.scopeSets.some(
          (s) => s.scopeKind === scopeKind && s.scope === scope
        )
    : true
  // `rights_visible_users` — учасники всіх моїх скоупів, яких клієнт не має:
  // видимий лише власний рядок.
  const users: CanResult =
    action === "read" && contract.readBoundary.includes("users")
      ? row !== undefined &&
        snapshot.userId !== null &&
        row[entry.keyName] === snapshot.userId
        ? true
        : "unknown"
      : true

  // `publicRead` знімає межу тенанта й саме відкриває читання, але не через
  // факти прийнятого членства виду (B6-1 Р9): там `unknown`.
  if (action === "read" && publicReadCovers(snapshot, entry))
    return and(users, kindAdopted ? "unknown" : true)
  return and(tenant, users, or(...branches))
}
