import type { RenameMap, RewriteProblem, TableRename } from "./renames"

/**
 * Відповідь резолву імені таблиці. `failed` — ім'я промотованої таблиці, яке
 * статично не доводиться: правити його не можна, а мовчки пропустити — теж.
 */
export type TableResolution =
  | { failed: true; code: RewriteProblem["code"]; detail: string }
  | {
      failed: false
      schema?: string
      table?: TableRename
      known?: readonly string[]
    }

/**
 * Ім'я таблиці за схемою; некваліфіковане — за `search_path` функції, а без
 * нього промотоване ім'я — відмова: таблицю обирає `search_path` викликача
 * (спека промоції §6). Спільне для операторів і типів PL/pgSQL (`%TYPE`,
 * `%ROWTYPE`), щоб одне ім'я не резолвилось двома правилами.
 */
export function resolveTableName(
  map: RenameMap,
  searchPath: readonly string[] | undefined,
  catalog: string | undefined,
  schema: string | undefined,
  relname: string
): TableResolution {
  const promoted = map.tables.some((t) => t.from === relname)
  if (catalog !== undefined) {
    if (!promoted) return { failed: false }
    return {
      failed: true,
      code: "rewrite.unsupported",
      detail: `a catalog-qualified name of promoted table "${relname}" is not rewritten`,
    }
  }
  const lookup = (s: string) => ({
    failed: false as const,
    schema: s,
    table: map.tables.find((t) => t.schema === s && t.from === relname),
    known: map.knownTables.get(`${s}.${relname}`),
  })
  if (schema !== undefined) return lookup(schema)
  if (searchPath === undefined) {
    if (!promoted) return { failed: false }
    return {
      failed: true,
      code: "rewrite.unqualified-table",
      detail: `table "${relname}" is not schema-qualified and the function sets no search_path`,
    }
  }
  // Схеми моделі: решта `search_path` (провайдер, розширення) невідома.
  const modelSchemas = new Set([
    ...[...map.knownTables.keys()].map((k) => k.slice(0, k.indexOf("."))),
    ...map.tables.map((t) => t.schema),
  ])
  for (const s of searchPath) {
    const found = lookup(s)
    if (found.table !== undefined || found.known !== undefined) return found
    // Схема поза моделлю раніше за схему таблиці: відношення з тим самим
    // ім'ям там статично не виключити (спека промоції §6).
    if (!modelSchemas.has(s) && promoted) {
      return {
        failed: true,
        code: "rewrite.ambiguous-name",
        detail: "search-path",
      }
    }
  }
  return { failed: false }
}
