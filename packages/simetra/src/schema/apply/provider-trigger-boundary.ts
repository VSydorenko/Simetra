import type { DatabaseProvider } from "simetra/model"

/**
 * Межа тригера на таблиці провайдера — одне правило для політики двигуна,
 * перепису, відбитка дрейфу, середовища тіні й діагностики оголошеного
 * тригера (платформна спека §6.9). Залежності тригера — усі, які Postgres
 * йому записує: функція тригера й функції умови `WHEN`; вбудована функція
 * залежності не записує. Тригер у межі, коли (а) залежності не мають жодної
 * функції, або мають член розширення, або функцію схеми застосунку, і
 * (б) жодна функція-залежність не лежить у власній схемі провайдера
 * (`PROVIDER_ASSUMED_SCHEMAS`): таку функцію базова політика провайдера
 * вважає провайдерською. Інакше — зовнішня інтеграція. Політика двигуна
 * бачить ті самі залежності ребрами (член розширення — ребром до
 * розширення); тест правила проганяє повну матрицю входів через усіх
 * читачів.
 *
 * `trigger` — SQL-вираз oid тригера, `app` — SQL-вираз множини oid схем
 * застосунку, `provider` — SQL-вираз множини oid власних схем провайдера.
 */
export function providerTriggerInBoundarySql(
  trigger: string,
  app: string,
  provider: string
): string {
  const depends = (extra: string) => `exists (select from pg_catalog.pg_depend d
      join pg_catalog.pg_proc f on f.oid = d.refobjid
      where d.classid = 'pg_catalog.pg_trigger'::regclass and d.objid = ${trigger}
        and d.refclassid = 'pg_catalog.pg_proc'::regclass
        and not exists (select from pg_catalog.pg_depend x
          where x.classid = 'pg_catalog.pg_proc'::regclass and x.objid = f.oid
            and x.deptype = 'e')
        ${extra})`
  return `((
    not ${depends("")}
    or exists (select from pg_catalog.pg_depend d
      join pg_catalog.pg_depend x on x.classid = d.refclassid
        and x.objid = d.refobjid and x.deptype = 'e'
      where d.classid = 'pg_catalog.pg_trigger'::regclass and d.objid = ${trigger})
    or ${depends(`and f.pronamespace in (${app})`)})
    and not ${depends(`and f.pronamespace in (${provider})`)})`
}

/**
 * Власні схеми провайдера: їх засів тіні двигуна переносить з цілі
 * (припущені схеми профілю), а функцію в них базова політика вважає
 * провайдерською.
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
