import { defineRightsClientSnapshotCases } from "./rights-client-snapshot.support"

// Знімок прав клієнта на стеку Supabase; тіло — rights-client-snapshot.support.ts.
// Кейси ролі команд і споживача сигналів — лише на postgres: вхід тестів
// Supabase (`postgres`) не перемикається на ці ролі.
defineRightsClientSnapshotCases({ platformRoles: false })
