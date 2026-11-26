// Типи для імпорту з TS-тестів; модуль лишається .mjs без збірки.
export const STACK_ENV: string
export const STACK_POOL_ENV: string
export const MIN_STACK: number
export const MAX_STACK: number

export type PostgresStack = {
  index: number
  /** Key of the stack in labels and reports: `postgres` or `postgres-N`. */
  key: string
  /** Compose project name. */
  project: string
  lockPath: string
  pgPort: number
  garageS3Port: number
  garageAdminPort: number
}

/** Index of the selected stack: `SIMETRA_STACK`, 1 when unset; throws on an invalid value. */
export function stackIndex(env?: Record<string, string | undefined>): number

/** Candidate indexes: `SIMETRA_STACK_POOL` in its order, 1…9 when unset; throws on an invalid value. */
export function stackPool(env?: Record<string, string | undefined>): number[]

/** Identity of the postgres stack `index` (1…9). */
export function postgresStack(index: number): PostgresStack

/** Throws (ADR-0117) when `supabase` meets `SIMETRA_STACK` other than 1 or `SIMETRA_STACK_POOL`. */
export function assertSupabaseUnindexed(
  env?: Record<string, string | undefined>
): void
