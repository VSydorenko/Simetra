import { clipBytes } from "simetra/model"
import { sha256HexSync } from "./sha256"

/**
 * Мітки рядкових `BEFORE`-тригерів платформи в порядку спрацювання.
 * Postgres запускає тригери одного часу за іменем (порівняння байтів), тож
 * порядок `author → carriers → key → touch` тримається, лише коли всі імена групи
 * мають один префікс, а мітки сортуються як цей масив.
 */
export const PLATFORM_BEFORE_ROW_LABELS = [
  "simetra_author",
  "simetra_author_update",
  "simetra_carriers",
  "simetra_key",
  "simetra_touch",
  "simetra_touch_update",
] as const

export type PlatformBeforeRowLabel = (typeof PLATFORM_BEFORE_ROW_LABELS)[number]

const MAX_IDENT_BYTES = 63
const HASH_LENGTH = 8

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Префікс міряють за найдовшою міткою, щоб він не залежав від мітки. */
const LONGEST_LABEL = Math.max(
  ...PLATFORM_BEFORE_ROW_LABELS.map((label) => encoder.encode(label).length)
)

/**
 * Ім'я рядкового `BEFORE`-тригера платформи. `makeObjectName` обрізав би назву
 * таблиці на довжину кожної мітки окремо, і на довгій таблиці префікси
 * розійшлися б, а з ними — порядок спрацювання. Тут префікс спільний для всієї
 * групи; довгу назву скорочено з хешем повної назви, щоб дві таблиці зі
 * спільним початком не отримали одне ім'я.
 */
export function platformBeforeTriggerName(
  table: string,
  label: PlatformBeforeRowLabel
): string {
  const bytes = encoder.encode(table)
  if (bytes.length + 1 + LONGEST_LABEL <= MAX_IDENT_BYTES)
    return `${table}_${label}`
  const clipped = decoder.decode(
    clipBytes(bytes, MAX_IDENT_BYTES - 1 - LONGEST_LABEL - 1 - HASH_LENGTH)
  )
  return `${clipped}_${sha256HexSync(table).slice(0, HASH_LENGTH)}_${label}`
}
