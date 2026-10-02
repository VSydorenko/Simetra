/**
 * Пресет провайдера Supabase для межі керування (платформна спека §6.9:
 * «перелік для конкретного провайдера — пресет»). Модуль нейтральний щодо
 * двигуна й не імпортує його пакет: адаптер двигуна живе в `@simetra/designer`
 * (`packages/designer/src/schema-engine/`), а перепис, межа моделі й коментарі розширень від нього не залежать.
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

/**
 * Ролі провайдера: їх створює провайдер, а не застосунок. Порівняння з
 * правилом «власник — системна роль» закріпленої версії двигуна тримає
 * контрактний тест адаптера.
 */
export const SUPABASE_ROLES: readonly string[] = [
  "anon",
  "authenticated",
  "authenticator",
  "cli_login_postgres",
  "dashboard_user",
  "pgbouncer",
  "pgsodium_keyholder",
  "pgsodium_keyiduser",
  "pgsodium_keymaker",
  "pgtle_admin",
  "service_role",
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_etl_admin",
  "supabase_functions_admin",
  "supabase_privileged_role",
  "supabase_read_only_user",
  "supabase_realtime_admin",
  "supabase_replication_admin",
  "supabase_storage_admin",
  "supabase_superuser",
]

/**
 * Таблиці схем провайдера, на яких одиниці застосунку належать застосунку
 * (§6.9): `table` — glob імені таблиці, `classes` — класи одиниць.
 */
export interface ProviderSurface {
  schema: string
  table: string
  classes: readonly ("policy" | "trigger")[]
}

/**
 * Політики — перелік правила `supabase.user-policy-surface` двигуна
 * (контрактний тест адаптера): окремі таблиці `storage`/`realtime` і вся
 * схема `auth`. Тригери — таблиці будь-якої схеми провайдера, крім `pgmq`:
 * двигун виключає там лише черги `q_*`/`a_*`, а позитивний glob такого
 * виключення не виражає, тож тригер у `pgmq` — гучна помилка, а не тиха
 * втрата. Умову «функція тригера поза схемами провайдера» перевіряє межа
 * моделі: це властивість одиниці, а не таблиці.
 */
export const SUPABASE_SURFACES: readonly ProviderSurface[] = [
  { schema: "auth", table: "*", classes: ["policy"] },
  { schema: "realtime", table: "messages", classes: ["policy"] },
  { schema: "realtime", table: "subscription", classes: ["policy"] },
  { schema: "storage", table: "buckets", classes: ["policy"] },
  { schema: "storage", table: "buckets_analytics", classes: ["policy"] },
  { schema: "storage", table: "objects", classes: ["policy"] },
  { schema: "storage", table: "s3_multipart_uploads", classes: ["policy"] },
  {
    schema: "storage",
    table: "s3_multipart_uploads_parts",
    classes: ["policy"],
  },
  ...SUPABASE_SCHEMAS.filter((schema) => schema !== "pgmq").map(
    (schema): ProviderSurface => ({ schema, table: "*", classes: ["trigger"] })
  ),
]
