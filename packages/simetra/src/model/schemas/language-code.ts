/**
 * Підмножина BCP 47 «мова[-Script][-REGION]» (спека багатомовності §5.2). Одне
 * джерело для CHECK `code` ролі `languages` (T0 `kinds/catalog.ts`) і поля
 * `primaryDataLanguage` проєкту: POSIX-регекс Postgres і JS-регекс тут збігаються.
 */
export const LANGUAGE_CODE_PATTERN =
  "^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$"
