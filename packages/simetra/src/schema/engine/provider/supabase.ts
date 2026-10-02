/**
 * Пресет провайдера Supabase для межі керування (платформна спека §6.9:
 * «перелік для конкретного провайдера — пресет»). Модуль нейтральний щодо
 * двигуна й не імпортує його пакет: адаптер двигуна може переїхати в окремий
 * пакет, а перепис, межа моделі й коментарі розширень від нього не залежать.
 * Рівність переліків тим, що виключає закріплена версія двигуна, тримає
 * контрактний тест адаптера.
 */

/** Схеми, які створює й наповнює провайдер; застосунок має в них лише поверхню пресету. */
export const SUPABASE_SCHEMAS: readonly string[] = [
  "_analytics",
  "_realtime",
  "_supavisor",
  "auth",
  "cron",
  "etl",
  "extensions",
  "graphql",
  "graphql_public",
  "information_schema",
  "net",
  "pgbouncer",
  "pgmq",
  "pgmq_public",
  "pgsodium",
  "pgsodium_masks",
  "pgtle",
  "realtime",
  "storage",
  "supabase_functions",
  "supabase_migrations",
  "vault",
]

/**
 * Розширення базового стану: їх ставить провайдер, а не застосунок, тож межа
 * їх не створює й не видаляє. `plpgsql`, `pgcrypto` і `uuid-ossp` пресет
 * двигуна не виключає, але засіяна тінь їх не має: без виключення план
 * «ціль → тінь» видаляв би їх із цілі.
 */
export const SUPABASE_EXTENSIONS: readonly string[] = [
  "pg_graphql",
  "pg_stat_statements",
  "pgcrypto",
  "pgsodium",
  "plpgsql",
  "supabase_vault",
  "uuid-ossp",
  "wrappers",
]

/** Тригери подій базового стану (LIKE-шаблони). */
export const SUPABASE_EVENT_TRIGGERS: readonly string[] = [
  "issue_%",
  "pgrst_%",
  "graphql_watch_%",
]
