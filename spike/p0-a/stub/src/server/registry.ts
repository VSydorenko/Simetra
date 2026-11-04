import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core"

// Синтетичний реєстр у формі репорту #8139: верхньорівневий об'єкт таблиці
// Drizzle в графі серверної функції.
export const probeItems = pgTable("probe_items", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  label: text("label").notNull(),
  touchedAt: timestamp("touched_at", { withTimezone: true }).notNull(),
})

export const REGISTRY = { probeItems } as const
