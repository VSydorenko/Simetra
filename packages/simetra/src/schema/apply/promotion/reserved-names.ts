import { quoteIdent } from "simetra/model"
import type { ApplyTransaction } from "../port"

/**
 * Шаблон тимчасових імен наміру (рішення 11 плану П3-2b-1): таблиці, колонки
 * й канонічні імена підоб'єктів ідуть через `simetra_tmp_<n>`, вилучені
 * колонки — через `simetra_retired_<n>`.
 */
const RESERVED = "^simetra_(tmp|retired)_[0-9]+$"

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/**
 * Об'єкти, що вже носять тимчасове ім'я наміру, з видом об'єкта: `relation
 * app.simetra_tmp_1`, `type …`, `column app.items.simetra_tmp_1`, `constraint
 * …`, відсортовано. Простір кожного імені — той, у якому його займає намір:
 * `pg_class` і `pg_type` схем одиниці (перейменування таблиці займає й її
 * рядковий тип; рядкові типи відносин тут не повторюються — їх називає
 * `relation`), колонки й обмеження таблиць одиниці в старих іменах. Збіг —
 * сирий `42701`/`42P07` посеред наміру на копії, тож план питає наперед;
 * хибна відмова на імені, яке не зіткнулося б, допустима.
 */
export async function readReservedNames(
  tx: ApplyTransaction,
  p: {
    schemas: readonly string[]
    tables: readonly { schema: string; name: string }[]
  }
): Promise<string[]> {
  const rows = await tx.query<{
    kind: string
    schema: string
    table: string | null
    name: string
  }>(
    `WITH unit AS (
       SELECT c.oid, n.nspname, c.relname
       FROM pg_catalog.json_to_recordset($2::pg_catalog.json) AS x(schema text, name text)
       JOIN pg_catalog.pg_namespace n ON n.nspname = x.schema
       JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = x.name
     )
     SELECT 'relation' AS kind, n.nspname::text AS schema, NULL::text AS "table",
       c.relname::text AS name
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY ($1::text[]) AND c.relname ~ $3
     UNION ALL
     SELECT 'type', n.nspname::text, NULL, t.typname::text
     FROM pg_catalog.pg_type t
     JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = ANY ($1::text[]) AND t.typrelid = 0 AND t.typname ~ $3
     UNION ALL
     SELECT 'column', u.nspname::text, u.relname::text, a.attname::text
     FROM unit u
     JOIN pg_catalog.pg_attribute a ON a.attrelid = u.oid
     WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attname ~ $3
     UNION ALL
     SELECT 'constraint', u.nspname::text, u.relname::text, k.conname::text
     FROM unit u
     JOIN pg_catalog.pg_constraint k ON k.conrelid = u.oid
     WHERE k.conname ~ $3`,
    [[...p.schemas], JSON.stringify(p.tables), RESERVED]
  )
  return rows
    .map(
      (r) =>
        `${r.kind} ${[r.schema, ...(r.table === null ? [] : [r.table]), r.name]
          .map(quoteIdent)
          .join(".")}`
    )
    .sort(byCodeUnit)
}
