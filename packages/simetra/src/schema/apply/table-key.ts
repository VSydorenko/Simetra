/**
 * Структурний ключ таблиці для множин і мап: ім'я з крапкою не злипається зі
 * схемою, як злиплося б у `schema.name`. Складені ключі підоб'єктів — так
 * само, `JSON.stringify([schema, table, name])`.
 */
export const tableKey = (schema: string, name: string): string =>
  JSON.stringify([schema, name])
