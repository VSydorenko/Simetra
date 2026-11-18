import { defineSignalCoreCases } from "./signal-core.support"

// Сигнал на стеку Supabase; тіло — signal-core.support.ts. Сценарії ядра
// під роллю команд — лише на postgres: вхід тестів Supabase (`postgres`)
// не перемикається на роль команд.
defineSignalCoreCases({ platformRoles: false })
