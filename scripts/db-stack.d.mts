// Типи для імпорту з TS-тестів: скрипт лишається .mjs без збірки, бо команди
// стека кличуть його до `pnpm install`.
export function withStackLock(
  path: string,
  fn: () => Promise<void>
): Promise<void>

/** Lock file name of the postgres stack, in the machine's temp dir. */
export const POSTGRES_LOCK_FILE: string
