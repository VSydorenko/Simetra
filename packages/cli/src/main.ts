import { defineCommand, runCommand, runMain, showUsage } from "citty"

const main = defineCommand({
  meta: {
    name: "simetra",
    description: "Simetra metadata tooling",
  },
  subCommands: {
    // Ліниві підкоманди повертають саму команду, а не простір імен модуля.
    compile: () => import("./commands/compile").then((m) => m.default),
    explain: () => import("./commands/explain").then((m) => m.default),
    fix: () => import("./commands/fix").then((m) => m.default),
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
