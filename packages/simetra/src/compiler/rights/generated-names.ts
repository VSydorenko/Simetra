import { makeObjectName } from "simetra/model"
import { sha256HexSync } from "../sha256"

const encoder = new TextEncoder()

/** Preserve distinct function names when PostgreSQL would truncate long table names alike. */
export function generatedTableFunctionName(
  table: string,
  label: string
): string {
  const plain = `${table}_${label}`
  if (encoder.encode(plain).length <= 63) return plain
  return makeObjectName(
    table,
    undefined,
    `${sha256HexSync(table).slice(0, 8)}_${label}`
  )
}
