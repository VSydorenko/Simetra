export const ALLOW_WRITE_FLAG = "--allow-write"

/**
 * Єдине джерело тексту «як увімкнути запис»: його бачить і клієнт MCP в
 * `instructions`, і агент у відмові на запис у режимі лише читання.
 * `launchArgs` — справжній argv запуску сервера без node і скрипта, тобто
 * лише ХВІСТ `args` у конфігу клієнта: лаунчер (`pnpm exec simetra …`,
 * `npx …`, обгортка) додає свої аргументи попереду. Тому підказка каже
 * «допиши прапорець у кінець» і показує хвіст до й після, а не видає його за
 * повний `"args"` — буквальна заміна зламала б конфіг.
 */
export function writeAccessHint(
  launchArgs: readonly string[] = ["simetra", "mcp"]
): string {
  const before = launchArgs.filter((a) => a !== ALLOW_WRITE_FLAG)
  const after = [...before, ALLOW_WRITE_FLAG]
  return [
    "This server is read-only: tools that change files are disabled.",
    `To enable them, append ${ALLOW_WRITE_FLAG} to the end of this server's args in the MCP client config and restart it:`,
    `args ending in ${JSON.stringify(before)} become ${JSON.stringify(after)}.`,
  ].join(" ")
}
