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

/**
 * Keyset-умова «після рядка» для вікна: повний кортеж сортування плюс ключ.
 * Спайк: без NULL у полях сортування.
 */
export function keysetAfter(
  orderBy: OrderBy,
  last: { key: string; values: Values }
): Filter {
  const parts = [
    ...orderBy.map((p) => ({ attribute: p.attribute, direction: p.direction })),
    { attribute: "id", direction: "asc" as const },
  ]
  const valueOf = (attribute: string) =>
    attribute === "id" ? last.key : last.values[attribute]
  const branches: Filter[] = parts.map((part, i) => {
    const equal: Filter[] = parts.slice(0, i).map((prev) => ({
      attribute: prev.attribute,
      op: "eq" as const,
      value: valueOf(prev.attribute),
    }))
    const strict: Filter = {
      attribute: part.attribute,
      op: part.direction === "asc" ? "gt" : "lt",
      value: valueOf(part.attribute),
    }
    return equal.length === 0 ? strict : { and: [...equal, strict] }
  })
  return branches.length === 1 ? (branches[0] as Filter) : { or: branches }
}
