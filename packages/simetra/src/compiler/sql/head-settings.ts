/**
 * Налаштування сесії, які корінь голови (функція множини скоупу, функція
 * значень виміру, функція політики) фіксує у своїй оболонці (спека декларацій
 * функцій §5.8): клієнт ставить їх сам (`Prefer: timezone` PostgREST, `SET`
 * сесії), а від них залежать ввід і вивід значень — перетворення
 * `timestamptz` у місцевий час, текст дат, інтервалів, чисел, грошей,
 * `bytea` і XML, розбір скорочень зон і конфігурація повнотекстового пошуку
 * без явного аргументу. Значення нейтральні; ланка, яку голова кличе,
 * виконується вже в цих налаштуваннях і не ставить їм інших значень.
 * Повноту набору проти `pg_settings` закріпленої версії Postgres тримає
 * DB-тест (`packages/simetra/test/db/head-settings.db.test.ts`).
 * Модуль без імпортів: його читають і суддя оболонки, і каталог повідомлень.
 */
export const HEAD_PINNED_SETTINGS: readonly {
  name: string
  value: string
}[] = [
  { name: "TimeZone", value: "UTC" },
  { name: "DateStyle", value: "ISO, MDY" },
  { name: "IntervalStyle", value: "postgres" },
  { name: "extra_float_digits", value: "1" },
  { name: "lc_monetary", value: "C" },
  { name: "lc_numeric", value: "C" },
  { name: "lc_time", value: "C" },
  { name: "bytea_output", value: "hex" },
  { name: "xmlbinary", value: "base64" },
  { name: "xmloption", value: "content" },
  { name: "timezone_abbreviations", value: "Default" },
  { name: "default_text_search_config", value: "pg_catalog.simple" },
]

/**
 * Опції `SET` оболонки кореня голови з `HEAD_PINNED_SETTINGS` — текст для
 * підказок: ім'я з великими літерами — в лапках, як його друкує
 * `pg_get_functiondef` (регістр імені налаштування Postgres не розрізняє).
 */
export function pinnedSettingsClause(): string {
  return HEAD_PINNED_SETTINGS.map(
    ({ name, value }) =>
      `SET ${name === name.toLowerCase() ? name : `"${name}"`} = '${value}'`
  ).join(" ")
}
