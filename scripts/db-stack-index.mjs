// Єдине місце, де індекс стека `postgres` стає іменами, портами й замком.
// Чистий ESM без залежностей: його імпортують і скрипт стека (він працює до
// `pnpm install`), і TS-тести. Усі функції беруть `env` параметром.
import { join } from "node:path"

export const STACK_ENV = "SIMETRA_STACK"
export const STACK_POOL_ENV = "SIMETRA_STACK_POOL"
export const MIN_STACK = 1
export const MAX_STACK = 9

function parseIndex(text, variable) {
  if (!/^[1-9]$/.test(text)) {
    throw new Error(
      `${variable} must be an integer from ${MIN_STACK} to ${MAX_STACK}, got ${JSON.stringify(text)}`
    )
  }
  return Number(text)
}

/** Index of the selected stack: `SIMETRA_STACK`, 1 when unset. */
export function stackIndex(env = process.env) {
  const raw = env[STACK_ENV]
  return raw === undefined ? 1 : parseIndex(raw, STACK_ENV)
}

/** Candidate stack indexes: `SIMETRA_STACK_POOL` in its order, 1…9 when unset. */
export function stackPool(env = process.env) {
  const raw = env[STACK_POOL_ENV]
  if (raw === undefined) {
    return Array.from({ length: MAX_STACK - MIN_STACK + 1 }, (_, i) => i + 1)
  }
  const items = raw.split(",").map((item) => item.trim())
  const pool = items.map((item) => parseIndex(item, STACK_POOL_ENV))
  if (new Set(pool).size !== pool.length) {
    throw new Error(
      `${STACK_POOL_ENV} lists a stack twice: ${JSON.stringify(raw)}`
    )
  }
  return pool
}

/** Identity of the postgres stack `index`: project, ports, lock, stack key. */
export function postgresStack(index) {
  if (!Number.isInteger(index) || index < MIN_STACK || index > MAX_STACK) {
    throw new Error(
      `Stack index must be an integer from ${MIN_STACK} to ${MAX_STACK}, got ${String(index)}`
    )
  }
  const first = index === 1
  const shift = 10 * (index - 1)
  return {
    index,
    key: first ? "postgres" : `postgres-${index}`,
    project: first ? "simetra-pg" : `simetra-pg-${index}`,
    lockPath: join(
      "/tmp",
      first
        ? "simetra-db-stack-postgres.lock"
        : `simetra-db-stack-postgres-${index}.lock`
    ),
    pgPort: 54422 + shift,
    garageS3Port: 3900 + shift,
    garageAdminPort: 3903 + shift,
  }
}

/** Throws (ADR-0117) when the frozen `supabase` profile meets a pool selection. */
export function assertSupabaseUnindexed(env = process.env) {
  const hasStack = env[STACK_ENV] !== undefined && stackIndex(env) !== 1
  if (hasStack || env[STACK_POOL_ENV] !== undefined) {
    throw new Error(
      `The supabase profile has no stack index: ${STACK_ENV} other than 1 and ${STACK_POOL_ENV} apply only to postgres (ADR-0117)`
    )
  }
}
