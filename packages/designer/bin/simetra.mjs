#!/usr/bin/env node
import { register } from "tsx/esm/api"

// Вихідники `simetra` мають імпорти без розширень, яких вбудоване стирання
// типів Node не виконає, тож реєструємо tsx до завантаження коду. Імпорт
// динамічний: статичний виконався б ще до реєстрації.
register()
await import("../src/main.ts")
