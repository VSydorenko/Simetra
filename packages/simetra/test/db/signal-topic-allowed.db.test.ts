import { defineSignalTopicCases } from "./signal-topic-allowed.support"

// Оракул каналу й політика outbox на стеку postgres; тіло — signal-topic-allowed.support.ts
defineSignalTopicCases({ platformRoles: true })
