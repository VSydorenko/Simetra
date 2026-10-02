export const ALLOW_WRITE_FLAG = "--allow-write"

/**
 * Єдине джерело тексту «як увімкнути запис»: його бачить і клієнт MCP в
 * `instructions`, і агент у відмові на запис у режимі лише читання.
 * `launchArgs` — справжній argv запуску сервера (без node і скрипта), щоб
 * фрагмент можна було вставити в конфіг клієнта без правок.
 */
export function writeAccessHint(
  launchArgs: readonly string[] = ["simetra", "mcp"]
): string {
  const args = launchArgs.includes(ALLOW_WRITE_FLAG)
    ? [...launchArgs]
    : [...launchArgs, ALLOW_WRITE_FLAG]
  return [
    "This server is read-only: tools that change files are disabled.",
    `To enable them, add ${ALLOW_WRITE_FLAG} to the server arguments and restart it, e.g. "args": ${JSON.stringify(args)}.`,
  ].join(" ")
}
