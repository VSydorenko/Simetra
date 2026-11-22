import { PINNED_SESSION_SETTINGS } from "simetra/model"

/**
 * Опції `SET` оболонки кореня голови з `PINNED_SESSION_SETTINGS` (спека
 * декларацій функцій §5.8) — текст для підказок і фікстур: ім'я з великими
 * літерами — в лапках, як його друкує `pg_get_functiondef` (регістр імені
 * налаштування Postgres не розрізняє).
 */
export function pinnedSettingsClause(): string {
  return PINNED_SESSION_SETTINGS.map(
    ({ name, value }) =>
      `SET ${name === name.toLowerCase() ? name : `"${name}"`} = '${value}'`
  ).join(" ")
}
