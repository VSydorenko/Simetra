/**
 * Converts runtime values to JSON: `bigint` becomes a decimal string, which
 * the `BigInt` input of T0 accepts back. The single place of this conversion.
 */
// Адаптери не мають власних копій: розбіжність форми дала б різні відповіді
// в різних каналах.
export function toJson(value: unknown): unknown {
  if (typeof value === "bigint") return String(value)
  if (Array.isArray(value)) return value.map(toJson)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toJson(v)])
    )
  return value
}
