import { encodeId } from "@supabase/pg-delta"
import type pg from "pg"
import type { FunctionVolatility } from "simetra/model"
import { readOnlyQuery } from "./read-only"

/**
 * Той самий оператор, яким витяг pg-delta фіксує шлях у своїй транзакції
 * (`SEARCH_PATH_STATEMENT` у `@supabase/pg-delta` `src/extract/scope.ts`;
 * пакет його не експортує): `format_type` кваліфікує кожен тип поза
 * `pg_catalog`, як і в ідентичності двигуна.
 */
const SEARCH_PATH_STATEMENT = "SET LOCAL search_path TO 'pg_catalog'"

const VOLATILITY: Readonly<Record<string, FunctionVolatility>> = {
  v: "volatile",
  s: "stable",
  i: "immutable",
}

/**
 * Волатильність кожної функції бази за її ідентичністю двигуна. Двигун дає
 * лише `pg_get_functiondef`, а той типової `VOLATILE` не друкує: відсутність
 * слова в тексті — формат виводу, а не факт, тож вузький запит до каталогу.
 * Типи аргументів — тим самим `format_type` і під тим самим `search_path`,
 * що й ідентичність двигуна: інакше тип зі схеми на шляху сесії (`public`,
 * `extensions`) вийшов би некваліфікованим і ключ не збігся б.
 */
export async function readRoutineVolatility(
  pool: pg.Pool
): Promise<ReadonlyMap<string, FunctionVolatility>> {
  // `SET LOCAL` живе лише в транзакції: шлях не переживає читання
  const rows = await readOnlyQuery(pool, async (client) => {
    await client.query(SEARCH_PATH_STATEMENT)
    const { rows } = await client.query<{
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
    return rows
  })
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
