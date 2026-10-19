import type { EngineScope } from "../engine"
import { inCatalogPath } from "./fingerprint"
import type { ApplyTransaction } from "./port"

/**
 * Недійсні обмеження таблиць і доменів та недійсні індекси схем межі
 * (`NOT VALID`, невдалий `CREATE INDEX CONCURRENTLY`). Відсортовані тексти
 * `constraint <таблиця> <ім'я>`, `domain constraint <домен> <ім'я>`,
 * `index <індекс>` — ті самі на бажаній тіні й на цілі, тож раннер порівнює
 * їх як множини. Читається через `inCatalogPath`: імена кваліфіковані
 * схемою незалежно від `search_path` сесії.
 */
export async function readInvalidObjects(
  tx: ApplyTransaction,
  scope: EngineScope
): Promise<string[]> {
  const rows = await inCatalogPath(
    tx,
    `select x.object from (
      select format('constraint %s %s', c.conrelid::regclass, c.conname) as object
      from pg_constraint c
      join pg_class k on k.oid = c.conrelid
      join pg_namespace n on n.oid = k.relnamespace
      where not c.convalidated and n.nspname = any($1::text[])
      union all
      select format('domain constraint %s %s', c.contypid::regtype, c.conname)
      from pg_constraint c
      join pg_type t on t.oid = c.contypid
      join pg_namespace n on n.oid = t.typnamespace
      where not c.convalidated and n.nspname = any($1::text[])
      union all
      select format('index %s', i.indexrelid::regclass)
      from pg_index i
      join pg_class k on k.oid = i.indrelid
      join pg_namespace n on n.oid = k.relnamespace
      where not (i.indisvalid and i.indisready) and n.nspname = any($1::text[])
    ) x
    order by x.object collate "C"`,
    [scope.schemas]
  )
  return rows.map((r) => String(r.object))
}
