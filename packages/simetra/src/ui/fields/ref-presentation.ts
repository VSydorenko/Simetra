import type { CatalogEntry } from "simetra/model"
import type { RowView } from "simetra/data/react"

// Порядок спеки П4-D §5.3: `description`, інакше `code`, інакше ключ.
const PRESENTATION_ATTRIBUTES = ["description", "code"] as const

/**
 * The text of a `Ref` to an object: the target's `description`, else `code`,
 * else the key. Which of the two the kind has is read from the target's catalog
 * entry — the compiler derives its attributes from the kind registry, so no
 * branch on the kind name is needed here. A removed or missing target shows
 * an empty text.
 */
export function refPresentation(
  row: RowView | null,
  target: CatalogEntry
): string {
  if (row === null || row.state === "removed") return ""
  // Колонка стандартного реквізиту може бути порожньою (`''` чи `NULL`): тоді
  // посилання не мало б жодного тексту, тож береться наступне.
  for (const name of PRESENTATION_ATTRIBUTES) {
    if (!target.attributes.some((a) => a.name === name)) continue
    const value = row.values[name]
    if (typeof value === "string" && value !== "") return value
  }
  return row.key
}
