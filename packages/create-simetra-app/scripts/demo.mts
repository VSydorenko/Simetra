#!/usr/bin/env node
// `node scripts/demo.mts [drop]`. Вихідники `simetra` мають імпорти без
// розширень, яких вбудоване стирання типів Node не виконає, тож tsx
// реєструється до завантаження коду, як у `packages/designer/bin/simetra.mjs`.
// Імпорт динамічний: статичний виконався б ще до реєстрації.
import { register } from "tsx/esm/api"

register()
const { demoDrop, demoUp } = await import("./lib/demo.mts")

try {
  if (process.argv[2] === "drop") await demoDrop()
  else process.exitCode = await demoUp()
} catch (error) {
  console.error(
    `demo: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
}
