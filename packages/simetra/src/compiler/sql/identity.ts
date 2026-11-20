import type { Node, TypeName } from "libpg-query"
import { compareStrings } from "../diagnostics"
import { quoteIdent, type SqlUnitClass } from "simetra/model"

/**
 * Ідентичність SQL-одиниці (спека П2 §3, §8.3): `<клас>:<ключ>`, де кожна
 * частина імені — за `quoteIdent`, а роздільники `.` `,` `:` `(` `)` стоять
 * лише поза лапками. Тож різні об'єкти Postgres мають різні ідентичності
 * (`"a.b".c` ≠ `a."b.c"`), а ключ функції — валідний підпис SQL. Цей модуль —
 * єдине місце, що складає й розбирає рядок ідентичності: склеєна вручну
 * частина без лапок знову зробила б ідентичність неін'єктивною (#297).
 */

/**
 * Клас ідентичності: клас SQL-одиниці або об'єкт моделі (таблиця, енам-тип),
 * що ділить із одиницями простір міток — у конфліктах імен і графі
 * створення.
 */
export type IdentityClass = SqlUnitClass | "table" | "enumType"

/** Кваліфіковане ім'я: частини за `quoteIdent` через `.`. */
export function qualifiedName(...parts: readonly string[]): string {
  return parts.map(quoteIdent).join(".")
}

/** Ідентичність з ключем із частин імені: `view:public."V"`. */
export function unitIdentity(
  cls: IdentityClass,
  ...parts: readonly string[]
): string {
  return keyIdentity(cls, qualifiedName(...parts))
}

/**
 * Ідентичність із готовим ключем: підписом (`signatureKey`) чи складеним
 * ключем гранту, коментаря, публікації. Частини такого ключа вже зібрано
 * функціями цього модуля.
 */
export function keyIdentity(cls: IdentityClass, key: string): string {
  return `${cls}:${key}`
}

/** Ключ ідентичності: усе після класу (клас двокрапки не містить). */
export function identityKey(identity: string): string {
  return identity.slice(identity.indexOf(":") + 1)
}

/**
 * Частини імені ключа з крапками (в'юха, тригер, політика:
 * схема, таблиця, ім'я) — імена каталогу, без лапок.
 */
export function identityParts(identity: string): string[] {
  return splitIdentity(identityKey(identity), ".").map(unquoteIdent)
}

/** Частина імені з ключа як ім'я каталогу: обернення `quoteIdent`. */
export function unquoteIdent(part: string): string {
  return part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part
}

/**
 * Частини ідентичності між роздільниками `separator` поза лапками й дужками:
 * роль чи ціль у лапках може містити і кому, і двокрапку.
 */
export function splitIdentity(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let current = ""
  for (const char of text) {
    if (char === '"') quoted = !quoted
    if (!quoted && char === "(") depth += 1
    if (!quoted && char === ")") depth -= 1
    if (!quoted && depth === 0 && char === separator) {
      parts.push(current)
      current = ""
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts
}

/** Типи, які знає модель (енам-типи й таблиці знімка, домени й в'юхи `.sql`): ім'я → схеми. */
export type ModelTypes = ReadonlyMap<string, readonly string[]>

/** Де читається некваліфікований тип: схема одиниці й типи моделі. */
export interface TypeScope {
  schema: string
  types: ModelTypes
}

/** Типи моделі за іменем; схеми імені — у сталому порядку. */
export function modelTypes(
  types: readonly { schema: string; name: string }[]
): ModelTypes {
  const schemas = new Map<string, string[]>()
  for (const { schema, name } of types) {
    const list = schemas.get(name) ?? []
    if (!list.includes(schema)) list.push(schema)
    schemas.set(name, list)
  }
  for (const list of schemas.values()) list.sort(compareStrings)
  return schemas
}

/**
 * Ключ функції з уже відрендерених типів аргументів: `схема.ім'я(т1,т2)`.
 * Агрегат без списку аргументів — тип `*`.
 */
export function functionKey(
  schema: string,
  name: string,
  types: readonly string[]
): string {
  return `${qualifiedName(schema, name)}(${types.join(",")})`
}

/**
 * Ключ функції з вузлів `TypeName` (спека П2 §8.3); `scope.schema` — схема
 * функції й некваліфікованих імен.
 */
export function signatureKey(
  name: string,
  argTypes: readonly (TypeName | undefined)[],
  scope: TypeScope
): string {
  return functionKey(
    scope.schema,
    name,
    argTypes.map((t) => typeKey(t, scope))
  )
}

/**
 * Ідентичність функції за типами каталогу: обгортки й функції платформи —
 * той самий простір, що й функції користувача, а типи моделі їм не потрібні.
 */
export function functionIdentity(
  schema: string,
  name: string,
  argTypes: readonly (TypeName | undefined)[]
): string {
  return keyIdentity(
    "function",
    signatureKey(name, argTypes, { schema, types: new Map() })
  )
}

/**
 * Вбудовані типи Postgres 17 (`pg_catalog`), які пишуть без схеми. Лише за
 * ними `_x` читається як масив `x[]`: ім'я `_item` користувача — просто ім'я
 * (масив його типу Postgres перейменовує на `__item`, коли `_item` зайняте);
 * і лише вони не резолвляться в однойменний тип моделі — `pg_catalog`
 * неявно першим у `search_path`.
 */
const CATALOG_TYPES: ReadonlySet<string> = new Set([
  "aclitem",
  "bit",
  "bool",
  "box",
  "bpchar",
  "bytea",
  "char",
  "cid",
  "cidr",
  "circle",
  "cstring",
  "date",
  "datemultirange",
  "daterange",
  "float4",
  "float8",
  "gtsvector",
  "inet",
  "int2",
  "int2vector",
  "int4",
  "int4multirange",
  "int4range",
  "int8",
  "int8multirange",
  "int8range",
  "interval",
  "json",
  "jsonb",
  "jsonpath",
  "line",
  "lseg",
  "macaddr",
  "macaddr8",
  "money",
  "name",
  "numeric",
  "nummultirange",
  "numrange",
  "oid",
  "oidvector",
  "path",
  "pg_lsn",
  "pg_snapshot",
  "point",
  "polygon",
  "record",
  "refcursor",
  "regclass",
  "regcollation",
  "regconfig",
  "regdictionary",
  "regnamespace",
  "regoper",
  "regoperator",
  "regproc",
  "regprocedure",
  "regrole",
  "regtype",
  "text",
  "tid",
  "time",
  "timestamp",
  "timestamptz",
  "timetz",
  "tsmultirange",
  "tsquery",
  "tsrange",
  "tstzmultirange",
  "tstzrange",
  "tsvector",
  "txid_snapshot",
  "uuid",
  "varbit",
  "varchar",
  "xid",
  "xid8",
  "xml",
])

/**
 * Тип у канонічній формі Postgres (спека П2 §8.3): одне написання на один тип
 * `pg_type`, інакше один об'єкт `pg_proc` мав би дві ідентичності. Синоніми
 * зводить до внутрішніх імен сама граматика (`integer` → `pg_catalog.int4`,
 * `character varying` → `pg_catalog.varchar`), тож лишається прибрати
 * `pg_catalog.`, модифікатор типу (`varchar(10)` — той самий тип) і
 * кількість вимірів масиву; ім'я масиву каталогу `_int4` — те саме, що
 * `int4[]`. Некваліфікований тип моделі бере її схему: єдину, а з кількох —
 * схему одиниці; невідомий моделі (типи розширень) лишається як є. Тип з
 * іншої схеми лишається кваліфікованим як є. Частини імені — за
 * `quoteIdent`, і в типів каталогу теж: `"char"` без лапок у SQL — `bpchar`.
 */
export function typeKey(type: TypeName | undefined, scope: TypeScope): string {
  if (type === undefined) return ""
  const names = nameParts(type.names)
  if (type.pct_type === true) return `${qualifiedName(...names)}%type`
  const array = (type.arrayBounds?.length ?? 0) > 0 ? "[]" : ""
  const [first, second] = names
  if (names.length === 2 && first === "pg_catalog") {
    return catalogType(second!, array)
  }
  if (names.length !== 1) return qualifiedName(...names) + array
  const name = first!
  if (
    CATALOG_TYPES.has(name) ||
    (name.startsWith("_") && CATALOG_TYPES.has(name.slice(1)))
  ) {
    return catalogType(name, array)
  }
  const schemas = scope.types.get(name) ?? []
  if (schemas.length === 0) return quoteIdent(name) + array
  const schema = schemas.length === 1 ? schemas[0]! : scope.schema
  return qualifiedName(schema, name) + array
}

/** Тип каталогу без схеми; `_x` — масив `x[]`. */
function catalogType(name: string, array: string): string {
  return name.length > 1 && name.startsWith("_")
    ? `${quoteIdent(name.slice(1))}[]`
    : quoteIdent(name) + array
}

function nameParts(nodes: readonly Node[] | undefined): string[] {
  return (nodes ?? []).map((n) => ("String" in n ? (n.String.sval ?? "") : ""))
}

/**
 * Ключ функції як текст підпису SQL: кома між типами — з пробілом. Поза
 * лапками кома в ключі функції стоїть лише між типами аргументів.
 */
export function signatureText(key: string): string {
  let quoted = false
  let text = ""
  for (const char of key) {
    if (char === '"') quoted = !quoted
    text += !quoted && char === "," ? ", " : char
  }
  return text
}
