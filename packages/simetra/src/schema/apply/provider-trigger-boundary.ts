import type { DatabaseProvider } from "simetra/model"

/**
 * Межа тригера на таблиці провайдера — одне правило для політики двигуна,
 * перепису, відбитка дрейфу й середовища тіні (платформна спека §6.9). Тригер
 * у межі, коли його залежності не мають жодної функції (вбудована функція
 * `pg_catalog` залежності не записує), або мають член розширення, або
 * функцію схеми застосунку. Інакше — зовнішня інтеграція: звичайна функція
 * поза схемами застосунку (у тому числі в схемі провайдера) і нічого з
 * переліченого. Залежності — усі, які Postgres записує тригеру: функція
 * тригера й функції умови `WHEN`. Політика двигуна бачить ті самі
 * залежності ребрами (член розширення — ребром до розширення), тож судить
 * так само; тест правила проганяє однакові входи через усіх читачів.
 *
 * `trigger` — SQL-вираз oid тригера, `app` — SQL-вираз множини oid схем
 * застосунку.
 */
export function providerTriggerInBoundarySql(
  trigger: string,
  app: string
): string {
  return `(
    not exists (select from pg_catalog.pg_depend d
      where d.classid = 'pg_catalog.pg_trigger'::regclass and d.objid = ${trigger}
        and d.refclassid = 'pg_catalog.pg_proc'::regclass)
    or exists (select from pg_catalog.pg_depend d
      join pg_catalog.pg_depend x on x.classid = d.refclassid
        and x.objid = d.refobjid and x.deptype = 'e'
      where d.classid = 'pg_catalog.pg_trigger'::regclass and d.objid = ${trigger})
    or exists (select from pg_catalog.pg_depend d
      join pg_catalog.pg_proc f on f.oid = d.refobjid
      where d.classid = 'pg_catalog.pg_trigger'::regclass and d.objid = ${trigger}
        and d.refclassid = 'pg_catalog.pg_proc'::regclass
        and f.pronamespace in (${app})))`
}

/**
 * Схеми, які засів тіні двигуна переносить з цілі: припущені схеми профілю.
 * Функцію зовнішнього тригера в них середовище тіні не дублює, а в будь-якій
 * іншій схемі — бере дослівно. Політика профілю `postgres` бере
 * `assumedSchemas` звідси; для `supabase` тест звіряє перелік з політикою
 * pg-delta.
 */
export const PROVIDER_ASSUMED_SCHEMAS: Readonly<
  Record<DatabaseProvider, readonly string[]>
> = {
  supabase: [
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
  ],
  postgres: ["better_auth"],
}
