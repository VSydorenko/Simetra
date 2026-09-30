import { PG_QUOTED_KEYWORDS } from "./pg-keywords"

/** NAMEDATALEN у Postgres мінус завершальний нуль. */
const MAX_IDENT_BYTES = 63

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const PLAIN_IDENT = /^[a-z_][a-z0-9_$]*$/

/** Як `quote_ident` Postgres: лапки лише коли без них ім'я змінилося б. */
export function quoteIdent(name: string): string {
  if (PLAIN_IDENT.test(name) && !PG_QUOTED_KEYWORDS.has(name)) return name
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Обрізає до `maxBytes` байтів UTF-8, не розриваючи символ (аналог
 * `pg_mbcliplen`): Postgres міряє ліміт у байтах, а розрізаний символ дав би
 * інше ім'я, ніж те, що збереже БД.
 */
function clipBytes(bytes: Uint8Array, maxBytes: number): Uint8Array {
  let end = Math.min(maxBytes, bytes.length)
  // Байт-продовження (10xxxxxx) на межі означає, що ми всередині символу.
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end)
}

/**
 * Ім'я об'єкта за алгоритмом `makeObjectName` Postgres: `name1[_name2]_label`,
 * а коли не влізає в 63 байти — скорочуються частини (довша першою, за
 * рівності — друга), мітка лишається цілою.
 */
export function makeObjectName(
  name1: string,
  name2: string | undefined,
  label: string
): string {
  const n1 = encoder.encode(name1)
  const n2 = name2 === undefined ? undefined : encoder.encode(name2)

  let overhead = encoder.encode(label).length + 1
  if (n2 !== undefined) overhead++
  const avail = MAX_IDENT_BYTES - overhead

  let len1 = n1.length
  let len2 = n2?.length ?? 0
  while (len1 + len2 > avail) {
    if (len1 > len2) len1--
    else len2--
  }

  let result = decoder.decode(clipBytes(n1, len1))
  if (n2 !== undefined) result += `_${decoder.decode(clipBytes(n2, len2))}`
  return `${result}_${label}`
}

/**
 * Як `ChooseConstraintName`: за колізії з уже зайнятим ім'ям до мітки
 * дописується лічильник (`key1`, `key2`, …) і ім'я будується заново, тож
 * обрізання враховує довшу мітку.
 */
export function chooseConstraintName(
  name1: string,
  name2: string | undefined,
  label: string,
  taken: ReadonlySet<string>
): string {
  let candidate = makeObjectName(name1, name2, label)
  for (let pass = 1; taken.has(candidate); pass++) {
    candidate = makeObjectName(name1, name2, `${label}${pass}`)
  }
  return candidate
}
