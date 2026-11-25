/**
 * Значення рантайму для JSON: `bigint` → десятковий рядок. JSON не має
 * `bigint`, а вхід `BigInt` T0 приймає цей рядок назад. Єдине місце такого
 * перетворення в T3: адаптери не мають власних копій.
 */
export function toJson(value: unknown): unknown {
  if (typeof value === "bigint") return String(value)
  if (Array.isArray(value)) return value.map(toJson)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toJson(v)])
    )
  return value
}
