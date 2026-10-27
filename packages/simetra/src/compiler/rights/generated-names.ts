import { makeObjectName } from "simetra/model"
import { sha256HexSync } from "../sha256"

const encoder = new TextEncoder()

/**
 * Postgres мовчки обрізає ім'я до 63 байтів, і дві довгі таблиці зі спільним
 * початком дали б одну функцію; хеш повної назви тримає імена різними.
 */
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
