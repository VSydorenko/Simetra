// Типи для імпорту з TS-тестів: скрипт лишається .mjs без збірки, бо команди
// стека кличуть його до `pnpm install`.
export function withStackLock(
  path: string,
  fn: () => Promise<void>
): Promise<void>
