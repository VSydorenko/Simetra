import { encodeId } from "@supabase/pg-delta"
import type pg from "pg"
import type { FunctionVolatility } from "simetra/model"

const VOLATILITY: Readonly<Record<string, FunctionVolatility>> = {
  v: "volatile",
  s: "stable",
  i: "immutable",
}

/**
 * Волатильність кожної функції бази за її ідентичністю двигуна. Двигун дає
 * лише `pg_get_functiondef`, а той типової `VOLATILE` не друкує: відсутність
 * слова в тексті — формат виводу, а не факт, тож вузький запит до каталогу.
 * Типи аргументів — тим самим `format_type`, що й ідентичність двигуна.
 */
export async function readRoutineVolatility(
  pool: pg.Pool
): Promise<ReadonlyMap<string, FunctionVolatility>> {
  const { rows } = await pool.query<{
    schema: string
    name: string
    args: string[]
    volatility: string
  }>(
    `select n.nspname as schema, p.proname as name,
            array(select format_type(t.t, null)
                    from unnest(p.proargtypes) with ordinality as t(t, ord)
                   order by t.ord)::text[] as args,
            p.provolatile as volatility
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where p.prokind in ('f', 'w')`
  )
  return new Map(
    rows.map((r) => [
      encodeId({
        kind: "function",
        schema: r.schema,
        name: r.name,
        args: r.args,
      }),
      VOLATILITY[r.volatility]!,
    ])
  )
}
