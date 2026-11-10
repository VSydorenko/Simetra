/**
 * Факти пресету провайдера за `scope.provider` — одне місце, де T2 бере
 * дані провайдера (платформна спека §6.9). Кожен факт — окрема мапа, а не
 * тип пресету: споживачі беруть лише свій факт, і новий провайдер — новий
 * ключ у кожній мапі, який вимагає `Record<DatabaseProvider, …>`. Імена ролей
 * API — факт T0 (`PROVIDER_API_ROLES`), не тут.
 */

import { quoteIdent, type DatabaseProvider } from "simetra/model"
import {
  POSTGRES_BASE_EXTENSIONS,
  POSTGRES_EVENT_TRIGGERS,
  POSTGRES_EXPECTED_BLIND_FUNCTIONS,
  POSTGRES_EXTENSIONS,
  POSTGRES_INSTALLABLE_EXTENSIONS,
  POSTGRES_LOCKS,
  POSTGRES_PUBLIC_SCHEMA_GRANTS,
  POSTGRES_ROLES,
  POSTGRES_SURFACES,
} from "./postgres"
import {
  SUPABASE_BASE_EXTENSIONS,
  SUPABASE_EVENT_TRIGGERS,
  SUPABASE_EXPECTED_BLIND_FUNCTIONS,
  SUPABASE_EXTENSIONS,
  SUPABASE_INSTALLABLE_EXTENSIONS,
  SUPABASE_LOCKS,
  SUPABASE_PUBLIC_SCHEMA_GRANTS,
  SUPABASE_ROLES,
  SUPABASE_SURFACES,
  type ProviderLocks,
  type ProviderSurface,
} from "./supabase"

/** Таблиці схем провайдера, одиниці на яких належать застосунку (§6.9). */
export const PROVIDER_SURFACES: Readonly<
  Record<DatabaseProvider, readonly ProviderSurface[]>
> = { supabase: SUPABASE_SURFACES, postgres: POSTGRES_SURFACES }

/**
 * Системні ролі пресету: типові привілеї «для ролі» з цього переліку двигун
 * не бачить (політика провайдера), тож і відбиток їх не читає.
 */
export const PROVIDER_SYSTEM_ROLES: Readonly<
  Record<DatabaseProvider, readonly string[]>
> = { supabase: SUPABASE_ROLES, postgres: POSTGRES_ROLES }

/** Механізм провайдерських замків пресету (спека промоції §7.2). */
export const PROVIDER_LOCKS: Readonly<Record<DatabaseProvider, ProviderLocks>> =
  { supabase: SUPABASE_LOCKS, postgres: POSTGRES_LOCKS }

/**
 * Розширення, які роль застосування може поставити попри `trusted = false`
 * (спека промоції §7.2): так план виводить режим `transient` для
 * `plpgsql_check`.
 */
export const PROVIDER_INSTALLABLE_EXTENSIONS: Readonly<
  Record<DatabaseProvider, readonly string[]>
> = {
  supabase: SUPABASE_INSTALLABLE_EXTENSIONS,
  postgres: POSTGRES_INSTALLABLE_EXTENSIONS,
}

/**
 * Сліпі функції базового стану провайдера поіменно (спека
 * промоції §7.2): замість попередження вивід плану називає їхню кількість.
 */
export const PROVIDER_EXPECTED_BLIND_FUNCTIONS: Readonly<
  Record<DatabaseProvider, readonly string[]>
> = {
  supabase: SUPABASE_EXPECTED_BLIND_FUNCTIONS,
  postgres: POSTGRES_EXPECTED_BLIND_FUNCTIONS,
}

/**
 * Шаблон бази для тіні профілю (спека профілю §3.5): `null` — тінь
 * створюється з `template0`. У `postgres` шаблон готує `roles` (розширення,
 * `plpgsql_check`), і тінь копіюється з нього.
 */
export const PROVIDER_SHADOW_TEMPLATES: Readonly<
  Record<DatabaseProvider, string | null>
> = { supabase: null, postgres: "simetra_template" }

/**
 * Профіль із шаблоном тіні копіює тінь із шаблону кластера цілі й окремого
 * сервера тіней не знає (Р9). Єдине місце цього факту для плану, адаптера й
 * інструмента застосування.
 */
export function copiesShadowFromTemplate(provider: DatabaseProvider): boolean {
  return PROVIDER_SHADOW_TEMPLATES[provider] !== null
}

/** Колляція бази: провайдер локалі `CREATE DATABASE` і локаль. */
export interface DatabaseLocale {
  provider: "icu"
  locale: string
}

/**
 * Колляція баз, які створює `roles` (спека профілю §3.4): обчислювач фільтра
 * на клієнті порівнює рядки колатором `en-US` (спека П4-B §4.2), тож база
 * мусить сортувати так само. `null` — бази створює провайдер, і `roles` їх не
 * створює.
 */
export const PROVIDER_DATABASE_LOCALES = {
  supabase: null,
  postgres: { provider: "icu", locale: "en-US" },
} as const satisfies Readonly<Record<DatabaseProvider, DatabaseLocale | null>>

/**
 * Розширення, якими межа не керує (їх ставить провайдер): перепис і політика
 * двигуна виключають їх з обох боків звірки.
 */
export const PROVIDER_UNMANAGED_EXTENSIONS: Readonly<
  Record<DatabaseProvider, readonly string[]>
> = { supabase: SUPABASE_EXTENSIONS, postgres: POSTGRES_EXTENSIONS }

/** Тригери подій базового стану (LIKE-шаблони), яких перепис не рахує. */
export const PROVIDER_EVENT_TRIGGERS: Readonly<
  Record<DatabaseProvider, readonly string[]>
> = { supabase: SUPABASE_EVENT_TRIGGERS, postgres: POSTGRES_EVENT_TRIGGERS }

/** Гранти самої схеми `public` в базовому стані провайдера (спека промоції §9.9). */
export const PROVIDER_PUBLIC_SCHEMA_GRANTS: Readonly<
  Record<
    DatabaseProvider,
    readonly { grantee: string; privileges: readonly string[] }[]
  >
> = {
  supabase: SUPABASE_PUBLIC_SCHEMA_GRANTS,
  postgres: POSTGRES_PUBLIC_SCHEMA_GRANTS,
}

/** Розширення базового стану, на які може посилатися бажаний стан. */
export const PROVIDER_BASE_EXTENSIONS: Readonly<
  Record<DatabaseProvider, readonly { name: string; schema: string }[]>
> = { supabase: SUPABASE_BASE_EXTENSIONS, postgres: POSTGRES_BASE_EXTENSIONS }

const granteeSql = (role: string) =>
  role === "PUBLIC" ? "PUBLIC" : quoteIdent(role)

/**
 * Засів тіні базовим станом провайдера: тінь створюється з `template0`, тож
 * без засіву `public` має лише `USAGE` для `PUBLIC`, а базових розширень немає.
 * Робоча база цей стан уже має, тож у `renderDesiredState` засіву немає —
 * його подає лише адаптер тіні, окремим файлом перед бажаним станом.
 * Тінь із шаблону базовий стан уже несе, тож засіву їй не потрібно.
 */
export function renderProviderSeed(provider: DatabaseProvider): string {
  if (PROVIDER_SHADOW_TEMPLATES[provider] !== null) return ""
  // Один оператор на набір привілеїв: отримувачі з різними наборами не мають
  // тихо отримати об'єднання
  const byPrivileges = new Map<string, string[]>()
  for (const g of PROVIDER_PUBLIC_SCHEMA_GRANTS[provider]) {
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
    ...PROVIDER_BASE_EXTENSIONS[provider].map(
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
