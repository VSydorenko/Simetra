/**
 * Факти пресету провайдера за `scope.provider` — одне місце, де T2 бере
 * дані провайдера (платформна спека §6.9). Кожен факт — окрема мапа, а не
 * тип пресету: споживачі беруть лише свій факт, і новий провайдер — новий
 * ключ у кожній мапі, який вимагає `Record<DatabaseProvider, …>`. Імена ролей
 * API — факт T0 (`PROVIDER_API_ROLES`), не тут.
 */

import type { DatabaseProvider } from "simetra/model"
import {
  SUPABASE_LOCKS,
  SUPABASE_ROLES,
  SUPABASE_SURFACES,
  type ProviderLocks,
  type ProviderSurface,
} from "./supabase"

/** Таблиці схем провайдера, одиниці на яких належать застосунку (§6.9). */
export const PROVIDER_SURFACES: Readonly<
  Record<DatabaseProvider, readonly ProviderSurface[]>
> = { supabase: SUPABASE_SURFACES }

/**
 * Системні ролі пресету: типові привілеї «для ролі» з цього переліку двигун
 * не бачить (політика провайдера), тож і відбиток їх не читає.
 */
export const PROVIDER_SYSTEM_ROLES: Readonly<
  Record<DatabaseProvider, readonly string[]>
> = { supabase: SUPABASE_ROLES }

/** Механізм провайдерських замків пресету (R27 плану П3-2a). */
export const PROVIDER_LOCKS: Readonly<Record<DatabaseProvider, ProviderLocks>> =
  { supabase: SUPABASE_LOCKS }
