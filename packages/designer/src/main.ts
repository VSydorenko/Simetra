import { defineCommand, runCommand, runMain, showUsage } from "citty"
// Версію вбудовує збірка: у пакеті `dist/main.js` не читає маніфест з диска
import pkg from "../package.json" with { type: "json" }
import { TOOL_NAMES } from "./tools/types"

const main = defineCommand({
  meta: {
    name: "simetra",
    version: pkg.version,
    description: "Simetra metadata tooling",
  },
  subCommands: {
    // Ліниво: `--help` не повинен вантажити компілятор і SDK MCP.
    ...Object.fromEntries(
      TOOL_NAMES.map((name) => [
        name,
        () => import("./cli/command").then((m) => m.commandByName(name)),
      ])
    ),
    mcp: () => import("./commands/mcp").then((m) => m.default),
  },
})

const rawArgs = process.argv.slice(2)

if (rawArgs.some((a) => a === "--help" || a === "-h" || a === "--version")) {
  // Довідка й версія — штатний шлях citty (вихід 0).
  void runMain(main)
} else {
  // `runMain` завершує будь-яку помилку кодом 1, а помилки
  // використання й введення-виведення — код 2 (1 — лише діагностика,
  // docs/architecture/designer.md).
  try {
    await runCommand(main, { rawArgs })
  } catch (error) {
    // CLIError citty не експортує — розпізнаємо за іменем.
    if (error instanceof Error && error.name === "CLIError") {
      await showUsage(main)
      console.error(error.message)
    } else {
      console.error(error)
    }
    process.exitCode = 2
  }
}
