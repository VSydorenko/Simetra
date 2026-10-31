import type { RuntimeAttribute, RuntimeObject } from "simetra/model"
import { CommandFailure } from "./errors"
import { INTEGER_TEXT, isPlainObject } from "./values"

const internal = () => new CommandFailure({ code: "command.internal" })

/**
 * Decodes a result row of the core (`to_jsonb(row) || <numeric/bigint as
 * text>`) into logical names and entity types. Розбіжність з каталогом
 * (невідома мітка, версія поза безпечним цілим) — `command.internal`: база
 * не тієї моделі чи дані, яких клієнт не прочитає без втрат.
 */
export function decodeRow(
  object: RuntimeObject,
  json: string
): Record<string, unknown> {
  let row: unknown
  try {
    row = JSON.parse(json)
  } catch {
    throw internal()
  }
  if (!isPlainObject(row)) throw internal()
  const out = decodeAttributes(
    object.attributes,
    object.key,
    object.keyName,
    row
  )
  if (Object.hasOwn(row, object.versionColumn)) {
    out[object.versionName] = decodeVersion(row[object.versionColumn])
  }
  const tabular = row.tabular
  if (isPlainObject(tabular)) {
    for (const section of object.tabularSections) {
      const rows = tabular[section.table.name]
      if (rows === undefined) continue
      if (!Array.isArray(rows)) throw internal()
      out[section.name] = rows.map((r: unknown) => {
        if (!isPlainObject(r)) throw internal()
        return decodeAttributes(
          section.attributes,
          section.key,
          section.keyName,
          r
        )
      })
    }
  }
  return out
}

function decodeAttributes(
  attributes: readonly RuntimeAttribute[],
  key: string,
  keyName: string,
  row: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (Object.hasOwn(row, key)) out[keyName] = row[key]
  for (const attribute of attributes) {
    if (!Object.hasOwn(row, attribute.column)) continue
    out[attribute.name] = decodeValue(attribute, row)
  }
  return out
}

function decodeValue(
  attribute: RuntimeAttribute,
  row: Record<string, unknown>
): unknown {
  const value = row[attribute.column]
  if (attribute.pair !== undefined) {
    const label = row[attribute.pair.typeColumn]
    if (value === null && label === null) return null
    const target = attribute.pair.targets.find((t) => t.label === label)
    if (target === undefined) throw internal()
    return { type: `${target.object.kind}.${target.object.name}`, id: value }
  }
  if (value === null) return null
  if (attribute.array === true) {
    if (!Array.isArray(value)) throw internal()
    return value.map((v: unknown) =>
      v === null ? null : decodeScalar(attribute, v)
    )
  }
  return decodeScalar(attribute, value)
}

function decodeScalar(attribute: RuntimeAttribute, value: unknown): unknown {
  if (attribute.type === "BigInt") {
    // Ядро віддає `bigint` текстом (Рт1), рантайм — JS `bigint`.
    if (typeof value !== "string" || !INTEGER_TEXT.test(value)) {
      throw internal()
    }
    return BigInt(value)
  }
  if (attribute.type === "Ref" && attribute.enumValues !== undefined) {
    const found = attribute.enumValues.find((v) => v.label === value)
    if (found === undefined) throw internal()
    return found.name
  }
  return value
}

/** Версія — `number` типу сутності; поза безпечним цілим клієнт її спотворив би. */
function decodeVersion(value: unknown): number {
  const version =
    typeof value === "string" && INTEGER_TEXT.test(value)
      ? Number(value)
      : value
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw internal()
  }
  return version
}
