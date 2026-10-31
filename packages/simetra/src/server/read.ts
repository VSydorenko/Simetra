import {
  isTextEncodedType,
  type BaseCastType,
  type CommandError,
  type ReadQuery,
  type RuntimeObject,
} from "simetra/model"
import { encodePair, encodeParam } from "./values"

// Колонка мітки пари й ключ таблиці в каталозі без `castType`: їхній тип
// задає платформа (мітка — текст, ключ — UUID).
const LABEL_CAST: BaseCastType = "text"
const KEY_CAST: BaseCastType = "uuid"

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`

/**
 * Рядок читання — та сама форма, що й результат ядра (`to_jsonb` і
 * `numeric`/`bigint` текстом, Рт1), тож декодує його той самий `decodeRow`.
 */
function projection(object: RuntimeObject): string {
  const text = object.attributes
    .filter((a) => isTextEncodedType(a.pgType))
    .map(
      (a) =>
        `${literal(a.column)}, t.${ident(a.column)}::${a.array === true ? "text[]" : "text"}`
    )
  return text.length === 0
    ? "to_jsonb(t)::text"
    : `(to_jsonb(t) || jsonb_build_object(${text.join(", ")}))::text`
}

/**
 * Builds the server read statement (P4 spec §6.11): one row by id or a
 * keyset page by equality, with bound parameters only. Тип приведення —
 * з каталогу без модифікатора: `$n::character varying(10)` обрізав би
 * значення фільтра й знайшов би рядок з іншим значенням.
 */
export function buildReadStatement(
  object: RuntimeObject,
  query: ReadQuery
): { text: string; params: (string | null)[] } | { error: CommandError } {
  const params: (string | null)[] = []
  const bind = (value: string | null, cast: string) => {
    params.push(value)
    return `$${params.length}::${cast}`
  }
  const equals = (column: string, value: string | null, cast: string) =>
    value === null
      ? `${ident(column)} IS NULL`
      : `${ident(column)} = ${bind(value, cast)}`
  const key = ident(object.key)
  const conditions: string[] = []
  let limit: number
  if ("id" in query) {
    conditions.push(`${key} = ${bind(query.id, KEY_CAST)}`)
    limit = 1
  } else {
    // Порядок входу: перша помилка — перший невірний ключ `where`.
    for (const [name, value] of Object.entries(query.where)) {
      const attribute = object.attributes.find((a) => a.name === name)
      if (attribute === undefined) {
        return { error: { code: "command.invalid", path: name } }
      }
      if (attribute.pair !== undefined) {
        const pair = encodePair(attribute, value, name)
        if ("error" in pair) return pair
        conditions.push(
          equals(attribute.pair.typeColumn, pair.value.label, LABEL_CAST),
          equals(attribute.column, pair.value.id, attribute.castType)
        )
        continue
      }
      const encoded = encodeParam(attribute, value, name)
      if ("error" in encoded) return encoded
      conditions.push(
        equals(attribute.column, encoded.value, attribute.castType)
      )
    }
    if (query.after !== undefined) {
      conditions.push(`${key} > ${bind(query.after, KEY_CAST)}`)
    }
    limit = query.limit
  }
  const where =
    conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`
  const table = `${ident(object.table.schema)}.${ident(object.table.name)}`
  params.push(String(limit))
  return {
    text:
      `SELECT ${projection(object)} AS row FROM ${table} t${where}` +
      ` ORDER BY ${key} LIMIT $${params.length}`,
    params,
  }
}
