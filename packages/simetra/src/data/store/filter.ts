import {
  CommandFailure,
  FILTER_OPERATORS,
  ORDER_BY_MAX,
  UUID_TEXT,
  encodeItemValue,
  encodePair,
  filterSchema,
  filterWithinLimits,
  normalDateTime,
  type CatalogEntry,
  type CatalogEntryAttribute,
  type CommandError,
  type Filter,
  type FilterCondition,
  type FilterOperator,
  type OrderBy,
} from "simetra/model"
import { DataError } from "../errors"
import type { Values } from "./types"

/*
 * Обчислювач фільтра T0 у ядрі (спека П4-B §6.1 «Предикати» й «Порядок
 * рядків», інв. 16): та сама множина, що в будівника T3
 * (`server/read-filter.ts`), — ті самі перевірки в тому самому порядку, те
 * саме кодування значення T0 і тризначна логіка SQL. Служить вигляду `full` і
 * перевірці предиката за сигналом; вікно фільтр локально не обчислює.
 */

/** Logical type of a field the evaluator knows: an attribute, the key or the version. */
export type FieldType = CatalogEntryAttribute["type"] | "Key" | "Version"

/** What the evaluator knows of one field. */
export interface FieldDescriptor {
  readonly type: FieldType
  /** The catalog attribute; absent for the key and the version. */
  readonly attribute?: CatalogEntryAttribute
  /** Enumeration: logical value name → database label. */
  readonly labels?: ReadonlyMap<string, string>
  /** Polymorphic pair: target `"<kind>.<name>"` → database label. */
  readonly targets?: ReadonlyMap<string, string>
}

/** Fields of one catalog entry by logical name. */
export type FieldInfo = ReadonlyMap<string, FieldDescriptor>

const infos = new WeakMap<CatalogEntry, FieldInfo>()

/**
 * The fields of a catalog entry the evaluator and the comparator read: the
 * attributes, the key and the version, with enumeration and pair labels.
 */
export function fieldInfoOf(entry: CatalogEntry): FieldInfo {
  const known = infos.get(entry)
  if (known !== undefined) return known
  const fields = new Map<string, FieldDescriptor>()
  for (const attribute of entry.attributes) {
    fields.set(attribute.name, {
      type: attribute.type,
      attribute,
      ...(attribute.enumValues === undefined
        ? {}
        : {
            labels: new Map(attribute.enumValues.map((v) => [v.name, v.label])),
          }),
      ...(attribute.pair === undefined
        ? {}
        : {
            targets: new Map(
              attribute.pair.targets.map((t) => [
                `${t.object.kind}.${t.object.name}`,
                t.label,
              ])
            ),
          }),
    })
  }
  fields.set(entry.keyName, { type: "Key" })
  fields.set(entry.versionName, { type: "Version" })
  infos.set(entry, fields)
  return fields
}

/**
 * The collator of filter comparisons: the database collation locale (P4-B
 * spec §4.2). One per data runtime.
 */
export function filterCollator(): Intl.Collator {
  return new Intl.Collator("en-US")
}

// ---------------------------------------------------------------- значення

/** Як порівнюються значення поля. */
type Kind =
  | "text"
  | "label"
  | "number"
  | "bigint"
  | "decimal"
  | "boolean"
  | "lexical"
  | "pair"
  | "none"

function kindOf(field: FieldDescriptor): Kind {
  if (field.labels !== undefined) return "label"
  if (field.targets !== undefined) return "pair"
  switch (field.type) {
    case "String":
    case "Text":
      return "text"
    case "Integer":
    case "SmallInt":
    case "Version":
      return "number"
    case "BigInt":
      return "bigint"
    case "Numeric":
      return "decimal"
    case "Boolean":
      return "boolean"
    case "Json":
    case "Raw":
      return "none"
    default:
      // `UUID`, `Ref`, ключ, `Date`, `DateTime`, `Bytes`: фіксована форма, де
      // порядок кодових одиниць — порядок бази.
      return "lexical"
  }
}

interface Pair {
  readonly label: string | undefined
  readonly id: string
}

const isNullish = (value: unknown) => value === null || value === undefined

/**
 * Канонічна форма значення для порівняння: регістр UUID і hex `bytea` база
 * не розрізняє, момент — UTC фіксованої ширини, перерахування — мітка, бо
 * мітку порівнює база.
 */
function canonical(
  field: FieldDescriptor,
  kind: Kind,
  value: unknown
): unknown {
  switch (kind) {
    case "label":
      // Рядок несе логічне ім'я; невідоме ім'я — поле відсутнє, тобто NULL.
      return field.labels!.get(value as string) ?? null
    case "pair": {
      const { type, id } = value as { type: string; id: string }
      return { label: field.targets!.get(type), id: id.toLowerCase() }
    }
    case "bigint":
      return BigInt(value as string | bigint)
    case "lexical":
      return field.type === "DateTime"
        ? (normalDateTime(value as string) ?? value)
        : (value as string).toLowerCase()
    default:
      return value
  }
}

const utf8 = new TextEncoder()

/**
 * Рядки як у детермінованої колляції ICU бази: колатор, а на нічиїй — байти
 * UTF-8 (Postgres розв'язує нічию `strcmp`).
 */
function compareText(collator: Intl.Collator, a: string, b: string): number {
  if (a === b) return 0
  const c = collator.compare(a, b)
  if (c !== 0) return c
  const x = utf8.encode(a)
  const y = utf8.encode(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!
  }
  return x.length - y.length
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/

/** Десятковий рядок: знак, ціла частина без провідних нулів, дріб без хвостових. */
function decimalParts(
  text: string
): [sign: number, whole: string, fraction: string] {
  const [, sign = "", rawWhole = "", rawFraction = ""] =
    DECIMAL.exec(text) ?? []
  const whole = rawWhole.replace(/^0+/, "")
  const fraction = rawFraction.replace(/0+$/, "")
  if (whole === "" && fraction === "") return [0, "", ""]
  return [sign === "-" ? -1 : 1, whole, fraction]
}

/** Точне порівняння десяткових рядків `Numeric`: `"10"` більше за `"9"`, `"10.00"` дорівнює `"10"`. */
function compareDecimal(a: string, b: string): number {
  const [sa, wa, fa] = decimalParts(a)
  const [sb, wb, fb] = decimalParts(b)
  if (sa !== sb) return sa - sb
  let c = wa.length - wb.length
  if (c === 0) c = wa < wb ? -1 : wa > wb ? 1 : 0
  if (c === 0) {
    const width = Math.max(fa.length, fb.length)
    const x = fa.padEnd(width, "0")
    const y = fb.padEnd(width, "0")
    c = x < y ? -1 : x > y ? 1 : 0
  }
  return c * sa
}

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0)

/** Порівняння двох канонічних не-NULL значень одного поля. */
function compareValues(
  kind: Kind,
  a: unknown,
  b: unknown,
  collator: Intl.Collator
): number {
  switch (kind) {
    case "text":
    case "label":
      return compareText(collator, a as string, b as string)
    case "number":
      return sign((a as number) - (b as number))
    case "decimal":
      return compareDecimal(a as string, b as string)
    case "boolean":
      return Number(a) - Number(b)
    case "pair": {
      // Пара лише рівністю (будівник не сортує й не порівнює її).
      const x = a as Pair
      const y = b as Pair
      return x.label === y.label && x.id === y.id ? 0 : 1
    }
    default: {
      const x = a as string | bigint
      const y = b as string | bigint
      return x < y ? -1 : x > y ? 1 : 0
    }
  }
}

// ---------------------------------------------------------------- відмови

const refuse = (path: string, reason?: string): never => {
  const error: CommandError = {
    code: "command.invalid",
    path,
    ...(reason === undefined ? {} : { reason }),
  }
  throw new CommandFailure(error)
}

const unsupported = (): never => {
  throw new DataError("data.unsupported-predicate")
}

const objectAt = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/**
 * Throws `command.invalid` (path `where`) when a filter exceeds
 * `FILTER_DEPTH_MAX` levels or `FILTER_NODES_MAX` nodes — the bound the
 * server checks first, so a user filter combined with a keyset is checked
 * before it is sent.
 */
export function checkFilterBudget(filter: Filter): void {
  if (!filterWithinLimits(filter)) refuse("where")
}

const OPERATORS: ReadonlySet<string> = new Set(FILTER_OPERATORS)

/**
 * Вузли, яких обчислювач не знає: невідомий вузол, оператор чи поле — помилка
 * розробника, а не відмова сервера (спека П4-B §6.1).
 */
function checkKnown(value: unknown, info: FieldInfo): void {
  const node = objectAt(value) ?? unsupported()
  if ("and" in node || "or" in node) {
    const children = node.and ?? node.or
    if (Array.isArray(children)) for (const c of children) checkKnown(c, info)
    return
  }
  if ("not" in node) return checkKnown(node.not, info)
  if (!("attribute" in node)) return unsupported()
  if (typeof node.op !== "string" || !OPERATORS.has(node.op)) unsupported()
  if (typeof node.attribute !== "string" || !info.has(node.attribute)) {
    unsupported()
  }
}

// ---------------------------------------------------------------- предикат

// Тризначна логіка SQL: `undefined` — NULL-результат.
type Truth = boolean | undefined
type Predicate = (row: Values) => Truth

/** Чи оператор має сенс для типу поля — те саме правило, що в будівника. */
function allows(field: FieldDescriptor, op: FilterOperator): boolean {
  const pair = field.targets !== undefined
  const array = field.attribute?.array === true
  switch (op) {
    case "isNull":
      return true
    case "contains":
    case "startsWith":
      return (field.type === "String" || field.type === "Text") && !array
    case "eq":
    case "ne":
    case "in":
      return !array && field.type !== "Json" && field.type !== "Raw"
    default:
      return (
        !array &&
        !pair &&
        field.type !== "Json" &&
        field.type !== "Bytes" &&
        field.type !== "Raw"
      )
  }
}

/**
 * Одне не-NULL значення фільтра в канонічній формі; кодування — те саме, що
 * в будівника (`encodeItemValue` T0 і правила ключа та версії), тож значення,
 * яке відхилив би сервер, відхиляє й обчислювач.
 */
function operand(
  field: FieldDescriptor,
  kind: Kind,
  value: unknown,
  path: string
): unknown {
  if (field.type === "Key") {
    return typeof value === "string" && UUID_TEXT.test(value)
      ? value.toLowerCase()
      : refuse(path)
  }
  if (field.type === "Version") {
    return Number.isSafeInteger(value) ? value : refuse(path)
  }
  const attribute = field.attribute!
  if (kind === "pair") {
    const pair = encodePair(attribute, value, path)
    if ("error" in pair) return refuse(path)
    return { label: pair.value.label!, id: pair.value.id!.toLowerCase() }
  }
  const encoded = encodeItemValue(attribute, value, path)
  if ("error" in encoded || encoded.value === null) return refuse(path)
  // Перерахування кодується міткою — саме її порівнює база.
  if (kind === "label") return encoded.value
  return canonical(field, kind, encoded.value)
}

function condition(
  node: FilterCondition,
  info: FieldInfo,
  collator: Intl.Collator,
  path: string
): Predicate {
  const name = node.attribute
  const field = info.get(name)!
  if (field.attribute?.load === "lazy") refuse(`${path}.attribute`, "lazy")
  const { op, value } = node
  if (!allows(field, op)) refuse(`${path}.op`)
  const kind = kindOf(field)
  const valuePath = `${path}.value`
  if (op === "isNull") return (row) => isNullish(row[name])
  // `= NULL` у SQL мовчки дав би порожню множину: будівник відмовляє (В5).
  const notNull = (item: unknown, at: string, reason?: string) => {
    if (item === null) refuse(at, reason)
    return item
  }
  const rowValue = (row: Values): unknown => {
    const raw = row[name]
    return isNullish(raw) ? null : canonical(field, kind, raw)
  }
  if (op === "in") {
    const items = (value as unknown[]).map((item, i) =>
      notNull(item, `${valuePath}.${i}`, "use-isNull")
    )
    const operands = items.map((item, i) =>
      operand(field, kind, item, `${valuePath}.${i}`)
    )
    return (row) => {
      const v = rowValue(row)
      if (v === null) return undefined
      return operands.some((o) => compareValues(kind, v, o, collator) === 0)
    }
  }
  if (op === "contains" || op === "startsWith") {
    // Буквальний підрядок: будівник для тієї самої множини екранує `%`, `_`
    // і `\` у шаблоні `ILIKE`.
    const text = (
      operand(field, kind, notNull(value, valuePath), valuePath) as string
    ).toLowerCase()
    return (row) => {
      const v = rowValue(row)
      if (v === null) return undefined
      const lower = (v as string).toLowerCase()
      return op === "contains" ? lower.includes(text) : lower.startsWith(text)
    }
  }
  notNull(
    value,
    valuePath,
    op === "eq" || op === "ne" ? "use-isNull" : undefined
  )
  const o = operand(field, kind, value, valuePath)
  const test = TESTS[op]
  return (row) => {
    const v = rowValue(row)
    return v === null ? undefined : test(compareValues(kind, v, o, collator))
  }
}

const TESTS: Record<
  "eq" | "ne" | "lt" | "lte" | "gt" | "gte",
  (c: number) => boolean
> = {
  eq: (c) => c === 0,
  ne: (c) => c !== 0,
  lt: (c) => c < 0,
  lte: (c) => c <= 0,
  gt: (c) => c > 0,
  gte: (c) => c >= 0,
}

function compileNode(
  filter: Filter,
  info: FieldInfo,
  collator: Intl.Collator,
  path: string
): Predicate {
  if ("not" in filter) {
    const inner = compileNode(filter.not, info, collator, `${path}.not`)
    return (row) => {
      const t = inner(row)
      return t === undefined ? undefined : !t
    }
  }
  if ("and" in filter || "or" in filter) {
    const [key, children] =
      "and" in filter
        ? (["and", filter.and] as const)
        : (["or", filter.or] as const)
    const parts = children.map((child, i) =>
      compileNode(child, info, collator, `${path}.${key}.${i}`)
    )
    // Логіка Кліні: домінує `false` для `and`, `true` для `or`; інакше NULL
    // перемагає.
    const dominant = key === "or"
    return (row) => {
      let result: Truth = !dominant
      for (const part of parts) {
        const t = part(row)
        if (t === dominant) return dominant
        if (t === undefined) result = undefined
      }
      return result
    }
  }
  return condition(filter, info, collator, path)
}

interface Compiled {
  readonly info: FieldInfo
  readonly collator: Intl.Collator
  readonly test: (row: Values) => boolean
}

const compiled = new WeakMap<object, Compiled>()

/**
 * Checks a filter against the fields and compiles it into a row test; every
 * refusal comes here, before any row or request. An unknown node, operator
 * or field is `DataError` `data.unsupported-predicate`; what the server
 * would refuse is `CommandFailure` `command.invalid` with the same `path`
 * (rooted at `where`). Filters are treated as immutable: the compiled test
 * is cached by the identity of the filter object, so a filter mutated after
 * its first use keeps its first meaning.
 */
export function compileFilter(
  filter: Filter,
  info: FieldInfo,
  collator: Intl.Collator
): (row: Values) => boolean {
  const known = objectAt(filter) && compiled.get(filter)
  if (known && known.info === info && known.collator === collator) {
    return known.test
  }
  checkFilterBudget(filter)
  checkKnown(filter, info)
  const parsed = filterSchema.safeParse(filter)
  if (!parsed.success) {
    const [issue] = parsed.error.issues
    refuse(["where", ...(issue?.path ?? [])].map(String).join("."))
  }
  const predicate = compileNode(filter, info, collator, "where")
  // NULL-результат — ні, як у `WHERE`.
  const test = (row: Values) => predicate(row) === true
  compiled.set(filter, { info, collator, test })
  return test
}

/**
 * Whether a row passes a filter, with the semantics of the server read
 * builder (P4-B spec §6.1): SQL three-valued logic, the collator for string
 * order with UTF-8 bytes on a tie, enumerations ordered by label.
 */
export function evaluateFilter(
  filter: Filter,
  row: Values,
  info: FieldInfo,
  collator: Intl.Collator
): boolean {
  return compileFilter(filter, info, collator)(row)
}

// ---------------------------------------------------------------- порядок

/** Чи поле сортується — те саме правило, що в будівника. */
const sortable = (field: FieldDescriptor) =>
  field.attribute?.array !== true &&
  field.targets === undefined &&
  field.type !== "Json" &&
  field.type !== "Bytes" &&
  field.type !== "Raw"

/**
 * The row comparator of a `full` view (P4-B spec §6.1 «Порядок рядків»):
 * strings by the user's collator, enumerations by label, `Numeric` by value,
 * moments lexically; `nulls` from the order or the Postgres default (`asc` —
 * last, `desc` — first); the key last. Refuses what the builder refuses to
 * sort with `command.invalid`.
 */
export function compareRows(
  orderBy: OrderBy,
  info: FieldInfo,
  keyName: string,
  userCollator: Intl.Collator
): (a: Values, b: Values) => number {
  const keyAt = orderBy.findIndex((e) => e.attribute === keyName)
  if (keyAt !== -1 && keyAt !== orderBy.length - 1) refuse(`orderBy.${keyAt}`)
  if (orderBy.length - (keyAt === -1 ? 0 : 1) > ORDER_BY_MAX) refuse("orderBy")
  const entries: OrderBy =
    keyAt === -1
      ? [...orderBy, { attribute: keyName, direction: "asc" }]
      : orderBy
  const parts = entries.map((entry, i) => {
    const path = `orderBy.${i}.attribute`
    const field =
      info.get(entry.attribute) ??
      (entry.attribute === keyName ? { type: "Key" as const } : refuse(path))
    if (field.attribute?.load === "lazy") refuse(path, "lazy")
    if (!sortable(field)) refuse(path)
    const kind = kindOf(field)
    const nullsFirst =
      (entry.nulls ?? (entry.direction === "asc" ? "last" : "first")) ===
      "first"
    // Рядки — мовою користувача (Рд29); нічия — далі за кортежем, ключ останнім.
    const compare =
      kind === "text" || kind === "label"
        ? (x: unknown, y: unknown) =>
            userCollator.compare(x as string, y as string)
        : (x: unknown, y: unknown) => compareValues(kind, x, y, userCollator)
    const value = (row: Values) => {
      const raw = row[entry.attribute]
      return isNullish(raw) ? null : canonical(field, kind, raw)
    }
    return {
      value,
      compare,
      direction: entry.direction === "desc" ? -1 : 1,
      nullsFirst,
    }
  })
  return (a, b) => {
    for (const part of parts) {
      const x = part.value(a)
      const y = part.value(b)
      if (x === null || y === null) {
        if (x === null && y === null) continue
        // Місце NULL абсолютне: напрям його не перевертає.
        return (x === null) === part.nullsFirst ? -1 : 1
      }
      const c = part.compare(x, y)
      if (c !== 0) return c * part.direction
    }
    return 0
  }
}

/**
 * Whether a field of the catalog entry may hold NULL: an optional attribute
 * does, a required one, the key and the version do not. The keyset condition
 * takes `isNull` branches only for these (P4-B spec §6.4).
 */
export function nullableOf(info: FieldInfo): (name: string) => boolean {
  return (name) => {
    const attribute = info.get(name)?.attribute
    return attribute !== undefined && !attribute.required
  }
}
