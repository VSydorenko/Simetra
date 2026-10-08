import type pg from "pg"

/**
 * Коментар control-файлу кожного встановленого розширення (для його версії).
 * `CREATE EXTENSION` ставить його сам, а двигун цього типового значення не
 * знає й дає `comment:(extension:…)` як звичайний коментар — доведена прогалина
 * двигуна (план E2a, рішення 8), тож вузький запит до каталогу, а не читач.
 * Коментар, рівний типовому, неявний; відмінний — одиниця.
 */
export async function readExtensionComments(
  pool: pg.Pool
): Promise<ReadonlyMap<string, string>> {
  const { rows } = await pool.query<{ name: string; comment: string | null }>(
    `select e.extname as name, v.comment
       from pg_extension e
       join pg_available_extension_versions v
         on v.name = e.extname and v.version = e.extversion`
  )
  return new Map(
    rows.flatMap((r) => (r.comment === null ? [] : [[r.name, r.comment]]))
  )
}
