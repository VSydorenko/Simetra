// Типи для імпорту з TS-тестів: скрипт лишається .mjs без збірки, бо команди
// стека кличуть його до `pnpm install`.
export function withStackLock(
  path: string,
  fn: () => Promise<void>
): Promise<void>

/** Lock file name of the postgres stack, in the machine's temp dir. */
export const POSTGRES_LOCK_FILE: string

/** Argv of `docker compose exec … psql`; holds no password (it goes through stdin). */
export const POSTGRES_PSQL_ARGS: readonly string[]

/** Argv and environment of the Better Auth step; the DSN is only in `env`. */
export function betterAuthCommand(
  secrets: Record<string, string>,
  superuserUrl: string
): { args: string[]; env: Record<string, string> }
