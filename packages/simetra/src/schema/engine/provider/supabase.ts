/**
 * Пресет провайдера Supabase для межі керування (платформна спека §6.9:
 * «перелік для конкретного провайдера — пресет»). Модуль нейтральний щодо
 * двигуна й не імпортує його пакет: адаптер двигуна живе в `@simetra/designer`
 * (`packages/designer/src/schema-engine/`), а перепис, межа моделі й коментарі розширень від нього не залежать.
 * Рівність переліків тим, що виключає закріплена версія двигуна, тримає
 * контрактний тест адаптера.
 */

import { quoteIdent } from "simetra/model"

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
 * Розширення, якими межа не керує: їх ставить провайдер, а не застосунок, тож
 * межа їх не створює й не видаляє. Базові з них (`SUPABASE_BASE_EXTENSIONS`)
 * тінь має із засіву провайдера, але виключення з межі лишається: керування
 * ними в бажаному стані дало б застосунку право видалити розширення
 * провайдера з цілі.
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

/**
 * Гранти самої схеми `public` в образі провайдера (власник схеми — поза
 * переліком: його права дає володіння). Тінь засівається цим пресетом, а не
 * копією ACL цілі (спека промоції §9.9): інакше відмінність цілі від образу
 * провайдера зникла б з обох боків порівняння. Привілеї — у верхньому
 * регістрі, як у payload двигуна. Рівність образу локального стеку тримає
 * контрактний тест `provider-preset.db.test.ts`.
 */
export const SUPABASE_PUBLIC_SCHEMA_GRANTS: readonly {
  grantee: string
  privileges: readonly string[]
}[] = [
  { grantee: "PUBLIC", privileges: ["USAGE"] },
  { grantee: "postgres", privileges: ["USAGE"] },
  { grantee: "anon", privileges: ["USAGE"] },
  { grantee: "authenticated", privileges: ["USAGE"] },
  { grantee: "service_role", privileges: ["USAGE"] },
]

/**
 * Розширення базового стану, на які може посилатися бажаний стан (тіло
 * функції з `extensions.gen_random_bytes`): без них у тіні перевірка тіл
 * функцій скаржиться на відсутній об'єкт. `plpgsql` є в кожній базі з
 * `template0`; `supabase_vault` у засів не входить.
 */
export const SUPABASE_BASE_EXTENSIONS: readonly {
  name: string
  schema: string
}[] = [
  { name: "pgcrypto", schema: "extensions" },
  { name: "uuid-ossp", schema: "extensions" },
  { name: "pg_stat_statements", schema: "extensions" },
]

const granteeSql = (role: string) =>
  role === "PUBLIC" ? "PUBLIC" : quoteIdent(role)

/**
 * Засів тіні базовим станом провайдера: тінь створюється з `template0`, тож
 * без засіву `public` має лише `USAGE` для `PUBLIC`, а базових розширень немає.
 * Робоча база цей стан уже має, тож у `renderDesiredState` засіву немає —
 * його подає лише адаптер тіні, окремим файлом перед бажаним станом.
 */
export function renderProviderSeed(): string {
  // Один оператор на набір привілеїв: отримувачі з різними наборами не мають
  // тихо отримати об'єднання
  const byPrivileges = new Map<string, string[]>()
  for (const g of SUPABASE_PUBLIC_SCHEMA_GRANTS) {
    const key = g.privileges.join(", ")
    byPrivileges.set(key, [
      ...(byPrivileges.get(key) ?? []),
      granteeSql(g.grantee),
    ])
  }
  return [
    ...[...byPrivileges].map(
      ([privileges, grantees]) =>
        `GRANT ${privileges} ON SCHEMA public TO ${grantees.join(", ")};`
    ),
    ...SUPABASE_BASE_EXTENSIONS.map(
      (ext) =>
        `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(ext.name)} WITH SCHEMA ${quoteIdent(ext.schema)};`
    ),
  ]
    .map(
      (line) => `${line}
`
    )
    .join("")
}

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

/**
 * Класи операторів, до яких провайдер може додати замки на свої таблиці
 * (спека промоції §7.2, «З'єднання й блокування», R27 плану П3-2a). Клас
 * кроку T2 виводить з дерева
 * розбору, а не з тексту SQL.
 */
export const PROVIDER_LOCK_STATEMENTS = [
  "createPolicy",
  "alterPolicy",
  "dropPolicy",
  "commentPolicy",
  "dropTrigger",
] as const

export type ProviderLockStatement = (typeof PROVIDER_LOCK_STATEMENTS)[number]

/**
 * Джерело переліку таблиць, які займає клас операторів: налаштування цілі з
 * JSON-об'єктом «роль → кваліфіковані імена таблиць».
 */
export interface ProviderLockSource {
  statements: readonly ProviderLockStatement[]
  setting: string
}

/**
 * Механізм провайдерських замків як дані: самого переліку таблиць пресет не
 * тримає — його читає план з цілі, бо провайдер змінює його між версіями.
 * `services` — служби провайдера, що стоять, доки транзакція тримає ці замки.
 */
export interface ProviderLocks {
  sources: readonly ProviderLockSource[]
  services: readonly string[]
}

/**
 * supautils виконує оператори політик і зняття тригера ролі з переліку з
 * підвищеними правами і бере при цьому `ACCESS EXCLUSIVE` на кожну таблицю
 * переліку цієї ролі — незалежно від таблиці самого оператора, до кінця
 * транзакції (перевірено на локальному стеку). `COMMENT ON POLICY` займає їх
 * так само; перейменування політики, створення тригера й `DROP TABLE` з
 * каскадом — ні.
 */
export const SUPABASE_LOCKS: ProviderLocks = {
  sources: [
    {
      statements: [
        "createPolicy",
        "alterPolicy",
        "dropPolicy",
        "commentPolicy",
      ],
      setting: "supautils.policy_grants",
    },
    { statements: ["dropTrigger"], setting: "supautils.drop_trigger_grants" },
  ],
  services: ["Auth", "Storage", "Realtime"],
}

/**
 * Розширення, які роль застосування може поставити, хоч вони й не довірені
 * (`trusted = false`) і роль не суперкористувач: supautils провайдера
 * виконує `CREATE EXTENSION` переліку з підвищеними правами (рішення 4 плану
 * П3-2b-1). Раннер ставить `plpgsql_check` лише в точці збереження.
 */
export const SUPABASE_INSTALLABLE_EXTENSIONS: readonly string[] = [
  "plpgsql_check",
]

/**
 * Функції базового стану провайдера, яких перевірка тіл не бачить
 * (рішення 5 плану П3-2b-1), — поіменно, за ідентичністю
 * `<схема>.<ім'я>(<типи аргументів>)` (`oidvectortypes`, без лапок), не за
 * схемою: виняток цілою схемою був би тихою зоною, а попередження, що
 * звучить завжди, привчає його не читати. Сліпа функція провайдера поза
 * переліком (нова версія провайдера) і далі дає попередження. Перелік звірено
 * з локальним стеком роллю `postgres`.
 */
export const SUPABASE_EXPECTED_BLIND_FUNCTIONS: readonly string[] = [
  // Функції подієвих тригерів провайдера: `plpgsql_check` подієвих функцій
  // не перевіряє (валідатор мови їх таки компілює)
  "extensions.grant_pg_cron_access()",
  "extensions.grant_pg_graphql_access()",
  "extensions.grant_pg_net_access()",
  "extensions.pgrst_ddl_watch()",
  "extensions.pgrst_drop_watch()",
  "extensions.set_graphql_placeholder()",
  // Власник — `supabase_admin`, `EXECUTE` лише для ролі пулера: роль
  // застосування тіла не перевірить жодним способом
  "pgbouncer.get_auth(text)",
  // Тригерна функція вебхуків без тригера, доки жодного вебхука не
  // створено: `plpgsql_check` перевіряє тригерну функцію лише з таблицею
  "supabase_functions.http_request()",
]
