import type { CatalogEntry } from "simetra/model"
import type { RowView } from "simetra/data/react"

/**
 * The text of a `Ref` to an object: its main presentation attribute, else the
 * key (P4-D spec §5.3). The attribute is the entry's `presentation`, derived
 * from the kind registry's standard columns and `mainPresentation`; an
 * attribute name is never guessed, since a custom `description` is not it.
 * A removed or missing target shows an empty text.
 */
export function refPresentation(
  row: RowView | null,
  target: CatalogEntry
): string {
  if (row === null || row.state === "removed") return ""
  const attribute = target.presentation?.attribute
  const value = attribute === undefined ? undefined : row.values[attribute]
  // Колонка може бути порожньою (`''` чи `NULL`): тоді посилання не мало б
  // жодного тексту, тож показується ключ.
  return typeof value === "string" && value !== "" ? value : row.key
}
