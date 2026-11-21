import { defineRightsSignalCases } from "./rights-signals.support"

// Сигнали прав на стеку Supabase; тіло — rights-signals.support.ts.
// Кейси ролі команд — на postgres: вхід тестів Supabase (`postgres`) не
// перемикається на роль команд.
defineRightsSignalCases({ platformRoles: false })
