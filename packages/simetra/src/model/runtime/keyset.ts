import type { Filter, OrderBy } from "./read"

/*
 * Keyset-умова сторінки (спека П4-B §6.4, рішення плану B1d Р8): для порядку
 * `(c1, …, cn, key)` і курсора `(v1, …, vn, k)` —
 *   `c1 ≥ v1 AND OR[ c1 > v1, AND[c1 = v1, c2 > v2], …, AND[…, key > k] ]`.
 * Форма пласка, тож глибина стала (≤ 5 з гілками `nulls`) і не залежить від
 * числа колонок: вкладена форма перевищила б `FILTER_DEPTH_MAX` для
 * `ORDER_BY_MAX` колонок, а межі фільтра — страж від ворожого дерева, їх не
 * послаблюють. Провідна межа `c1 ≥ v1` дає Postgres Index Cond діапазону
 * замість читання всього індексу до курсора.
 */

/** Which side of the cursor row a keyset page lies on. */
export type KeysetDirection = "after" | "before"

/** The row a keyset page starts from. */
export interface KeysetCursor {
  /** Sort column values of the cursor row by attribute name; absent or `null` is NULL. */
  readonly values: Readonly<Record<string, unknown>>
  /** The key value of the cursor row. */
  readonly key: string
  readonly direction: KeysetDirection
}

interface Term {
  readonly attribute: string
  readonly desc: boolean
  readonly nullsFirst: boolean
  /** The key is never NULL, so it gets no `isNull` branches. */
  readonly nullable: boolean
}

const isNullish = (value: unknown) => value === null || value === undefined

const isNull = (attribute: string): Filter => ({ attribute, op: "isNull" })

/** Терми порядку: колонки запиту й ключ останнім (його додає сервер, як `orderClause` T3). */
function termsOf(orderBy: OrderBy, keyName: string): Term[] {
  const terms: Term[] = orderBy.map((entry) => ({
    attribute: entry.attribute,
    desc: entry.direction === "desc",
    // Типове місце NULL — як у Postgres: `asc` — у кінці, `desc` — на початку.
    nullsFirst:
      (entry.nulls ?? (entry.direction === "asc" ? "last" : "first")) ===
      "first",
    nullable: entry.attribute !== keyName,
  }))
  // Порядок, що вже закінчується ключем, ключ удруге не дописує.
  if (terms[terms.length - 1]?.attribute !== keyName) {
    terms.push({
      attribute: keyName,
      desc: false,
      nullsFirst: false,
      nullable: false,
    })
  }
  return terms
}

/** «До» — дзеркало «після»: усі напрямки й місця NULL міняються місцями. */
const mirrored = (term: Term): Term => ({
  ...term,
  desc: !term.desc,
  nullsFirst: !term.nullsFirst,
})

/** Строго після `v` у порядку терма; `undefined` — після нього нічого. */
function strict(term: Term, v: unknown): Filter | undefined {
  const { attribute } = term
  if (isNullish(v)) {
    // NULL на початку — після нього всі непорожні; NULL у кінці — нічого.
    return term.nullsFirst ? { not: isNull(attribute) } : undefined
  }
  const cmp: Filter = { attribute, op: term.desc ? "lt" : "gt", value: v }
  // Непорожнє значення при NULL у кінці: усі NULL ідуть після нього.
  return term.nullsFirst || !term.nullable
    ? cmp
    : { or: [cmp, isNull(attribute)] }
}

/**
 * Не раніше `v` у порядку терма (провідна межа); `undefined` — межа
 * порожня, тобто підходить усе: тавтологію не емітять.
 */
function atOrAfter(term: Term, v: unknown): Filter | undefined {
  const { attribute } = term
  if (isNullish(v)) return term.nullsFirst ? undefined : isNull(attribute)
  const cmp: Filter = { attribute, op: term.desc ? "lte" : "gte", value: v }
  return term.nullsFirst || !term.nullable
    ? cmp
    : { or: [cmp, isNull(attribute)] }
}

const equalTo = (attribute: string, v: unknown): Filter =>
  isNullish(v) ? isNull(attribute) : { attribute, op: "eq", value: v }

function build(terms: readonly Term[], values: readonly unknown[]): Filter {
  const branches: Filter[] = []
  terms.forEach((term, i) => {
    const after = strict(term, values[i])
    if (after === undefined) return
    const equal = terms
      .slice(0, i)
      .map((prev, j) => equalTo(prev.attribute, values[j]))
    branches.push(equal.length === 0 ? after : { and: [...equal, after] })
  })
  // Ключ ніколи не NULL, тож його гілка є завжди.
  const body = branches.length === 1 ? branches[0]! : { or: branches }
  // Єдиний терм — сам ключ: межа `key ≥ k` до `key > k` нічого не додає.
  if (terms.length === 1) return body
  const bound = atOrAfter(terms[0]!, values[0])
  return bound === undefined ? body : { and: [bound, body] }
}

/**
 * The keyset condition of a page next to a cursor row, in the order of
 * `orderBy` plus the key (ascending, appended last unless `orderBy` already
 * ends with it): a leading bound on the first column and a flat `OR` of
 * per-column branches, of constant depth. `before` is the mirror of `after`.
 * A NULL leading-column value yields the exact bound for where `nulls` puts
 * NULL, or no bound when every row qualifies. Throws `TypeError` when the
 * cursor has no key.
 */
export function keysetFilter(
  orderBy: OrderBy,
  cursor: KeysetCursor,
  keyName: string
): Filter {
  if (isNullish(cursor.key)) throw new TypeError("keyset cursor has no key")
  const forward = termsOf(orderBy, keyName)
  const terms =
    cursor.direction === "after" ? forward : forward.map((t) => mirrored(t))
  const values = forward.map((term) =>
    term.attribute === keyName ? cursor.key : cursor.values[term.attribute]
  )
  return build(terms, values)
}

const nodesOf = (filter: Filter): number =>
  "and" in filter
    ? 1 + filter.and.reduce((n, child) => n + nodesOf(child), 0)
    : "or" in filter
      ? 1 + filter.or.reduce((n, child) => n + nodesOf(child), 0)
      : "not" in filter
        ? 1 + nodesOf(filter.not)
        : 1

/**
 * The most nodes a keyset condition of this order can have, over both
 * directions and every NULL / non-NULL pattern of the cursor row. The window
 * checks a user filter against this worst case, so a page never fails on the
 * server for the cursor it happens to hold (spec §6.4). `orderBy` is the
 * query order without the key.
 */
export function keysetNodesMax(orderBy: OrderBy): number {
  const key = "\u0000key"
  const terms = termsOf(orderBy, key)
  let max = 0
  for (const direction of ["after", "before"] as const) {
    const used = direction === "after" ? terms : terms.map((t) => mirrored(t))
    for (let mask = 0; mask < 1 << orderBy.length; mask++) {
      const values = terms.map((_, i) =>
        i < orderBy.length && (mask >> i) & 1 ? null : 0
      )
      max = Math.max(max, nodesOf(build(used, values)))
    }
  }
  return max
}
