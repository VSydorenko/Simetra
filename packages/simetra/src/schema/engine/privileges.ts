/**
 * Повний перелік привілеїв класу об'єкта в PostgreSQL 17 (таблиця 5.2
 * документації) — те, що означає `ALL` в операторі гранту. Ключ — клас
 * об'єкта в ідентичності одиниці компілятора (`grant:…:<клас>:…`), значення —
 * у нижньому регістрі, як у розборі libpg-query. Каталог тримає не `ALL`, а
 * розгорнутий список, тож звірка розгортає `ALL` за цією таблицею.
 */
export const ALL_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  table: [
    "delete",
    "insert",
    "maintain",
    "references",
    "select",
    "trigger",
    "truncate",
    "update",
  ],
  sequence: ["select", "update", "usage"],
  function: ["execute"],
  procedure: ["execute"],
  routine: ["execute"],
  schema: ["create", "usage"],
  type: ["usage"],
  domain: ["usage"],
  language: ["usage"],
  fdw: ["usage"],
  foreign_server: ["usage"],
}
