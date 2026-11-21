import { describeViewWritePath } from "./view-write-path.support"

/**
 * Доказ премиси Р3 (інваріант І14) на стеку postgres: запис крізь подання без
 * `security_invoker` обминає RLS таблиці виду для ролі запиту, з ним —
 * `42501`. Випадок спільний із `view-write-path.supabase.db.test.ts`.
 */
describeViewWritePath()
