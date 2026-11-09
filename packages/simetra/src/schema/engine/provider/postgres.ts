/**
 * Пресет профілю `postgres` — чистий Postgres без образу провайдера (спека
 * профілів провайдера, §4.2): дзеркало `supabase.ts`, але майже порожнє.
 * Провайдер тут — лише схема Better Auth, тож межа керування бачить в чужих
 * схемах тригери провізії на `better_auth."user"` і більше нічого.
 */

import type { ProviderLocks, ProviderSurface } from "./supabase"

/**
 * Таблиця схеми Better Auth, на якій застосунок ставить тригери провізії
 * (спека профілю §4.2). Політик у схемі провайдера немає.
 */
export const POSTGRES_SURFACES: readonly ProviderSurface[] = [
  { schema: "better_auth", table: "user", classes: ["trigger"] },
]

/** `simetra_auth` не має типових привілеїв у схемах межі: системних ролей немає. */
export const POSTGRES_ROLES: readonly string[] = []

/**
 * Замків supautils у чистому Postgres немає; зняття тригера провізії судить
 * окрема перевірка плану (`plan.identity-trigger-locked`), а не ця мапа.
 */
export const POSTGRES_LOCKS: ProviderLocks = { sources: [], services: [] }

/** Порожньо: розширення профілю готує шаблон тіні, а не роль застосування (§3.5). */
export const POSTGRES_INSTALLABLE_EXTENSIONS: readonly string[] = []

/** Базового стану провайдера немає — сліпих функцій теж. */
export const POSTGRES_EXPECTED_BLIND_FUNCTIONS: readonly string[] = []

/**
 * Розширення, якими межа не керує: у профілі `postgres` їх готує шаблон тіні,
 * а не застосунок (спека профілю §3.5).
 */
export const POSTGRES_EXTENSIONS: readonly string[] = [
  "plpgsql",
  "plpgsql_check",
]

/** Тригерів подій базового стану в чистому Postgres немає. */
export const POSTGRES_EVENT_TRIGGERS: readonly string[] = []

/** Гранти схеми `public` у чистій базі: лише `USAGE` для `PUBLIC`. */
export const POSTGRES_PUBLIC_SCHEMA_GRANTS: readonly {
  grantee: string
  privileges: readonly string[]
}[] = [{ grantee: "PUBLIC", privileges: ["USAGE"] }]

/** Розширень базового стану немає: їх дає шаблон тіні. */
export const POSTGRES_BASE_EXTENSIONS: readonly {
  name: string
  schema: string
}[] = []
