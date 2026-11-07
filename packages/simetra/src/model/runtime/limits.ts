/**
 * The most bytes a request body may carry (P4-B spec §4.5), measured by
 * {@link jsonBytes}.
 */
export const PAYLOAD_MAX_BYTES = 4 * 1024 * 1024

/**
 * The most bytes a response may carry (P4-B spec §4.5), measured by
 * {@link jsonBytes}; a page past it is cut, other reads are refused.
 */
export const RESPONSE_BUDGET_BYTES = 4 * 1024 * 1024

// Один кодувальник на модуль: міра йде на кожне тіло й кожну відповідь.
const encoder = new TextEncoder()

/**
 * UTF-8 bytes of `JSON.stringify(value)`, a `bigint` as its decimal text;
 * `0` when nothing serializes (`undefined`, a function).
 */
export function jsonBytes(value: unknown): number {
  // `bigint` — рядком, як його шле форма передачі (`INTEGER_TEXT`): інакше
  // `JSON.stringify` кидає, а міра розійшлася б із тим, що піде дротом.
  const text = JSON.stringify(value, (_, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v
  ) as string | undefined
  return text === undefined ? 0 : encoder.encode(text).length
}
