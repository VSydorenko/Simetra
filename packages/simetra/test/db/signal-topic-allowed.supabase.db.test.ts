import { defineSignalTopicCases } from "./signal-topic-allowed.support"

// Оракул каналу на стеку Supabase; тіло — signal-topic-allowed.support.ts.
// Кейси ролі команд і входу споживача — лише на postgres: вхід тестів
// Supabase (`postgres`) не перемикається на роль команд.
defineSignalTopicCases({ platformRoles: false })
