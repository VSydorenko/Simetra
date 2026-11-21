import { describeViewWritePath } from "./view-write-path.support"

/**
 * Той самий доказ премиси Р3 (інваріант І14) на стеку Supabase, де типові
 * привілеї провайдера дають ролям API записи на таблиці `public`. Випадок
 * спільний із `view-write-path.db.test.ts`.
 */
describeViewWritePath()
