import { defineCommand, runCommand, runMain, showUsage } from "citty"
import { catalogSubCommands } from "./cli/command"

const main = defineCommand({
  meta: {
    name: "simetra",
    description: "Simetra metadata tooling",
  },
  subCommands: {
    ...catalogSubCommands(),
    // Ліниво: сервер MCP тягне SDK, який потрібен лише цій підкоманді.
    mcp: () => import("./commands/mcp").then((m) => m.default),
  },
})

const rawArgs = process.argv.slice(2)

if (rawArgs.some((a) => a === "--help" || a === "-h" || a === "--version")) {
  // Довідка й версія — штатний шлях citty (вихід 0).
  void runMain(main)
} else {
  // `runMain` завершує будь-яку помилку кодом 1, а за рішенням плану 6
  // помилки використання й введення-виведення — код 2 (1 — лише діагностика).
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
