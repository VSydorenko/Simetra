/**
 * Факти пресету провайдера за `scope.provider` — одне місце, де T2 бере
 * дані провайдера (платформна спека §6.9). Кожен факт — окрема мапа, а не
 * тип пресету: споживачі беруть лише свій факт, і новий провайдер — новий
 * ключ у кожній мапі, який вимагає `Record<DatabaseProvider, …>`. Імена ролей
 * API — факт T0 (`PROVIDER_API_ROLES`), не тут.
 */

import type { DatabaseProvider } from "simetra/model"
import {
  POSTGRES_EXPECTED_BLIND_FUNCTIONS,
  POSTGRES_INSTALLABLE_EXTENSIONS,
  POSTGRES_LOCKS,
  POSTGRES_ROLES,
  POSTGRES_SURFACES,
} from "./postgres"
import {
  SUPABASE_EXPECTED_BLIND_FUNCTIONS,
  SUPABASE_INSTALLABLE_EXTENSIONS,
  SUPABASE_LOCKS,
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
