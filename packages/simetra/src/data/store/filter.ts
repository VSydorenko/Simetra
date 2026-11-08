import type { Filter, FilterCondition, OrderBy } from "simetra/model"
import type { FieldType, Values } from "./types"

/**
 * Мінімальний обчислювач фільтра T0 для `full` і перевірки предиката. Повну
 * еквівалентність будівнику T3 (спека П4-B §6.1, інв. 16) спайк не доводить:
 * тут лише семантика, потрібна для критеріїв і заміру часу.
 */

// Тризначна логіка SQL: `undefined` — NULL-результат порівняння.
type Truth = boolean | undefined

const dbCollator = new Intl.Collator("en-US")
const utf8 = new TextEncoder()

/** Порівняння рядків як у детермінованій колляції ICU бази: нічия — байти. */
export function compareDbText(a: string, b: string): number {
  const c = dbCollator.compare(a, b)
  if (c !== 0) return c
  const x = utf8.encode(a)
  const y = utf8.encode(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0)
  }
  return x.length - y.length
}

function compareTyped(type: FieldType, a: unknown, b: unknown): number {
  switch (type) {
    case "number":
      return (a as number) - (b as number)
    case "bigint-text":
    case "numeric-text": {
      // Спайк: точне порівняння десяткових рядків не потрібне критеріям.
      return Number(a) - Number(b)
    }
    case "boolean":
      return Number(a) - Number(b)
    case "string":
      return compareDbText(a as string, b as string)
    default:
      // `date`, `datetime`, `uuid` — фіксована ширина, лексично.
      return (a as string) < (b as string)
        ? -1
        : (a as string) > (b as string)
          ? 1
          : 0
  }
}

function evalCondition(
  fields: Readonly<Record<string, FieldType>>,
  row: Values,
  cond: FilterCondition
): Truth {
  const value = row[cond.attribute]
  if (cond.op === "isNull") return value === null || value === undefined
  if (value === null || value === undefined) return undefined
  const type = fields[cond.attribute] ?? "string"
  switch (cond.op) {
    case "eq":
      return value === cond.value
    case "ne":
      return value !== cond.value
    case "in": {
      const list = cond.value as unknown[]
      return list.includes(value)
    }
    case "lt":
      return compareTyped(type, value, cond.value) < 0
    case "lte":
      return compareTyped(type, value, cond.value) <= 0
    case "gt":
      return compareTyped(type, value, cond.value) > 0
    case "gte":
      return compareTyped(type, value, cond.value) >= 0
    case "contains":
      return String(value)
        .toLowerCase()
        .includes(String(cond.value).toLowerCase())
    case "startsWith":
      return String(value)
        .toLowerCase()
        .startsWith(String(cond.value).toLowerCase())
  }
}

function evalTruth(
  fields: Readonly<Record<string, FieldType>>,
  row: Values,
  filter: Filter
): Truth {
  if ("and" in filter) {
    let result: Truth = true
    for (const part of filter.and) {
      const t = evalTruth(fields, row, part)
      if (t === false) return false
      if (t === undefined) result = undefined
    }
    return result
  }
  if ("or" in filter) {
    let result: Truth = false
    for (const part of filter.or) {
      const t = evalTruth(fields, row, part)
      if (t === true) return true
      if (t === undefined) result = undefined
    }
    return result
  }
  if ("not" in filter) {
    const t = evalTruth(fields, row, filter.not)
    return t === undefined ? undefined : !t
  }
  return evalCondition(fields, row, filter)
}

/** Чи підходить рядок фільтру (NULL-результат — ні, як `WHERE`). */
export function matches(
  fields: Readonly<Record<string, FieldType>>,
  row: Values,
  filter: Filter | undefined
): boolean {
  return filter === undefined || evalTruth(fields, row, filter) === true
}

/**
 * Компаратор `full` за типом поля: рядки — мовою користувача, `nulls` —
 * типове Postgres (`asc` — last, `desc` — first), нічия — ключ за зростанням.
 */
export function rowComparator(
  fields: Readonly<Record<string, FieldType>>,
  orderBy: OrderBy | undefined,
  locale?: string
): (
  a: { key: string; values: Values },
  b: { key: string; values: Values }
) => number {
  const userCollator = new Intl.Collator(locale)
  const parts = (orderBy ?? []).map((part) => {
    const type = fields[part.attribute] ?? "string"
    const dir = part.direction === "asc" ? 1 : -1
    const nullsFirst =
      (part.nulls ?? (part.direction === "asc" ? "last" : "first")) === "first"
    const cmp =
      type === "string"
        ? (x: unknown, y: unknown) =>
            userCollator.compare(x as string, y as string)
        : (x: unknown, y: unknown) => compareTyped(type, x, y)
    return { attribute: part.attribute, dir, nullsFirst, cmp }
  })
  return (a, b) => {
    for (const p of parts) {
      const x = a.values[p.attribute]
      const y = b.values[p.attribute]
      const xn = x === null || x === undefined
      const yn = y === null || y === undefined
      if (xn || yn) {
        if (xn && yn) continue
        return xn === p.nullsFirst ? -1 : 1
      }
      const c = p.cmp(x, y)
      if (c !== 0) return c * p.dir
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  }
}

/** Частина повного кортежу сортування з явним місцем `NULL`. */
interface SortPart {
  readonly attribute: string
  readonly direction: "asc" | "desc"
  readonly nullsFirst: boolean
}

/**
 * Повний кортеж сортування: атрибути `orderBy` з явним `nulls` (типове
 * Postgres: `asc` — last, `desc` — first) і ключ останнім. Ключ, якщо його
 * немає в `orderBy`, — за зростанням, як дописує сервер (§4.1).
 */
function sortParts(orderBy: OrderBy): SortPart[] {
  const parts: SortPart[] = orderBy.map((p) => ({
    attribute: p.attribute,
    direction: p.direction,
    nullsFirst:
      (p.nulls ?? (p.direction === "asc" ? "last" : "first")) === "first",
  }))
  if (parts[parts.length - 1]?.attribute !== "id")
    parts.push({ attribute: "id", direction: "asc", nullsFirst: false })
  return parts
}

/**
 * Зворотний порядок того самого кортежу — для `goToEnd` і `loadBefore`:
 * напрям і місце `NULL` перевернуто, ключ — явно останнім (інакше сервер
 * допише його за зростанням, і нічия розвернеться неправильно).
 */
export function reverseOrder(orderBy: OrderBy): OrderBy {
  return sortParts(orderBy).map((p) => ({
    attribute: p.attribute,
    direction: p.direction === "asc" ? "desc" : "asc",
    nulls: p.nullsFirst ? "last" : "first",
  })) as OrderBy
}

const isNullish = (v: unknown) => v === null || v === undefined

/** «Строго після `v`» (чи «не раніше» з `inclusive`) у порядку частини. */
function after(
  p: SortPart,
  v: unknown,
  inclusive: boolean
): Filter | undefined {
  if (isNullish(v)) {
    // `NULL` найменше (nulls first): після нього всі непорожні; найбільше
    // (nulls last): після нього нічого.
    if (inclusive) return { attribute: p.attribute, op: "isNull" }
    return p.nullsFirst
      ? { not: { attribute: p.attribute, op: "isNull" } }
      : undefined
  }
  const op =
    p.direction === "asc"
      ? inclusive
        ? "gte"
        : "gt"
      : inclusive
        ? "lte"
        : "lt"
  const cmp: Filter = { attribute: p.attribute, op, value: v }
  // Непорожнє значення при nulls last: усі `NULL` ідуть після нього.
  return p.nullsFirst
    ? cmp
    : { or: [cmp, { attribute: p.attribute, op: "isNull" }] }
}

function equalTo(p: SortPart, v: unknown): Filter {
  return isNullish(v)
    ? { attribute: p.attribute, op: "isNull" }
    : { attribute: p.attribute, op: "eq", value: v }
}

/**
 * Keyset-умова для вікна: рядки після `cursor` у порядку `orderBy` (повний
 * кортеж сортування плюс ключ, з `NULL`). `inclusive` — і сам рядок курсора
 * (нижня межа сторінки, прочитаної від свого першого рядка).
 */
export function keysetAfter(
  orderBy: OrderBy,
  cursor: { key: string; values: Values },
  inclusive = false
): Filter {
  const parts = sortParts(orderBy)
  const valueOf = (attribute: string) =>
    attribute === "id" ? cursor.key : cursor.values[attribute]
  const branches: Filter[] = []
  parts.forEach((part, i) => {
    const last = i === parts.length - 1
    const strict = after(part, valueOf(part.attribute), inclusive && last)
    if (strict === undefined) return
    const equal = parts
      .slice(0, i)
      .map((prev) => equalTo(prev, valueOf(prev.attribute)))
    branches.push(equal.length === 0 ? strict : { and: [...equal, strict] })
  })
  // Ключ ніколи не `NULL`, тож гілка ключа є завжди.
  return branches.length === 1 ? (branches[0] as Filter) : { or: branches }
}

/**
 * Перехід «до значення» (`goTo`): рядки, у яких перший атрибут сортування
 * не раніше `value` у порядку списку.
 */
export function keysetFromValue(orderBy: OrderBy, value: unknown): Filter {
  const first = sortParts(orderBy)[0]
  if (first === undefined) throw new TypeError("empty orderBy")
  return (
    after(first, value, true) ?? { attribute: first.attribute, op: "isNull" }
  )
}

/** Компаратор повного кортежу, як у бази (тести й перевірки ланцюжка). */
export function tupleComparator(
  fields: Readonly<Record<string, FieldType>>,
  orderBy: OrderBy
): (
  a: { key: string; values: Values },
  b: { key: string; values: Values }
) => number {
  const parts = sortParts(orderBy)
  return (a, b) => {
    for (const p of parts) {
      const x = p.attribute === "id" ? a.key : a.values[p.attribute]
      const y = p.attribute === "id" ? b.key : b.values[p.attribute]
      const xn = isNullish(x)
      const yn = isNullish(y)
      if (xn || yn) {
        if (xn && yn) continue
        return xn === p.nullsFirst ? -1 : 1
      }
      const type =
        p.attribute === "id" ? "uuid" : (fields[p.attribute] ?? "string")
      const c = compareTyped(type, x, y)
      if (c !== 0) return p.direction === "asc" ? c : -c
    }
    return 0
  }
}
