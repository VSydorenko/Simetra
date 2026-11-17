import type { CatalogEntry } from "simetra/model"
import type { RowView } from "simetra/data/react"

/**
 * The text of a `Ref` to an object: the target's `description`, else `code`,
 * else the key (P4-D spec §5.3). Which of the two the kind has is the entry's
 * `presentation`, derived from the kind registry's standard columns; the
 * attribute name is never looked up, since a custom `description` is not it.
 * A removed or missing target shows an empty text.
 */
export function refPresentation(
  row: RowView | null,
  target: CatalogEntry
): string {
  if (row === null || row.state === "removed") return ""
  // Колонка стандартного реквізиту може бути порожньою (`''` чи `NULL`): тоді
  // посилання не мало б жодного тексту, тож береться наступне.
  for (const name of [
    target.presentation?.description,
    target.presentation?.code,
  ]) {
    if (name === undefined) continue
    const value = row.values[name]
    if (typeof value === "string" && value !== "") return value
  }
  return row.key
}
